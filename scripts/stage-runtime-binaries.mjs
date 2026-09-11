import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: node scripts/stage-runtime-binaries.mjs <target-triple>");
}

const isWindows = target.includes("windows");
const root = process.cwd();
const outputDir = path.join(root, "src-tauri", "resources", "bin", target);
const inputs = [
  ["FFMPEG_PATH", isWindows ? "ffmpeg.exe" : "ffmpeg"],
  ["FFPROBE_PATH", isWindows ? "ffprobe.exe" : "ffprobe"],
  ["WHISPER_CLI_PATH", isWindows ? "whisper-cli.exe" : "whisper-cli"],
];

function macosRpaths(binary) {
  const loadCommands = execFileSync("otool", ["-l", binary], { encoding: "utf8" });
  const rpaths = [];
  let inRpathCommand = false;
  for (const line of loadCommands.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "cmd LC_RPATH") {
      inRpathCommand = true;
      continue;
    }
    if (inRpathCommand && trimmed.startsWith("path ")) {
      rpaths.push(trimmed.split(" ")[1]);
      inRpathCommand = false;
    }
  }
  return rpaths;
}

for (const [envName, outputName] of inputs) {
  const source = process.env[envName];
  if (!source) {
    throw new Error(`${envName} is required`);
  }
  if (!fs.existsSync(source)) {
    throw new Error(`${envName} does not exist: ${source}`);
  }
}

for (const envName of ["FFMPEG_PATH", "FFPROBE_PATH"]) {
  const source = process.env[envName];
  const version = execFileSync(source, ["-version"], { encoding: "utf8" });
  if (version.includes("--enable-nonfree")) {
    throw new Error(`${envName} was built with --enable-nonfree and cannot be redistributed by Scribe`);
  }
}

if (!isWindows) {
  for (const envName of ["FFMPEG_PATH", "FFPROBE_PATH"]) {
    const source = process.env[envName];
    const linkedLibraries = execFileSync("otool", ["-L", source], { encoding: "utf8" });
    const externalHomebrewDeps = linkedLibraries
      .split("\n")
      .map((line) => line.trim().split(" ")[0])
      .filter((library) => library.startsWith("/opt/homebrew/") || library.startsWith("/usr/local/"));
    if (externalHomebrewDeps.length > 0) {
      throw new Error(`${envName} is not portable; it links external libraries:\n${externalHomebrewDeps.join("\n")}`);
    }
  }

  const whisperCli = process.env.WHISPER_CLI_PATH;
  const whisperDir = path.dirname(whisperCli);
  const whisperLibraries = execFileSync("otool", ["-L", whisperCli], { encoding: "utf8" });
  const requiredWhisperLibraries = whisperLibraries
    .split("\n")
    .map((line) => line.trim().split(" ")[0])
    .filter((library) => library.startsWith("@rpath/"))
    .map((library) => library.replace("@rpath/", ""));
  for (const libraryName of requiredWhisperLibraries) {
    const source = path.join(whisperDir, libraryName);
    if (!fs.existsSync(source)) {
      throw new Error(`Required whisper runtime library is missing: ${source}`);
    }
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const [envName, outputName] of inputs) {
  const source = process.env[envName];
  const destination = path.join(outputDir, outputName);
  fs.copyFileSync(source, destination);
  if (!isWindows) {
    fs.chmodSync(destination, 0o755);
  }
  console.log(`staged ${outputName} from ${source}`);
}

if (!isWindows) {
  const whisperCli = process.env.WHISPER_CLI_PATH;
  const whisperDir = path.dirname(whisperCli);
  const whisperLibraries = execFileSync("otool", ["-L", whisperCli], { encoding: "utf8" });
  const requiredWhisperLibraries = whisperLibraries
    .split("\n")
    .map((line) => line.trim().split(" ")[0])
    .filter((library) => library.startsWith("@rpath/"))
    .map((library) => library.replace("@rpath/", ""));
  for (const libraryName of requiredWhisperLibraries) {
    const source = path.join(whisperDir, libraryName);
    if (!fs.existsSync(source)) {
      throw new Error(`Required whisper runtime library is missing: ${source}`);
    }
    const destination = path.join(outputDir, libraryName);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o755);
    console.log(`staged ${libraryName} from ${source}`);
  }

  const stagedWhisperCli = path.join(outputDir, "whisper-cli");
  for (const rpath of macosRpaths(stagedWhisperCli)) {
    execFileSync("install_name_tool", ["-delete_rpath", rpath, stagedWhisperCli]);
  }
  execFileSync("install_name_tool", ["-add_rpath", "@executable_path", stagedWhisperCli]);
}

console.log(`runtime binaries staged in ${path.relative(root, outputDir)}`);
