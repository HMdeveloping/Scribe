# Scribe

Scribe is a local-first desktop audio recording, import, and transcription application.

## Platforms

- macOS
- Windows

## Features

- Record audio
- Import audio files
- Offline/local Whisper transcription
- Synchronized word-level transcript playback
- Projects
- Recordings library
- Archive and delete
- Local Whisper model management
- Multiple interface and transcription languages
- Privacy-focused local storage

## Download

Public builds are distributed through GitHub Releases:

- Latest release: `https://github.com/<owner>/<repository>/releases/latest`
- Download site: `https://<github-username>.github.io/<repository>/`

Replace the placeholders after the GitHub repository is created.

## Privacy

Scribe is designed so your recordings and transcripts stay on your device. Whisper models are downloaded locally, and the app may connect to the internet for model downloads and update checks.

## Development

```bash
npm ci
npm run build
npm run tauri dev
```

Rust checks:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

## Release Status

The release infrastructure is prepared for GitHub Actions, GitHub Releases, updater artifacts, and GitHub Pages. Release builds stage and bundle `ffmpeg`, `ffprobe`, and `whisper-cli` as Tauri resources so users do not need Homebrew, CMake, FFmpeg, whisper.cpp, or PATH setup.

Before sharing v0.1 publicly, run the GitHub release workflow and perform a clean-machine install test on macOS and Windows.

## License

No license has been chosen yet. Choose and add a `LICENSE` file before making the source repository public.
