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
const originalConsoleInfo = console.info;
console.info = () => {};
const nativePerformance = globalThis.performance;
Object.defineProperty(dom.window, "performance", { configurable: true, value: nativePerformance });

const tracks = [];
let acquisition = async () => makeStream();
let emitOnStart = true;
const mediaDevices = new dom.window.EventTarget();
mediaDevices.getUserMedia = (...args) => acquisition(...args);
Object.defineProperty(dom.window.navigator, "mediaDevices", { configurable: true, value: mediaDevices });
Object.defineProperty(dom.window.navigator, "permissions", {
  configurable: true,
  value: { query: async () => ({ state: "granted" }) },
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

class FakeTrack extends dom.window.EventTarget {
  readyState = "live";
  id = "private-device-id";
  stop() { this.readyState = "ended"; }
  end() { this.readyState = "ended"; this.dispatchEvent(new dom.window.Event("ended")); }
}
function makeStream() {
  const track = new FakeTrack();
  tracks.push(track);
  return {
    active: true,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

class FakeAudioContext {
  state = "running";
  createAnalyser() { return { fftSize: 512, disconnect() {}, getByteTimeDomainData() {} }; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async resume() {}
  async close() { this.state = "closed"; }
}
globalThis.AudioContext = FakeAudioContext;
globalThis.requestAnimationFrame = (cb) => dom.window.setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);

class FakeMediaRecorder extends dom.window.EventTarget {
  static isTypeSupported() { return true; }
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable = null;
  onerror = null;
  onstart = null;
  onpause = null;
  onresume = null;
  onstop = null;
  constructor(stream) {
    super();
    if (!stream.active) throw new DOMException("bad stream", "NotReadableError");
  }
  start() { this.state = "recording"; this.onstart?.(); if (emitOnStart) this.emitAudio("abc"); }
  emitAudio(value) { this.ondataavailable?.({ data: new Blob([value], { type: this.mimeType }) }); }
  requestData() { if (emitOnStart) this.emitAudio("flush"); }
  stop() {
    this.requestData();
    this.state = "inactive";
    this.onstop?.();
    this.dispatchEvent(new dom.window.Event("stop"));
  }
  pause() { this.state = "paused"; this.onpause?.(); }
  resume() { this.state = "recording"; this.onresume?.(); }
}
globalThis.MediaRecorder = FakeMediaRecorder;

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { useMicrophoneLevel } = await vite.ssrLoadModule("/src/hooks/useMicrophoneLevel.ts");
const { useAudioRecorder } = await vite.ssrLoadModule("/src/hooks/useAudioRecorder.ts");
const { getMicrophoneDiagnostics } = await vite.ssrLoadModule("/src/microphone-diagnostics.ts");
let latest;
function Harness() {
  const mic = useMicrophoneLevel(false);
  const recorder = useAudioRecorder(mic.stream, false, mic.sessionId);
  latest = { mic, recorder };
  return React.createElement("div", null, `${mic.status}/${recorder.status}`);
}
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);

await act(async () => { root.render(React.createElement(Harness)); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.mic.status, "active", "permission grant acquires the default input");
assert.equal(latest.recorder.status, "recording", "recorder starts on a live stream");
const firstSession = latest.mic.sessionId;
const firstTrack = tracks.at(-1);
mediaDevices.dispatchEvent(new dom.window.Event("devicechange"));
assert.match(getMicrophoneDiagnostics(firstSession), /audio_input_device_change/);
await act(async () => { firstTrack.end(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.mic.status, "error", "ended track reports capture interruption");
assert.equal(latest.mic.stream !== null, true, "ended stream is retained until partial audio can be finalized");
let partial;
let sameStop;
await act(async () => {
  const firstStop = latest.recorder.stop();
  sameStop = latest.recorder.stop();
  assert.strictEqual(firstStop, sameStop, "concurrent stop calls share one finalization promise");
  partial = await firstStop;
});
assert.ok(partial.size > 0, "final flush preserves buffered audio after track end");
const diagnosticText = getMicrophoneDiagnostics(firstSession);
assert.match(diagnosticText, /audio_track_ended/);
assert.doesNotMatch(diagnosticText, /private-device-id/, "diagnostics exclude device identifiers");
assert.match(latest.mic.sessionId, /^[0-9a-f-]{36}$/i);

await act(async () => { latest.mic.retry(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.notEqual(latest.mic.sessionId, firstSession, "retry starts a fresh diagnostic session");
assert.equal(latest.mic.status, "active", "retry reacquires a fresh input stream");
assert.ok(tracks.length >= 2, "retry calls getUserMedia again");
const newStream = latest.mic.stream;
await act(async () => { firstTrack.end(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.mic.stream, newStream, "late events from the previous stream cannot disrupt a retry");
const secondAttemptTrack = tracks.at(-1);
const secondSession = latest.mic.sessionId;
await act(async () => { latest.mic.retry(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.notEqual(latest.mic.sessionId, secondSession, "a repeated retry also creates a fresh session");
assert.notEqual(latest.mic.stream, newStream, "a repeated retry gets a fresh stream");
await act(async () => { secondAttemptTrack.end(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.mic.status, "active", "a stale event after repeated retry cannot end the current session");

emitOnStart = false;
await act(async () => root.unmount());
root = createRoot(host);
await act(async () => { root.render(React.createElement(Harness)); await new Promise((resolve) => setTimeout(resolve, 0)); });
let emptyBlob;
await act(async () => { emptyBlob = await latest.recorder.stop(); });
assert.equal(emptyBlob.size, 0, "empty capture remains an explicit empty result");

await act(async () => { latest.mic.stop(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.mic.stream, null, "explicit stop releases the stream");

await act(async () => root.unmount());
root = createRoot(host);

let permissionState = "denied";
Object.defineProperty(dom.window.navigator, "permissions", {
  configurable: true,
  value: { query: async () => ({ state: permissionState }) },
});
acquisition = async () => { throw new DOMException("permission denied", "NotAllowedError"); };
await act(async () => { root.render(React.createElement(Harness)); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.mic.error, "microphonePermissionDetail", "confirmed permission denial has a specific status");
assert.equal(latest.mic.stream, null, "denial does not retain an invalid stream");
await act(async () => root.unmount());
root = createRoot(host);

permissionState = "granted";
acquisition = async () => makeStream();
const OriginalRecorder = globalThis.MediaRecorder;
globalThis.MediaRecorder = class extends OriginalRecorder {
  constructor() { throw new DOMException("constructor failure", "NotSupportedError"); }
};
await act(async () => { root.render(React.createElement(Harness)); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert.equal(latest.recorder.status, "error", "MediaRecorder construction failure is surfaced");
await act(async () => root.unmount());
globalThis.MediaRecorder = OriginalRecorder;

await vite.close();
dom.window.close();
console.info = originalConsoleInfo;
console.log("microphone lifecycle tests passed");
