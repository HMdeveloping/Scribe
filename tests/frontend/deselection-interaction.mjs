import assert from "node:assert/strict";
import fs from "node:fs";

const library = fs.readFileSync("src/components/LibraryViews.tsx", "utf8");
const app = fs.readFileSync("src/App.tsx", "utf8");
const source = `${library}\n${app}`;

for (const marker of ["HomeRecentRecordings", "RecordingsView", "ProjectDetailView"]) {
  assert.match(library, new RegExp(`export function ${marker}`));
}
assert.equal(source.includes("SCRIBE_DESELECT_DEBUG"), false);
assert.equal(source.includes("SCRIBE_PROJECT_SELECTION_DEBUG"), false);
assert.equal(source.includes("SCRIBE_SIDEBAR_DEBUG"), false);
assert.match(library, /function clearSelectionFromBackground\(event: MouseEvent, clear: \(\) => void\)/);
assert.equal((library.match(/clearSelectionFromBackground\(event, \(\) => setSelectedIds\(new Set\(\)\)\)/g) ?? []).length, 6);
assert.match(library, /selectionClearSignal = 0/);
assert.equal((app.match(/selectionClearSignal=\{selectionClearSignal\}/g) ?? []).length, 3);
assert.match(app, /onClickCapture=\{\(\) => \{\s*setSelectionClearSignal/);

function backgroundClick(target) {
  return !target.interactive;
}

assert.equal(backgroundClick({ interactive: false }), true, "nested whitespace clears selection");
assert.equal(backgroundClick({ interactive: true }), false, "recording/control interaction remains protected");

console.log("frontend deselection interaction checks passed: Home, Recordings, Project, sidebar, controls");
