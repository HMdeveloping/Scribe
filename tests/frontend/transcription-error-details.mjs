import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = new Map([
  ["@tauri-apps/api/core", "\0test:core"],
]);
const vite = await createServer({
  configFile: false,
  plugins: [{
    name: "tauri-test-mock",
    enforce: "pre",
    resolveId(id) { return mocks.get(id); },
    load(id) {
      if (id === "\0test:core") return "export async function invoke() { return null; }";
      return null;
    },
  }],
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const { FinalizingView } = await vite.ssrLoadModule("/src/components/RecordingWorkflow.tsx");
const { classifyTranscriptionError } = await vite.ssrLoadModule("/src/transcription-errors.ts");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const t = (key) => key === "transcriptionTechnicalDetails" ? "Technical details" : key;
const noop = () => {};
const baseProps = {
  t,
  onRetry: noop,
  onContinue: noop,
  onOpenTranscriptionSettings: noop,
  onCancel: noop,
};

await act(async () => root.render(React.createElement(FinalizingView, {
  ...baseProps,
  errorKind: "transcription",
  diagnosticCode: "WHISPER_EXECUTION_FAILED",
  errorMessage: "whisper failure: exit code 1",
})));
assert.equal(host.querySelector(".transcription-error-details summary")?.textContent, "Technical details");
assert.equal(host.querySelector(".transcription-error-details pre")?.textContent, "[WHISPER_EXECUTION_FAILED] whisper failure: exit code 1");

assert.equal(classifyTranscriptionError({ kind: "whisper_failed", message: "child failure" }).diagnosticCode, "WHISPER_EXECUTION_FAILED");
assert.equal(classifyTranscriptionError({ kind: "model_missing" }).diagnosticCode, "MODEL_NOT_FOUND");
assert.equal(classifyTranscriptionError({ kind: "model_download_failed", message: "network unavailable" }).diagnosticCode, "MODEL_DOWNLOAD_FAILED");
assert.equal(classifyTranscriptionError({ kind: "model_corrupted" }).diagnosticCode, "MODEL_LOAD_FAILED");
assert.equal(classifyTranscriptionError({ kind: "whisper_missing" }).diagnosticCode, "WHISPER_BINARY_NOT_FOUND");
assert.equal(classifyTranscriptionError({ kind: "audio_decode_failed" }).diagnosticCode, "AUDIO_PREPROCESSING_FAILED");
assert.equal(classifyTranscriptionError({ kind: "backend_initialization_failed" }).diagnosticCode, "BACKEND_INITIALIZATION_FAILED");
assert.equal(classifyTranscriptionError({ kind: "resource_path_invalid" }).diagnosticCode, "RESOURCE_PATH_INVALID");
assert.equal(classifyTranscriptionError({ kind: "permission_denied" }).diagnosticCode, "PERMISSION_DENIED");
assert.equal(classifyTranscriptionError("ffmpeg conversion failed").diagnosticCode, "UNKNOWN_TRANSCRIPTION_ERROR");
assert.equal(classifyTranscriptionError("ffmpeg conversion failed").message, "ffmpeg conversion failed");

await act(async () => root.render(React.createElement(FinalizingView, {
  ...baseProps,
  errorKind: "model_downloading",
  errorMessage: "Model download in progress",
})));
assert.equal(host.querySelector(".transcription-error-details"), null, "download guidance is not duplicated");
assert.match(host.textContent, /Model download in progress/);

await act(async () => root.unmount());
await vite.close();
dom.window.close();
console.log("transcription diagnostic disclosure tests passed");
