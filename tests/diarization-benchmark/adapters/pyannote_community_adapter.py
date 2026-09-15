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


def annotation_to_turns(annotation):
    turns = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        turns.append({
            "start": round(float(turn.start), 3),
            "end": round(float(turn.end), 3),
            "speaker": str(speaker),
        })
    return turns


def prepare_waveform(audio_path):
    ffmpeg = os.environ.get("SCRIBE_DIARIZATION_FFMPEG") or os.environ.get("SCRIBE_ASR_FFMPEG") or "ffmpeg"
    temp_dir = tempfile.TemporaryDirectory(prefix="scribe-pyannote-community1-")
    wav_path = Path(temp_dir.name) / "input-16k-mono.wav"
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
            str(wav_path),
        ],
        check=True,
    )

    import numpy as np
    import torch
    from scipy.io import wavfile

    sample_rate, data = wavfile.read(wav_path)
    if data.dtype.kind in {"i", "u"}:
        max_value = np.iinfo(data.dtype).max
        data = data.astype("float32") / max_value
    else:
        data = data.astype("float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    waveform = torch.from_numpy(data).unsqueeze(0)
    return temp_dir, {"waveform": waveform, "sample_rate": int(sample_rate)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--mode", choices=["auto", "num_speakers_2"], default="auto")
    parser.add_argument("--checkpoint", default=os.environ.get("SCRIBE_DIARIZATION_PYANNOTE_MODEL", "pyannote/speaker-diarization-community-1"))
    args = parser.parse_args()

    started = time.perf_counter()
    init_started = time.perf_counter()

    import torch
    import pyannote.audio
    from pyannote.audio import Pipeline

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    pipeline = Pipeline.from_pretrained(args.checkpoint, token=token)
    device = torch.device("cpu")
    pipeline.to(device)
    init_seconds = time.perf_counter() - init_started

    conversion_started = time.perf_counter()
    temp_dir, file = prepare_waveform(args.audio)
    conversion_seconds = time.perf_counter() - conversion_started

    inference_started = time.perf_counter()
    kwargs = {"num_speakers": 2} if args.mode == "num_speakers_2" else {}
    try:
        output = pipeline(file, **kwargs)
    finally:
        temp_dir.cleanup()
    inference_seconds = time.perf_counter() - inference_started

    regular = getattr(output, "speaker_diarization", output)
    exclusive = getattr(output, "exclusive_speaker_diarization", None)
    speaker_turns = annotation_to_turns(exclusive or regular)

    peak_memory_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    payload = {
        "engine": "pyannote-community-1",
        "mode": args.mode,
        "checkpoint": args.checkpoint,
        "sampleId": args.sample_id,
        "speakerTurns": speaker_turns,
        "regularSpeakerTurns": annotation_to_turns(regular),
        "exclusiveSpeakerTurns": annotation_to_turns(exclusive) if exclusive is not None else None,
        "exclusiveAvailable": exclusive is not None,
        "runtimeSeconds": time.perf_counter() - started,
        "initializationSeconds": init_seconds,
        "audioConversionSeconds": conversion_seconds,
        "inferenceSeconds": inference_seconds,
        "peakMemoryBytes": peak_memory_kb * 1024,
        "device": str(device),
        "versions": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "pyannoteAudio": getattr(pyannote.audio, "__version__", "unknown"),
            "torch": torch.__version__,
        },
        "licenses": {
            "weights": "CC-BY-4.0 per pyannote Community-1 model card; verify before production.",
            "runtime": "MIT for pyannote.audio; transitive Python dependencies require review.",
        },
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
