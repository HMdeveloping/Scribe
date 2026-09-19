import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const tauriMocks = new Map([
  ["@tauri-apps/api/core", "\0scribe-test:core"],
  ["@tauri-apps/api/app", "\0scribe-test:app"],
  ["@tauri-apps/api/event", "\0scribe-test:event"],
  ["@tauri-apps/api/window", "\0scribe-test:window"],
  ["@tauri-apps/plugin-dialog", "\0scribe-test:dialog"],
  ["@tauri-apps/plugin-process", "\0scribe-test:process"],
  ["@tauri-apps/plugin-updater", "\0scribe-test:updater"],
]);
const vite = await createServer({
  configFile: false,
  plugins: [{
    name: "scribe-frontend-test-tauri-boundaries",
    enforce: "pre",
    resolveId(id) { return tauriMocks.get(id); },
    load(id) {
      if (id === "\0scribe-test:core") return "export async function invoke(command, args) { return globalThis.__SCRIBE_TEST_INVOKE(command, args); }";
      if (id === "\0scribe-test:app") return "export async function getVersion() { return '0.1.22'; }";
      if (id === "\0scribe-test:event") return "export async function listen() { return () => {}; }";
      if (id === "\0scribe-test:window") return "export function getCurrentWindow() { return { isFullscreen: async () => false, onResized: async () => () => {}, startDragging: async () => {} }; }";
      if (id === "\0scribe-test:dialog") return "export async function open() { return null; }";
      if (id === "\0scribe-test:process") return "export async function relaunch() {}";
      if (id === "\0scribe-test:updater") return "export async function check() { return null; }";
      return null;
    },
  }],
  server: { middlewareMode: true, hmr: false, ws: false },
  ssr: { noExternal: ["@tauri-apps/api", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-process", "@tauri-apps/plugin-updater"] },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { HomeRecentRecordings, RecordingsView, ProjectDetailView, SidebarSelectionBoundary, SidebarNavigationItem, MainContentSelectionBoundary } = await vite.ssrLoadModule("/src/components/LibraryViews.tsx");
const { WebviewContextMenuGuard } = await vite.ssrLoadModule("/src/components/WebviewContextMenuGuard.tsx");
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
assert.equal(tauriConfig.app.windows[0].devtools, false, "Tauri main webview disables built-in development tools in debug and release configurations");
const appSource = readFileSync("src/App.tsx", "utf8");
assert.match(appSource, /sharedRecordingSelectedIds/);
assert.match(appSource, /setSharedRecordingSelectedIds\(new Set\(\)\)/, "sidebar and main background directly clear the shared recording list selection");
assert.doesNotMatch(appSource, /useProjectRecordingSelection|projectSelectedRecordingIds|clearProjectRecordingSelection/);
const librarySource = readFileSync("src/components/LibraryViews.tsx", "utf8");
assert.match(librarySource, /export function RecordingSelectionList/);
assert.match(librarySource.slice(librarySource.indexOf("export function RecordingsView"), librarySource.indexOf("export function ProjectDetailView")), /<RecordingSelectionList/);
assert.match(librarySource.slice(librarySource.indexOf("export function ProjectDetailView"), librarySource.indexOf("export function MoveToProjectDialog")), /<RecordingSelectionList/);
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
const settingsData = {
  settingsFileExisted: true,
  settings: { version: 1, whisperModel: "large-v3-turbo", transcriptionLanguage: "sl", language: "en", appLanguage: "en", onboardingCompleted: true, lastSeenWhatsNewVersion: "0.1.22" },
  models: [],
};
globalThis.__SCRIBE_TEST_INVOKE = async (command) => {
  if (command === "load_scribe_settings" || command === "save_scribe_settings") return settingsData;
  if (command === "initialize_library") return null;
  if (command === "list_projects") return [project];
  if (command === "list_recordings" || command === "list_project_recordings") return [recording(), recording("rec-2")];
  if (command === "list_archived_recordings") return [];
  return null;
};
const noOp = () => {};
let openedRecordings = 0;
const props = {
  recordings: [recording(), recording("rec-2")], t, appLanguage: "en", onOpenRecording: () => { openedRecordings += 1; },
  onMoveRecordings: noOp, onArchiveRecordings: noOp, onRestoreRecordings: noOp,
  onDeleteRecordings: () => true,
  getRecordingActions: () => [{ id: "test-action", label: "Test action", onSelect: noOp }],
  onRecordingContextMenu: noOp,
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
    async pointerDown(target) { await act(async () => target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))); },
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
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected") !== null, false, `${Component}: actual DOM whitespace click clears actual selection`);
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  const secondCheckbox = view.host.querySelectorAll(".recording-row-shell .selection-circle")[1];
  await view.click(secondCheckbox);
  assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 2, `${Component}: multiple selection controls work`);
  await view.click(view.host.querySelector(".recording-row-shell"));
  assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 0, `${Component}: nearby background clears all selected rows`);
  const openedBefore = openedRecordings;
  await view.click(view.host.querySelector(".recording-row"));
  assert.equal(openedRecordings, openedBefore + 1, `${Component}: ordinary row click still opens the recording`);
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  await view.click(view.host.querySelector(".row-menu-button"));
  assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 1, `${Component}: menu action establishes/preserves its target selection without background clearing`);
  await view.unmount();
}

await testBackground("HomeRecentRecordings", (clearRef) => h(HomeRecentRecordings, {
  ...props, onViewAll: noOp, clearSelectionRef: clearRef,
}), ".recent-header h2");

const projectView = (selectedIds, setSelectedIds) => h(ProjectDetailView, {
  project, ...props, onNewRecording: noOp, onImportAudio: noOp, onRenameProject: noOp,
  onDeleteProject: noOp, selectedIds, setSelectedIds,
});

function ControlledProjectView({ clearRef }) {
  const [selectedIds, setSelectedIds] = React.useState(new Set());
  clearRef.current = () => setSelectedIds(new Set());
  return projectView(selectedIds, setSelectedIds);
}

await testBackground("ProjectDetailView", (clearRef) => h(ControlledProjectView, { clearRef }), ".library-header > div");
const projectParentView = await mount(h(ControlledProjectView, { clearRef: createRef() }));
await projectParentView.click(projectParentView.host.querySelector(".recording-row-shell .selection-circle"));
assert.ok(projectParentView.host.querySelector(".recording-row-shell.is-selected"), "ProjectDetail parent test begins with a real selected recording");
await projectParentView.click(projectParentView.host.querySelector(".library-view"));
assert.equal(projectParentView.host.querySelector(".recording-row-shell.is-selected"), null, "ProjectDetail page parent directly clears without relying on the App main boundary");
await projectParentView.unmount();

function ControlledRecordingsView({ clearRef }) {
  const [selectedIds, setSelectedIds] = React.useState(new Set());
  clearRef.current = () => setSelectedIds(new Set());
  return h(RecordingsView, { ...props, onOpenArchived: noOp, selectedIds, setSelectedIds });
}
await testBackground("RecordingsView", (clearRef) => h(ControlledRecordingsView, { clearRef }), ".library-header > div");

for (const destination of ["Home", "Recordings", "Projects", "Settings"]) {
  const route = { current: "project-detail" };
  const ordering = [];
  function ProjectAppHierarchy() {
    const [selectedIds, setSelectedIds] = React.useState(new Set());
    const [currentRoute, setCurrentRoute] = React.useState("project-detail");
    return h(React.Fragment, null,
      h(WebviewContextMenuGuard),
      h(SidebarSelectionBoundary, {
        className: "sidebar",
        onClearSelection: () => { ordering.push("clear"); setSelectedIds(new Set()); },
        onPointerDownCapture: () => setSelectedIds(new Set()),
      },
        h(SidebarNavigationItem, {
          className: destination === "Settings" ? "settings-button" : "nav-item",
          onClick: () => { ordering.push("navigate"); if (destination !== "Projects") { route.current = destination; setCurrentRoute(destination); } },
        }, destination)),
      h(MainContentSelectionBoundary, { className: "main-content", onBackgroundClick: () => setSelectedIds(new Set()) }, currentRoute === "project-detail"
        ? projectView(selectedIds, setSelectedIds)
        : h("output", { "data-testid": "route" }, currentRoute)),
    );
  }
  const view = await mount(h(React.Fragment, null,
  h(ProjectAppHierarchy),
  ));
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  if (destination === "Recordings") {
    await view.click(view.host.querySelectorAll(".recording-row-shell .selection-circle")[1]);
    assert.equal(view.host.querySelectorAll(".recording-row-shell.is-selected").length, 2, "sidebar multi-selection setup uses actual ProjectDetail state");
  }
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected") !== null, true, `${destination}: App-owned ProjectDetail selection is active before sidebar click`);
  await view.pointerDown(view.host.querySelector("aside.sidebar"));
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected"), null, `${destination}: sidebar-root background capture directly clears Project selection`);
  ordering.length = 0;
  await view.click(view.host.querySelector(".recording-row-shell .selection-circle"));
  const sidebarItem = view.host.querySelector(destination === "Settings" ? ".settings-button" : ".nav-item");
  assert.ok(sidebarItem, `${destination}: actual production sidebar navigation item is mounted`);
  await view.pointerDown(sidebarItem);
  await view.click(sidebarItem);
  assert.equal(view.host.querySelector(".recording-row-shell.is-selected"), null, `${destination}: sidebar directly clears App-owned ProjectDetail selection`);
  assert.deepEqual(ordering, ["clear", "navigate"], `${destination}: actual sidebar click clears before its action`);
  assert.equal(route.current, destination === "Projects" ? "project-detail" : destination, `${destination}: sidebar action executes; same-page Projects remains open`);
  await view.unmount();
}

dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { default: App } = await vite.ssrLoadModule("/src/App.tsx");
const appView = await mount(h(App));
async function settleApp() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
const actualNav = (name) => [...appView.host.querySelectorAll(".sidebar .nav-item, .sidebar .settings-button")]
  .find((button) => button.textContent.trim() === name);
async function clickActualNav(name) {
  const button = actualNav(name);
  assert.ok(button, `actual App sidebar contains ${name}`);
  await appView.click(button);
  await settleApp();
}
async function openActualProject() {
  if (!appView.host.querySelector(".project-row")) await clickActualNav("Projects");
  const projectButton = appView.host.querySelector(".project-row");
  assert.ok(projectButton, "actual App Projects view renders the project fixture");
  await appView.click(projectButton);
  await settleApp();
  assert.ok(appView.host.querySelector(".project-title-button"), "actual App opened ProjectDetail");
}
async function selectActualProjectRecording() {
  const checkbox = appView.host.querySelector(".recording-row-shell .selection-circle");
  assert.ok(checkbox, "actual ProjectDetail shared list exposes its recording checkbox");
  await appView.click(checkbox);
  assert.equal(appView.host.querySelector(".recording-row-shell.is-selected") !== null, true, "actual App shared selection state renders selected Project row");
}
await settleApp();
await clickActualNav("Projects");
await openActualProject();
await selectActualProjectRecording();
await appView.click(appView.host.querySelector(".library-view"));
assert.equal(appView.host.querySelector(".recording-row-shell.is-selected"), null, "actual ProjectDetail page-parent whitespace clears shared selection");
for (const destination of ["Home", "Recordings", "Projects", "Settings"]) {
  await openActualProject();
  await selectActualProjectRecording();
  const destinationItem = actualNav(destination);
  assert.ok(destinationItem, `actual App sidebar contains ${destination}`);
  await appView.pointerDown(destinationItem);
  assert.equal(appView.host.querySelector(".recording-row-shell.is-selected"), null, `actual sidebar pointer-down capture clears before ${destination} navigation`);
  await appView.click(destinationItem);
  await settleApp();
  assert.equal(appView.host.querySelector(".recording-row-shell.is-selected"), null, `actual App sidebar ${destination} clears the shared selection`);
}
await openActualProject();
await selectActualProjectRecording();
await appView.pointerDown(appView.host.querySelector("aside.sidebar"));
assert.equal(appView.host.querySelector(".recording-row-shell.is-selected"), null, "actual sidebar-root pointer-down clears on empty container interaction");
await appView.unmount();

const contextMenuTest = await mount(h(WebviewContextMenuGuard));
for (const target of [document.createElement("div"), document.createElement("button"), document.createElement("aside")]) {
  document.body.append(target);
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, "ordinary app surfaces suppress the WebView development context menu");
  target.remove();
}
const editable = document.createElement("input");
document.body.append(editable);
const editableMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
editable.dispatchEvent(editableMenu);
assert.equal(editableMenu.defaultPrevented, false, "editable input retains its native text-editing context menu");
editable.remove();
await contextMenuTest.unmount();

await vite.close();
dom.window.close();
console.log("frontend production-component interaction tests passed: Home, Recordings, Project whitespace; sidebar Home/Recordings/Projects(same-page)/Settings; controls");
