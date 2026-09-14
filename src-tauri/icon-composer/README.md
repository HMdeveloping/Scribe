# Scribe Icon Composer Source

This directory is reserved for the canonical Apple Icon Composer source:

```text
src-tauri/icon-composer/Scribe.icon
```

`Scribe.icon` must be created with Apple's Icon Composer on macOS 26 / Xcode 26 or newer. The current development Mac only has Command Line Tools on macOS 15, so it cannot create or compile the `.icon` source locally.

The source must use the approved Scribe artwork and must not bake the final macOS rounded-square mask, Dock mask, external system shadow, or Liquid Glass effects into exported artwork. Icon Composer and macOS are responsible for the final platform rendering.

Expected layer plan:

- `01-background`: approved Scribe background/color material, without a baked final system mask.
- `02-symbol`: approved blue/cyan/violet Scribe mark.
- `03-highlight`: only if needed to preserve existing approved internal highlight/depth, not a system shadow.

Once `Scribe.icon` exists, compile it with:

```bash
node scripts/verify-modern-macos-icon-toolchain.mjs
node scripts/compile-modern-macos-icon.mjs
```

The compile step must produce:

- `Assets.car` for macOS 26 Liquid Glass/system-rendered icons.
- `Scribe.icns` as the Apple-generated legacy fallback for older macOS.

Do not commit Apple developer tools or SDK binaries. Committing the `.icon` source and generated app resources is allowed only if they are project assets generated from Scribe artwork.
