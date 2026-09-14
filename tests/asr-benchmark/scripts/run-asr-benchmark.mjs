import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const benchmarkRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repoRoot = path.resolve(benchmarkRoot, "../..");
const manifestPath = path.join(benchmarkRoot, "manifest.json");
const latestDir = path.join(benchmarkRoot, "results", "latest");
const promptHint = "Slovenian speech with occasional English words and informal expressions.";
const supportedCategories = new Set([
  "clean_slovenian",
  "code_switch_sl_en",
  "colloquial",
  "slang",
  "technical",
  "fast_speech",
  "noisy",
  "silence",
  "long_form",
  "legitimate_repetition",
  "pause_test",
]);

function resolveBenchmarkPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Expected a non-empty relative path");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Benchmark paths must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(benchmarkRoot, relativePath);
  if (!resolved.startsWith(benchmarkRoot + path.sep)) {
    throw new Error(`Benchmark path escapes tests/asr-benchmark: ${relativePath}`);
  }
  return resolved;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

function normalizeText(text) {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("sl-SI")
    .replace(/[^\p{L}\p{N}'-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function words(text) {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ") : [];
}

function levenshtein(a, b) {
  const previous = new Array(b.length + 1);
  const current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length] ?? 0;
}

function errorRate(referenceItems, hypothesisItems) {
  if (referenceItems.length === 0) return hypothesisItems.length === 0 ? 0 : 1;
  return levenshtein(referenceItems, hypothesisItems) / referenceItems.length;
}

function normalizedWer(reference, hypothesis) {
  return errorRate(words(reference), words(hypothesis));
}

function rawWer(reference, hypothesis) {
  const split = (value) => value.trim().split(/\s+/).filter(Boolean);
  return errorRate(split(reference), split(hypothesis));
}

function cer(reference, hypothesis) {
  return errorRate([...normalizeText(reference)], [...normalizeText(hypothesis)]);
}

function codeSwitchAccuracy(expectedTokens, hypothesis) {
  const hypWords = new Set(words(hypothesis));
  const expected = expectedTokens.map((token) => normalizeText(token)).filter(Boolean);
  const correct = expected.filter((token) => hypWords.has(token)).length;
  return {
    expected: expected.length,
    correct,
    accuracy: expected.length === 0 ? null : correct / expected.length,
    missing: expected.filter((token) => !hypWords.has(token)),
  };
}

function countRepeatedPhrases(text) {
  const tokens = words(text);
  let count = 0;
  for (let size = 1; size <= 6; size += 1) {
    for (let i = 0; i + size * 2 <= tokens.length; i += 1) {
      const phrase = tokens.slice(i, i + size).join(" ");
      let repeats = 1;
      while (
        i + size * (repeats + 1) <= tokens.length &&
        tokens.slice(i + size * repeats, i + size * (repeats + 1)).join(" ") === phrase
      ) {
        repeats += 1;
      }
      if (repeats >= 3) {
        count += 1;
        i += size * repeats - 1;
      }
    }
  }
  return count;
}

function omittedWordCount(reference, hypothesis) {
  const hypCounts = new Map();
  for (const word of words(hypothesis)) {
    hypCounts.set(word, (hypCounts.get(word) ?? 0) + 1);
  }
  let omitted = 0;
  for (const word of words(reference)) {
    const count = hypCounts.get(word) ?? 0;
    if (count > 0) {
      hypCounts.set(word, count - 1);
    } else {
      omitted += 1;
    }
  }
  return omitted;
}

function duplicatedSegmentCount(segments) {
  if (!Array.isArray(segments)) return 0;
  let duplicated = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const previous = normalizeText(segments[i - 1]?.text ?? "");
    const current = normalizeText(segments[i]?.text ?? "");
    if (current && current === previous) duplicated += 1;
  }
  return duplicated;
}

function applyScribeRepetitionFilter(segments) {
  const summary = { candidates: 0, removedSegments: 0 };
  if (!Array.isArray(segments)) return { segments: [], summary };
  const filtered = [];
  let index = 0;
  while (index < segments.length) {
    const key = normalizeText(segments[index]?.text ?? "");
    let end = index + 1;
    while (end < segments.length && normalizeText(segments[end]?.text ?? "") === key) end += 1;
    const run = segments.slice(index, end);
    const reliable = run.every((segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.start >= 0 &&
      segment.end > segment.start &&
      segment.end - segment.start <= 4.0
    );
    const tight = run.slice(1).every((segment, offset) => {
      const previous = run[offset];
      const gap = segment.start - previous.end;
      return gap >= -0.05 && gap <= 1.25;
    });
    const short = key.split(/\s+/).filter(Boolean).length <= 6 && (segments[index]?.text ?? "").length <= 60;
    if (key && run.length >= 3 && reliable && tight && short) {
      filtered.push(run[0]);
      summary.candidates += 1;
      summary.removedSegments += run.length - 1;
    } else {
      filtered.push(...run);
    }
    index = end;
  }
  return { segments: filtered, summary };
}

function scribePostProcess(raw) {
  const segments = Array.isArray(raw.segments) ? raw.segments : [];
  const filtered = applyScribeRepetitionFilter(segments);
  return {
    text: filtered.segments.map((segment) => segment.text ?? "").join(" ").trim() || raw.text || "",
    segments: filtered.segments,
    repetitionFilter: filtered.summary,
  };
}

function transcriptOutputFromRaw(raw) {
  const segments = Array.isArray(raw.segments)
    ? raw.segments
    : Array.isArray(raw.transcription)
      ? raw.transcription.map((segment) => ({
          start: Number.isFinite(segment.start) ? segment.start : (segment.offsets?.from ?? 0) / 1000,
          end: Number.isFinite(segment.end) ? segment.end : (segment.offsets?.to ?? 0) / 1000,
          text: segment.text ?? "",
        }))
      : [];
  return {
    text: raw.text || segments.map((segment) => segment.text ?? "").join(" ").trim(),
    segments,
  };
}

function metricsFor(reference, output, sample, runtimeSeconds, audioSeconds, modelSizeBytes) {
  const text = output.text ?? "";
  return {
    normalizedWer: normalizedWer(reference, text),
    rawWer: rawWer(reference, text),
    cer: cer(reference, text),
    codeSwitch: codeSwitchAccuracy(sample.expectedEnglishTokens ?? [], text),
    hallucinatedRepeatedPhraseCount: countRepeatedPhrases(text),
    omittedWordCount: omittedWordCount(reference, text),
    duplicatedSegmentCount: duplicatedSegmentCount(output.segments),
    runtimeSeconds,
    audioSeconds,
    realTimeFactor: audioSeconds > 0 && runtimeSeconds !== null ? runtimeSeconds / audioSeconds : null,
    peakMemoryBytes: null,
    modelSizeBytes,
  };
}

async function runCommand(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    ...options,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const runtimeSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${code}: ${stderr || stdout}`);
  }
  return { stdout, stderr, runtimeSeconds };
}

async function validateManifest(manifest) {
  if (manifest.version !== 1) throw new Error("manifest.version must be 1");
  if (!Array.isArray(manifest.samples)) throw new Error("manifest.samples must be an array");
  if (!Array.isArray(manifest.candidates)) throw new Error("manifest.candidates must be an array");
  const ids = new Set();
  for (const sample of manifest.samples) {
    if (!sample.id || ids.has(sample.id)) throw new Error(`Invalid or duplicate sample id: ${sample.id}`);
    ids.add(sample.id);
    if (!supportedCategories.has(sample.category)) throw new Error(`Unsupported category for ${sample.id}: ${sample.category}`);
    resolveBenchmarkPath(sample.audio);
    const referencePath = resolveBenchmarkPath(sample.reference);
    const reference = (await readFile(referencePath, "utf8")).trim();
    if (!reference) throw new Error(`Reference transcript is empty for ${sample.id}`);
    if (!Array.isArray(sample.expectedEnglishTokens)) {
      throw new Error(`expectedEnglishTokens must be an array for ${sample.id}`);
    }
    if (sample.enabled && !existsSync(resolveBenchmarkPath(sample.audio))) {
      throw new Error(`Enabled sample audio is missing for ${sample.id}: ${sample.audio}`);
    }
  }
}

function bundledWhisperPath() {
  const triple = process.platform === "darwin" && process.arch === "arm64" ? "aarch64-apple-darwin" : null;
  if (!triple) return null;
  return path.join(repoRoot, "src-tauri", "resources", "bin", triple, "whisper-cli");
}

async function whisperCliInfo() {
  const explicit = process.env.SCRIBE_ASR_WHISPER_CLI;
  const candidate = explicit || bundledWhisperPath();
  if (!candidate || !(await isExecutable(candidate))) {
    return { path: candidate, available: false, reason: "whisper-cli not found or not executable" };
  }
  const version = await runCommand(candidate, ["--version"]);
  const help = await runCommand(candidate, ["-h"]);
  return {
    path: candidate,
    available: true,
    version: version.stdout.trim() || version.stderr.trim(),
    supportsPrompt: help.stdout.includes("--prompt") || help.stderr.includes("--prompt"),
  };
}

async function audioDurationSeconds(audioPath) {
  const ffprobe = process.env.SCRIBE_ASR_FFPROBE || "ffprobe";
  try {
    const result = await runCommand(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const parsed = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function whisperCanRead(audioPath) {
  return new Set([".flac", ".mp3", ".ogg", ".wav"]).has(path.extname(audioPath).toLowerCase());
}

async function whisperAudioPath(sample, dirs) {
  const audioPath = resolveBenchmarkPath(sample.audio);
  if (whisperCanRead(audioPath)) return audioPath;
  const derivedPath = path.join(dirs.derived, `${sample.id}.wav`);
  if (existsSync(derivedPath)) return derivedPath;
  await mkdir(dirs.derived, { recursive: true });
  await runCommand(process.env.SCRIBE_ASR_FFMPEG || "ffmpeg", [
    "-y",
    "-i",
    audioPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-sample_fmt",
    "s16",
    derivedPath,
  ]);
  return derivedPath;
}

async function runWhisperCandidate(candidate, sample, reference, dirs, whisper) {
  const modelPath = process.env[candidate.modelPathEnv];
  if (!modelPath) {
    return { skipped: true, reason: `missing ${candidate.modelPathEnv}` };
  }
  if (!existsSync(modelPath)) {
    return { skipped: true, reason: `model path does not exist: ${modelPath}` };
  }
  if (candidate.prompt && !whisper.supportsPrompt) {
    return { skipped: true, reason: "bundled whisper-cli does not support --prompt" };
  }
  const originalAudioPath = resolveBenchmarkPath(sample.audio);
  const audioPath = await whisperAudioPath(sample, dirs);
  const outputPrefix = path.join(dirs.raw, `${sample.id}-${candidate.id}`);
  const args = [
    "-m",
    modelPath,
    "-f",
    audioPath,
    "-l",
    sample.language || "sl",
    "-ojf",
    "-of",
    outputPrefix,
  ];
  if (candidate.prompt) args.push("--prompt", candidate.prompt);
  const audioSeconds = await audioDurationSeconds(originalAudioPath);
  let run;
  let backendUsed = candidate.backend;
  try {
    run = await runCommand(whisper.path, args);
  } catch (error) {
    const cpuArgs = ["-ng", ...args];
    run = await runCommand(whisper.path, cpuArgs);
    backendUsed = `${candidate.backend} (CPU fallback after GPU/Metal failure: ${error.message.split("\n")[0]})`;
  }
  const rawJsonPath = `${outputPrefix}.json`;
  if (!existsSync(rawJsonPath)) {
    throw new Error(`whisper-cli completed but did not produce expected JSON: ${rawJsonPath}`);
  }
  const raw = await readJson(rawJsonPath);
  const output = transcriptOutputFromRaw(raw);
  const postProcessed = scribePostProcess(output);
  return {
    skipped: false,
    rawOutputPath: path.relative(benchmarkRoot, rawJsonPath),
    prompt: candidate.prompt ?? null,
    appleSiliconRuntime: process.platform === "darwin" && process.arch === "arm64" ? backendUsed : null,
    backend: backendUsed,
    modelSizeBytes: await fileSize(modelPath),
    rawMetrics: metricsFor(reference, output, sample, run.runtimeSeconds, audioSeconds, await fileSize(modelPath)),
    scribePostProcessedMetrics: metricsFor(reference, postProcessed, sample, run.runtimeSeconds, audioSeconds, await fileSize(modelPath)),
    repetitionFilter: postProcessed.repetitionFilter,
  };
}

async function runExternalCandidate(candidate, sample, reference, dirs) {
  const command = process.env[candidate.commandEnv];
  if (!command) return { skipped: true, reason: `missing ${candidate.commandEnv}` };
  if (!existsSync(command)) return { skipped: true, reason: `command path does not exist: ${command}` };
  const audioPath = resolveBenchmarkPath(sample.audio);
  const outputPath = path.join(dirs.raw, `${sample.id}-${candidate.id}.json`);
  const audioSeconds = await audioDurationSeconds(audioPath);
  const started = process.hrtime.bigint();
  await runCommand(command, [
    "--audio",
    audioPath,
    "--reference",
    resolveBenchmarkPath(sample.reference),
    "--sample-id",
    sample.id,
    "--language",
    sample.language || "sl",
    "--output",
    outputPath,
  ]);
  const runtimeSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  const raw = await readJson(outputPath);
  const output = transcriptOutputFromRaw(raw);
  const postProcessed = scribePostProcess(output);
  return {
    skipped: false,
    rawOutputPath: path.relative(benchmarkRoot, outputPath),
    prompt: null,
    appleSiliconRuntime: process.platform === "darwin" && process.arch === "arm64" ? `${candidate.label} local adapter on Apple Silicon` : null,
    backend: candidate.backend,
    modelSizeBytes: raw.modelSizeBytes ?? null,
    rawMetrics: metricsFor(reference, output, sample, runtimeSeconds, audioSeconds, raw.modelSizeBytes ?? null),
    scribePostProcessedMetrics: metricsFor(reference, postProcessed, sample, runtimeSeconds, audioSeconds, raw.modelSizeBytes ?? null),
    repetitionFilter: postProcessed.repetitionFilter,
  };
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(3);
}

function summarize(results) {
  const byEngine = new Map();
  for (const result of results.filter((item) => !item.skipped)) {
    const bucket = byEngine.get(result.engineId) ?? {
      engineId: result.engineId,
      label: result.label,
      normalizedWer: [],
      codeCorrect: 0,
      codeExpected: 0,
      hallucinations: 0,
      rtf: [],
      peakMemoryBytes: null,
    };
    bucket.normalizedWer.push(result.rawMetrics.normalizedWer);
    bucket.codeCorrect += result.rawMetrics.codeSwitch.correct;
    bucket.codeExpected += result.rawMetrics.codeSwitch.expected;
    bucket.hallucinations += result.rawMetrics.hallucinatedRepeatedPhraseCount;
    if (result.rawMetrics.realTimeFactor !== null) bucket.rtf.push(result.rawMetrics.realTimeFactor);
    byEngine.set(result.engineId, bucket);
  }
  return [...byEngine.values()].map((bucket) => ({
    ...bucket,
    normalizedWer: bucket.normalizedWer.reduce((sum, value) => sum + value, 0) / bucket.normalizedWer.length,
    codeSwitchAccuracy: bucket.codeExpected === 0 ? null : bucket.codeCorrect / bucket.codeExpected,
    realTimeFactor: bucket.rtf.length ? bucket.rtf.reduce((sum, value) => sum + value, 0) / bucket.rtf.length : null,
  }));
}

function summarizeByCategory(results) {
  const byCategory = new Map();
  for (const result of results.filter((item) => !item.skipped)) {
    const key = `${result.category}:${result.engineId}`;
    const bucket = byCategory.get(key) ?? {
      category: result.category,
      engineId: result.engineId,
      label: result.label,
      normalizedWer: [],
      cer: [],
      codeCorrect: 0,
      codeExpected: 0,
      hallucinations: 0,
      duplicatedSegments: 0,
      rtf: [],
    };
    bucket.normalizedWer.push(result.rawMetrics.normalizedWer);
    bucket.cer.push(result.rawMetrics.cer);
    bucket.codeCorrect += result.rawMetrics.codeSwitch.correct;
    bucket.codeExpected += result.rawMetrics.codeSwitch.expected;
    bucket.hallucinations += result.rawMetrics.hallucinatedRepeatedPhraseCount;
    bucket.duplicatedSegments += result.rawMetrics.duplicatedSegmentCount;
    if (result.rawMetrics.realTimeFactor !== null) bucket.rtf.push(result.rawMetrics.realTimeFactor);
    byCategory.set(key, bucket);
  }
  return [...byCategory.values()].map((bucket) => ({
    ...bucket,
    normalizedWer: bucket.normalizedWer.reduce((sum, value) => sum + value, 0) / bucket.normalizedWer.length,
    cer: bucket.cer.reduce((sum, value) => sum + value, 0) / bucket.cer.length,
    codeSwitchAccuracy: bucket.codeExpected === 0 ? null : bucket.codeCorrect / bucket.codeExpected,
    realTimeFactor: bucket.rtf.length ? bucket.rtf.reduce((sum, value) => sum + value, 0) / bucket.rtf.length : null,
  }));
}

function summarizePromptPairs(summary) {
  const byId = new Map(summary.map((row) => [row.engineId, row]));
  const pairs = [
    ["whisper-large-v3-turbo", "whisper-large-v3-turbo-prompt", "Whisper Large v3 Turbo"],
    ["whisper-large-v3", "whisper-large-v3-prompt", "Whisper Large v3"],
  ];
  return pairs.map(([baseId, promptId, label]) => {
    const base = byId.get(baseId);
    const prompted = byId.get(promptId);
    return {
      label,
      baseEngineId: baseId,
      promptEngineId: promptId,
      available: Boolean(base && prompted),
      normalizedWerDelta: base && prompted ? prompted.normalizedWer - base.normalizedWer : null,
      codeSwitchAccuracyDelta:
        base?.codeSwitchAccuracy !== null &&
        base?.codeSwitchAccuracy !== undefined &&
        prompted?.codeSwitchAccuracy !== null &&
        prompted?.codeSwitchAccuracy !== undefined
          ? prompted.codeSwitchAccuracy - base.codeSwitchAccuracy
          : null,
      hallucinationDelta: base && prompted ? prompted.hallucinations - base.hallucinations : null,
      rtfDelta:
        base?.realTimeFactor !== null &&
        base?.realTimeFactor !== undefined &&
        prompted?.realTimeFactor !== null &&
        prompted?.realTimeFactor !== undefined
          ? prompted.realTimeFactor - base.realTimeFactor
          : null,
    };
  });
}

function buildReport({ manifest, results, skipped, summary, categorySummary, promptSummary, startedAt, whisper }) {
  const lines = [
    "# Scribe ASR Benchmark Report",
    "",
    `Generated: ${startedAt}`,
    `Host: ${os.type()} ${os.release()} ${os.arch()}`,
    `Whisper CLI: ${whisper.available ? `${whisper.version} (${whisper.path})` : `unavailable (${whisper.reason})`}`,
    `Prompt experiment hint: "${promptHint}"`,
    "",
    "## Result Table",
    "",
    "| Engine | Normalized WER | Code-switch accuracy | Hallucinations | RTF | RAM |",
    "|--------|----------------|----------------------|----------------|-----|-----|",
  ];
  if (summary.length === 0) {
    lines.push("| n/a | n/a | n/a | n/a | n/a | n/a |");
  } else {
    for (const row of summary) {
      lines.push(`| ${row.label} | ${formatPercent(row.normalizedWer)} | ${formatPercent(row.codeSwitchAccuracy)} | ${row.hallucinations} | ${formatNumber(row.realTimeFactor)} | n/a |`);
    }
  }
  lines.push("", "## Category Breakdown", "");
  if (categorySummary.length === 0) {
    lines.push("No executed samples.");
  } else {
    lines.push("| Category | Engine | Normalized WER | CER | Code-switch accuracy | Repeated phrases | Duplicated segments | RTF |");
    lines.push("|----------|--------|----------------|-----|----------------------|------------------|---------------------|-----|");
    for (const row of categorySummary) {
      lines.push(`| ${row.category} | ${row.label} | ${formatPercent(row.normalizedWer)} | ${formatPercent(row.cer)} | ${formatPercent(row.codeSwitchAccuracy)} | ${row.hallucinations} | ${row.duplicatedSegments} | ${formatNumber(row.realTimeFactor)} |`);
    }
  }
  lines.push("", "## Prompt Comparison", "");
  lines.push("| Pair | WER delta | Code-switch delta | Repeated phrase delta | RTF delta |");
  lines.push("|------|-----------|-------------------|-----------------------|-----------|");
  for (const row of promptSummary) {
    if (!row.available) {
      lines.push(`| ${row.label} | n/a | n/a | n/a | n/a |`);
    } else {
      lines.push(`| ${row.label} | ${formatPercent(row.normalizedWerDelta)} | ${formatPercent(row.codeSwitchAccuracyDelta)} | ${row.hallucinationDelta} | ${formatNumber(row.rtfDelta)} |`);
    }
  }
  lines.push("", "## Skipped Engines", "");
  for (const item of skipped) {
    lines.push(`- ${item.label}: ${item.reason}`);
  }
  if (skipped.length === 0) lines.push("- none");
  lines.push("", "## Categories", "");
  for (const category of manifest.requiredCategories ?? []) {
    const enabled = manifest.samples.filter((sample) => sample.enabled && sample.category === category).length;
    lines.push(`- ${category}: ${enabled} enabled sample(s)`);
  }
  lines.push(
    "",
    "## Notes",
    "",
    "- Raw ASR metrics and Scribe post-processed metrics are stored separately in `results.json`.",
    "- Private audio under `tests/asr-benchmark/audio/` and generated reports under `tests/asr-benchmark/results/` are gitignored.",
    "- No production transcription settings, model defaults, UI, updater, or persistence behavior are modified by this benchmark.",
  );
  if (results.length === 0) {
    lines.push("- No enabled local audio samples were present, so this is a harness validation report, not a model quality comparison.");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const startedAt = new Date().toISOString();
  const manifest = await readJson(manifestPath);
  await validateManifest(manifest);
  await mkdir(path.join(latestDir, "raw"), { recursive: true });

  const whisper = await whisperCliInfo();
  const enabledSamples = manifest.samples.filter((sample) => sample.enabled);
  const results = [];
  const skipped = [];

  for (const candidate of manifest.candidates.filter((item) => item.enabled !== false)) {
    if (candidate.type === "whisper" && !whisper.available) {
      skipped.push({ engineId: candidate.id, label: candidate.label, reason: whisper.reason });
      continue;
    }
    for (const sample of enabledSamples) {
      const reference = (await readFile(resolveBenchmarkPath(sample.reference), "utf8")).trim();
      const dirs = { raw: path.join(latestDir, "raw"), derived: path.join(latestDir, "derived") };
      let result;
      try {
        result =
          candidate.type === "whisper"
            ? await runWhisperCandidate(candidate, sample, reference, dirs, whisper)
            : await runExternalCandidate(candidate, sample, reference, dirs);
      } catch (error) {
        const messageLines = error.message.split("\n").map((line) => line.trim()).filter(Boolean);
        const reason =
          messageLines.find((line) => line.includes("does not support Slovenian")) ||
          messageLines[0] ||
          String(error);
        result = {
          skipped: true,
          reason,
        };
      }
      if (result.skipped) {
        skipped.push({ engineId: candidate.id, label: candidate.label, sampleId: sample.id, reason: result.reason });
      } else {
        results.push({ engineId: candidate.id, label: candidate.label, sampleId: sample.id, category: sample.category, ...result });
      }
    }
    if (enabledSamples.length === 0) {
      if (candidate.type === "whisper") {
        const reason = candidate.modelPathEnv && !process.env[candidate.modelPathEnv]
          ? `no enabled samples; model env ${candidate.modelPathEnv} not used`
          : "no enabled samples";
        skipped.push({ engineId: candidate.id, label: candidate.label, reason });
      } else {
        skipped.push({ engineId: candidate.id, label: candidate.label, reason: `no enabled samples; ${candidate.commandEnv} not used` });
      }
    }
  }

  const selfTestReference = "Vamo videti. Naslednji stavek.";
  const selfTestRaw = {
    text: "Vamo videti. Vamo videti. Vamo videti. Naslednji stavek.",
    segments: [
      { start: 0, end: 0.8, text: "Vamo videti." },
      { start: 0.9, end: 1.7, text: "Vamo videti." },
      { start: 1.8, end: 2.6, text: "Vamo videti." },
      { start: 5, end: 6, text: "Naslednji stavek." },
    ],
  };
  const selfTestPostProcessed = scribePostProcess(selfTestRaw);
  if (selfTestPostProcessed.repetitionFilter.removedSegments !== 2) {
    throw new Error("Benchmark self-test failed: Scribe repetition post-processing did not remove the synthetic loop");
  }

  const summary = summarize(results);
  const categorySummary = summarizeByCategory(results);
  const promptSummary = summarizePromptPairs(summary);
  const output = {
    startedAt,
    host: { platform: process.platform, arch: process.arch, release: os.release() },
    manifest: path.relative(repoRoot, manifestPath),
    whisper,
    samples: manifest.samples.map((sample) => ({
      id: sample.id,
      enabled: Boolean(sample.enabled),
      category: sample.category,
      language: sample.language,
      expectedEnglishTokens: sample.expectedEnglishTokens ?? [],
    })),
    results,
    skipped,
    summary,
    categorySummary,
    promptSummary,
    selfTest: {
      rawNormalizedWer: normalizedWer(selfTestReference, selfTestRaw.text),
      postProcessedNormalizedWer: normalizedWer(selfTestReference, selfTestPostProcessed.text),
      repetitionFilter: selfTestPostProcessed.repetitionFilter,
    },
  };

  await writeJson(path.join(latestDir, "results.json"), output);
  await writeFile(path.join(latestDir, "report.md"), buildReport({ manifest, results, skipped, summary, categorySummary, promptSummary, startedAt, whisper }));
  await copyFile(manifestPath, path.join(latestDir, "manifest.snapshot.json"));

  console.log("ASR BENCHMARK HARNESS PASS");
  console.log(`enabledSamples: ${enabledSamples.length}`);
  console.log(`executedResults: ${results.length}`);
  console.log(`skipped: ${skipped.length}`);
  console.log(`results: ${path.relative(repoRoot, path.join(latestDir, "results.json"))}`);
  console.log(`report: ${path.relative(repoRoot, path.join(latestDir, "report.md"))}`);
  if (enabledSamples.length === 0) {
    console.log("qualityComparison: skipped (no enabled local benchmark audio)");
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
