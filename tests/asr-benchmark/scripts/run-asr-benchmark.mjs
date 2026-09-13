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
  const audioPath = resolveBenchmarkPath(sample.audio);
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
  const audioSeconds = await audioDurationSeconds(audioPath);
  const run = await runCommand(whisper.path, args);
  const rawJsonPath = `${outputPrefix}.json`;
  const raw = await readJson(rawJsonPath);
  const output = {
    text: raw.text || (raw.segments ?? []).map((segment) => segment.text ?? "").join(" ").trim(),
    segments: raw.segments ?? [],
  };
  const postProcessed = scribePostProcess(output);
  return {
    skipped: false,
    rawOutputPath: path.relative(benchmarkRoot, rawJsonPath),
    prompt: candidate.prompt ?? null,
    appleSiliconRuntime: process.platform === "darwin" && process.arch === "arm64" ? "whisper.cpp local CLI on Apple Silicon" : null,
    backend: candidate.backend,
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
  const output = {
    text: raw.text || (raw.segments ?? []).map((segment) => segment.text ?? "").join(" ").trim(),
    segments: raw.segments ?? [],
  };
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

function buildReport({ manifest, results, skipped, summary, startedAt, whisper }) {
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
      const dirs = { raw: path.join(latestDir, "raw") };
      const result =
        candidate.type === "whisper"
          ? await runWhisperCandidate(candidate, sample, reference, dirs, whisper)
          : await runExternalCandidate(candidate, sample, reference, dirs);
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
    selfTest: {
      rawNormalizedWer: normalizedWer(selfTestReference, selfTestRaw.text),
      postProcessedNormalizedWer: normalizedWer(selfTestReference, selfTestPostProcessed.text),
      repetitionFilter: selfTestPostProcessed.repetitionFilter,
    },
  };

  await writeJson(path.join(latestDir, "results.json"), output);
  await writeFile(path.join(latestDir, "report.md"), buildReport({ manifest, results, skipped, summary, startedAt, whisper }));
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
