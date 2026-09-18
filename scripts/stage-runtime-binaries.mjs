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

function linkedLibraries(binary) {
  return execFileSync("otool", ["-L", binary], { encoding: "utf8" })
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

function requiredRpathLibraries(binary) {
  return linkedLibraries(binary)
    .filter((library) => library.startsWith("@rpath/"))
    .map((library) => library.replace("@rpath/", ""));
}

function unique(values) {
  return [...new Set(values)];
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(entryPath);
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      return [entryPath];
    }
    return [];
  });
}

function findWhisperBuildDir(whisperCli) {
  if (process.env.WHISPER_BUILD_DIR) {
    return process.env.WHISPER_BUILD_DIR;
  }

  let currentDir = path.dirname(whisperCli);
  while (currentDir !== path.dirname(currentDir)) {
    if (path.basename(currentDir) === "build") {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return path.dirname(whisperCli);
}

function whisperLibrarySearchDirs(whisperCli) {
  const buildDir = findWhisperBuildDir(whisperCli);
  return unique([
    path.dirname(whisperCli),
    path.join(buildDir, "bin"),
    path.join(buildDir, "src"),
    path.join(buildDir, "ggml", "src"),
    path.join(buildDir, "ggml", "src", "ggml-cpu"),
    path.join(buildDir, "ggml", "src", "ggml-blas"),
    path.join(buildDir, "ggml", "src", "ggml-metal"),
    ...walkFiles(buildDir)
      .filter((file) => path.basename(file).startsWith("libwhisper") || path.basename(file).startsWith("libggml"))
      .map((file) => path.dirname(file)),
  ]);
}

function resolveWhisperLibrary(libraryName, searchDirs) {
  const candidates = unique(searchDirs.map((dir) => path.join(dir, libraryName)));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveRequiredWhisperLibraries(whisperCli) {
  const searchDirs = whisperLibrarySearchDirs(whisperCli);
  const pending = requiredRpathLibraries(whisperCli);
  const resolved = new Map();

  while (pending.length > 0) {
    const libraryName = pending.shift();
    if (resolved.has(libraryName)) {
      continue;
    }

    const source = resolveWhisperLibrary(libraryName, searchDirs);
    if (!source) {
      throw new Error(
        `Required whisper runtime library is missing: ${libraryName}\n` +
          `Searched:\n${searchDirs.join("\n")}`,
      );
    }

    resolved.set(libraryName, source);
    pending.push(...requiredRpathLibraries(source));
  }

  return [...resolved.entries()].map(([libraryName, source]) => ({ libraryName, source }));
}

function assertMacosArm64(binary) {
  const description = execFileSync("file", [binary], { encoding: "utf8" });
  if (!description.includes("Mach-O") || !description.includes("arm64")) {
    throw new Error(`${binary} is not an arm64 Mach-O binary:\n${description}`);
  }
}

function assertNoForbiddenMacosDeps(binary) {
  const externalHomebrewDeps = linkedLibraries(binary).filter(
    (library) => library.startsWith("/opt/homebrew/") || library.startsWith("/usr/local/"),
  );
  if (externalHomebrewDeps.length > 0) {
    throw new Error(`${binary} is not portable; it links external libraries:\n${externalHomebrewDeps.join("\n")}`);
  }
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

function windowsWhisperDlls(whisperCli) {
  const buildDir = findWhisperBuildDir(whisperCli);
  return walkFiles(buildDir)
    .filter((file) => path.extname(file).toLowerCase() === ".dll")
    .filter((file) => {
      const name = path.basename(file).toLowerCase();
      return name === "ggml.dll" || name.startsWith("ggml-") || name === "whisper.dll";
    });
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
    assertNoForbiddenMacosDeps(process.env[envName]);
  }

  const whisperCli = process.env.WHISPER_CLI_PATH;
  const requiredWhisperLibraries = resolveRequiredWhisperLibraries(whisperCli);
  const requiredNames = requiredWhisperLibraries.map(({ libraryName }) => libraryName);
  if (!requiredNames.some((libraryName) => libraryName.startsWith("libwhisper"))) {
    throw new Error(`whisper-cli does not link a required libwhisper dylib:\n${linkedLibraries(whisperCli).join("\n")}`);
  }
  if (!requiredNames.some((libraryName) => libraryName.startsWith("libggml"))) {
    throw new Error(`whisper-cli does not link required libggml dylibs:\n${linkedLibraries(whisperCli).join("\n")}`);
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
  const requiredWhisperLibraries = resolveRequiredWhisperLibraries(whisperCli);
  for (const { libraryName, source } of requiredWhisperLibraries) {
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

  for (const stagedBinary of fs.readdirSync(outputDir).map((entry) => path.join(outputDir, entry))) {
    assertMacosArm64(stagedBinary);
    assertNoForbiddenMacosDeps(stagedBinary);
  }
} else {
  const whisperCli = process.env.WHISPER_CLI_PATH;
  const whisperDlls = unique(windowsWhisperDlls(whisperCli));
  const stagedNames = new Set();
  for (const source of whisperDlls) {
    const destination = path.join(outputDir, path.basename(source));
    fs.copyFileSync(source, destination);
    if (fs.statSync(destination).size === 0) {
      throw new Error(`Staged Windows whisper DLL is empty: ${destination}`);
    }
    stagedNames.add(path.basename(source).toLowerCase());
    console.log(`staged ${path.basename(source)} from ${source}`);
  }

  if (!stagedNames.has("ggml.dll")) {
    throw new Error(
      `Required Windows whisper runtime DLL is missing: ggml.dll\n` +
        `Searched beneath: ${findWhisperBuildDir(whisperCli)}`,
    );
  }
}

console.log(`runtime binaries staged in ${path.relative(root, outputDir)}`);
