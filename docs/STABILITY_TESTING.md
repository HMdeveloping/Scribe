# Scribe Stability Testing

Scribe's stability harness is a repeatable regression and soak suite for the 1.0.0 stability pass. It does not publish releases, does not require real microphone hardware, and uses disposable temporary data only.

## Quick Run

```sh
npm run test:stability
```

This runs:

- i18n audit
- frontend production build
- Rust format check
- Rust check
- Rust unit tests
- disposable persistence/integration checks
- frontend source-contract checks
- deterministic soak loop

## Individual Layers

```sh
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:soak
```

`npm run test:e2e` currently performs source-level UI regression checks and reports a clear SKIP for browser-driven Playwright automation because Playwright is not installed in this project.

## Soak Runs

Default local soak:

```sh
npm run test:soak
```

Longer local soak:

```sh
SCRIBE_SOAK_ITERATIONS=100 npm run test:soak
```

The soak runner repeatedly creates disposable projects, recordings, transcripts, archive/restore state, follow/seek state, and restart simulations. A passing run prints:

```text
STABILITY SOAK PASS
iterations: 50
failures: 0
uncaught errors: 0
data integrity failures: 0
```

## Data Safety

The harness creates temporary directories under the operating system temp directory and refuses to use paths outside temp. It must never touch:

```text
~/Library/Application Support/com.scribeapp.app/
```

Failed soak runs preserve their temporary directory path in the log for inspection. Passing runs clean up after themselves.

## GitHub Actions

Manual workflow:

```text
Scribe Stability Harness
```

The workflow runs static/build/unit checks first, then the stability harness with a moderate CI soak count. It uploads temporary stability artifacts only on failure and does not require release signing secrets.

## Interpreting Failures

- Rust test failure: backend parser, metadata, model, import, or data invariant regression.
- Integration failure: disposable persistence, restart simulation, archive/restore, non-ASCII filename, or viewport CSS contract regression.
- E2E source-contract failure: a core UI flow hook or required scroll container disappeared.
- Soak failure: repeated-action state mismatch, data integrity failure, uncaught exception, or timeout-like failure.

## Manual-Only Areas

These remain outside automation:

- real microphone permission and hardware capture
- real Whisper model download/transcription quality
- clean-machine install behavior
- Gatekeeper or SmartScreen behavior
- DMG visual inspection
- updater flow from a previously published build
