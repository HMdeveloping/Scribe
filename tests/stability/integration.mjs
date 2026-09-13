import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  assert,
  assertLibraryIntegrity,
  assertNoPrivateArtifacts,
  cleanupHarnessDir,
  defaultSettings,
  loadState,
  logStep,
  makeHarnessDir,
  repoRoot,
  saveState,
  seedState,
  uniqueId,
  writeJson
} from "./lib/harness.mjs";

const started = Date.now();
const appDataDir = await makeHarnessDir("integration");

try {
  logStep(`using disposable app data ${appDataDir}`);
  const seeded = await seedState(appDataDir);
  assertLibraryIntegrity(seeded);

  const state = await loadState(appDataDir);
  state.settings = {
    ...defaultSettings(),
    appLanguage: "sl",
    transcriptionLanguage: "sl",
    whisperModel: "medium"
  };
  const project = { id: uniqueId("project", 2), name: "Projekt čšž", archived: false };
  const recording = {
    id: uniqueId("recording", 2),
    projectId: project.id,
    title: "Posnetek s presledki čšž",
    durationSeconds: 42,
    language: "sl",
    archived: false,
    audioFile: "audio with spaces čšž.m4a"
  };
  state.projects.push(project);
  state.recordings.push(recording);
  state.transcripts.push({
    recordingId: recording.id,
    version: 1,
    language: "sl",
    text: "Uvožen posnetek ostane povezan s projektom.",
    segments: []
  });
  await saveState(appDataDir, state);

  const restarted = await loadState(appDataDir);
  assert(restarted.settings.appLanguage === "sl", "app language did not persist after restart simulation");
  assert(restarted.settings.whisperModel === "medium", "selected model did not persist after restart simulation");
  assert(restarted.recordings.some((item) => item.audioFile.includes("čšž")), "non-ASCII import fixture was not preserved");

  const archivedRecording = restarted.recordings.find((item) => item.id === recording.id);
  archivedRecording.archived = true;
  await saveState(appDataDir, restarted);
  const afterArchive = await loadState(appDataDir);
  const restoredRecording = afterArchive.recordings.find((item) => item.id === recording.id);
  assert(restoredRecording.archived === true, "archive state did not persist");
  restoredRecording.archived = false;
  await saveState(appDataDir, afterArchive);
  const afterRestore = await loadState(appDataDir);
  assert(afterRestore.recordings.find((item) => item.id === recording.id).archived === false, "restore state did not persist");

  const css = await readFile(path.join(repoRoot, "src/App.css"), "utf8");
  assert(/html,\s*body,\s*#root\s*\{[\s\S]*overflow:\s*hidden;/.test(css), "root viewport is not explicitly bounded");
  assert(/\.main-content\s*\{[\s\S]*overflow:\s*hidden;/.test(css), "main content must not be the global scroll container");
  assert(/\.transcript-scroll-area\s*\{[\s\S]*overflow-y:\s*auto;/.test(css), "transcript scroll area must be the transcript scroller");
  assert(!/max-height:\s*calc\(100vh\s*-\s*320px\)/.test(css), "fragile transcript 100vh max-height returned");

  await writeJson(path.join(appDataDir, "artifacts", "summary.json"), {
    result: "PASS",
    checks: [
      "settings persistence",
      "project/recording/transcript integrity",
      "archive/restore persistence",
      "non-ASCII fixture names",
      "viewport CSS contracts"
    ]
  });
  await assertNoPrivateArtifacts(appDataDir);

  console.log("STABILITY INTEGRATION PASS");
  console.log(`runtimeMs: ${Date.now() - started}`);
} finally {
  await cleanupHarnessDir(appDataDir);
}
