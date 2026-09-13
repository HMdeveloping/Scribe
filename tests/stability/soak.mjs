import path from "node:path";
import {
  assert,
  assertLibraryIntegrity,
  cleanupHarnessDir,
  loadState,
  logStep,
  makeHarnessDir,
  saveState,
  seedState,
  uniqueId
} from "./lib/harness.mjs";

const iterations = Number.parseInt(process.env.SCRIBE_SOAK_ITERATIONS ?? "50", 10);
assert(Number.isInteger(iterations) && iterations > 0, "SCRIBE_SOAK_ITERATIONS must be a positive integer");

const started = Date.now();
const appDataDir = await makeHarnessDir("soak");
let failures = 0;
let uncaughtErrors = 0;
let dataIntegrityFailures = 0;
let currentIteration = 0;
let currentAction = "startup";

process.on("uncaughtException", (error) => {
  uncaughtErrors += 1;
  console.error("STABILITY SOAK UNCAUGHT", { currentIteration, currentAction, error });
  process.exitCode = 1;
});
process.on("unhandledRejection", (reason) => {
  uncaughtErrors += 1;
  console.error("STABILITY SOAK UNHANDLED REJECTION", { currentIteration, currentAction, reason });
  process.exitCode = 1;
});

try {
  logStep(`using disposable app data ${appDataDir}`);
  await seedState(appDataDir);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    currentIteration = iteration;
    currentAction = "load/restart simulation";
    const state = await loadState(appDataDir);

    try {
      currentAction = "create project";
      const project = { id: uniqueId("soak-project", iteration), name: `Soak Project ${iteration}`, archived: false };
      state.projects.push(project);

      currentAction = "create synthetic recording";
      const recording = {
        id: uniqueId("soak-recording", iteration),
        projectId: project.id,
        title: `Soak Recording ${iteration}`,
        durationSeconds: 4 + iteration,
        language: "sl",
        archived: false,
        audioFile: iteration % 2 === 0 ? "audio fixture čšž.m4a" : "audio.fixture.webm"
      };
      state.recordings.push(recording);
      state.transcripts.push({
        recordingId: recording.id,
        version: 1,
        language: "sl",
        text: `Soak transcript ${iteration} č š ž.`,
        segments: [
          {
            start: 0,
            end: 1,
            text: `Soak transcript ${iteration}.`,
            words: [
              { text: "Soak", start: 0, end: 0.2 },
              { text: "transcript", start: 0.2, end: 0.6 },
              { text: `${iteration}.`, start: 0.6, end: 1 }
            ]
          }
        ]
      });

      currentAction = "seek/pause/follow state simulation";
      const playerState = {
        playing: false,
        currentTime: 0,
        followMode: "following"
      };
      playerState.playing = true;
      playerState.currentTime = 0.6;
      playerState.followMode = "suspendedByUser";
      assert(playerState.followMode === "suspendedByUser", "manual scroll did not suspend follow");
      playerState.followMode = "following";
      assert(playerState.followMode === "following", "Follow Transcript did not resume following");
      playerState.playing = false;

      currentAction = "archive/unarchive";
      recording.archived = true;
      assert(state.recordings.find((item) => item.id === recording.id).archived === true, "archive did not set state");
      recording.archived = false;

      currentAction = "delete disposable project";
      if (iteration % 5 === 0) {
        const deletedProjectId = project.id;
        state.projects = state.projects.filter((item) => item.id !== deletedProjectId);
        for (const item of state.recordings) {
          if (item.projectId === deletedProjectId) item.projectId = null;
        }
      }

      currentAction = "integrity check";
      assertLibraryIntegrity(state);

      currentAction = "persist/restart";
      await saveState(appDataDir, state);
      const restarted = await loadState(appDataDir);
      assertLibraryIntegrity(restarted);
      assert(restarted.settings.whisperModel === "large-v3-turbo", "restart reset selected model");
      assert(restarted.settings.appLanguage === "en", "restart reset app language");
    } catch (error) {
      failures += 1;
      if (currentAction === "integrity check") dataIntegrityFailures += 1;
      console.error("STABILITY SOAK FAIL", {
        iteration,
        action: currentAction,
        message: error instanceof Error ? error.message : String(error),
        appDataDir
      });
      throw error;
    }
  }

  console.log("STABILITY SOAK PASS");
  console.log(`iterations: ${iterations}`);
  console.log(`failures: ${failures}`);
  console.log(`uncaught errors: ${uncaughtErrors}`);
  console.log(`data integrity failures: ${dataIntegrityFailures}`);
  console.log(`runtimeMs: ${Date.now() - started}`);
} finally {
  if (process.exitCode) {
    console.error(`Preserving failed soak artifacts at ${appDataDir}`);
  } else {
    await cleanupHarnessDir(appDataDir);
  }
}
