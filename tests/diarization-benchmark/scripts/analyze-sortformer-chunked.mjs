import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const benchmarkRoot = path.resolve(new URL("..", import.meta.url).pathname);
const latestDir = path.join(benchmarkRoot, "results", "latest");
const inputPath = process.argv[2] ?? path.join(latestDir, "sortformer-chunked-120x20.json");
const outputPath = process.argv[3] ?? path.join(latestDir, "sortformer-chunked-analysis.json");
const whisperPath = path.join(os.homedir(), "Scribe-ASR-Benchmark", "repetition-cases", "diagnostics", "whisper-output.json");

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

function whisperSegments(raw) {
  return Array.isArray(raw.segments) ? raw.segments : raw.transcription ?? [];
}

function whisperWords(raw) {
  const words = [];
  for (const segment of whisperSegments(raw)) {
    const source = Array.isArray(segment.words) ? segment.words : segment.tokens ?? [];
    for (const token of source) {
      const text = String(token.word ?? token.text ?? token.content ?? "").replace(/^\s+/, "").replace(/^Ġ/, "").trim();
      const start = segmentTime(token, "start");
      const end = segmentTime(token, "end");
      if (text && end > start && !text.startsWith("[_") && !text.startsWith("<|") && text !== "|") words.push({ text, start, end });
    }
  }
  return words;
}

function phraseWindows(raw) {
  const segments = whisperSegments(raw);
  return {
    A1: { start: 0, end: 3.66, text: segments[0]?.text?.trim() ?? "" },
    B: { start: 3.66, end: 4.66, text: segments[1]?.text?.trim() ?? "" },
    A2: { start: 4.66, end: 6.66, text: segments[2]?.text?.trim() ?? "" },
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
  const ranked = [...bySpeaker.entries()].sort((left, right) => right[1] - left[1]);
  return ranked[0] ? { speaker: ranked[0][0], overlapSeconds: ranked[0][1], evidence: Object.fromEntries(ranked) } : { speaker: null, overlapSeconds: 0, evidence: {} };
}

function durationStats(turns) {
  const durations = turns.map((turn) => turn.end - turn.start).sort((a, b) => a - b);
  const pick = (ratio) => durations.length ? durations[Math.floor((durations.length - 1) * ratio)] : null;
  return { min: durations[0] ?? null, p10: pick(0.1), median: pick(0.5), p90: pick(0.9), max: durations.at(-1) ?? null };
}

function speakerDistribution(turns) {
  const buckets = new Map();
  for (const turn of turns) {
    const bucket = buckets.get(turn.speaker) ?? { speaker: turn.speaker, seconds: 0, turns: 0, longestTurn: 0, durations: [] };
    const duration = turn.end - turn.start;
    bucket.seconds += duration;
    bucket.turns += 1;
    bucket.longestTurn = Math.max(bucket.longestTurn, duration);
    bucket.durations.push(duration);
    buckets.set(turn.speaker, bucket);
  }
  const total = [...buckets.values()].reduce((sum, item) => sum + item.seconds, 0);
  return [...buckets.values()].map((item) => ({
    speaker: item.speaker,
    seconds: item.seconds,
    percent: total ? item.seconds / total : null,
    turns: item.turns,
    longestTurn: item.longestTurn,
    durationStats: durationStats(item.durations.map((duration, index) => ({ start: index, end: index + duration }))),
  })).sort((left, right) => right.seconds - left.seconds);
}

function speakerSwitches(turns) {
  let switches = 0;
  for (let index = 1; index < turns.length; index += 1) {
    if (turns[index].speaker !== turns[index - 1].speaker) switches += 1;
  }
  return switches;
}

function abaMicroTransitions(turns, maxMiddleDuration) {
  let count = 0;
  for (let index = 0; index + 2 < turns.length; index += 1) {
    const left = turns[index];
    const middle = turns[index + 1];
    const right = turns[index + 2];
    if (left.speaker === right.speaker && left.speaker !== middle.speaker && middle.end - middle.start < maxMiddleDuration) count += 1;
  }
  return count;
}

function assignWord(word, turns, tolerance = 0.35) {
  const overlaps = turns.map((turn) => ({ turn, overlap: overlap(turn, word) })).filter((item) => item.overlap > 0).sort((a, b) => b.overlap - a.overlap);
  if (overlaps[0]) return { speaker: overlaps[0].turn.speaker, turn: overlaps[0].turn, ambiguous: new Set(overlaps.map((item) => item.turn.speaker)).size > 1 };
  const midpoint = (word.start + word.end) / 2;
  const containing = turns.find((turn) => midpoint >= turn.start && midpoint <= turn.end);
  if (containing) return { speaker: containing.speaker, turn: containing, ambiguous: false };
  const nearest = turns.map((turn) => ({ turn, distance: Math.min(Math.abs(word.start - turn.end), Math.abs(word.end - turn.start)) })).filter((item) => item.distance <= tolerance).sort((a, b) => a.distance - b.distance)[0];
  return nearest ? { speaker: nearest.turn.speaker, turn: nearest.turn, ambiguous: false } : { speaker: null, turn: null, ambiguous: false };
}

function alignment(words, turns) {
  const assigned = words.map((word) => ({ word, assignment: assignWord(word, turns) }));
  let paragraphs = 0;
  let under05 = 0;
  let under10 = 0;
  let previousSpeaker = null;
  for (const item of assigned) {
    const speaker = item.assignment.speaker;
    if (!speaker) continue;
    if (previousSpeaker && previousSpeaker !== speaker) {
      paragraphs += 1;
      const duration = item.assignment.turn ? item.assignment.turn.end - item.assignment.turn.start : null;
      if (duration !== null && duration < 0.5) under05 += 1;
      if (duration !== null && duration < 1.0) under10 += 1;
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
    alignedSpeakerSwitches: paragraphs,
    simulatedSpeakerParagraphs: paragraphs,
    boundariesCausedByTurnsUnder05: under05,
    boundariesCausedByTurnsUnder10: under10,
  };
}

function stabilityFilter(turns, boundaries) {
  const ambiguousBoundaries = boundaries.filter((boundary) => boundary.confidence === "ambiguous").map((boundary) => boundary.boundary);
  const filtered = [];
  for (let index = 0; index < turns.length; index += 1) {
    const previous = filtered.at(-1);
    const current = turns[index];
    const next = turns[index + 1];
    const duration = current.end - current.start;
    const nearAmbiguousBoundary = ambiguousBoundaries.some((boundary) => Math.abs(((current.start + current.end) / 2) - boundary) <= 5);
    const weakAba = previous && next && previous.speaker === next.speaker && previous.speaker !== current.speaker && duration < 0.5 && nearAmbiguousBoundary;
    if (weakAba) {
      previous.end = next.end;
      index += 1;
    } else {
      filtered.push({ ...current });
    }
  }
  return filtered;
}

function transcriptAround(segments, timestamp, radius = 8) {
  return segments
    .filter((segment) => segmentTime(segment, "start") <= timestamp + radius && segmentTime(segment, "end") >= timestamp - radius)
    .map((segment) => segment.text?.trim())
    .filter(Boolean)
    .join(" ");
}

function humanReviewManifest(data, turns, segments) {
  const samples = [];
  const add = (timestamp, reason) => {
    if (samples.some((sample) => Math.abs(sample.timestamp - timestamp) < 2)) return;
    const before = turns.filter((turn) => turn.end <= timestamp).at(-1) ?? null;
    const after = turns.find((turn) => turn.start >= timestamp) ?? null;
    samples.push({
      timestamp,
      label: new Date(timestamp * 1000).toISOString().slice(11, 19),
      reason,
      predictedTransition: { before, after },
      transcript: transcriptAround(segments, timestamp),
      status: "NEEDS HUMAN REVIEW",
    });
  };
  add(3.66, "known opening A-B-A short speaker interjection");
  for (const boundary of data.boundaryReports.slice(0, 4)) add(boundary.boundary, `chunk boundary ${boundary.confidence}`);
  for (const boundary of data.boundaryReports.filter((item) => item.confidence === "ambiguous").slice(0, 3)) add(boundary.boundary, "ambiguous reconciliation boundary");
  for (const turn of turns.filter((turn) => turn.end - turn.start < 1.0 && turn.speaker !== turns[0]?.speaker).slice(0, 5)) add((turn.start + turn.end) / 2, "short secondary-speaker event");
  const targets = [300, 600, 900, 1200];
  for (const target of targets) add(target, "distributed lecture sanity sample");
  return samples.slice(0, 14);
}

const data = JSON.parse(await readFile(inputPath, "utf8"));
const whisper = JSON.parse(await readFile(whisperPath, "utf8"));
const segments = whisperSegments(whisper);
const words = whisperWords(whisper);
const windows = phraseWindows(whisper);
const turns = data.speakerTurns;
const opening = {
  A1: { ...windows.A1, ...speakerForWindow(turns, windows.A1) },
  B: { ...windows.B, ...speakerForWindow(turns, windows.B) },
  A2: { ...windows.A2, ...speakerForWindow(turns, windows.A2) },
};
const openingPass = opening.A1.speaker && opening.A1.speaker === opening.A2.speaker && opening.B.speaker && opening.B.speaker !== opening.A1.speaker;
const filteredTurns = stabilityFilter(turns, data.boundaryReports ?? []);
const analysis = {
  source: inputPath,
  chunkCount: data.chunks.length,
  metrics: {
    runtimeSeconds: data.runtimeSeconds,
    inferenceSeconds: data.inferenceSeconds,
    realTimeFactor: data.runtimeSeconds / data.audioSeconds,
    peakMemoryBytes: data.peakMemoryBytes,
    speakers: new Set(turns.map((turn) => turn.speaker)).size,
    turns: turns.length,
    switches: speakerSwitches(turns),
    switchesPerMinute: speakerSwitches(turns) / (data.audioSeconds / 60),
    durationStats: durationStats(turns),
    microTurns: {
      under025: turns.filter((turn) => turn.end - turn.start < 0.25).length,
      under050: turns.filter((turn) => turn.end - turn.start < 0.5).length,
      under100: turns.filter((turn) => turn.end - turn.start < 1.0).length,
    },
    abaMiddleUnder050: abaMicroTransitions(turns, 0.5),
    abaMiddleUnder100: abaMicroTransitions(turns, 1.0),
    speakerDistribution: speakerDistribution(turns),
  },
  reconciliation: {
    boundaries: data.boundaryReports.length,
    confidentBoundaries: data.boundaryReports.filter((boundary) => boundary.confidence === "confident").length,
    ambiguousBoundaries: data.boundaryReports.filter((boundary) => boundary.confidence === "ambiguous").length,
    artificialSwitchesPossible: data.boundaryReports.filter((boundary) => boundary.artificialSwitchPossible).length,
    boundaryAdjacentMicroTurns: turns.filter((turn) => (data.boundaryReports ?? []).some((boundary) => Math.abs(((turn.start + turn.end) / 2) - boundary.boundary) <= 5) && turn.end - turn.start < 1).length,
  },
  opening: {
    turns0To12: turns.filter((turn) => turn.start < 12 && turn.end > 0),
    A1: opening.A1,
    B: opening.B,
    A2: opening.A2,
    result: openingPass ? "PASS" : "FAIL",
  },
  alignment: alignment(words, turns),
  stabilityFiltered: {
    turns: filteredTurns.length,
    switches: speakerSwitches(filteredTurns),
    microTurns: {
      under025: filteredTurns.filter((turn) => turn.end - turn.start < 0.25).length,
      under050: filteredTurns.filter((turn) => turn.end - turn.start < 0.5).length,
      under100: filteredTurns.filter((turn) => turn.end - turn.start < 1.0).length,
    },
    openingBPreserved: speakerForWindow(filteredTurns, windows.B).speaker === opening.B.speaker,
  },
  humanReviewManifest: humanReviewManifest(data, turns, segments),
};

await writeFile(outputPath, `${JSON.stringify(analysis, null, 2)}\n`);
console.log(`analysis: ${path.relative(path.resolve(benchmarkRoot, "../.."), outputPath)}`);
