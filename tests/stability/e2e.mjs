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
assert(workflowSource.includes("MAX_PARAGRAPH_WORDS"), "transcript paragraph word-count guard is missing");
assert(workflowSource.includes("MAX_PARAGRAPH_SENTENCES"), "transcript paragraph sentence-count guard is missing");
assert(workflowSource.includes("endsWithSentencePunctuation(previousWord.text)"), "paragraph guard must prefer sentence boundaries");
const manualScrollHandler = /const suspendFollowingForManualScroll = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/.exec(workflowSource)?.[1] ?? "";
assert(manualScrollHandler.includes('setFollowMode("suspendedByUser")'), "manual transcript scroll does not suspend follow");
assert(!manualScrollHandler.includes("isPlaying"), "manual transcript scroll suspension must work while playback is paused");
assert(!/const resumeFollowing = useCallback\([\s\S]*?\.play\(/.test(workflowSource), "Follow Transcript must not start playback");
assert(workflowSource.includes("className={`transcript-word"), "timed words must remain individually rendered for highlighting and seeking");
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

const transcriptBlocks = [".transcript-scroll-area", ".transcript-paragraph", ".transcript-word"].map((selector) => {
  const block = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[\\s\\S]*?\\}`, "m").exec(css)?.[0] ?? "";
  assert(block, `${selector} CSS block is missing`);
  return [selector, block];
});
for (const [selector, block] of transcriptBlocks) {
  assert(!block.includes("text-align: justify"), `${selector} must not justify transcript text`);
  assert(!block.includes("inline-flex"), `${selector} must not distribute individual words with flex layout`);
}
const paragraphBlock = transcriptBlocks.find(([selector]) => selector === ".transcript-paragraph")?.[1] ?? "";
const wordBlock = transcriptBlocks.find(([selector]) => selector === ".transcript-word")?.[1] ?? "";
assert(paragraphBlock.includes("text-align: left"), "transcript paragraphs must be left aligned");
assert(paragraphBlock.includes("word-spacing: normal"), "transcript paragraphs must preserve normal word spacing");
assert(paragraphBlock.includes("letter-spacing: normal"), "transcript paragraphs must preserve normal letter spacing");
assert(wordBlock.includes("display: inline"), "timed words must stay inline");
assert(wordBlock.includes("margin: 0"), "timed words must not add artificial inter-word margins");
assert(wordBlock.includes("padding: 0"), "timed words must not add artificial inter-word padding");

if (!hasPlaywright) {
  console.log("STABILITY E2E SKIP: Playwright is not installed; source-level UI contracts passed.");
} else {
  console.log("STABILITY E2E NOTE: Playwright dependency detected, but no browser-driven suite is configured in this lightweight harness.");
}
console.log(`runtimeMs: ${Date.now() - started}`);
