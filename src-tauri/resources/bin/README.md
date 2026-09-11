# Bundled Runtime Binaries

Release builds populate this directory before `tauri build`.

Expected layout:

```text
src-tauri/resources/bin/aarch64-apple-darwin/
  ffmpeg
  ffprobe
  whisper-cli

src-tauri/resources/bin/x86_64-pc-windows-msvc/
  ffmpeg.exe
  ffprobe.exe
  whisper-cli.exe
```

These binaries are intentionally not committed to the repository. The release workflow obtains/builds them from documented upstream sources and Tauri bundles this directory as application resources.
