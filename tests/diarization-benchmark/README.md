# Scribe Diarization Benchmark

This harness is intentionally isolated from production Scribe. It evaluates local diarization candidates as structural speaker-turn providers only; it does not alter transcript text, Whisper word timings, persistence, UI, updater behavior, or release packaging.

Private audio must stay outside the repository. The long Slovenian lecture gate defaults to:

`$HOME/Scribe-ASR-Benchmark/repetition-cases/Jambrekovo predavanje 1.m4a`

To run an external local engine, set `SCRIBE_DIARIZATION_ENGINE` to an executable that accepts the arguments declared in `manifest.json` and writes JSON with either `speakerTurns` or `turns`.

Expected turn shape:

```json
{
  "speakerTurns": [
    { "start": 0.0, "end": 4.2, "speaker": "A", "confidence": 0.91 }
  ]
}
```

Outputs are written to `tests/diarization-benchmark/results/latest/` and are gitignored.
