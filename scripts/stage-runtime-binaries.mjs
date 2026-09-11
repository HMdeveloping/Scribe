import fs from "node:fs";
import path from "node:path";

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

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const [envName, outputName] of inputs) {
  const source = process.env[envName];
  if (!source) {
    throw new Error(`${envName} is required`);
  }
  if (!fs.existsSync(source)) {
    throw new Error(`${envName} does not exist: ${source}`);
  }
  const destination = path.join(outputDir, outputName);
  fs.copyFileSync(source, destination);
  if (!isWindows) {
    fs.chmodSync(destination, 0o755);
  }
  console.log(`staged ${outputName} from ${source}`);
}
