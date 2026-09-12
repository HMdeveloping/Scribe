import { useCallback, useEffect, useRef, useState } from "react";

const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

const CHUNK_TIMESLICE_MS = 1000;

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

  useEffect(() => {
    if (!stream || recorderRef.current) return;
    let recorder: MediaRecorder | null = null;

    try {
      console.info("[recording-lifecycle] media_stream_ready", {
        audioTracks: stream.getAudioTracks().length,
        active: stream.active,
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
      setMimeType(recorder.mimeType || selectedMimeType);
      console.info("[recording-lifecycle] media_recorder_created", {
        mimeType: recorder.mimeType || selectedMimeType || "",
        state: recorder.state,
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
          if (!firstChunkReceivedRef.current) {
            firstChunkReceivedRef.current = true;
            console.info("[recording-lifecycle] first_dataavailable", {
              size: event.data.size,
              elapsedMs: startedAtRef.current === null ? null : Math.round(performance.now() - startedAtRef.current),
            });
          }
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
      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (reason) {
      console.error("Scribe: MediaRecorder initialization failed", reason);
      setError("Unable to record audio.");
      setStatus("error");
    }

    return () => {
      if (recorder && recorder.state !== "inactive" && !stopPromiseRef.current) {
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      stopPromiseRef.current = null;
      startedAtRef.current = null;
      firstChunkReceivedRef.current = false;
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
            elapsedRecordingDurationMs: startedAtRef.current === null ? 0 : Math.round(performance.now() - startedAtRef.current),
          });
          resolve(blob);
        }, 0);
      };
      const fail = (reason: unknown) => reject(reason);
      recorder.addEventListener("stop", finalize, { once: true });
      recorder.addEventListener("error", fail, { once: true });

      try {
        if (recorder.state === "inactive") {
          recorder.removeEventListener("stop", finalize);
          finalize();
        } else {
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
      if (recorder && recorder.state !== "inactive" && !stopPromiseRef.current) {
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      stopPromiseRef.current = null;
      startedAtRef.current = null;
      firstChunkReceivedRef.current = false;
    };
  }, []);

  return { status, mimeType, error, stop, discard };
}
