# Scribe compatibility policy (v1.0.1 candidate)

This matrix describes release intent and current evidence. A successful CI build
checks packaging properties; it does not prove behavior on every physical
computer. Only platforms marked tested have hardware GUI evidence.

## Support matrix

| Platform | Status | Evidence and limits |
| --- | --- | --- |
| macOS 11+ Apple Silicon (ARM64), M3 | Supported, tested on earlier packaged candidate | Owner reports microphone transcription and audio import passed on an earlier candidate. Exact OS version and Turbo/long-recording details were not recorded; the production-clean candidate still needs testing. |
| macOS 11+ Apple Silicon (ARM64), M4 | Supported, user-reported test | Owner reports transcription pass. Exact package, workflow and OS version are not recorded. |
| macOS 11+ Apple Silicon (ARM64), M1 | Experimental; partial candidate validation reported | Owner reports Turbo transcription and imported-audio transcription on one M1. On a second M1 with intermittent microphone disconnections, multiple consecutive recordings passed on the microphone-recovery diagnostic candidate. The production-clean candidate still needs real-M1 validation. |
| macOS 11+ Apple Silicon (ARM64), M2 | Supported by build target, not directly tested | ARMv8-A candidate has no direct M2 hardware run. |
| Intel Mac | Unsupported | No x86_64 macOS release binary or validation. |
| Windows 10 x64 | Experimental | Release target is x86_64 MSVC, but no Windows 10 GUI run is recorded. The tested Windows PC's OS version is unknown. |
| Windows 11 x64 | Supported by target, hardware details unknown | Owner reports transcription passed on one Windows x64 PC. OS version, CPU vendor and exact workflow were not recorded; the production-clean installer still needs testing. |
| Windows x64 Intel processors | Supported, not directly tested | Release runtime includes generic x64 and runtime-dispatched CPU variants; no Intel hardware run is recorded. |
| Windows x64 AMD processors | Supported, not directly tested | Same x64 package and runtime dispatch; no AMD hardware run is recorded. |
| Windows ARM64 | Unsupported | No ARM64 Windows package or validation. |
| Windows x64 CPU inference | Supported by runtime design, hardware coverage pending | Whisper builds generic x64 and runtime-selected optimized CPU backends; automatic CPU fallback has unit coverage, but no matrix hardware run is recorded. Vulkan is optional. |
| 8 GB RAM / low-memory systems | Experimental | No representative peak-memory measurements are available. Large models may compete with the OS and other applications for memory. |

“Supported” means an intended release target, not a universal guarantee. Tauri's
platform table lists Windows 10 and above; this app's Windows 10 build coverage
is still experimental. [Tauri platform support](https://github.com/tauri-apps/tauri#platforms)

## Bundled runtime policy

- whisper.cpp is pinned to tag `v1.7.6` in release workflows.
- macOS packages target ARM64, `armv8-a`, macOS 11.0, with `GGML_NATIVE=OFF`; Metal is optional and `-ng` selects CPU inference.
- macOS runtime validation rejects missing bundled dylibs, non-ARM64 files, deployment targets above 11, developer/Homebrew paths and nonrelative RPATHs.
- Windows release builds target x64 and explicitly use `GGML_NATIVE=OFF`, `GGML_BACKEND_DL=ON` and `GGML_CPU_ALL_VARIANTS=ON`. This packages a generic x64 backend plus optimized CPU variants selected at runtime. Vulkan is optional; CPU inference remains available.
- Windows FFmpeg is an LGPL n8.1 archive. Its URL is on BtbN's moving `latest` release, but its SHA-256 is pinned to `602a1b4f1aaf6d2344cba2ffd44dd3ccc9cf0ba956f7b63baa3e9e4871af9452`; if upstream changes the asset, the CI gate stops until the reviewed digest is updated.
- Runtime gates verify required executables and libraries, architecture, Whisper runtime presence and nonfree FFmpeg flags. Packaging and hardware transcription remain separate checks.

## Memory and performance

The application model catalog currently includes `large-v3-turbo` (expected
download size 1,624,555,275 bytes) and `large-v3` (3,095,033,483 bytes). These
are on-disk sizes, not RAM requirements. This repository has no trustworthy
peak-memory measurements for M1 8 GB, Windows x64 8 GB, long recordings or
concurrent system load, so it makes no RAM/performance guarantee. Until those
measurements exist, use Turbo as the default, close memory-heavy applications
on 8 GB systems, and treat Large v3 on those devices as experimental. Processing
remains local/offline after model download.

The current backend processes chunks sequentially within one transcription,
but accepts separate transcription requests and has no global memory-based
concurrency cap. Safe simultaneous-run limits are therefore unknown and must be
measured before endorsing concurrent transcriptions on 8 GB devices.

## Release validation matrix

Record device model, OS version/build, CPU vendor/core family, RAM, app/runtime
hashes, model ID/hash, input duration/format, selected backend, result and peak
memory. Use non-private speech samples.

| Device class | Fresh install / model download | Mic | WAV + MP3 import | Turbo | Retry after recoverable error | Offline | Long recording |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M1, 8 GB | Required | Required | Required | Required | Required | Required | Required |
| M1, 16 GB | Required | Required | Required | Required | Required | Required | Required |
| M2, 8/16 GB | Required | Required | Required | Required | Required | Required | Required |
| M3, 8/16 GB | Required | Existing M3 GUI pass; rerun after runtime change | Existing import pass; rerun after runtime change | Required | Required | Required | Required |
| M4, 8/16 GB | Required | Owner-reported pass; exact workflow not recorded | Required | Required | Required | Required | Required |
| Windows 10 x64, Intel, 8/16 GB | Required | Required | Required | Required | Required | Required | Required |
| Windows 10 x64, AMD, 8/16 GB | Required | Required | Required | Required | Required | Required | Required |
| Windows 11 x64, Intel, 8/16 GB | Required | Required | Required | Required | Required | Required | Required |
| Windows 11 x64, AMD, 8/16 GB | Required | Required | Required | Required | Required | Required | Required |

For Windows, repeat CPU-only on integrated/no-GPU systems and normal mode on a
Vulkan-capable GPU. CI results must not be recorded as hardware GUI passes.

## Current release gate

v1.0.1 remains **NO-GO** until the exact production-clean candidate passes GUI
microphone recording, WAV/MP3 import, normal Turbo inference, CPU inference on a
CPU-only system or verified GPU-to-CPU fallback, Retry after a recoverable
failure, offline use, and a long recording on a real M1. There is no user-facing
CPU-only diagnostic setting. Repeat the required microphone, import, Retry,
offline and long-recording checks on M3 and the final Windows x64 installer.
Preserve sanitized diagnostics if any item fails. Earlier diagnostic-candidate
results do not validate the production-clean candidate.

## 2026-10-20 M1 intermittent microphone interruption

The owner reports an intermittent microphone track termination on a second
M1. The UI had continued to show the recording timer while capture had ended.
The previous microphone error path cleared the stream, which caused the audio
recorder hook to tear down and erase buffered chunks. This explains the lost
partial recording and false-active UI. The low-level reason the WebView track
ends on that Mac remains unknown.

The local fix freezes the recording UI on capture error, retains the recorder
buffer until explicit save/discard, flushes and saves captured audio before a
new recording on Retry, reacquires a new default input stream, and ignores
events from stale tracks. It adds bounded, in-memory diagnostics that contain
event categories, timings, stream/track state, and byte/chunk counts only. It
does not capture audio, transcript text, device identifiers or labels. A
deterministic frontend lifecycle test passes. Owner-reported repeated recordings
on the affected M1 used the private microphone-recovery diagnostic candidate;
M3 microphone testing used an earlier packaged candidate. Neither result
validates the production-clean candidate. GUI Retry on the production-clean
candidate remains UNVERIFIED and the release is NO-GO.
