#!/usr/bin/env python3
"""Research-only standalone Streaming Sortformer v2 sidecar CLI."""
import argparse
import json
import sys
import time
import wave
from pathlib import Path

from sortformer_v2_streaming_adapter import (
    apply_streaming_config,
    audio_duration,
    normalize_audio,
    normalize_prediction,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True, help="HF model ID or local model directory")
    parser.add_argument("--output", required=True)
    parser.add_argument("--input-ready-wav", action="store_true", help="input is PCM s16le mono 16 kHz WAV")
    args = parser.parse_args()
    started = time.perf_counter()
    try:
        import torch
        from nemo.collections.asr.models import SortformerEncLabelModel

        if args.input_ready_wav:
            with wave.open(args.audio, "rb") as ready_wav:
                if (ready_wav.getnchannels(), ready_wav.getframerate(), ready_wav.getsampwidth()) != (1, 16000, 2):
                    raise ValueError("--input-ready-wav requires mono 16 kHz 16-bit PCM WAV")
                duration = ready_wav.getnframes() / ready_wav.getframerate()
            temp_dir, normalized = None, args.audio
        else:
            duration = audio_duration(args.audio)
            temp_dir, normalized = normalize_audio(args.audio)
        try:
            local_model = Path(args.model)
            if local_model.is_dir():
                candidates = sorted(local_model.glob("*.nemo"))
                if len(candidates) != 1:
                    raise ValueError("local --model directory must contain exactly one .nemo checkpoint")
                local_model = candidates[0]
            if local_model.is_file():
                model = SortformerEncLabelModel.restore_from(str(local_model), map_location=torch.device("cpu"))
            else:
                model = SortformerEncLabelModel.from_pretrained(args.model, map_location=torch.device("cpu"))
            model = model.to(torch.device("cpu"))
            model.eval()
            config = apply_streaming_config(model)
            prediction = model.diarize(audio=[normalized], batch_size=1, num_workers=0)
        finally:
            if temp_dir is not None:
                temp_dir.cleanup()
        payload = {
            "version": 1,
            "model": args.model,
            "modelRevision": "5240a64075176943f677d30fa2171c780229f341",
            "duration": duration,
            "speakerTurns": normalize_prediction(prediction),
            "streamingConfig": config,
        }
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": "ok", "runtimeSeconds": time.perf_counter() - started}))
    except Exception as error:
        print(f"scribe-diarize: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
