import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type LoadRecordingAudioResult = {
  audioBytes: number[] | Uint8Array;
  mimeType: string;
};

type AudioStatus = "loading" | "ready" | "error";

const END_EPSILON_SECONDS = 0.15;

function readSeekableDuration(audio: HTMLAudioElement) {
  if (audio.seekable.length === 0) return 0;
  return audio.seekable.end(audio.seekable.length - 1);
}

function resolveDuration(audio: HTMLAudioElement, fallbackDurationSeconds: number) {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  const seekableDuration = readSeekableDuration(audio);
  if (Number.isFinite(seekableDuration) && seekableDuration > 0) return seekableDuration;
  return fallbackDurationSeconds;
}

export function formatPlaybackTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor(safeSeconds / 60) % 60;
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  return [minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function useAudioPlayer(recordingId: string, fallbackMimeType: string, fallbackDurationSeconds: number) {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const objectUrlRef = useRef<string | null>(null);
  const loadTokenRef = useRef(0);
  const [status, setStatus] = useState<AudioStatus>("loading");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDurationSeconds);
  const [canSeek, setCanSeek] = useState(false);

  const syncDuration = useCallback(() => {
    const audio = audioRef.current;
    const nextDuration = resolveDuration(audio, fallbackDurationSeconds);
    setDuration(nextDuration);
    setCanSeek(Number.isFinite(audio.duration) && audio.duration > 0 && audio.seekable.length > 0);
  }, [fallbackDurationSeconds]);

  useEffect(() => {
    const audio = audioRef.current;

    function handleLoadedMetadata() {
      syncDuration();
      setStatus("ready");
    }

    function handleCanPlay() {
      syncDuration();
      setStatus("ready");
    }

    function handleDurationChange() {
      syncDuration();
    }

    function handleTimeUpdate() {
      setCurrentTime(audio.currentTime);
    }

    function handlePlay() {
      setIsPlaying(true);
    }

    function handlePause() {
      setIsPlaying(false);
    }

    function handleEnded() {
      setIsPlaying(false);
      setCurrentTime(resolveDuration(audio, fallbackDurationSeconds));
    }

    function handleError() {
      if (!audio.src) return;
      console.error("Scribe audio: error event", {
        code: audio.error?.code,
        message: audio.error?.message,
        networkState: audio.networkState,
        readyState: audio.readyState,
      });
      setStatus("error");
      setIsPlaying(false);
    }

    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [fallbackDurationSeconds, syncDuration]);

  useEffect(() => {
    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    const audio = audioRef.current;

    setStatus("loading");
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(fallbackDurationSeconds);
    setCanSeek(false);

    audio.pause();
    audio.removeAttribute("src");
    audio.load();

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    async function loadAudio() {
      try {
        const result = await invoke<LoadRecordingAudioResult>("load_recording_audio", { recordingId });
        if (loadTokenRef.current !== token) return;

        const audioBytes = result.audioBytes instanceof Uint8Array
          ? result.audioBytes
          : new Uint8Array(result.audioBytes);
        const mimeType = result.mimeType || fallbackMimeType || "audio/webm";

        const audioBuffer = audioBytes.buffer.slice(
          audioBytes.byteOffset,
          audioBytes.byteOffset + audioBytes.byteLength,
        ) as ArrayBuffer;
        const blob = new Blob([audioBuffer], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        objectUrlRef.current = objectUrl;

        audio.src = objectUrl;
        audio.load();
      } catch (reason) {
        console.error("Scribe audio: failed to load recording bytes", reason);
        if (loadTokenRef.current === token) setStatus("error");
      }
    }

    void loadAudio();

    return () => {
      loadTokenRef.current += 1;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [fallbackDurationSeconds, fallbackMimeType, recordingId]);

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    const nextDuration = resolveDuration(audio, fallbackDurationSeconds);
    const nextTime = Math.min(Math.max(seconds, 0), nextDuration || 0);

    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }, [fallbackDurationSeconds]);

  const readCurrentTime = useCallback(() => audioRef.current.currentTime, []);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (status !== "ready") return;

    if (!audio.paused) {
      audio.pause();
      return;
    }

    const nextDuration = resolveDuration(audio, fallbackDurationSeconds);
    if (audio.ended || audio.currentTime >= nextDuration - END_EPSILON_SECONDS) {
      audio.currentTime = 0;
      setCurrentTime(0);
    }

    try {
      await audio.play();
    } catch (reason) {
      console.warn("Scribe audio: play() was rejected", reason);
    }
  }, [fallbackDurationSeconds, status]);

  return {
    status,
    isPlaying,
    currentTime,
    duration,
    canSeek,
    togglePlayback,
    seekTo,
    readCurrentTime,
  };
}
