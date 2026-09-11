# Releasing Scribe

This guide describes the intended GitHub release flow for Scribe v0.1 and later.

## Runtime Binaries

Release builds bundle working `ffmpeg`, `ffprobe`, and `whisper-cli` binaries for each target platform.

The app resolves runtime tools in this order:

1. bundled Tauri resources in `bin/<target-triple>/`
2. app-data overrides for development
3. `PATH` fallback for development

Public installers must be produced by the GitHub release workflow or by running equivalent staging locally before `tauri build`.

## One-Time GitHub Setup

1. Create the GitHub repository.
2. Push this project to the repository.
3. Choose whether the repository is public or private.
4. Add the Tauri updater public key to `src-tauri/tauri.conf.json`.
5. Verify the updater endpoint in `src-tauri/tauri.conf.json`:

   ```json
   "https://github.com/sportiyeet/Scribe/releases/latest/download/latest.json"
   ```

6. Add GitHub Actions secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
7. In repository settings, allow GitHub Actions to create releases with `GITHUB_TOKEN`.
8. Enable GitHub Pages with source set to GitHub Actions.
9. Choose and add a `LICENSE` file before making the source public.

Optional signing can be added later:

- Apple Developer signing and notarization secrets for macOS.
- Authenticode/code-signing secrets for Windows.

## Version Release Flow

1. Update the version in:
   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. Run local checks:

   ```bash
   npm run build
   cargo fmt --manifest-path src-tauri/Cargo.toml --check
   cargo check --manifest-path src-tauri/Cargo.toml
   ```

3. For a local package build, stage runtime binaries first:

   ```bash
   FFMPEG_PATH=/path/to/ffmpeg \
   FFPROBE_PATH=/path/to/ffprobe \
   WHISPER_CLI_PATH=/path/to/whisper-cli \
   node scripts/stage-runtime-binaries.mjs aarch64-apple-darwin
   ```

4. Commit the version change.
5. Push `main`.
6. Create and push a version tag:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

7. GitHub Actions builds macOS and Windows.
8. The release workflow creates or updates `Scribe v0.1.1`.
9. The release receives:
   - macOS `.dmg`
   - Windows NSIS `.exe`
   - updater artifacts and signatures
   - `latest.json`
   - stable website aliases `Scribe-macOS.dmg` and `Scribe-Windows.exe`
10. The GitHub Pages site points to the latest release aliases.
11. Installed Scribe apps check the same GitHub Release `latest.json` for updates.

## First v0.1 Tag

For the initial release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The first workflow run should be treated as a release-candidate validation run. Inspect every uploaded asset before sharing the download page.

## Architecture

GitHub Releases are the single source for both public downloads and in-app updates:

```text
GitHub repository
  +-- GitHub Actions
  +-- GitHub Release v0.1.0
  |   +-- macOS installer
  |   +-- Windows installer
  |   +-- updater artifacts/signatures
  |   +-- latest.json
  +-- GitHub Pages download website
```

The in-app updater reads:

```text
https://github.com/sportiyeet/Scribe/releases/latest/download/latest.json
```

The website downloads:

```text
https://github.com/sportiyeet/Scribe/releases/latest/download/Scribe-macOS.dmg
https://github.com/sportiyeet/Scribe/releases/latest/download/Scribe-Windows.exe
```

## Notes About Signing

The current workflow supports Tauri updater signing through GitHub Secrets. It does not fake Apple notarization or Windows Authenticode signing.

Until those platform signing systems are configured, macOS and Windows may warn users when opening the app.
