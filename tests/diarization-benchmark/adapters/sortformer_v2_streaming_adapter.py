#!/usr/bin/env python3
import argparse
import json
import platform
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def maxrss_bytes():
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def normalize_audio(audio_path, start=None, duration=None):
    temp_dir = tempfile.TemporaryDirectory(prefix="scribe-sortformer-v2-")
    output_path = Path(temp_dir.name) / "input-16k-mono.wav"
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if start is not None:
        command += ["-ss", f"{start:.3f}"]
    command += ["-i", audio_path]
    if duration is not None:
        command += ["-t", f"{duration:.3f}"]
    command += ["-ac", "1", "-ar", "16000", str(output_path)]
    subprocess.run(command, check=True)
    return temp_dir, str(output_path)


def audio_duration(audio_path):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            audio_path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def normalize_prediction(prediction, offset=0.0):
    raw_prediction = prediction[0] if isinstance(prediction, (list, tuple)) and prediction else prediction
    turns = []
    for item in raw_prediction or []:
        if isinstance(item, str):
            parts = item.strip().split()
            if len(parts) >= 3:
                turns.append({"start": float(parts[0]) + offset, "end": float(parts[1]) + offset, "speaker": parts[2]})
        elif isinstance(item, dict):
            turns.append({
                "start": float(item.get("start", item.get("start_time", 0))) + offset,
                "end": float(item.get("end", item.get("end_time", 0))) + offset,
                "speaker": str(item.get("speaker", item.get("label", "speaker_0"))),
            })
    return sorted([turn for turn in turns if turn["end"] > turn["start"]], key=lambda turn: (turn["start"], turn["end"], turn["speaker"]))


def apply_streaming_config(model):
    modules = getattr(model, "sortformer_modules", None)
    if modules is None:
        return {}
    # Official model-card quick-start values. Values are in 80ms frames.
    desired = {
        "chunk_len": 340,
        "chunk_right_context": 40,
        "fifo_len": 40,
        "spkcache_update_period": 300,
    }
    applied = {}
    for key, value in desired.items():
        if hasattr(modules, key):
            setattr(modules, key, value)
            applied[key] = getattr(modules, key)
    for key in ["chunk_left_context", "spkcache_len"]:
        if hasattr(modules, key):
            applied[key] = getattr(modules, key)
    return applied


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--model", default="nvidia/diar_streaming_sortformer_4spk-v2")
    parser.add_argument("--slice-start", type=float, default=None)
    parser.add_argument("--slice-duration", type=float, default=None)
    args = parser.parse_args()

    started = time.perf_counter()
    import nemo
    import torch
    from nemo.collections.asr.models import SortformerEncLabelModel

    device = torch.device("cpu")
    init_started = time.perf_counter()
    model = SortformerEncLabelModel.from_pretrained(args.model, map_location=device)
    model = model.to(device)
    model.eval()
    streaming_config = apply_streaming_config(model)
    init_seconds = time.perf_counter() - init_started

    source_duration = audio_duration(args.audio)
    temp_dir, normalized_audio = normalize_audio(args.audio, args.slice_start, args.slice_duration)
    analyzed_seconds = args.slice_duration or source_duration

    inference_started = time.perf_counter()
    try:
        prediction = model.diarize(audio=[normalized_audio], batch_size=1, num_workers=0)
    finally:
        temp_dir.cleanup()
    inference_seconds = time.perf_counter() - inference_started

    turns = normalize_prediction(prediction, offset=args.slice_start or 0.0)
    payload = {
        "engine": "nemo-streaming-sortformer-v2",
        "checkpoint": args.model,
        "sampleId": args.sample_id,
        "sourceAudioSeconds": source_duration,
        "analyzedAudioSeconds": analyzed_seconds,
        "sliceStart": args.slice_start,
        "sliceDuration": args.slice_duration,
        "speakerTurns": turns,
        "runtimeSeconds": time.perf_counter() - started,
        "initializationSeconds": init_seconds,
        "inferenceSeconds": inference_seconds,
        "realTimeFactor": inference_seconds / analyzed_seconds if analyzed_seconds else None,
        "peakMemoryBytes": maxrss_bytes(),
        "device": str(device),
        "streamingConfig": streaming_config,
        "versions": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "nemo": getattr(nemo, "__version__", "unknown"),
            "torch": torch.__version__,
        },
        "licenses": {
            "weights": "CC-BY-4.0 per official NVIDIA Hugging Face model card; verify before production.",
            "runtime": "Apache-2.0 for NeMo toolkit; transitive Python dependencies require review.",
        },
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
