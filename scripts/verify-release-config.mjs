import fs from "node:fs";

const workflows = [
  ".github/workflows/release.yml",
  ".github/workflows/windows-test-build.yml",
  ".github/workflows/windows-release-diagnostic.yml",
  ".github/workflows/windows-store-msix-build.yml",
];
const errors = [];
const expectedWhisperCommit = "a8d002cfd879315632a579e73f0148d06959de36";
for (const file of workflows) {
  const content = fs.readFileSync(file, "utf8");
  if (!/WHISPER_CPP_REF:\s*v1\.7\.6/.test(content)) errors.push(`${file}: whisper.cpp must be pinned to v1.7.6`);
  if (!content.includes(expectedWhisperCommit)) errors.push(`${file}: whisper.cpp tag must resolve to reviewed commit ${expectedWhisperCommit}`);
  if (!content.includes("rev-parse HEAD")) errors.push(`${file}: cloned whisper.cpp commit must be verified before building`);
  const cmakeLines = content.split(/\r?\n/).filter((line) => /cmake\s+-S .*whisper\.cpp/.test(line));
  if (cmakeLines.length === 0) errors.push(`${file}: no whisper.cpp CMake configure command found`);
  for (const line of cmakeLines) {
    if (!line.includes("-DGGML_NATIVE=OFF")) errors.push(`${file}: whisper.cpp configure must disable machine-specific GGML_NATIVE tuning`);
    if (file !== workflows[0] && (!line.includes("-DGGML_CPU_ALL_VARIANTS=ON") || !line.includes("-DGGML_BACKEND_DL=ON") || !line.includes("-DBUILD_SHARED_LIBS=ON"))) {
      errors.push(`${file}: Windows must build runtime-dispatched CPU variants`);
    }
  }
}
const macRelease = fs.readFileSync(workflows[0], "utf8");
for (const flag of ["-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0", "-DGGML_CPU_ARM_ARCH=armv8-a", "-DGGML_METAL=ON"]) {
  if (!macRelease.includes(flag)) errors.push(`${workflows[0]}: missing required macOS setting ${flag}`);
}
const ffmpegHash = "602a1b4f1aaf6d2344cba2ffd44dd3ccc9cf0ba956f7b63baa3e9e4871af9452";
for (const file of workflows) {
  const content = fs.readFileSync(file, "utf8");
  if (content.includes("ffmpeg-n8.1-latest-win64-lgpl-8.1.zip") && !content.includes(ffmpegHash)) {
    errors.push(`${file}: pinned Windows FFmpeg SHA-256 check is missing`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Release configuration checks passed: pinned Whisper, portable CPU configuration, and fixed Windows FFmpeg artifact.");
}
