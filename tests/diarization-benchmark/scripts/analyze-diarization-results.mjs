import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const benchmarkRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repoRoot = path.resolve(benchmarkRoot, "../..");
const latestDir = path.join(benchmarkRoot, "results", "latest");
const whisperPath = path.join(os.homedir(), "Scribe-ASR-Benchmark", "repetition-cases", "diagnostics", "whisper-output.json");
const audioPath = path.join(os.homedir(), "Scribe-ASR-Benchmark", "repetition-cases", "Jambrekovo predavanje 1.m4a");

function parseTimestamp(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}

function segmentTime(segment, key) {
  if (segment[key] !== undefined) return parseTimestamp(segment[key]);
  if (segment.timestamps) return parseTimestamp(segment.timestamps[key === "start" ? "from" : "to"]);
  if (segment.offsets) return Number(segment.offsets[key === "start" ? "from" : "to"] ?? 0) / 1000;
  return 0;
}

function normalizeWordText(text) {
  return String(text ?? "")
    .replace(/^\s+/, "")
    .replace(/^Ġ/, "")
    .trim();
}

function whisperSegments(raw) {
  return Array.isArray(raw.segments) ? raw.segments : raw.transcription ?? [];
}

function whisperWords(raw) {
  const words = [];
  for (const segment of whisperSegments(raw)) {
    const source = Array.isArray(segment.words) ? segment.words : segment.tokens ?? [];
    for (const token of source) {
      const text = normalizeWordText(token.word ?? token.text ?? token.content ?? "");
      if (!text || text.startsWith("[_") || text.startsWith("<|") || text === "|") continue;
      const start = segmentTime(token, "start");
      const end = segmentTime(token, "end");
      if (end > start) words.push({ text, start, end });
    }
  }
  return words;
}

function phraseWindows(raw) {
  const segments = whisperSegments(raw);
  return {
    A1: { start: segmentTime(segments[0], "start"), end: segmentTime(segments[0], "end"), text: segments[0]?.text?.trim() ?? "" },
    B: { start: segmentTime(segments[1], "start"), end: segmentTime(segments[1], "end"), text: segments[1]?.text?.trim() ?? "" },
    A2: { start: segmentTime(segments[2], "start"), end: segmentTime(segments[2], "end"), text: segments[2]?.text?.trim() ?? "" },
  };
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function speakerForWindow(turns, window) {
  const bySpeaker = new Map();
  for (const turn of turns) {
    const amount = overlap(turn, window);
    if (amount > 0) bySpeaker.set(turn.speaker, (bySpeaker.get(turn.speaker) ?? 0) + amount);
  }
  const ranked = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { speaker: null, overlapSeconds: 0 };
  return { speaker: ranked[0][0], overlapSeconds: ranked[0][1] };
}

function assignWord(word, turns, tolerance = 0.35) {
  const overlaps = turns
    .map((turn) => ({ turn, overlap: overlap(turn, word) }))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);
  if (overlaps[0]) {
    const speakers = new Set(overlaps.map((item) => item.turn.speaker));
    return { speaker: overlaps[0].turn.speaker, method: "overlap", turn: overlaps[0].turn, ambiguous: speakers.size > 1 };
  }

  const midpoint = (word.start + word.end) / 2;
  const containing = turns.find((turn) => midpoint >= turn.start && midpoint <= turn.end);
  if (containing) return { speaker: containing.speaker, method: "midpoint", turn: containing };

  const nearest = turns
    .map((turn) => ({ turn, distance: Math.min(Math.abs(word.start - turn.end), Math.abs(word.end - turn.start)) }))
    .filter((item) => item.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance)[0];
  if (nearest) return { speaker: nearest.turn.speaker, method: "nearest", turn: nearest.turn };
  return { speaker: null, method: "unassigned", turn: null };
}

function alignmentSimulation(words, turns) {
  const assigned = words.map((word) => ({ word, assignment: assignWord(word, turns) }));
  let speakerParagraphs = 0;
  let boundariesUnder05 = 0;
  let boundariesUnder10 = 0;
  let previousSpeaker = null;
  for (const item of assigned) {
    const speaker = item.assignment.speaker;
    if (!speaker) continue;
    if (previousSpeaker && previousSpeaker !== speaker) {
      speakerParagraphs += 1;
      const duration = item.assignment.turn ? item.assignment.turn.end - item.assignment.turn.start : null;
      if (duration !== null && duration < 0.5) boundariesUnder05 += 1;
      if (duration !== null && duration < 1.0) boundariesUnder10 += 1;
    }
    previousSpeaker = speaker;
  }
  const assignedCount = assigned.filter((item) => item.assignment.speaker).length;
  const ambiguousCount = assigned.filter((item) => item.assignment.ambiguous).length;
  return {
    totalWords: words.length,
    assignedWordsPercent: words.length ? assignedCount / words.length : null,
    unassignedWordsPercent: words.length ? (words.length - assignedCount) / words.length : null,
    ambiguousWordsPercent: words.length ? ambiguousCount / words.length : null,
    speakerChangeParagraphCount: speakerParagraphs,
    boundariesCausedByTurnsUnder05: boundariesUnder05,
    boundariesCausedByTurnsUnder10: boundariesUnder10,
  };
}

function durationStats(turns) {
  const durations = turns.map((turn) => turn.end - turn.start).sort((a, b) => a - b);
  const pick = (ratio) => durations.length ? durations[Math.floor((durations.length - 1) * ratio)] : null;
  return {
    min: durations[0] ?? null,
    p10: pick(0.1),
    median: pick(0.5),
    p90: pick(0.9),
    max: durations[durations.length - 1] ?? null,
  };
}

function speakerDistribution(turns) {
  const speakers = new Map();
  for (const turn of turns) {
    const bucket = speakers.get(turn.speaker) ?? { speaker: turn.speaker, seconds: 0, turns: 0, longestTurn: 0, durations: [] };
    const duration = turn.end - turn.start;
    bucket.seconds += duration;
    bucket.turns += 1;
    bucket.longestTurn = Math.max(bucket.longestTurn, duration);
    bucket.durations.push(duration);
    speakers.set(turn.speaker, bucket);
  }
  const total = [...speakers.values()].reduce((sum, item) => sum + item.seconds, 0);
  return [...speakers.values()]
    .map((item) => ({ ...item, percent: total ? item.seconds / total : null, durationStats: durationStats(item.durations.map((duration, index) => ({ start: index, end: index + duration }))) }))
    .sort((a, b) => b.seconds - a.seconds);
}

function abaMicroTransitions(turns, maxMiddleDuration) {
  let count = 0;
  for (let index = 0; index + 2 < turns.length; index += 1) {
    const a1 = turns[index];
    const b = turns[index + 1];
    const a2 = turns[index + 2];
    if (a1.speaker === a2.speaker && a1.speaker !== b.speaker && b.end - b.start < maxMiddleDuration) count += 1;
  }
  return count;
}

function enhance(result, words, windows) {
  const turns = result.speakerTurns ?? [];
  const opening = {
    A1: { ...windows.A1, ...speakerForWindow(turns, windows.A1) },
    B: { ...windows.B, ...speakerForWindow(turns, windows.B) },
    A2: { ...windows.A2, ...speakerForWindow(turns, windows.A2) },
  };
  const openingPass = opening.A1.speaker && opening.A1.speaker === opening.A2.speaker && opening.B.speaker && opening.B.speaker !== opening.A1.speaker;
  const runtime = result.runtimeSeconds ?? 0;
  return {
    ...result,
    enhanced: {
      sourceAudio: audioPath,
      phraseWindows: windows,
      opening,
      openingGate: opening.A1.speaker && opening.B.speaker && opening.A2.speaker ? (openingPass ? "pass" : "fail") : "inconclusive",
      microTurnMetrics: {
        under025: turns.filter((turn) => turn.end - turn.start < 0.25).length,
        under050: turns.filter((turn) => turn.end - turn.start < 0.5).length,
        under100: turns.filter((turn) => turn.end - turn.start < 1.0).length,
        abaMiddleUnder050: abaMicroTransitions(turns, 0.5),
        abaMiddleUnder100: abaMicroTransitions(turns, 1.0),
        speakerSwitchesPerMinute: result.audioSeconds ? result.metrics.speakerSwitchCount / (result.audioSeconds / 60) : null,
      },
      turnDuration: durationStats(turns),
      speakerDistribution: speakerDistribution(turns),
      alignment: alignmentSimulation(words, turns),
      measuredRuntimeSeconds: runtime,
    },
  };
}

function normalizeRawTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .map((turn) => ({
      start: Number(turn.start),
      end: Number(turn.end),
      speaker: String(turn.speaker),
    }))
    .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start && turn.speaker)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function basicMetrics(turns, audioSeconds) {
  const speakers = new Set(turns.map((turn) => turn.speaker));
  let switches = 0;
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index].speaker !== turns[index - 1].speaker) switches += 1;
  }
  return {
    speakerCount: speakers.size,
    turnCount: turns.length,
    speakerSwitchCount: switches,
    switchesPerMinute: audioSeconds ? switches / (audioSeconds / 60) : null,
  };
}

async function pyannoteVariants(result, words, windows) {
  if (!result.engineId?.startsWith("pyannote-community-1")) return null;
  const rawPath = path.join(latestDir, "raw", `${result.sampleId}-${result.engineId}.json`);
  if (!existsSync(rawPath)) return null;
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  const variants = {};
  for (const [name, sourceTurns] of [
    ["standard", raw.regularSpeakerTurns],
    ["exclusive", raw.exclusiveSpeakerTurns],
  ]) {
    const turns = normalizeRawTurns(sourceTurns);
    const opening = {
      A1: { ...windows.A1, ...speakerForWindow(turns, windows.A1) },
      B: { ...windows.B, ...speakerForWindow(turns, windows.B) },
      A2: { ...windows.A2, ...speakerForWindow(turns, windows.A2) },
    };
    const openingPass = opening.A1.speaker && opening.A1.speaker === opening.A2.speaker && opening.B.speaker && opening.B.speaker !== opening.A1.speaker;
    variants[name] = {
      available: turns.length > 0,
      rawTurns0To12: turns.filter((turn) => turn.start < 12 && turn.end > 0),
      opening,
      openingGate: opening.A1.speaker && opening.B.speaker && opening.A2.speaker ? (openingPass ? "pass" : "fail") : "inconclusive",
      metrics: {
        ...basicMetrics(turns, result.audioSeconds),
        microTurns: {
          under025: turns.filter((turn) => turn.end - turn.start < 0.25).length,
          under050: turns.filter((turn) => turn.end - turn.start < 0.5).length,
          under100: turns.filter((turn) => turn.end - turn.start < 1.0).length,
        },
        abaMiddleUnder050: abaMicroTransitions(turns, 0.5),
        abaMiddleUnder100: abaMicroTransitions(turns, 1.0),
        durationStats: durationStats(turns),
        speakerDistribution: speakerDistribution(turns).map(({ durations, ...speaker }) => speaker),
      },
      alignment: alignmentSimulation(words, turns),
    };
  }
  return variants;
}

function formatPercent(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(3);
}

function buildComparison(results, skipped) {
  const lines = [
    "# Scribe Real-World Diarization Comparison",
    "",
    `Source audio: ${audioPath}`,
    "",
    "| Engine | Opening A-B-A | Speakers | Turns | <0.5s | Switches/min | Assigned words | Runtime | RTF |",
    "|--------|---------------|----------|-------|-------|--------------|----------------|---------|-----|",
  ];
  for (const result of results) {
    lines.push(`| ${result.label} | ${result.enhanced.openingGate} | ${result.metrics.speakerCount} | ${result.metrics.turnCount} | ${result.enhanced.microTurnMetrics.under050} | ${formatNumber(result.enhanced.microTurnMetrics.speakerSwitchesPerMinute)} | ${formatPercent(result.enhanced.alignment.assignedWordsPercent)} | ${formatNumber(result.runtimeSeconds)} | ${formatNumber(result.realTimeFactor)} |`);
  }
  if (results.length === 0) lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |");
  lines.push("", "## Skipped", "");
  for (const item of skipped) lines.push(`- ${item.label ?? item.engineId} / ${item.sampleId ?? "all"}: ${item.reason}`);
  if (skipped.length === 0) lines.push("- none");
  return `${lines.join("\n")}\n`;
}

const raw = JSON.parse(await readFile(path.join(latestDir, "results.json"), "utf8"));
const whisper = existsSync(whisperPath) ? JSON.parse(await readFile(whisperPath, "utf8")) : null;
const words = whisper ? whisperWords(whisper) : [];
const windows = whisper ? phraseWindows(whisper) : {};
const results = [];
for (const result of raw.results) {
  const enhanced = enhance(result, words, windows);
  const variants = await pyannoteVariants(result, words, windows);
  results.push(variants ? { ...enhanced, pyannoteVariants: variants } : enhanced);
}
const comparison = {
  ...raw,
  whisperTimingSource: whisperPath,
  results,
};
await writeFile(path.join(latestDir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
await writeFile(path.join(latestDir, "comparison.md"), buildComparison(results, raw.skipped ?? []));
console.log(`comparison: ${path.relative(repoRoot, path.join(latestDir, "comparison.json"))}`);
