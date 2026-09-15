#!/usr/bin/env python3
import argparse
import json
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def normalize_audio_for_sortformer(audio_path):
    ffmpeg = os.environ.get("SCRIBE_DIARIZATION_FFMPEG") or os.environ.get("SCRIBE_ASR_FFMPEG") or "ffmpeg"
    temp_dir = tempfile.TemporaryDirectory(prefix="scribe-sortformer-")
    output_path = Path(temp_dir.name) / "input-16k-mono.wav"
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            audio_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output_path),
        ],
        check=True,
    )
    return temp_dir, str(output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--model", default="nvidia/diar_sortformer_4spk-v1")
    args = parser.parse_args()

    started = time.perf_counter()
    try:
        import torch
        import nemo
        from nemo.collections.asr.models import SortformerEncLabelModel
    except Exception as error:
        raise SystemExit(f"NeMo Sortformer dependencies unavailable: {error}")

    device = torch.device("cpu")
    init_started = time.perf_counter()
    model = SortformerEncLabelModel.from_pretrained(args.model, map_location=device)
    model = model.to(device)
    model.eval()
    init_seconds = time.perf_counter() - init_started

    if not hasattr(model, "diarize"):
        raise SystemExit("Loaded Sortformer model does not expose a diarize method in this NeMo version")

    conversion_started = time.perf_counter()
    temp_dir, normalized_audio = normalize_audio_for_sortformer(args.audio)
    conversion_seconds = time.perf_counter() - conversion_started

    inference_started = time.perf_counter()
    try:
        prediction = model.diarize(audio=normalized_audio, batch_size=1, num_workers=0)
    finally:
        temp_dir.cleanup()
    inference_seconds = time.perf_counter() - inference_started

    turns = []
    raw_prediction = prediction
    if isinstance(prediction, (list, tuple)):
        raw_prediction = prediction[0] if prediction else []
    for item in raw_prediction or []:
        if isinstance(item, str):
            parts = item.strip().split()
            if len(parts) >= 3:
                turns.append({"start": float(parts[0]), "end": float(parts[1]), "speaker": parts[2]})
        elif isinstance(item, dict):
            turns.append({
                "start": float(item.get("start", item.get("start_time", 0))),
                "end": float(item.get("end", item.get("end_time", 0))),
                "speaker": str(item.get("speaker", item.get("label", "SPEAKER_00"))),
            })

    peak_memory_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    payload = {
        "engine": "nemo-sortformer",
        "checkpoint": args.model,
        "sampleId": args.sample_id,
        "speakerTurns": turns,
        "runtimeSeconds": time.perf_counter() - started,
        "initializationSeconds": init_seconds,
        "audioConversionSeconds": conversion_seconds,
        "inferenceSeconds": inference_seconds,
        "peakMemoryBytes": peak_memory_kb * 1024,
        "device": str(device),
        "versions": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "nemo": getattr(nemo, "__version__", "unknown"),
            "torch": torch.__version__,
        },
        "licenses": {
            "weights": "UNKNOWN until checkpoint model card is reviewed.",
            "runtime": "Apache-2.0 for NeMo toolkit; transitive dependencies require review.",
        },
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
