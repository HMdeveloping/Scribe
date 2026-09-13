#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("NUMBA_CACHE_DIR", str(Path(tempfile.gettempdir()) / "scribe-qwen-numba-cache"))

from qwen_asr import Qwen3ASRModel

MODEL_DIR = Path(os.environ.get("SCRIBE_ASR_QWEN3_MODEL", Path.home() / "Scribe-ASR-Benchmark/models/qwen3-asr-0.6b"))


def model_size_bytes(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        if path.is_file():
            total += path.stat().st_size
    return total


def transcription_text(item) -> str:
    if isinstance(item, str):
        return item
    for name in ("text", "transcript", "transcription"):
        value = getattr(item, name, None)
        if isinstance(value, str):
            return value
    if isinstance(item, dict):
        for name in ("text", "transcript", "transcription"):
            value = item.get(name)
            if isinstance(value, str):
                return value
    return str(item)


def wav_for_engine(audio: str, temp_dir: Path) -> str:
    source = Path(audio)
    if source.suffix.lower() == ".wav":
        return str(source)
    wav = temp_dir / "input.wav"
    subprocess.run(
        [
            os.environ.get("SCRIBE_ASR_FFMPEG", "ffmpeg"),
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-sample_fmt",
            "s16",
            str(wav),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return str(wav)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    if not MODEL_DIR.is_dir():
        raise SystemExit(f"Missing Qwen model directory: {MODEL_DIR}")

    with tempfile.TemporaryDirectory(prefix="scribe-qwen-") as temp:
        engine_audio = wav_for_engine(args.audio, Path(temp))
        model = Qwen3ASRModel.from_pretrained(
            str(MODEL_DIR),
            local_files_only=True,
            trust_remote_code=True,
            max_inference_batch_size=1,
            max_new_tokens=256,
        )
        supported_languages = model.get_supported_languages()
        if "Slovenian" not in supported_languages:
            raise SystemExit(
                "Qwen3-ASR 0.6B local package does not support Slovenian; "
                f"supported languages: {supported_languages}"
            )
        result = model.transcribe(engine_audio, language="Slovenian", return_time_stamps=False)
        first = result[0] if isinstance(result, list) and result else result
        text = transcription_text(first).strip()
        payload = {
            "text": text,
            "segments": [],
            "modelSizeBytes": model_size_bytes(MODEL_DIR),
        }
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
