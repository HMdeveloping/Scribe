import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const benchmarkRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repoRoot = path.resolve(benchmarkRoot, "../..");
const manifestPath = path.join(benchmarkRoot, "manifest.json");
const latestDir = path.join(benchmarkRoot, "results", "latest");
const privateAudioRoot = path.resolve(os.homedir(), "Scribe-ASR-Benchmark");

function expandHome(value) {
  return value.replace(/^\$HOME(?=$|\/)/, os.homedir());
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

function assertNoRepoAudioPath(filePath) {
  const resolved = path.resolve(filePath);
  const benchmarkAudioDir = path.join(benchmarkRoot, "audio");
  if (resolved.startsWith(benchmarkAudioDir + path.sep)) {
    throw new Error(`Diarization benchmark audio must not be committed under ${benchmarkAudioDir}`);
  }
}

function resolveSampleAudio(sample) {
  if (sample.fixtureDurationSeconds) return null;
  const explicit = sample.audioEnv ? process.env[sample.audioEnv] : null;
  const configured = explicit || sample.defaultAudioPath;
  if (!configured) return null;
  const audioPath = path.resolve(expandHome(configured));
  assertNoRepoAudioPath(audioPath);
  if (!audioPath.startsWith(privateAudioRoot + path.sep)) {
    console.warn(`[diarization] audio is outside the default private benchmark root: ${audioPath}`);
  }
  return audioPath;
}

function normalizeTurn(raw) {
  const start = Number(raw.start);
  const end = Number(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) return null;
  const speaker = raw.speaker ?? raw.speakerId ?? raw.label;
  if (speaker === null || speaker === undefined || String(speaker).length === 0) return null;
  const confidence = raw.confidence === undefined ? undefined : Number(raw.confidence);
  return {
    start,
    end,
    speaker: String(speaker),
    ...(Number.isFinite(confidence) ? { confidence } : {}),
  };
}

function normalizeTurns(raw) {
  const sourceTurns = Array.isArray(raw?.speakerTurns)
    ? raw.speakerTurns
    : Array.isArray(raw?.turns)
      ? raw.turns
      : [];
  return sourceTurns
    .map(normalizeTurn)
    .filter(Boolean)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return merged;
}

function intervalDuration(intervals) {
  return intervals.reduce((sum, interval) => sum + Math.max(0, interval.end - interval.start), 0);
}

function overlapDuration(turns) {
  let overlap = 0;
  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1];
    const current = turns[index];
    overlap += Math.max(0, Math.min(previous.end, current.end) - current.start);
  }
  return overlap;
}

function speakerSwitchCount(turns) {
  let count = 0;
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index].speaker !== turns[index - 1].speaker) count += 1;
  }
  return count;
}

function collapseSpeakerSequence(turns, minDurationSeconds = 0.35) {
  const sequence = [];
  for (const turn of turns) {
    if (turn.end - turn.start < minDurationSeconds) continue;
    if (sequence[sequence.length - 1]?.speaker !== turn.speaker) {
      sequence.push({ speaker: turn.speaker, start: turn.start, end: turn.end });
    } else {
      sequence[sequence.length - 1].end = turn.end;
    }
  }
  return sequence;
}

function evaluateOpeningGate(sample, turns) {
  const gate = sample.openingGate;
  if (!gate) return { status: "not_configured" };
  const sequence = collapseSpeakerSequence(turns);
  const expectedLength = gate.expectedSequence?.length ?? 0;
  if (sequence.length < expectedLength) {
    return { status: "fail", reason: "too_few_stable_turns", observedSequence: sequence.map((item) => item.speaker) };
  }

  if (Array.isArray(gate.expectedTurns) && gate.expectedTurns.length > 0) {
    const observed = sequence.slice(0, gate.expectedTurns.length);
    const passed = gate.expectedTurns.every((expected, index) => {
      const actual = observed[index];
      return actual && actual.speaker === expected.speaker && Math.abs(actual.start - expected.start) <= 0.5 && Math.abs(actual.end - expected.end) <= 0.5;
    });
    return {
      status: passed ? "pass" : "fail",
      expectedSequence: gate.expectedSequence,
      observedSequence: observed.map((item) => item.speaker),
      observed,
    };
  }

  const firstThree = sequence.slice(0, 3);
  const pattern = firstThree.length === 3 &&
    firstThree[0].speaker === firstThree[2].speaker &&
    firstThree[0].speaker !== firstThree[1].speaker;
  const timingOk = (!gate.maxFirstSwitchSeconds || firstThree[1]?.start <= gate.maxFirstSwitchSeconds) &&
    (!gate.maxSecondSwitchSeconds || firstThree[2]?.start <= gate.maxSecondSwitchSeconds);
  return {
    status: pattern && timingOk ? "pass" : "fail",
    expectedSequence: gate.expectedSequence,
    observedSequence: firstThree.map((item) => item.speaker),
    observed: firstThree,
  };
}

function turnMetrics(turns, audioSeconds) {
  const durations = turns.map((turn) => turn.end - turn.start);
  const speakers = new Set(turns.map((turn) => turn.speaker));
  const merged = mergeIntervals(turns);
  const assignedSeconds = intervalDuration(merged);
  const overlapSeconds = overlapDuration(turns);
  return {
    speakerCount: speakers.size,
    turnCount: turns.length,
    turnDurationSeconds: {
      min: durations.length ? Math.min(...durations) : null,
      p50: percentile(durations, 0.5),
      p90: percentile(durations, 0.9),
      max: durations.length ? Math.max(...durations) : null,
    },
    assignedAudioPercent: audioSeconds ? assignedSeconds / audioSeconds : null,
    unassignedAudioPercent: audioSeconds ? Math.max(0, audioSeconds - assignedSeconds) / audioSeconds : null,
    overlapAudioPercent: audioSeconds ? overlapSeconds / audioSeconds : null,
    veryShortTurnCount: durations.filter((duration) => duration < 0.75).length,
    speakerSwitchCount: speakerSwitchCount(turns),
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
  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const runtimeSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  if (exit.code !== 0) {
    const exitLabel = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${exitLabel}: ${stderr || stdout}`);
  }
  return { stdout, stderr, runtimeSeconds };
}

async function audioDurationSeconds(audioPath, fixtureDurationSeconds) {
  if (fixtureDurationSeconds) return fixtureDurationSeconds;
  const ffprobe = process.env.SCRIBE_DIARIZATION_FFPROBE || process.env.SCRIBE_ASR_FFPROBE || "ffprobe";
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

async function runFixtureEngine(sample) {
  if (!sample.fixtureDurationSeconds) return { skipped: true, reason: "fixture engine only supports fixture samples" };
  return {
    skipped: false,
    runtimeSeconds: 0,
    peakMemoryBytes: null,
    raw: { speakerTurns: sample.openingGate?.expectedTurns ?? [] },
  };
}

async function runExternalJsonEngine(engine, sample, audioPath, outputPath) {
  const command = process.env[engine.commandEnv];
  if (!command) return { skipped: true, reason: `missing ${engine.commandEnv}` };
  if (!(await isExecutable(command))) return { skipped: true, reason: `command is missing or not executable: ${command}` };
  if (!audioPath || !existsSync(audioPath)) return { skipped: true, reason: `audio missing: ${audioPath ?? "not configured"}` };
  const replacements = {
    "{audio}": audioPath,
    "{output}": outputPath,
    "{sampleId}": sample.id,
    "{language}": sample.language || "sl",
  };
  const args = (engine.args ?? []).map((arg) => replacements[arg] ?? arg);
  const run = await runCommand(command, args);
  if (!existsSync(outputPath)) throw new Error(`Diarization engine did not create expected output: ${outputPath}`);
  return { skipped: false, runtimeSeconds: run.runtimeSeconds, peakMemoryBytes: null, raw: await readJson(outputPath) };
}

function buildReport({ startedAt, results, skipped }) {
  const lines = [
    "# Scribe Diarization Benchmark Report",
    "",
    `Generated: ${startedAt}`,
    `Host: ${os.type()} ${os.release()} ${os.arch()}`,
    "",
    "## Results",
    "",
    "| Sample | Engine | Speakers | Turns | Switches | Assigned | Overlap | Short turns | RTF | Opening A-B-A |",
    "|--------|--------|----------|-------|----------|----------|---------|-------------|-----|---------------|",
  ];
  for (const result of results) {
    lines.push(`| ${result.sampleId} | ${result.label} | ${result.metrics.speakerCount} | ${result.metrics.turnCount} | ${result.metrics.speakerSwitchCount} | ${formatPercent(result.metrics.assignedAudioPercent)} | ${formatPercent(result.metrics.overlapAudioPercent)} | ${result.metrics.veryShortTurnCount} | ${formatNumber(result.realTimeFactor)} | ${result.openingGate.status} |`);
  }
  if (results.length === 0) lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |");

  lines.push("", "## Skipped", "");
  for (const item of skipped) lines.push(`- ${item.engineId} / ${item.sampleId ?? "all"}: ${item.reason}`);
  if (skipped.length === 0) lines.push("- none");

  lines.push(
    "",
    "## Notes",
    "",
    "- Speaker labels are benchmark-internal only and must not be displayed in production UI.",
    "- Generated JSON and reports are gitignored under `tests/diarization-benchmark/results/`.",
    "- Private audio is referenced in place and is never copied into this repository.",
  );
  return `${lines.join("\n")}\n`;
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(3);
}

async function main() {
  const startedAt = new Date().toISOString();
  const manifest = await readJson(manifestPath);
  if (manifest.version !== 1) throw new Error("manifest.version must be 1");
  await mkdir(path.join(latestDir, "raw"), { recursive: true });

  const results = [];
  const skipped = [];

  for (const sample of manifest.samples.filter((item) => item.enabled !== false)) {
    const audioPath = resolveSampleAudio(sample);
    const audioSeconds = await audioDurationSeconds(audioPath, sample.fixtureDurationSeconds);
    for (const engine of manifest.engines.filter((item) => item.enabled !== false)) {
      if (Array.isArray(engine.sampleIds) && !engine.sampleIds.includes(sample.id)) continue;
      const outputPath = path.join(latestDir, "raw", `${sample.id}-${engine.id}.json`);
      let run;
      try {
        run = engine.type === "fixture"
          ? await runFixtureEngine(sample)
          : await runExternalJsonEngine(engine, sample, audioPath, outputPath);
      } catch (error) {
        run = { skipped: true, reason: error.message };
      }
      if (run.skipped) {
        skipped.push({ sampleId: sample.id, engineId: engine.id, label: engine.label, reason: run.reason });
        continue;
      }
      const turns = normalizeTurns(run.raw);
      const metrics = turnMetrics(turns, audioSeconds);
      const openingGate = evaluateOpeningGate(sample, turns);
      results.push({
        sampleId: sample.id,
        engineId: engine.id,
        label: engine.label,
        language: sample.language,
        category: sample.category,
        audioSeconds,
        runtimeSeconds: run.runtimeSeconds,
        realTimeFactor: audioSeconds && run.runtimeSeconds !== null ? run.runtimeSeconds / audioSeconds : null,
        peakMemoryBytes: run.peakMemoryBytes ?? null,
        modelSizeBytes: run.raw.modelSizeBytes ?? (run.raw.modelPath ? await fileSize(run.raw.modelPath) : null),
        metrics,
        openingGate,
        speakerTurns: turns,
      });
    }
  }

  const output = {
    startedAt,
    host: { platform: process.platform, arch: process.arch, release: os.release() },
    manifest: path.relative(repoRoot, manifestPath),
    privateAudioRoot,
    results,
    skipped,
  };
  await writeJson(path.join(latestDir, "results.json"), output);
  await writeFile(path.join(latestDir, "report.md"), buildReport({ startedAt, results, skipped }));

  const fixtureResult = results.find((result) => result.sampleId === "fixture-aba" && result.engineId === "fixture-aba");
  if (!fixtureResult || fixtureResult.openingGate.status !== "pass") {
    throw new Error("Diarization benchmark self-test failed: fixture A-B-A gate did not pass");
  }

  console.log("DIARIZATION BENCHMARK HARNESS PASS");
  console.log(`executedResults: ${results.length}`);
  console.log(`skipped: ${skipped.length}`);
  console.log(`privateLongLectureFound: ${existsSync(expandHome("$HOME/Scribe-ASR-Benchmark/repetition-cases/Jambrekovo predavanje 1.m4a"))}`);
  console.log(`results: ${path.relative(repoRoot, path.join(latestDir, "results.json"))}`);
  console.log(`report: ${path.relative(repoRoot, path.join(latestDir, "report.md"))}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
