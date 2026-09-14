import { useCallback, useEffect, useRef, useState } from "react";

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

export function useAudioRecorder(stream: MediaStream | null, paused: boolean) {
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
      console.info("[recording-lifecycle] media_stream_ready", {
        audioTracks: stream.getAudioTracks().length,
        active: stream.active,
        performanceNowMs: Math.round(performance.now()),
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
      console.info("[recording-lifecycle] media_recorder_created", {
        mimeType: recorder.mimeType || selectedMimeType || "",
        state: recorder.state,
        timesliceMs: CHUNK_TIMESLICE_MS,
        performanceNowMs: Math.round(performance.now()),
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          chunkCountRef.current += 1;
          const elapsedMs = startedAtRef.current === null ? null : Math.round(performance.now() - startedAtRef.current);
          if (!firstChunkReceivedRef.current) {
            firstChunkReceivedRef.current = true;
            console.info("[recording-lifecycle] first_dataavailable", {
              size: event.data.size,
              elapsedMs,
              performanceNowMs: Math.round(performance.now()),
            });
          }
          console.info("[recording-lifecycle] dataavailable", {
            chunkIndex: chunkCountRef.current,
            size: event.data.size,
            elapsedMs,
          });
        }
      };
      recorder.onerror = (event) => {
        console.error("Scribe: MediaRecorder failed", event);
        setError("Unable to record audio.");
        setStatus("error");
      };
      recorder.onstart = () => {
        startedAtRef.current = performance.now();
        console.info("[recording-lifecycle] media_recorder_onstart", {
          state: recorder?.state,
          startDelayMs: startRequestedAtRef.current === null ? null : Math.round(startedAtRef.current - startRequestedAtRef.current),
          performanceNowMs: Math.round(startedAtRef.current),
        });
        earlyFlushFrameRef.current = requestAnimationFrame(() => {
          earlyFlushFrameRef.current = null;
          if (!recorder || recorder.state !== "recording") return;
          try {
            console.info("[recording-lifecycle] media_recorder_request_data_after_start", {
              state: recorder.state,
              elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
              chunksBeforeRequest: chunksRef.current.length,
              performanceNowMs: Math.round(performance.now()),
            });
            recorder.requestData();
          } catch (reason) {
            console.warn("Scribe: early MediaRecorder requestData failed", reason);
          }
        });
        setStatus("recording");
      };
      recorder.onpause = () => setStatus("paused");
      recorder.onresume = () => setStatus("recording");
      recorder.onstop = () => {
        const durationMs = startedAtRef.current === null ? 0 : performance.now() - startedAtRef.current;
        console.info("[recording-lifecycle] media_recorder_onstop", {
          chunks: chunksRef.current.length,
          finalBlobSize: chunksRef.current.reduce((total, chunk) => total + chunk.size, 0),
          elapsedRecordingDurationMs: Math.round(durationMs),
        });
        setStatus("stopped");
      };
      startRequestedAtRef.current = performance.now();
      recorder.start(CHUNK_TIMESLICE_MS);
      console.info("[recording-lifecycle] media_recorder_start_called", {
        state: recorder.state,
        timesliceMs: CHUNK_TIMESLICE_MS,
        performanceNowMs: Math.round(startRequestedAtRef.current),
      });
    } catch (reason) {
      console.error("Scribe: MediaRecorder initialization failed", reason);
      setError("Unable to record audio.");
      setStatus("error");
    }

    return () => {
      if (earlyFlushFrameRef.current !== null) {
        cancelAnimationFrame(earlyFlushFrameRef.current);
        earlyFlushFrameRef.current = null;
      }
      if (recorder && recorder.state !== "inactive" && !stopPromiseRef.current) {
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      stopPromiseRef.current = null;
      startedAtRef.current = null;
      firstChunkReceivedRef.current = false;
      startRequestedAtRef.current = null;
      chunkCountRef.current = 0;
    };
  }, [stream]);

  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    if (paused && recorder.state === "recording") {
      recorder.pause();
    } else if (!paused && recorder.state === "paused") {
      recorder.resume();
    }
  }, [paused]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return Promise.resolve(new Blob(chunksRef.current, { type: mimeType }));
    if (stopPromiseRef.current) return stopPromiseRef.current;

    stopPromiseRef.current = new Promise<Blob>((resolve, reject) => {
      const finalize = () => {
        window.setTimeout(() => {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType });
          console.info("[recording-lifecycle] final_blob", {
            size: blob.size,
            type: blob.type,
            chunks: chunksRef.current.length,
            elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
          });
          resolve(blob);
        }, 0);
      };
      const fail = (reason: unknown) => reject(reason);
      recorder.addEventListener("stop", finalize, { once: true });
      recorder.addEventListener("error", fail, { once: true });

      try {
        if (earlyFlushFrameRef.current !== null) {
          cancelAnimationFrame(earlyFlushFrameRef.current);
          earlyFlushFrameRef.current = null;
        }
        if (recorder.state === "inactive") {
          recorder.removeEventListener("stop", finalize);
          finalize();
        } else {
          console.info("[recording-lifecycle] media_recorder_request_data_before_stop", {
            state: recorder.state,
            chunksBeforeRequest: chunksRef.current.length,
            elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
          });
          recorder.requestData();
          recorder.stop();
        }
      } catch (reason) {
        recorder.removeEventListener("stop", finalize);
        fail(reason);
      }
    });

    return stopPromiseRef.current;
  }, [mimeType]);

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
      } catch (reason) {
        console.warn("Scribe: unable to stop discarded recorder", reason);
      }
    }
    recorderRef.current = null;
    setStatus("stopped");
  }, []);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (earlyFlushFrameRef.current !== null) {
        cancelAnimationFrame(earlyFlushFrameRef.current);
        earlyFlushFrameRef.current = null;
      }
      if (recorder && recorder.state !== "inactive" && !stopPromiseRef.current) {
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      stopPromiseRef.current = null;
      startedAtRef.current = null;
      firstChunkReceivedRef.current = false;
      startRequestedAtRef.current = null;
      chunkCountRef.current = 0;
    };
  }, []);

  return { status, mimeType, error, stop, discard };
}
