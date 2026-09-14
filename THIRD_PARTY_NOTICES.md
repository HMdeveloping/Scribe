# Third-Party Notices

Scribe release builds bundle runtime command-line tools so users do not need to install developer tools manually.

## FFmpeg and FFprobe

- Project: FFmpeg
- Website: https://ffmpeg.org/
- Source: https://github.com/FFmpeg/FFmpeg
- License: LGPL version 2.1 or later for the configured macOS build described below.
- macOS release workflow source: built from the pinned `FFMPEG_REF` in `.github/workflows/release.yml`, currently `n6.1.1`.
- macOS build configuration: static command-line `ffmpeg` and `ffprobe` binaries with a minimal native audio-focused configuration for AAC/M4A, MP3, Opus/WebM, FLAC, WAV/PCM probing and conversion.
- macOS configuration status: does not use `--enable-gpl` and must not use `--enable-nonfree`; release CI fails if `--enable-nonfree` appears in `ffmpeg -version` or `ffprobe -version`.
- Windows release workflow source: BtbN `ffmpeg-master-latest-win64-lgpl.zip` from `https://github.com/BtbN/FFmpeg-Builds`.
- Windows configuration status: release CI fails if `--enable-nonfree` appears in `ffmpeg.exe -version` or `ffprobe.exe -version`.

Before publishing a release, verify the selected FFmpeg build's redistribution terms and keep the matching license text/notices with the release assets. Do not publish a release with a nonfree FFmpeg build.

## whisper.cpp / whisper-cli

- Project: whisper.cpp
- Repository: https://github.com/ggml-org/whisper.cpp
- License: MIT
- Release workflow source: built from `ggml-org/whisper.cpp` using the configured `WHISPER_CPP_REF` in `.github/workflows/release.yml` currently `v1.7.6`.

Whisper model files are not bundled. Users download models through Scribe's local model manager.
