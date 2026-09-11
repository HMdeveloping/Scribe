# Third-Party Notices

Scribe release builds bundle runtime command-line tools so users do not need to install developer tools manually.

## FFmpeg and FFprobe

- Project: FFmpeg
- Website: https://ffmpeg.org/
- License: FFmpeg is distributed under LGPL or GPL depending on build configuration and enabled libraries.
- macOS release workflow source: Homebrew `ffmpeg` package on the `macos-15` arm64 GitHub runner.
- Windows release workflow source: Chocolatey `ffmpeg` package on the `windows-latest` x64 GitHub runner.

Before publishing a release, verify whether the selected FFmpeg build is LGPL or GPL and keep the matching license text/notices with the release assets. If GPL builds are used, Scribe distribution must comply with GPL obligations.

## whisper.cpp / whisper-cli

- Project: whisper.cpp
- Repository: https://github.com/ggml-org/whisper.cpp
- License: MIT
- Release workflow source: built from `ggml-org/whisper.cpp` using the configured `WHISPER_CPP_REF` in `.github/workflows/release.yml` currently `v1.7.6`.

Whisper model files are not bundled. Users download models through Scribe's local model manager.
