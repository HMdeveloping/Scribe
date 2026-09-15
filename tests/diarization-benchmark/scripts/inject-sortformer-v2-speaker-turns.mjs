import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const appDataDir = path.join(os.homedir(), "Library", "Application Support", "com.scribeapp.app");
const recordingsDir = path.join(appDataDir, "recordings");
const privateAudioPath = path.join(os.homedir(), "Scribe-ASR-Benchmark", "repetition-cases", "Jambrekovo predavanje 1.m4a");
const sortformerResultPath = path.join(repoRoot, "tests", "diarization-benchmark", "results", "latest", "sortformer-v2-full.json");

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function findRecording() {
  const expectedHash = await sha256(privateAudioPath);
  const entries = await readdir(recordingsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(recordingsDir, entry.name);
    const metadataPath = path.join(dir, "recording.json");
    const transcriptPath = path.join(dir, "transcript.json");
    if (!existsSync(metadataPath) || !existsSync(transcriptPath)) continue;
    const metadata = await readJson(metadataPath);
    const audioPath = path.join(dir, metadata.audioFile ?? "");
    if (!existsSync(audioPath)) continue;
    const audioStats = await stat(audioPath);
    const durationDelta = Math.abs(Number(metadata.durationSeconds ?? 0) - 1423.744);
    const title = String(metadata.title ?? "");
    if (durationDelta < 2 || title.includes("Jambrekovo")) {
      candidates.push({ dir, metadata, transcriptPath, audioPath, audioStats });
    }
  }

  for (const candidate of candidates) {
    if (await sha256(candidate.audioPath) === expectedHash) return candidate;
  }
  return null;
}

const result = await readJson(sortformerResultPath);
const speakerTurns = (result.speakerTurns ?? [])
  .map((turn) => ({
    start: Number(turn.start),
    end: Number(turn.end),
    speaker: String(turn.speaker),
  }))
  .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start && turn.speaker.length > 0);

if (speakerTurns.length === 0) {
  throw new Error(`No speakerTurns found in ${sortformerResultPath}`);
}

const recording = await findRecording();
if (!recording) {
  console.error("No matching Scribe recording found for the private lecture.");
  console.error("Import the M4A into Scribe first, then rerun this script.");
  process.exit(2);
}

const transcript = await readJson(recording.transcriptPath);
const backupPath = `${recording.transcriptPath}.bak-sortformer-v2-${new Date().toISOString().replace(/[:.]/g, "-")}`;
await copyFile(recording.transcriptPath, backupPath);

const beforeText = JSON.stringify({ text: transcript.text, segments: transcript.segments });
transcript.speakerTurns = speakerTurns;
const afterText = JSON.stringify({ text: transcript.text, segments: transcript.segments });
if (beforeText !== afterText) {
  throw new Error("Refusing to write: transcript text or segments changed during injection.");
}

await writeFile(recording.transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  recordingId: recording.metadata.id,
  recordingDir: recording.dir,
  transcriptPath: recording.transcriptPath,
  backupPath,
  speakerTurns: speakerTurns.length,
}, null, 2));
