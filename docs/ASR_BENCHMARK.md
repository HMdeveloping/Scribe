# Scribe ASR Quality Benchmark

This is an experimental research harness for comparing local ASR quality on real Slovenian speech. It does not change Scribe production transcription behavior, default models, CLI arguments, UI, updater, persistence, or release versioning.

## Layout

```text
tests/asr-benchmark/
  manifest.json
  audio/
  local-references/
  adapters/
  results/
  scripts/run-asr-benchmark.mjs
```

`audio/` and `results/` are gitignored except for `.gitkeep`. Do not commit private recordings, model files, generated reports, or copied raw ASR output. `local-references/` contains intentional human reference fixtures and may be committed when the text is safe to share.

## Dataset

Each sample in `manifest.json` needs a local audio file and a human-written reference transcript:

```json
{
  "id": "sl-code-switch-001",
  "enabled": true,
  "audio": "audio/sl-code-switch-001.wav",
  "reference": "local-references/sl-code-switch-001.txt",
  "category": "code_switch_sl_en",
  "language": "sl",
  "expectedEnglishTokens": ["feedback", "project"],
  "notes": "Slovenian sentence containing English technical terms"
}
```

Reference transcripts must preserve what was actually spoken. Do not correct slang, informal wording, dialect-like pronunciation, or English code-switch words into literary Slovenian. Never use one ASR engine's output as another engine's reference.

Use these categories:

- `clean_slovenian`
- `code_switch_sl_en`
- `colloquial`
- `slang`
- `technical`
- `fast_speech`
- `legitimate_repetition`
- `pause_test`
- `noisy`
- `silence`
- `long_form`

Include silence/end-of-recording samples, low-energy speech, pauses, noisy audio, fast speech, and code-switched Slovenian-English sentences. For embedded English words, list the expected spoken English tokens in `expectedEnglishTokens`.

## Running

```bash
npm run benchmark:asr
```

The runner validates the manifest, discovers available local runtimes, runs enabled candidates when their local model/runtime configuration is present, preserves raw outputs, computes metrics, and writes:

```text
tests/asr-benchmark/results/latest/results.json
tests/asr-benchmark/results/latest/report.md
```

If no enabled local audio exists, the harness still validates itself and writes a report, but it does not claim a model-quality winner.

## Whisper Candidates

The harness uses Scribe's bundled `whisper-cli` by default on Apple Silicon:

```text
src-tauri/resources/bin/aarch64-apple-darwin/whisper-cli
```

Override paths with:

```bash
SCRIBE_ASR_WHISPER_CLI=/path/to/whisper-cli \
SCRIBE_ASR_WHISPER_TURBO_MODEL=/path/to/ggml-large-v3-turbo.bin \
SCRIBE_ASR_WHISPER_LARGE_V3_MODEL=/path/to/ggml-large-v3.bin \
npm run benchmark:asr
```

The manifest includes:

- Whisper Large v3 Turbo, current production-style no prompt
- Whisper Large v3 Turbo with the minimal prompt, disabled by default after benchmark rejection
- Whisper Large v3, current production-style no prompt
- Whisper Large v3 with the minimal prompt, disabled by default after benchmark rejection

The prompt experiment is intentionally tiny:

```text
Slovenian speech with occasional English words and informal expressions.
```

Do not add vocabulary lists, expected transcript content, people names, project terminology, or `--carry-initial-prompt` without a separate benchmark reason.

## Parakeet Investigation

NVIDIA Parakeet TDT 0.6B v3 is listed as a benchmark candidate, not as production integration. NVIDIA's model card describes it as a 600M-parameter multilingual ASR model, licensed CC-BY-4.0, supporting Slovenian (`sl`) and English (`en`), with punctuation/capitalization and word/segment timestamps. NVIDIA's NGC collection also describes word-level timestamps and v3 support for 25 European languages.

Local benchmark execution should start with the smallest separate Python/NeMo or Transformers experiment that can emit JSON for this harness. Keep the dependency tree outside Scribe production. Record whether inference used CPU, Metal/MPS, CoreML, MLX, ONNX, or another backend, whether it stayed local after model download, model size, runtime, memory, timestamp availability, and Windows x64 feasibility.

The final Scribe 1.0 benchmark measured Parakeet TDT 0.6B v3 at 32.3% WER on the local Slovenian suite. It is not a production candidate for Scribe 1.0.

## Qwen3-ASR Investigation

Qwen3-ASR 0.6B is listed as a benchmark candidate, not as production integration. The Hugging Face repository lists Apache-2.0 licensing and a roughly 1.88 GB model file. Before running locally, confirm language/code-switch behavior, local/offline support, timestamp capability, Apple Silicon feasibility, Windows feasibility, RAM, speed, and dependency burden.

If local execution is impractical, mark it skipped with the exact reason in the benchmark report instead of forcing a large infrastructure project.

The tested local Qwen3-ASR 0.6B package does not support Slovenian. It was skipped in the final Scribe 1.0 benchmark and is not a production candidate for Scribe 1.0.

## External Engine Adapters

The manifest includes declarative placeholders for external commands:

```bash
SCRIBE_ASR_PARAKEET_CMD=/path/to/local/parakeet-wrapper
SCRIBE_ASR_QWEN3_ASR_CMD=/path/to/local/qwen3-wrapper
```

Wrappers are launched as:

```bash
wrapper --audio path.wav --reference reference.txt --sample-id sample-id --language sl --output output.json
```

They should write raw JSON with at least:

```json
{
  "text": "transcribed text",
  "segments": [
    { "start": 0.0, "end": 1.2, "text": "segment text" }
  ],
  "modelSizeBytes": 1880000000
}
```

Keep wrappers outside Scribe production. They may use a separate Python virtual environment or local runtime as long as the generated output JSON is local and reproducible.

This repository includes benchmark-only helper adapters in `tests/asr-benchmark/adapters/` for the tested local Parakeet and Qwen runtimes. They are not used by Scribe production code.

Adapter-local runtime paths may be overridden with:

- `SCRIBE_ASR_NEMO_SPEECH_BIN`
- `SCRIBE_ASR_PARAKEET_MODEL`
- `SCRIBE_ASR_QWEN3_MODEL`

## Metrics

Implemented metrics:

- Normalized WER
- Raw WER
- CER
- Embedded English/code-switch token accuracy
- Hallucinated repeated phrase count
- Omitted-word count
- Duplicated segment count
- Transcription runtime
- Real-time factor, `transcription_seconds / audio_seconds`
- Model disk size
- Peak memory field, currently `null` unless a runtime-specific adapter supplies it

Normalization lowercases text, preserves lexical differences, keeps letters/numbers/apostrophes/hyphens, collapses whitespace, and removes punctuation that would otherwise distort WER. It does not equate unrelated Slovenian and English words.

The report stores raw ASR metrics separately from Scribe post-processed metrics. This matters for hallucination testing because a model should not be judged better only because Scribe's conservative repetition filter hid repeated segments.

## Interpretation

Do not recommend a new default model because of a tiny total-WER improvement. Weigh:

1. Slovenian accuracy
2. Slovenian-English code switching
3. hallucination rate
4. word timestamps
5. speed
6. local/offline simplicity
7. memory
8. cross-platform packaging
9. model download size
10. production reliability

If Whisper with the minimal prompt is the best trade-off, say so. If current Whisper remains best, say so. If Parakeet wins accuracy but has high integration cost, report those separately.

## Final Scribe 1.0 Result

The accepted final Slovenian ASR benchmark conclusion is:

- Whisper Large v3 Turbo, no prompt: 15.5% WER.
- Whisper Large v3, no prompt: 9.8% WER.
- Parakeet TDT 0.6B v3: 32.3% WER.
- Qwen3-ASR 0.6B: unsupported for Slovenian in the tested local package.

Prompted Whisper Large v3 Turbo was previously rejected because WER worsened substantially. The production Whisper decoding arguments should not be changed from this benchmark.

Whisper Large v3 is the best-quality Slovenian model found by this benchmark and is the Scribe 1.0 quality baseline. Whisper Large v3 Turbo remains the faster practical alternative. Parakeet TDT 0.6B v3 and Qwen3-ASR 0.6B are not production candidates for Scribe 1.0.

## Privacy

Private benchmark audio remains local in `tests/asr-benchmark/audio/`. Generated outputs remain local in `tests/asr-benchmark/results/`. Both paths are ignored by git. Human reference fixtures live in `tests/asr-benchmark/local-references/`. The runner writes references to relative paths and must not copy files from Scribe's real app data directory.

## First Real Benchmark Step

Record or collect at least 3 to 5 human-reference samples for each priority category, starting with:

- clean Slovenian
- Slovenian-English code switching
- informal/slang Slovenian
- technical English words in Slovenian sentences
- speech followed by silence

Place audio in `tests/asr-benchmark/audio/`, write exact human transcripts in `tests/asr-benchmark/local-references/`, set `enabled: true`, configure local model paths through environment variables, then run `npm run benchmark:asr`.
