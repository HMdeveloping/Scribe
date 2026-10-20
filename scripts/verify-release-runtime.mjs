import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!target || !["aarch64-apple-darwin", "x86_64-pc-windows-msvc"].includes(target)) {
  throw new Error("Usage: node scripts/verify-release-runtime.mjs <aarch64-apple-darwin|x86_64-pc-windows-msvc>");
}

const dir = path.join("src-tauri", "resources", "bin", target);
const windows = target.includes("windows");
const required = windows
  ? ["ffmpeg.exe", "ffprobe.exe", "whisper-cli.exe"]
  : ["ffmpeg", "ffprobe", "whisper-cli"];
const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
const fail = (message) => { throw new Error(`Runtime portability gate failed: ${message}`); };

for (const name of required) {
  if (!fs.existsSync(path.join(dir, name))) fail(`missing ${name}`);
}

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
for (const name of required.filter((file) => file.startsWith("ff"))) {
  const output = run(path.join(dir, name), ["-version"]);
  if (/--enable-nonfree/i.test(output)) fail(`${name} enables nonfree components`);
}

if (!windows) {
  const machos = files.filter((file) => !file.endsWith(".DS_Store"));
  const dylibs = files.filter((file) => file.endsWith(".dylib"));
  if (!dylibs.some((file) => path.basename(file).startsWith("libwhisper"))) fail("libwhisper dylib is missing");
  if (!dylibs.some((file) => path.basename(file).startsWith("libggml"))) fail("libggml dylibs are missing");
  for (const file of machos) {
    const kind = run("file", [file]);
    if (!kind.includes("Mach-O") || !kind.includes("arm64")) fail(`${file} is not ARM64 Mach-O`);
    const loads = run("otool", ["-l", file]);
    const minos = [...loads.matchAll(/\bminos\s+(\d+\.\d+)/g)].map((match) => match[1]);
    if (minos.length && minos.some((version) => Number(version.split(".")[0]) > 11)) fail(`${file} requires macOS newer than 11`);
    if (/\/(?:Users|tmp|opt\/homebrew|usr\/local)\//.test(loads)) fail(`${file} contains a developer or package-manager path`);
    for (const match of loads.matchAll(/path\s+([^\s]+)\s+\(offset/g)) {
      if (!match[1].startsWith("@loader_path") && !match[1].startsWith("@executable_path")) fail(`${file} has nonrelative RPATH ${match[1]}`);
    }
    const linked = run("otool", ["-L", file]);
    for (const match of linked.matchAll(/^\s+(@rpath\/[^\s]+)\s+\(/gm)) {
      const library = path.join(dir, path.basename(match[1]));
      if (!fs.existsSync(library)) fail(`${file} needs missing bundled library ${match[1]}`);
    }
    if (/\/(?:opt\/homebrew|usr\/local)\//.test(linked)) fail(`${file} links to an external package-manager library`);
  }
  const whisperVersion = run(path.join(dir, "whisper-cli"), ["--help"]);
  if (/1\.9\.4-dev/.test(whisperVersion)) fail("known unpinned whisper.cpp 1.9.4-dev binary detected");
} else {
  const allBinaries = files.filter((file) => /\.(exe|dll)$/i.test(file));
  if (!allBinaries.some((file) => /ggml\.dll$/i.test(file))) fail("ggml.dll missing");
  if (!allBinaries.some((file) => /ggml-cpu-x64\.dll$/i.test(file))) fail("portable generic x64 CPU backend missing");
  if (!allBinaries.some((file) => /ggml-cpu-(sse42|haswell)\.dll$/i.test(file))) fail("runtime-dispatched optimized CPU backend missing");
  if (allBinaries.filter((file) => /\.dll$/i.test(file)).length < 2) fail("Whisper DLL closure is incomplete");
  for (const file of allBinaries) {
    const buffer = fs.readFileSync(file);
    if (buffer.toString("ascii", 0, 2) !== "MZ") fail(`${file} is not a PE binary`);
    const peOffset = buffer.readUInt32LE(0x3c);
    if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0" || buffer.readUInt16LE(peOffset + 4) !== 0x8664) {
      fail(`${file} is not Windows x64`);
    }
  }
}

console.log(`Runtime portability checks passed for ${target} (${files.length} bundled files).`);
