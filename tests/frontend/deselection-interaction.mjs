import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
const { HomeRecentRecordings, RecordingsView, ProjectDetailView, SidebarSelectionBoundary, MainContentSelectionBoundary } = await vite.ssrLoadModule("/src/components/LibraryViews.tsx");
const legacyDf0Library = execFileSync("git", ["show", "df0c71a:src/components/LibraryViews.tsx"], { encoding: "utf8" });
assert.match(legacyDf0Library, /event\.target === event\.currentTarget/, "baseline contains the broken nested-background condition exercised below");
assert.match(legacyDf0Library, /selectionClearSignal/, "baseline uses the prior deferred signal architecture exercised by the sidebar test");
assert.doesNotMatch(legacyDf0Library, /useRegisterSelectionClear/, "baseline does not synchronously clear ProjectDetail's local selection owner");

const h = React.createElement;
const t = (key) => ({
  select: "Select", deselect: "Deselect", selectAll: "Select all", selected: "selected",
  recentRecordings: "Recent recordings", viewAll: "View all", recordingSingular: "recording",
  recordingPlural: "recordings", slovenian: "Slovenian", noRecordings: "No recordings",
  recordingsAppear: "Recordings appear here", recordings: "Recordings", archived: "Archived",
  noArchivedRecordings: "No archived recordings", newRecording: "New recording",
  importAudio: "Import audio", rename: "Rename", deleteProject: "Delete project",
  projectActions: "Project actions", recordingActions: "Recording actions",
  moveToProject: "Move to project", archive: "Archive", deletePermanently: "Delete permanently",
}[key] ?? key);
const recording = (id = "rec-1") => ({
  id, projectId: "project-1", projectName: "Project", title: `Recording ${id}`,
  createdAt: "2026-09-01T12:00:00Z", updatedAt: "2026-09-01T12:00:00Z", durationSeconds: 90,
  language: "sl", audioFile: "audio.wav", mimeType: "audio/wav", transcriptFile: null,
  transcriptStatus: "none", archivedAt: null,
});
const project = { id: "project-1", name: "Project", createdAt: "2026-01-01", updatedAt: "2026-01-01", recordingCount: 2, totalDurationSeconds: 180 };
const noActions = () => [];
const noOp = () => {};
const props = {
  recordings: [recording(), recording("rec-2")], t, appLanguage: "en", onOpenRecording: noOp,
  onMoveRecordings: noOp, onArchiveRecordings: noOp, onRestoreRecordings: noOp,
  onDeleteRecordings: () => true, getRecordingActions: noActions, onRecordingContextMenu: noOp,
  canGoBack: false, onBack: noOp,
};

async function mount(element) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    async click(target) { await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true }))); },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
}

async function testBackground(Component, elementFactory, backgroundSelector) {
  const clearRef = createRef();
  clearRef.current = () => {};
  const view = await mount(h(MainContentSelectionBoundary, { className: "main-content", onBackgroundClick: () => clearRef.current() }, elementFactory(clearRef)));
  const select = view.host.querySelector(".recording-row-shell .selection-circle");
  await view.click(select);
  assert.equal(view.host.querySelector(".recording-row-shell")?.classList.contains("is-selected"), true, `${Component}: selection uses production row state`);
  const rowSurface = view.host.querySelector(".recording-row");
  await view.click(rowSurface);
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected"), null, `${Component}: row click follows normal selection-mode behavior, not a background handler`);
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  await view.click(view.host.querySelector(".recording-row-shell"));
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected"), null, `${Component}: click on actual row-shell whitespace clears selection`);
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  const whitespace = view.host.querySelector(backgroundSelector);
  assert.ok(whitespace, `${Component}: actual nearby background target exists`);
  if (Component === "RecordingsView") {
    const page = view.host.querySelector(".library-view");
    assert.notEqual(whitespace, page, "Recordings case clicks a real nested child, not the page handler's currentTarget");
    assert.equal(whitespace === page, false, "df0c71a target/currentTarget branch would not clear this nested child click");
  }
  await view.click(whitespace);
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected"), null, `${Component}: actual DOM whitespace click clears actual selection`);
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  const secondCheckbox = view.host.querySelectorAll(".recording-row-shell .selection-circle")[1];
  await view.click(secondCheckbox);
  assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 2, `${Component}: multiple selection controls work`);
  await view.click(view.host.querySelector(".recording-row-shell"));
  assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 0, `${Component}: nearby background clears all selected rows`);
  await view.unmount();
}

await testBackground("HomeRecentRecordings", (clearRef) => h(HomeRecentRecordings, {
  ...props, onViewAll: noOp, clearSelectionRef: clearRef,
}), ".recent-header h2");

await testBackground("RecordingsView", (clearRef) => h(RecordingsView, {
  ...props, onOpenArchived: noOp, selectionClearRef: clearRef,
}), ".library-header > div");

const projectView = (selectionClearRef) => h(ProjectDetailView, {
  project, ...props, onNewRecording: noOp, onImportAudio: noOp, onRenameProject: noOp,
  onDeleteProject: noOp, selectionClearRef,
});
await testBackground("ProjectDetailView", projectView, ".library-header > div");

for (const destination of ["Home", "Recordings", "Projects", "Settings"]) {
  const route = { current: "project-detail" };
  const ordering = [];
  const activeSelectionClearRef = createRef();
  const noClearRegistered = () => {};
  activeSelectionClearRef.current = noClearRegistered;
  const view = await mount(h(React.Fragment, null,
    h(SidebarSelectionBoundary, { onClearSelection: () => { ordering.push("clear"); activeSelectionClearRef.current(); } },
      h("button", { onClick: () => { ordering.push("navigate"); if (destination !== "Projects") route.current = destination; } }, destination)),
    projectView(activeSelectionClearRef),
    h("output", { "data-testid": "route" }, route.current),
  ));
  assert.notEqual(activeSelectionClearRef.current, noClearRegistered, "actual ProjectDetail registers its local selection owner");
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  if (destination === "Recordings") {
    await view.click(view.host.querySelectorAll(".recording-row-shell .selection-circle")[1]);
    assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 2, "sidebar multi-selection setup uses actual ProjectDetail state");
  }
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected") !== null, true, `${destination}: project recording selection is active before sidebar click`);
  await view.click([...view.host.querySelectorAll("button")].find((button) => button.textContent === destination));
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected") !== null, false, `${destination}: actual ProjectDetail owner cleared by actual boundary click`);
  assert.deepEqual(ordering, ["clear", "navigate"], `${destination}: actual sidebar click clears before its action`);
  assert.equal(route.current, destination === "Projects" ? "project-detail" : destination, `${destination}: sidebar navigation/action still executes (Projects may remain same-page)`);
  await view.unmount();
}

await vite.close();
dom.window.close();
console.log("frontend production-component interaction tests passed: Home, Recordings, Project whitespace; sidebar Home/Recordings/Projects(same-page)/Settings; controls");
