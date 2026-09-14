# macOS Icon Composer Pipeline

Scribe's long-term macOS icon path should use Apple's Icon Composer source format plus Xcode asset compilation, not hand-scaled `.icns` variants.

## Current Local Toolchain Finding

The current development Mac cannot compile this pipeline:

- macOS: `15.7.7`
- active developer directory: `/Library/Developer/CommandLineTools`
- `xcodebuild`: unavailable because full Xcode is not selected/installed
- `actool`: unavailable
- Icon Composer: unavailable
- `iconutil`: available, but insufficient for Liquid Glass `.icon -> Assets.car` compilation

Do not fake the compiled resources on this machine.

## Second Mac Prerequisite Check

On the macOS 26 machine, install full Xcode 26 or newer and select it:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

Then verify the exact toolchain:

```bash
sw_vers
xcode-select -p
xcodebuild -version
xcrun --find actool
npm run icon:macos:verify-toolchain
```

Also check Icon Composer manually if needed:

```bash
mdfind 'kMDItemFSName == "Icon Composer.app"'
find /Applications -maxdepth 4 -name 'Icon Composer.app' -print
find /Applications/Xcode.app -maxdepth 5 -name 'Icon Composer.app' -print
```

Expected locations include:

- `/Applications/Icon Composer.app`
- `/Applications/Xcode.app/Contents/Applications/Icon Composer.app`

Do not continue until full Xcode, `xcodebuild`, `actool`, and Icon Composer are all present.

## Apple Mechanism

Apple's Icon Composer creates a single multilayer `.icon` file. Xcode uses that source at build time so the system can render platform-appropriate icons. For platforms or OS versions without the same Liquid Glass rendering, Xcode generates compatible older representations from the `.icon` source.

For a non-Xcode Tauri app, the supported command-line integration point is Xcode's `actool`:

```bash
xcrun actool src-tauri/icon-composer/Scribe.icon \
  --compile src-tauri/target/modern-macos-icon \
  --app-icon Scribe \
  --output-format xml1 \
  --notices \
  --warnings \
  --errors \
  --include-all-app-icons \
  --enable-on-demand-resources NO \
  --development-region en \
  --target-device mac \
  --platform macosx \
  --minimum-deployment-target 13.0 \
  --output-partial-info-plist src-tauri/target/modern-macos-icon/assetcatalog-generated-info.plist
```

Expected outputs:

- `Assets.car`: authoritative macOS 26 app icon asset archive.
- `Scribe.icns`: Apple-generated legacy fallback for older macOS.
- `assetcatalog-generated-info.plist`: generated metadata; for Scribe the important app bundle key is `CFBundleIconName = Scribe`.

## Tauri Integration Strategy

The correct production sequence is:

1. Build or update `src-tauri/icon-composer/Scribe.icon` in Icon Composer from approved Scribe artwork.
2. Run `node scripts/compile-modern-macos-icon.mjs` on macOS 26 with full Xcode 26+.
3. Ensure the app bundle receives:
   - `Contents/Resources/Assets.car`
   - `Contents/Resources/icon.icns` from the generated `Scribe.icns`
   - `Info.plist` with `CFBundleIconFile = icon.icns`
   - `Info.plist` with `CFBundleIconName = Scribe`
4. Perform this before final app signing, updater archive signing, and DMG packaging.

Never patch the bundle after final signing.

## Creating `Scribe.icon` on macOS 26

Create the real Icon Composer file here:

```text
src-tauri/icon-composer/Scribe.icon
```

Use the currently approved Scribe artwork as the design source. Do not redesign the logo. The working canvas should be `1024 x 1024`.

Preferred layer structure:

1. `01-background`: approved base/background material.
2. `02-symbol`: approved Scribe waveform/mic symbol.
3. `03-highlight`: optional, only if needed to preserve approved internal highlight/depth.

Do not bake the final macOS rounded-square mask, Dock mask, external system shadow, or fake Liquid Glass effects into the imported artwork. Let Icon Composer and macOS apply the final system rendering.

If the current flattened icon cannot be cleanly separated, use the most faithful source artwork available, but document that limitation in the release notes for the pipeline work. Do not hand-generate `Assets.car`.

## Second Mac Test Build Sequence

After `Scribe.icon` exists on the macOS 26 machine:

```bash
npm ci
npm run icon:macos:verify-toolchain
npm run icon:macos:compile
npm run tauri build -- --target aarch64-apple-darwin --bundles app
node scripts/apply-modern-macos-icon-to-app.mjs \
  --app=/path/to/Scribe.app \
  --compiled=src-tauri/target/modern-macos-icon
```

The apply step must happen before final signing, updater archive creation, and DMG packaging. For a local test-only DMG, use the existing deterministic DMG layout/background and name the artifact clearly, for example:

```text
Scribe-0.1.17-IconComposer-test.dmg
```

Verify:

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' Scribe.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' Scribe.app/Contents/Info.plist
test -f Scribe.app/Contents/Resources/Assets.car
test -f Scribe.app/Contents/Resources/icon.icns
```

## CI Recommendation

Use GitHub Actions `macos-26` / arm64 with Xcode 26 pinned or explicitly selected, then fail loudly if:

- `src-tauri/icon-composer/Scribe.icon` is missing
- `xcrun actool` is unavailable
- `Assets.car` is not produced
- `Scribe.icns` is not produced

The current release workflow still uses `macos-15`; that runner cannot be the final professional Icon Composer compiler.

## Legacy Behavior

Keep `icon.icns` for older macOS. Once compiled by Xcode 26, this should be the generated legacy fallback from `Scribe.icon`, not a hand-scaled canvas hack. Exact old visual parity with the pre-Icon-Composer `.icns` is not guaranteed; platform-correct output is preferred.
