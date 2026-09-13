import { mkdtemp, readFile, rm, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname, "..");
export const realAppDataFragment = path.join("Library", "Application Support", "com.scribeapp.app");

export function logStep(message) {
  console.log(`[stability] ${message}`);
}

export async function makeHarnessDir(label) {
  const dir = await mkdtemp(path.join(tmpdir(), `scribe-${label}-`));
  assertDisposablePath(dir);
  return dir;
}

export function assertDisposablePath(targetPath) {
  const normalized = path.resolve(targetPath);
  if (!normalized.startsWith(path.resolve(tmpdir()) + path.sep)) {
    throw new Error(`Refusing to use non-temporary stability path: ${normalized}`);
  }
  if (normalized.includes(realAppDataFragment)) {
    throw new Error(`Refusing to touch real Scribe app data: ${normalized}`);
  }
}

export async function cleanupHarnessDir(dir) {
  assertDisposablePath(dir);
  await rm(dir, { recursive: true, force: true });
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function uniqueId(prefix, iteration) {
  return `${prefix}-${String(iteration).padStart(4, "0")}-0000-4000-8000-${String(iteration).padStart(12, "0")}`;
}

export function assertUniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    assert(typeof item.id === "string" && item.id.length > 0, `${label} contains item without id`);
    assert(!ids.has(item.id), `${label} contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
}

export function assertLibraryIntegrity(state) {
  assert(Array.isArray(state.projects), "projects must be an array");
  assert(Array.isArray(state.recordings), "recordings must be an array");
  assert(Array.isArray(state.transcripts), "transcripts must be an array");
  assertUniqueIds(state.projects, "projects");
  assertUniqueIds(state.recordings, "recordings");

  const projectIds = new Set(state.projects.map((project) => project.id));
  const recordingIds = new Set(state.recordings.map((recording) => recording.id));
  for (const recording of state.recordings) {
    assert(!recording.projectId || projectIds.has(recording.projectId), `recording ${recording.id} references missing project`);
    assert(typeof recording.archived === "boolean", `recording ${recording.id} has invalid archive state`);
  }
  for (const transcript of state.transcripts) {
    assert(recordingIds.has(transcript.recordingId), `transcript references missing recording ${transcript.recordingId}`);
    assert(typeof transcript.text === "string", `transcript ${transcript.recordingId} missing text`);
  }
}

export function defaultSettings() {
  return {
    version: 1,
    whisperModel: "large-v3-turbo",
    transcriptionLanguage: "sl",
    language: "sl",
    appLanguage: "en",
    onboardingCompleted: true,
    lastSeenWhatsNewVersion: "0.1.13"
  };
}

export function createEmptyState() {
  return {
    settings: defaultSettings(),
    projects: [],
    recordings: [],
    transcripts: []
  };
}

export async function saveState(appDataDir, state) {
  assertDisposablePath(appDataDir);
  assertLibraryIntegrity(state);
  await writeJson(path.join(appDataDir, "state.json"), state);
}

export async function loadState(appDataDir) {
  assertDisposablePath(appDataDir);
  const state = await readJson(path.join(appDataDir, "state.json"));
  assertLibraryIntegrity(state);
  return state;
}

export async function seedState(appDataDir) {
  const transcript = await readJson(path.join(repoRoot, "tests/stability/fixtures/transcript.fixture.json"));
  const state = createEmptyState();
  const project = { id: uniqueId("project", 1), name: "Stability Project", archived: false };
  const recording = {
    id: uniqueId("recording", 1),
    projectId: project.id,
    title: "Stability Recording",
    durationSeconds: 4,
    language: "sl",
    archived: false,
    audioFile: "audio.fixture.webm"
  };
  state.projects.push(project);
  state.recordings.push(recording);
  state.transcripts.push({ recordingId: recording.id, ...transcript });
  await saveState(appDataDir, state);
  return state;
}

export async function assertNoPrivateArtifacts(rootDir) {
  const entries = await walk(rootDir);
  for (const entry of entries) {
    assert(!entry.includes(realAppDataFragment), `private app data path leaked into artifacts: ${entry}`);
  }
}

async function walk(rootDir) {
  if (!existsSync(rootDir)) return [];
  const result = [];
  async function visit(current) {
    result.push(current);
    const currentStat = await stat(current);
    if (!currentStat.isDirectory()) return;
    for (const entry of await readdir(current)) {
      await visit(path.join(current, entry));
    }
  }
  await visit(rootDir);
  return result;
}

export async function runCommand(command, args, options = {}) {
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
  return Date.now() - started;
}
