#!/usr/bin/env python3
import argparse
import itertools
import json
import os
import platform
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def maxrss_bytes():
    # macOS reports ru_maxrss in bytes; Linux reports KiB. This benchmark runs on macOS.
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def run_ffmpeg(input_path, output_path, start=None, duration=None):
    ffmpeg = os.environ.get("SCRIBE_DIARIZATION_FFMPEG") or os.environ.get("SCRIBE_ASR_FFMPEG") or "ffmpeg"
    command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    if start is not None:
        command += ["-ss", f"{start:.3f}"]
    command += ["-i", input_path]
    if duration is not None:
        command += ["-t", f"{duration:.3f}"]
    command += ["-ac", "1", "-ar", "16000", str(output_path)]
    subprocess.run(command, check=True)


def audio_duration(audio_path):
    ffprobe = os.environ.get("SCRIBE_DIARIZATION_FFPROBE") or os.environ.get("SCRIBE_ASR_FFPROBE") or "ffprobe"
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            audio_path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def normalize_prediction(prediction, offset=0.0, prefix=None):
    raw_prediction = prediction
    if isinstance(prediction, (list, tuple)):
        raw_prediction = prediction[0] if prediction else []
    turns = []
    for item in raw_prediction or []:
        if isinstance(item, str):
            parts = item.strip().split()
            if len(parts) >= 3:
                speaker = parts[2]
                turns.append({"start": float(parts[0]) + offset, "end": float(parts[1]) + offset, "speaker": f"{prefix}:{speaker}" if prefix else speaker})
        elif isinstance(item, dict):
            speaker = str(item.get("speaker", item.get("label", "speaker_0")))
            turns.append({
                "start": float(item.get("start", item.get("start_time", 0))) + offset,
                "end": float(item.get("end", item.get("end_time", 0))) + offset,
                "speaker": f"{prefix}:{speaker}" if prefix else speaker,
            })
    return [turn for turn in turns if turn["end"] > turn["start"]]


def overlap(a, b):
    return max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


def clip_turn(turn, start, end):
    clipped = {**turn, "start": max(turn["start"], start), "end": min(turn["end"], end)}
    return clipped if clipped["end"] > clipped["start"] else None


def speaker_set(turns):
    return sorted({turn["speaker"] for turn in turns})


def agreement_matrix(previous_turns, current_turns, current_local_speakers, global_speakers, overlap_start, overlap_end):
    matrix = {}
    previous_overlap = [turn for turn in previous_turns if turn["start"] < overlap_end and turn["end"] > overlap_start]
    current_overlap = [turn for turn in current_turns if turn["start"] < overlap_end and turn["end"] > overlap_start]
    for local in current_local_speakers:
        for global_speaker in global_speakers:
            agreement = 0.0
            conflict = 0.0
            local_turns = [turn for turn in current_overlap if turn["speaker"] == local]
            global_turns = [turn for turn in previous_overlap if turn["speaker"] == global_speaker]
            other_turns = [turn for turn in previous_overlap if turn["speaker"] != global_speaker]
            for current in local_turns:
                agreement += sum(overlap(current, previous) for previous in global_turns)
                conflict += sum(overlap(current, previous) for previous in other_turns)
            evidence = sum(max(0.0, min(turn["end"], overlap_end) - max(turn["start"], overlap_start)) for turn in local_turns)
            matrix[(local, global_speaker)] = {"agreement": agreement, "conflict": conflict, "evidence": evidence}
    return matrix


def best_mapping(matrix, locals_, globals_):
    if not locals_ or not globals_:
        return {}, 0.0
    best = ({}, -1.0)
    for chosen_globals in itertools.permutations(globals_, min(len(locals_), len(globals_))):
        mapping = dict(zip(locals_, chosen_globals))
        score = sum(matrix.get((local, global_speaker), {}).get("agreement", 0.0) - matrix.get((local, global_speaker), {}).get("conflict", 0.0) for local, global_speaker in mapping.items())
        if score > best[1]:
            best = (mapping, score)
    return best


def reconcile_chunks(chunks, min_evidence=1.0, min_margin=0.35):
    global_counter = 0
    reconciled_chunks = []
    boundary_reports = []
    previous_global_turns = []

    for index, chunk in enumerate(chunks):
        local_turns = chunk["turns"]
        local_speakers = speaker_set(local_turns)
        mapping = {}
        confidence = "initial"
        matrix = {}

        if index == 0:
            for local in local_speakers:
                mapping[local] = f"GLOBAL_{global_counter:02d}"
                global_counter += 1
        else:
            previous = chunks[index - 1]
            overlap_start = chunk["start"]
            overlap_end = min(previous["end"], chunk["start"] + chunk["overlap"])
            global_speakers = speaker_set(previous_global_turns)
            matrix = agreement_matrix(previous_global_turns, local_turns, local_speakers, global_speakers, overlap_start, overlap_end)
            candidate_mapping, _ = best_mapping(matrix, local_speakers, global_speakers)
            confident = 0
            ambiguous = 0
            for local in local_speakers:
                ranked = sorted(
                    [(global_speaker, matrix.get((local, global_speaker), {"agreement": 0.0, "conflict": 0.0, "evidence": 0.0})) for global_speaker in global_speakers],
                    key=lambda item: item[1]["agreement"] - item[1]["conflict"],
                    reverse=True,
                )
                selected = candidate_mapping.get(local)
                selected_stats = matrix.get((local, selected), {"agreement": 0.0, "conflict": 0.0, "evidence": 0.0}) if selected else {"agreement": 0.0, "conflict": 0.0, "evidence": 0.0}
                best_score = selected_stats["agreement"] - selected_stats["conflict"]
                runner_up = ranked[1][1]["agreement"] - ranked[1][1]["conflict"] if len(ranked) > 1 else -999.0
                if selected and selected_stats["evidence"] >= min_evidence and best_score - runner_up >= min_margin and selected_stats["agreement"] > selected_stats["conflict"]:
                    mapping[local] = selected
                    confident += 1
                else:
                    mapping[local] = f"GLOBAL_{global_counter:02d}"
                    global_counter += 1
                    ambiguous += 1
            confidence = "confident" if ambiguous == 0 else "ambiguous"
            before = speaker_at(previous_global_turns, chunk["start"] - 0.1)
            provisional = [{**turn, "speaker": mapping.get(turn["speaker"], turn["speaker"])} for turn in local_turns]
            after = speaker_at(provisional, chunk["start"] + 0.1)
            boundary_reports.append({
                "boundary": chunk["start"],
                "overlapStart": overlap_start,
                "overlapEnd": overlap_end,
                "mapping": mapping,
                "confidence": confidence,
                "confidentMappings": confident,
                "ambiguousMappings": ambiguous,
                "speakerBefore": before,
                "speakerAfter": after,
                "artificialSwitchPossible": bool(before and after and before != after and confidence == "ambiguous"),
            })

        global_turns = [{**turn, "speaker": mapping.get(turn["speaker"], turn["speaker"])} for turn in local_turns]
        reconciled = {**chunk, "globalTurns": global_turns, "mapping": mapping, "mappingConfidence": confidence}
        reconciled_chunks.append(reconciled)
        previous_global_turns.extend(global_turns)
        previous_global_turns.sort(key=lambda turn: (turn["start"], turn["end"]))

    return reconciled_chunks, boundary_reports


def speaker_at(turns, timestamp):
    candidates = [turn for turn in turns if turn["start"] <= timestamp <= turn["end"]]
    if not candidates:
        return None
    return max(candidates, key=lambda turn: turn["end"] - turn["start"])["speaker"]


def stitch_chunks(chunks, duration):
    stitched = []
    for index, chunk in enumerate(chunks):
        if index == 0:
            ownership_start = 0.0
        else:
            ownership_start = chunk["start"] + chunk["overlap"] / 2.0
        if index + 1 < len(chunks):
            ownership_end = chunks[index + 1]["start"] + chunks[index + 1]["overlap"] / 2.0
        else:
            ownership_end = duration
        for turn in chunk["globalTurns"]:
            clipped = clip_turn(turn, ownership_start, ownership_end)
            if clipped:
                stitched.append(clipped)
    stitched.sort(key=lambda turn: (turn["start"], turn["end"], turn["speaker"]))
    merged = []
    for turn in stitched:
        previous = merged[-1] if merged else None
        if previous and previous["speaker"] == turn["speaker"] and turn["start"] <= previous["end"] + 0.05:
            previous["end"] = max(previous["end"], turn["end"])
        else:
            merged.append(turn)
    return merged


def run_diarize(model, wav_path):
    return model.diarize(audio=wav_path, batch_size=1, num_workers=0)


def load_model(model_name):
    import torch
    import nemo
    from nemo.collections.asr.models import SortformerEncLabelModel

    device = torch.device("cpu")
    model = SortformerEncLabelModel.from_pretrained(model_name, map_location=device)
    model = model.to(device)
    model.eval()
    return model, {"nemo": getattr(nemo, "__version__", "unknown"), "torch": torch.__version__, "device": str(device)}


def run_window_benchmark(args):
    started = time.perf_counter()
    model, versions = load_model(args.model)
    audio_seconds = audio_duration(args.audio)
    durations = [float(item) for item in args.durations.split(",") if item.strip()]
    results = []
    with tempfile.TemporaryDirectory(prefix="scribe-sortformer-windows-") as temp_root:
        for duration in durations:
            if duration > audio_seconds:
                break
            wav_path = Path(temp_root) / f"slice-{int(duration)}s.wav"
            run_ffmpeg(args.audio, wav_path, start=0.0, duration=duration)
            before = maxrss_bytes()
            inference_started = time.perf_counter()
            ok = True
            error = None
            turns = []
            try:
                prediction = run_diarize(model, str(wav_path))
                turns = normalize_prediction(prediction)
            except Exception as exc:
                ok = False
                error = str(exc)
            inference_seconds = time.perf_counter() - inference_started
            after = maxrss_bytes()
            results.append({
                "durationSeconds": duration,
                "completed": ok,
                "error": error,
                "inferenceSeconds": inference_seconds,
                "realTimeFactor": inference_seconds / duration if duration else None,
                "peakMemoryBytes": after,
                "memoryDeltaBytes": max(0, after - before),
                "turns": len(turns),
                "speakers": len(speaker_set(turns)),
                "speakerTurns": turns,
            })
            if not ok:
                break
    return {
        "engine": "nemo-sortformer-window-benchmark",
        "checkpoint": args.model,
        "sampleId": args.sample_id,
        "audioSeconds": audio_seconds,
        "runtimeSeconds": time.perf_counter() - started,
        "peakMemoryBytes": maxrss_bytes(),
        "results": results,
        "versions": {"python": sys.version.split()[0], "platform": platform.platform(), **versions},
    }


def run_chunked(args):
    started = time.perf_counter()
    init_started = time.perf_counter()
    model, versions = load_model(args.model)
    init_seconds = time.perf_counter() - init_started
    audio_seconds = audio_duration(args.audio)
    step = args.window - args.overlap
    chunk_starts = []
    cursor = 0.0
    while cursor < audio_seconds:
        chunk_starts.append(cursor)
        cursor += step
        if audio_seconds - cursor < 1.0:
            break

    chunks = []
    inference_seconds = 0.0
    conversion_seconds = 0.0
    with tempfile.TemporaryDirectory(prefix="scribe-sortformer-chunked-") as temp_root:
        for index, start in enumerate(chunk_starts):
            end = min(audio_seconds, start + args.window)
            duration = end - start
            wav_path = Path(temp_root) / f"chunk-{index:03d}.wav"
            conversion_started = time.perf_counter()
            run_ffmpeg(args.audio, wav_path, start=start, duration=duration)
            conversion_seconds += time.perf_counter() - conversion_started
            inference_started = time.perf_counter()
            prediction = run_diarize(model, str(wav_path))
            chunk_inference = time.perf_counter() - inference_started
            inference_seconds += chunk_inference
            local_turns = normalize_prediction(prediction, offset=start)
            chunks.append({
                "index": index,
                "start": start,
                "end": end,
                "duration": duration,
                "overlap": args.overlap if index > 0 else 0.0,
                "inferenceSeconds": chunk_inference,
                "turns": local_turns,
                "speakers": speaker_set(local_turns),
                "peakMemoryBytes": maxrss_bytes(),
            })

    reconciled_chunks, boundaries = reconcile_chunks(chunks)
    stitched = stitch_chunks(reconciled_chunks, audio_seconds)
    return {
        "engine": "nemo-sortformer-chunked",
        "checkpoint": args.model,
        "sampleId": args.sample_id,
        "speakerTurns": stitched,
        "chunks": reconciled_chunks,
        "boundaryReports": boundaries,
        "windowSeconds": args.window,
        "overlapSeconds": args.overlap,
        "audioSeconds": audio_seconds,
        "runtimeSeconds": time.perf_counter() - started,
        "initializationSeconds": init_seconds,
        "audioConversionSeconds": conversion_seconds,
        "inferenceSeconds": inference_seconds,
        "peakMemoryBytes": maxrss_bytes(),
        "device": versions["device"],
        "versions": {"python": sys.version.split()[0], "platform": platform.platform(), **versions},
        "licenses": {
            "weights": "UNKNOWN until NVIDIA checkpoint model card/license is reviewed.",
            "runtime": "Apache-2.0 for NeMo toolkit; transitive Python dependencies require review.",
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sample-id", required=True)
    parser.add_argument("--model", default="nvidia/diar_sortformer_4spk-v1")
    parser.add_argument("--mode", choices=["windows", "chunked"], default="chunked")
    parser.add_argument("--durations", default="30,60,120,180,300")
    parser.add_argument("--window", type=float, default=120.0)
    parser.add_argument("--overlap", type=float, default=20.0)
    args = parser.parse_args()

    if args.overlap >= args.window:
        raise SystemExit("--overlap must be smaller than --window")

    payload = run_window_benchmark(args) if args.mode == "windows" else run_chunked(args)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
