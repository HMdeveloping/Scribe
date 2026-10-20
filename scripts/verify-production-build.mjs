import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const arg = (name, fallback) => process.argv.slice(2).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const frontendDir = path.resolve(root, arg("--frontend", "dist"));
const appPath = arg("--app", "");
const forbiddenUi = [/cpuOnlyDiagnosticMode/i, /CPU[- ]only diagnostic mode/i, /Temporarily disables GPU\/Metal for troubleshooting/i];

async function textFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await textFiles(file));
    else if (/\.(?:html|js|css|json)$/i.test(entry.name)) result.push(file);
  }
  return result;
}

const settingsUi = await readFile(path.join(root, "src/components/SettingsView.tsx"), "utf8");
const translations = await readFile(path.join(root, "src/i18n/index.ts"), "utf8");
for (const pattern of [/cpuOnlyDiagnosticMode/i, /cpuOnlyTranscription/i, /CPU[- ]only diagnostic mode/i]) {
  assert.doesNotMatch(settingsUi, pattern, `settings UI contains forbidden diagnostic control token ${pattern}`);
  assert.doesNotMatch(translations, pattern, `translations contain forbidden diagnostic label ${pattern}`);
}

const frontendFiles = await textFiles(frontendDir);
assert.ok(frontendFiles.some((file) => file.endsWith(".js")), `no production JavaScript found in ${frontendDir}`);
for (const file of frontendFiles) {
  const contents = await readFile(file, "utf8");
  for (const pattern of forbiddenUi) {
    assert.doesNotMatch(contents, pattern, `production frontend contains diagnostic UI label ${pattern} in ${file}`);
  }
  assert.doesNotMatch(contents, /cpuOnlyTranscription/i, `production frontend contains a persisted diagnostic preference reference in ${file}`);
}

const recordings = await readFile(path.join(root, "src-tauri/src/commands/recordings.rs"), "utf8");
assert.doesNotMatch(recordings, /preserve_forensic_json/,
  "production transcription must not copy raw transcript JSON into diagnostics");
assert.match(recordings, /macro_rules! release_debug_log[\s\S]*?#\[cfg\(debug_assertions\)\][\s\S]*?eprintln!/,
  "verbose Rust logs must compile only in debug builds");
const productionRunner = recordings.match(/fn run_production_c0\([\s\S]*?\n\}/)?.[0];
assert.ok(productionRunner, "production transcription runner was not found");
assert.doesNotMatch(productionRunner, /cpu_only|force_cpu_only/i,
  "production runner must not expose a forced CPU-only execution option");
assert.doesNotMatch(recordings, /settings\.cpu_only_transcription|cpu_only_transcription:\s*Option<bool>/,
  "persisted settings must not control production backend selection");
assert.match(recordings, /discard_legacy_cpu_only_preference\(&mut settings\)/,
  "legacy CPU-only settings must be removed while loading settings");
assert.match(recordings, /\|\| loaded\.legacy_cpu_preference_present/,
  "legacy CPU-only settings must be rewritten without the old preference");

const chunking = await readFile(path.join(root, "src-tauri/src/transcription_chunking.rs"), "utf8");
assert.doesNotMatch(chunking, /cpu_only|force_cpu_only/i,
  "transcription engine must not contain a forced CPU-only execution mode");
assert.match(chunking, /if !cpu\s*\{\s*self\.gpu_failed = true;/,
  "automatic GPU-to-CPU fallback must remain enabled");
assert.match(chunking, /attempt:\s*Some\("cpu_fallback"\)/,
  "automatic CPU fallback reporting must remain present");

if (appPath) {
  const executable = path.resolve(root, appPath, "Contents/MacOS/scribe-app");
  assert.ok((await stat(executable)).isFile(), `packaged app executable is missing: ${executable}`);
  const packagedStrings = execFileSync("strings", [executable], { encoding: "utf8" });
  for (const pattern of forbiddenUi) {
    assert.doesNotMatch(packagedStrings, pattern, `packaged app contains diagnostic UI label ${pattern}`);
  }
  for (const marker of ["[project-delete-rust]", "[delete-rust]", "Scribe import: starting import_id=", "Scribe transcription: starting recording_id=", "raw-whisper", "recovery-whisper", "transcribe_recording_chunked_dev", "candidate_workspace="]) {
    assert.ok(!packagedStrings.includes(marker), `packaged app contains verbose debug marker ${marker}`);
  }
  console.log(`Packaged app UI scan passed: ${path.resolve(root, appPath)}`);
}

console.log(`Production build checks passed: ${frontendFiles.length} compiled frontend files inspected; diagnostic UI absent; legacy preference ignored; automatic CPU fallback retained.`);
