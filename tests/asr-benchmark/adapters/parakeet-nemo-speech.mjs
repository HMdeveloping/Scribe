#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const nemoSpeech = process.env.SCRIBE_ASR_NEMO_SPEECH_BIN || path.join(home, "Library/Application Support/NeMoSpeech/bin/nemo-speech");
const modelPath = process.env.SCRIBE_ASR_PARAKEET_MODEL || path.join(home, "Scribe-ASR-Benchmark/models/parakeet/parakeet-tdt-0.6b-v3.q8_0.gguf");

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function toWav(input, tempDir) {
  if (path.extname(input).toLowerCase() === ".wav") return input;
  const wav = path.join(tempDir, "input.wav");
  await run(process.env.SCRIBE_ASR_FFMPEG || "ffmpeg", [
    "-y", "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", "-sample_fmt", "s16", wav,
  ]);
  return wav;
}

function collectText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "transcript", "transcription", "output"]) {
    if (typeof value[key] === "string") return value[key];
  }
  if (Array.isArray(value.segments)) {
    return value.segments.map((segment) => collectText(segment)).filter(Boolean).join(" ");
  }
  if (Array.isArray(value.results)) {
    return value.results.map((item) => collectText(item)).filter(Boolean).join(" ");
  }
  return "";
}

function collectSegments(value) {
  const source = Array.isArray(value?.segments)
    ? value.segments
    : Array.isArray(value?.results)
      ? value.results.flatMap((item) => Array.isArray(item?.segments) ? item.segments : [])
      : [];
  return source.map((segment) => ({
    start: Number(segment.start ?? segment.start_time ?? segment.begin ?? 0),
    end: Number(segment.end ?? segment.end_time ?? 0),
    text: collectText(segment),
  })).filter((segment) => segment.text);
}

async function main() {
  const args = process.argv.slice(2);
  const audio = argValue(args, "--audio");
  const language = argValue(args, "--language");
  const output = argValue(args, "--output");
  if (!existsSync(nemoSpeech)) throw new Error(`Missing nemo-speech: ${nemoSpeech}`);
  if (!existsSync(modelPath)) throw new Error(`Missing Parakeet model: ${modelPath}`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "scribe-parakeet-"));
  try {
    const wav = await toWav(audio, tempDir);
    const nemoOutput = path.join(tempDir, "parakeet.json");
    const transcribeArgs = [
      "--json",
      "transcribe",
      wav,
      "--model",
      modelPath,
      "--language",
      language,
      "--backend",
      "metal",
      "--format",
      "json",
      "--output",
      nemoOutput,
      "--force",
    ];
    try {
      await run(nemoSpeech, transcribeArgs);
    } catch (error) {
      const cpuArgs = [...transcribeArgs];
      const backendIndex = cpuArgs.indexOf("--backend");
      if (backendIndex !== -1) cpuArgs[backendIndex + 1] = "cpu";
      await run(nemoSpeech, cpuArgs);
    }
    const rawText = await readFile(nemoOutput, "utf8");
    const parsed = JSON.parse(rawText);
    const segments = collectSegments(parsed);
    const text = collectText(parsed) || segments.map((segment) => segment.text).join(" ");
    const modelSizeBytes = (await stat(modelPath)).size;
    await writeFile(output, `${JSON.stringify({ text, segments, modelSizeBytes }, null, 2)}\n`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
