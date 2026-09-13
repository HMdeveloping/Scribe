import path from "node:path";
import { readFile } from "node:fs/promises";
import { assert, logStep, repoRoot } from "./lib/harness.mjs";

const started = Date.now();
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const hasPlaywright = Boolean(packageJson.devDependencies?.["@playwright/test"] || packageJson.devDependencies?.playwright);

const appSource = await readFile(path.join(repoRoot, "src/App.tsx"), "utf8");
const workflowSource = await readFile(path.join(repoRoot, "src/components/RecordingWorkflow.tsx"), "utf8");
const audioPlayerSource = await readFile(path.join(repoRoot, "src/components/AudioPlayer.tsx"), "utf8");
const css = await readFile(path.join(repoRoot, "src/App.css"), "utf8");

logStep("checking source-level UI regression contracts");
for (const view of ["home", "projects", "recordings", "settings", "transcript"]) {
  assert(appSource.includes(`view === "${view}"`) || appSource.includes(`className="${view}`), `navigation/view contract missing for ${view}`);
}

assert(workflowSource.includes("handleWordClick"), "word click seek handler is missing");
assert(workflowSource.includes("resumeFollowing"), "Follow Transcript resume handler is missing");
assert(workflowSource.includes("suspendedByUser"), "manual transcript scroll suspend state is missing");
assert(audioPlayerSource.includes("togglePlayback"), "audio pause/resume path is missing");
assert(audioPlayerSource.includes("onChange"), "audio seek control path is missing");

const viewportSelectors = [
  [".home", "overflow-y: auto"],
  [".library-view", "overflow-y: auto"],
  [".settings-view", "overflow-y: auto"],
  [".transcript-scroll-area", "overflow-y: auto"]
];
for (const [selector, rule] of viewportSelectors) {
  const block = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[\\s\\S]*?\\}`, "m").exec(css)?.[0] ?? "";
  assert(block.includes(rule), `${selector} is not an explicit inner scroll container`);
}

if (!hasPlaywright) {
  console.log("STABILITY E2E SKIP: Playwright is not installed; source-level UI contracts passed.");
} else {
  console.log("STABILITY E2E NOTE: Playwright dependency detected, but no browser-driven suite is configured in this lightweight harness.");
}
console.log(`runtimeMs: ${Date.now() - started}`);
