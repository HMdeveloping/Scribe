import { useCallback, useEffect, useRef, useState } from "react";
import { recordMicrophoneDiagnostic } from "../microphone-diagnostics";

const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

const CHUNK_TIMESLICE_MS = 100;

type RecorderStatus = "idle" | "preparing" | "recording" | "paused" | "stopped" | "error";

function getSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_TYPE_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

export function useAudioRecorder(stream: MediaStream | null, paused: boolean, sessionId: string) {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [mimeType, setMimeType] = useState("");
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopPromiseRef = useRef<Promise<Blob> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const firstChunkReceivedRef = useRef(false);
  const startRequestedAtRef = useRef<number | null>(null);
  const chunkCountRef = useRef(0);
  const earlyFlushFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream || recorderRef.current) return;
    let recorder: MediaRecorder | null = null;

    try {
      const audioTracks = stream.getAudioTracks();
      if (!stream.active || audioTracks.length === 0 || audioTracks.every((track) => track.readyState !== "live")) {
        recordMicrophoneDiagnostic(sessionId, "recorder_initialization_rejected", {
          category: "stream_not_live",
          audioTrackCount: audioTracks.length,
        });
        setError("stream_not_live");
        setStatus("error");
        return;
      }
      recordMicrophoneDiagnostic(sessionId, "recorder_initialization_attempted", {
        audioTrackCount: audioTracks.length,
        streamActive: stream.active,
      });
      setStatus("preparing");
      const selectedMimeType = getSupportedMimeType();
      recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);

      recorderRef.current = recorder;
      chunksRef.current = [];
      firstChunkReceivedRef.current = false;
      startedAtRef.current = null;
      startRequestedAtRef.current = null;
      chunkCountRef.current = 0;
      setMimeType(recorder.mimeType || selectedMimeType);
      recordMicrophoneDiagnostic(sessionId, "media_recorder_created", {
        mimeType: recorder.mimeType || selectedMimeType || "",
        state: recorder.state,
        timesliceMs: CHUNK_TIMESLICE_MS,
      });

      recorder.ondataavailable = (event) => {
        if (recorderRef.current !== recorder) return;
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          chunkCountRef.current += 1;
          const elapsedMs = startedAtRef.current === null ? null : Math.round(performance.now() - startedAtRef.current);
          if (!firstChunkReceivedRef.current) {
            firstChunkReceivedRef.current = true;
            recordMicrophoneDiagnostic(sessionId, "first_audio_chunk_received", { size: event.data.size, elapsedMs });
          }
          recordMicrophoneDiagnostic(sessionId, "audio_chunk_received", {
            chunkIndex: chunkCountRef.current,
            size: event.data.size,
            elapsedMs,
          });
        }
      };
      recorder.onerror = () => {
        if (recorderRef.current !== recorder) return;
        recordMicrophoneDiagnostic(sessionId, "media_recorder_failed", { category: "media_recorder_error" });
        setError("media_recorder_error");
        setStatus("error");
      };
      const activeRecorder = recorder;
      activeRecorder.onstart = () => {
        if (recorderRef.current !== activeRecorder) return;
        startedAtRef.current = performance.now();
        recordMicrophoneDiagnostic(sessionId, "audio_capture_started", {
          state: activeRecorder.state,
          startDelayMs: startRequestedAtRef.current === null ? null : Math.round(startedAtRef.current - startRequestedAtRef.current),
        });
        earlyFlushFrameRef.current = requestAnimationFrame(() => {
          earlyFlushFrameRef.current = null;
          if (activeRecorder.state !== "recording") return;
          try {
            recordMicrophoneDiagnostic(sessionId, "audio_capture_initial_flush_requested", {
              state: activeRecorder.state,
              elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
              chunksBeforeRequest: chunksRef.current.length,
            });
            activeRecorder.requestData();
          } catch (reason) {
            recordMicrophoneDiagnostic(sessionId, "audio_capture_initial_flush_failed", { category: "request_data_failed" });
          }
        });
        setStatus("recording");
      };
      recorder.onpause = () => {
        if (recorderRef.current !== recorder) return;
        recordMicrophoneDiagnostic(sessionId, "audio_capture_paused");
        setStatus("paused");
      };
      recorder.onresume = () => {
        if (recorderRef.current !== recorder) return;
        recordMicrophoneDiagnostic(sessionId, "audio_capture_resumed");
        setStatus("recording");
      };
      recorder.onstop = () => {
        if (recorderRef.current !== recorder) return;
        const durationMs = startedAtRef.current === null ? 0 : performance.now() - startedAtRef.current;
        recordMicrophoneDiagnostic(sessionId, "audio_capture_stopped", {
          chunks: chunksRef.current.length,
          finalBlobSize: chunksRef.current.reduce((total, chunk) => total + chunk.size, 0),
          elapsedRecordingDurationMs: Math.round(durationMs),
        });
        setStatus("stopped");
      };
      startRequestedAtRef.current = performance.now();
      recorder.start(CHUNK_TIMESLICE_MS);
      recordMicrophoneDiagnostic(sessionId, "audio_capture_start_requested", {
        state: recorder.state,
        timesliceMs: CHUNK_TIMESLICE_MS,
      });
    } catch (reason) {
      recordMicrophoneDiagnostic(sessionId, "recorder_initialization_failed", {
        category: reason instanceof DOMException ? reason.name : "media_recorder_initialization_error",
      });
      setError("media_recorder_initialization_error");
      setStatus("error");
    }

    return () => {
      if (earlyFlushFrameRef.current !== null) {
        cancelAnimationFrame(earlyFlushFrameRef.current);
        earlyFlushFrameRef.current = null;
      }
      if (recorder && recorder.state !== "inactive" && !stopPromiseRef.current) {
        try { recorder.stop(); } catch { /* Component teardown must remain safe. */ }
      }
      // If a previous session is being replaced, its user action has already
      // finalized it. This release prevents stale recorder events affecting a retry.
      if (recorderRef.current === recorder) recorderRef.current = null;
    };
  }, [sessionId, stream]);

  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    try {
      if (paused && recorder.state === "recording") {
        recorder.pause();
      } else if (!paused && recorder.state === "paused") {
        recorder.resume();
      }
    } catch {
      recordMicrophoneDiagnostic(sessionId, "audio_capture_pause_resume_failed", { category: "media_recorder_state_error" });
      setError("media_recorder_state_error");
      setStatus("error");
    }
  }, [paused, sessionId]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return Promise.resolve(new Blob(chunksRef.current, { type: mimeType }));
    if (stopPromiseRef.current) return stopPromiseRef.current;

    let resolveStop!: (blob: Blob) => void;
    let rejectStop!: (reason: unknown) => void;
    const stopPromise = new Promise<Blob>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    stopPromiseRef.current = stopPromise;
    const finalize = () => {
      window.setTimeout(() => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType });
        recordMicrophoneDiagnostic(sessionId, "final_audio_blob_ready", {
          size: blob.size,
          chunks: chunksRef.current.length,
          elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
        });
        resolveStop(blob);
      }, 0);
    };
    const fail = (reason: Event) => {
      recordMicrophoneDiagnostic(sessionId, "audio_capture_stop_failed", { category: "media_recorder_error" });
      rejectStop(new Error(reason.type));
    };
    recorder.addEventListener("stop", finalize, { once: true });
    recorder.addEventListener("error", fail, { once: true });
    try {
      if (earlyFlushFrameRef.current !== null) {
        cancelAnimationFrame(earlyFlushFrameRef.current);
        earlyFlushFrameRef.current = null;
      }
      if (recorder.state === "inactive") {
        finalize();
      } else {
        recordMicrophoneDiagnostic(sessionId, "audio_capture_final_data_requested", {
          state: recorder.state,
          chunksBeforeRequest: chunksRef.current.length,
          elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
        });
        recorder.requestData();
        recorder.stop();
      }
    } catch (reason) {
      recorder.removeEventListener("stop", finalize);
      recorder.removeEventListener("error", fail);
      rejectStop(reason);
    }
    return stopPromiseRef.current!;
  }, [mimeType, sessionId]);

  const discard = useCallback(() => {
    const recorder = recorderRef.current;
    if (earlyFlushFrameRef.current !== null) {
      cancelAnimationFrame(earlyFlushFrameRef.current);
      earlyFlushFrameRef.current = null;
    }
    chunksRef.current = [];
    stopPromiseRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        recorder.stop();
      } catch {
        recordMicrophoneDiagnostic(sessionId, "discard_stop_failed", { category: "media_recorder_stop_error" });
      }
    }
    recorderRef.current = null;
    setStatus("stopped");
  }, [sessionId]);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (earlyFlushFrameRef.current !== null) {
        cancelAnimationFrame(earlyFlushFrameRef.current);
        earlyFlushFrameRef.current = null;
      }
      if (recorder && recorder.state !== "inactive" && !stopPromiseRef.current) {
        try { recorder.stop(); } catch { /* Component teardown must remain safe. */ }
      }
      if (recorderRef.current === recorder) recorderRef.current = null;
    };
  }, []);

  return { status, mimeType, error, stop, discard };
}
