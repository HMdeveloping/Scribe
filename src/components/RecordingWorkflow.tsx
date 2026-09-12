import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { FolderInput, LoaderCircle, MoreHorizontal, Pause, Pencil, Play, Square, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { AudioPlayer } from "./AudioPlayer";
import { BackButton } from "./BackButton";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { useMicrophoneLevel } from "../hooks/useMicrophoneLevel";
import type { TFunction } from "../i18n";
import type { AppLanguage } from "../i18n";
import type { ContextMenuAction } from "./ContextMenu";
import { formatRecordingDateTime, localizedRecordingTitle } from "./LibraryViews";

export function formatDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, "0")).join(":");
}

export type RecordingMetadata = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  language: "sl";
  audioFile: string;
  mimeType: string;
};

export type TranscriptWord = {
  text: string;
  start: number;
  end: number;
};

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  words?: TranscriptWord[];
};

export type TranscriptData = {
  version: 1 | 2;
  language: string;
  text: string;
  segments: TranscriptSegment[];
};

type SaveRecordingResult = {
  id: string;
  details: {
    recording: RecordingMetadata;
    projectId: string | null;
    projectName: string | null;
    transcriptStatus: string;
    transcript: TranscriptData | null;
  };
};

type RecordingPhase = "preparing" | "recording" | "paused" | "stopping" | "save-error" | "too-short" | "discarding";

export function RecordingView({ onStop, onSaved, onDiscard, onStartNew, t, projectId }: { onStop: (metadata: RecordingMetadata) => void; onSaved: (details: SaveRecordingResult["details"]) => void; onDiscard: () => void; onStartNew: () => void; t: TFunction; projectId?: string | null }) {
  const [phase, setPhase] = useState<RecordingPhase>("preparing");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pendingSave, setPendingSave] = useState<{ blob: Blob; metadata: RecordingMetadata } | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const isPaused = phase === "paused";
  const isStopping = phase === "stopping";
  const isSaveError = phase === "save-error";
  const isTooShort = phase === "too-short";
  const isPreparing = phase === "preparing";
  const isCaptureActive = phase === "preparing" || phase === "recording" || phase === "paused";
  const microphone = useMicrophoneLevel(isPaused || !isCaptureActive);
  const recorder = useAudioRecorder(microphone.stream, isPaused || !isCaptureActive);
  const accumulatedElapsedMs = useRef(0);
  const startedAtMs = useRef<number | null>(null);
  const stopStarted = useRef(false);
  const mountedRef = useRef(true);
  const sessionTokenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    console.info("[recording-lifecycle] start_requested", {
      performanceNowMs: Math.round(performance.now()),
      wallClock: new Date().toISOString(),
    });
    console.info("[recording-timer] session start");
    accumulatedElapsedMs.current = 0;
    startedAtMs.current = null;
    stopStarted.current = false;
    setElapsedMs(0);
    console.info("[recording-timer] elapsedMs reset: 0 ms");
    return () => {
      mountedRef.current = false;
      startedAtMs.current = null;
      stopStarted.current = true;
      sessionTokenRef.current += 1;
      microphone.stop();
    };
  }, []);

  useEffect(() => {
    if (phase !== "preparing" || recorder.status !== "recording") return;
    setPhase("recording");
  }, [phase, recorder.status]);

  useEffect(() => {
    if (phase !== "recording") return;
    startedAtMs.current = performance.now();
    console.info("[recording-timer] startedAt:", `${startedAtMs.current} ms`);
    const interval = window.setInterval(() => {
      if (startedAtMs.current !== null) {
        setElapsedMs(accumulatedElapsedMs.current + performance.now() - startedAtMs.current);
      }
    }, 100);
    return () => {
      window.clearInterval(interval);
      if (startedAtMs.current !== null) {
        accumulatedElapsedMs.current += performance.now() - startedAtMs.current;
        console.info("[recording-timer] pause/freeze snapshot:", `${accumulatedElapsedMs.current} ms`);
        startedAtMs.current = null;
      }
    };
  }, [phase]);

  function snapshotElapsedMs() {
    if (startedAtMs.current !== null) {
      accumulatedElapsedMs.current += performance.now() - startedAtMs.current;
      startedAtMs.current = null;
    }
    setElapsedMs(accumulatedElapsedMs.current);
    console.info("[recording-timer] stop snapshot:", `${accumulatedElapsedMs.current} ms`);
    return accumulatedElapsedMs.current;
  }

  async function saveRecording(blob: Blob, metadata: RecordingMetadata) {
    if (blob.size <= 0) {
      throw new Error("invalid/zero-byte audio");
    }

    let audioBytes: number[];
    try {
      audioBytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    } catch (reason) {
      console.error("Scribe: failed to read finalized recording Blob", reason);
      throw new Error("blob-read-failed");
    }

    try {
      console.info("[recording-save] invoke start");
      console.info("[recording-save] id", metadata.id);
      console.info("[recording-save] projectId", projectId ?? null);
      console.info("[recording-save] blob bytes", blob.size);
      console.info("[recording-save] mime", metadata.mimeType);
      console.info("[recording-save] durationSeconds", metadata.durationSeconds);
      console.info("Scribe: saving recording", {
        recordingId: metadata.id,
        bytes: audioBytes.length,
        mimeType: metadata.mimeType,
        durationSeconds: metadata.durationSeconds,
        projectId: projectId ?? null,
      });
      const result = await invoke<SaveRecordingResult>("save_recording", {
        recordingId: metadata.id,
        audioBytes,
        metadata,
        projectId: projectId ?? null,
      });
      console.info("[recording-save] invoke success", result);
      console.info("Scribe: saved recording", result);
      onSaved(result.details);
    } catch (reason) {
      console.error("[recording-save] invoke error", reason);
      console.error("Scribe: Tauri save_recording failed", {
        recordingId: metadata.id,
        bytes: audioBytes.length,
        reason,
      });
      throw reason;
    }
  }

  async function stopAndSave() {
    if (stopStarted.current) return;
    if (recorder.status !== "recording" && recorder.status !== "paused") {
      console.warn("[recording-lifecycle] stop_requested_before_recorder_ready", {
        recorderStatus: recorder.status,
        microphoneStatus: microphone.status,
      });
      return;
    }
    stopStarted.current = true;
    console.info("[recording-lifecycle] stop_requested", {
      recorderStatus: recorder.status,
      elapsedMs,
      performanceNowMs: Math.round(performance.now()),
      wallClock: new Date().toISOString(),
    });
    const sessionToken = sessionTokenRef.current;
    setPhase("stopping");

    const finalElapsedMs = snapshotElapsedMs();
    console.info("[recording-timer] final elapsedMs:", `${finalElapsedMs} ms`);
    try {
      const blob = await recorder.stop();
      microphone.stop();
      if (blob.size <= 0) {
        console.error("Scribe: MediaRecorder finalized an empty Blob", { mimeType: blob.type || recorder.mimeType });
        setPendingSave(null);
        setPhase("too-short");
        return;
      }
      const metadata: RecordingMetadata = {
        version: 1,
        id: crypto.randomUUID(),
        title: t("newRecordingTitle"),
        createdAt: new Date().toISOString(),
        durationSeconds: Math.max(0, Math.round(finalElapsedMs / 1000)),
        language: "sl",
        audioFile: "audio.webm",
        mimeType: blob.type || recorder.mimeType || "audio/webm",
      };
      setPendingSave({ blob, metadata });
      await saveRecording(blob, metadata);
      if (!mountedRef.current || sessionToken !== sessionTokenRef.current) return;
      setPendingSave(null);
      onStop(metadata);
    } catch (reason) {
      console.error("Scribe: failed to save recording", reason);
      microphone.stop();
      if (!mountedRef.current || sessionToken !== sessionTokenRef.current) return;
      setPhase("save-error");
    }
  }

  async function retrySave() {
    if (!pendingSave || phase === "stopping") return;
    setPhase("stopping");
    try {
      await saveRecording(pendingSave.blob, pendingSave.metadata);
      if (!mountedRef.current) return;
      setPendingSave(null);
      onStop(pendingSave.metadata);
    } catch (reason) {
      console.error("Scribe: failed to save recording on retry", reason);
      if (!mountedRef.current) return;
      setPhase("save-error");
    }
  }

  function requestDiscard() {
    setDiscardDialogOpen(true);
  }

  function confirmDiscard() {
    sessionTokenRef.current += 1;
    stopStarted.current = true;
    setDiscardDialogOpen(false);
    setPhase("discarding");
    setPendingSave(null);
    snapshotElapsedMs();
    recorder.discard();
    microphone.stop();
    onDiscard();
  }

  return (
    <section className={`recording-view${isPaused ? " is-paused" : ""}`} aria-label={t("recording")}>
      <header>
        <h1 className="recording-label">{t("recording")}</h1>
        <div className="recording-timer" role="timer" aria-label={t("elapsedTime")}>{formatDuration(elapsedMs)}</div>
      </header>
      <div className="waveform" aria-hidden="true">
        {microphone.levels.map((level, index) => (
          <span key={index} style={{
            height: `${6 + level * 44}px`,
          }} />
        ))}
      </div>
      <p className={`recording-status${recorder.status === "recording" && phase === "recording" ? " is-listening" : ""}`} role="status">
        <span />{isTooShort ? t("recordingTooShort")
          : recorder.status === "error" ? t("recorderError")
          : isSaveError ? t("saveFailed")
          : isStopping ? t("savingRecording")
          : microphone.status === "error" ? t(microphone.error || "microphoneError")
          : microphone.status === "requesting" || isPreparing ? t("waitingMic")
          : isPaused ? t("paused") : t("listening")}
      </p>
      {isSaveError ? (
        <button className="retry-save-control" onClick={retrySave} disabled={!pendingSave}>
          {t("tryAgain")}
        </button>
      ) : null}
      {isTooShort ? (
        <button className="retry-save-control" onClick={onStartNew}>
          {t("startNewRecording")}
        </button>
      ) : null}
      <div className="live-transcript">
        <h2>{t("liveTranscript")}</h2>
        <p>{t("liveTranscriptPlaceholder")}</p>
      </div>
      {isCaptureActive ? (
        <div className="recording-controls">
          <button className="pause-control" disabled={recorder.status !== "recording" && recorder.status !== "paused"} onClick={() => {
            if (phase === "recording") {
              snapshotElapsedMs();
              console.info("[recording-timer] pause started");
              setPhase("paused");
            } else {
              console.info("[recording-timer] resumed");
              setPhase("recording");
            }
          }}>
            {isPaused ? <Play size={18} /> : <Pause size={18} />}
            {isPaused ? t("resume") : t("pause")}
          </button>
          <button className="stop-control" disabled={recorder.status !== "recording" && recorder.status !== "paused"} onClick={stopAndSave}>
            <Square size={16} fill="currentColor" />{t("stop")}
          </button>
          <button className="discard-control" onClick={requestDiscard}>
            <Trash2 size={17} />{t("discard")}
          </button>
        </div>
      ) : null}
      {discardDialogOpen ? (
        <div className="modal-backdrop modal-backdrop-polished" role="presentation">
          <div className="library-dialog confirm-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("discardRecordingTitle")}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Trash2 size={18} />
            </div>
            <div className="confirm-dialog-copy">
              <h2>{t("discardRecordingTitle")}</h2>
              <p>{t("discardRecordingCopy")}</p>
            </div>
            <div className="dialog-actions confirm-dialog-actions">
              <button type="button" className="dialog-button dialog-button-secondary" onClick={() => setDiscardDialogOpen(false)}>{t("cancel")}</button>
              <button type="button" className="dialog-button dialog-button-danger" onClick={confirmDiscard}>{t("discard")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

type FinalizingViewProps = {
  errorKind?: "model_missing" | "model_downloading" | "model_ready" | "ffmpeg_missing" | "whisper_missing" | "audio_missing" | "conversion_failed" | "transcript_unavailable" | "transcription";
  errorMessage?: string;
  progress?: TranscriptionProgress | null;
  t: TFunction;
  onRetry: () => void;
  onContinue: () => void;
  onOpenTranscriptionSettings: () => void;
  retryDisabled?: boolean;
};

export type TranscriptionProgress = {
  stage: "saving" | "importing" | "preparing" | "transcribing" | "finalizing";
  percent?: number | null;
  downloadedBytes?: number;
  totalBytes?: number;
  durationSeconds?: number;
};

function progressStageLabel(progress: TranscriptionProgress | null | undefined, t: TFunction) {
  if (!progress) return t("finalizingTranscript");
  if (progress.stage === "saving") return t("savingRecording");
  if (progress.stage === "importing") return t("importingAudio");
  if (progress.stage === "preparing") return t("preparingAudio");
  if (progress.stage === "transcribing") return t("transcribing");
  return t("finalizingTranscript");
}

function formatProgressBytes(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function FinalizingView({ errorKind, errorMessage, progress, t, onRetry, onContinue, onOpenTranscriptionSettings, retryDisabled = false }: FinalizingViewProps) {
  if (errorKind) {
    const title = errorKind === "model_missing"
      ? t("transcriptionModelNotInstalledTitle")
      : errorKind === "model_downloading"
        ? t("transcriptionModelDownloadingTitle")
        : errorKind === "model_ready"
          ? t("transcriptionModelReadyTitle")
      : errorKind === "ffmpeg_missing"
        ? t("ffmpegUnavailable")
        : errorKind === "whisper_missing"
          ? t("whisperUnavailable")
          : t("transcriptionFailed");
    const copy = errorKind === "model_missing"
      ? t("transcriptionModelNotInstalledCopy")
      : errorKind === "model_downloading"
        ? errorMessage ?? t("modelDownloadingFriendly")
      : errorKind === "model_ready"
        ? t("transcriptionModelReadyCopy")
      : errorKind === "ffmpeg_missing"
        ? t("installFfmpeg")
        : errorKind === "whisper_missing"
          ? t("installWhisper")
          : t("savedAudioAvailable");

    return <section className="finalizing-view transcription-error-view" role="status">
      <h1>{title}</h1>
      <p>{copy}</p>
      <div className="transcription-error-actions">
        {errorKind === "model_missing" ? (
          <button className="pause-control" onClick={onOpenTranscriptionSettings}>{t("openTranscriptionSettings")}</button>
        ) : (
          <button className="pause-control" onClick={onRetry} disabled={retryDisabled}>{t("retryTranscription")}</button>
        )}
        <button className="stop-control" onClick={onContinue}>{t("continueWithoutTranscript")}</button>
      </div>
    </section>;
  }

  const isDeterminate = typeof progress?.percent === "number";

  return <section className="finalizing-view" role="status">
    <LoaderCircle className="processing-spinner" size={30} aria-hidden="true" />
    <h1>{progressStageLabel(progress, t)}</h1>
    <div className={`work-progress${isDeterminate ? "" : " is-indeterminate"}`}>
      <div style={isDeterminate ? { width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%` } : undefined} />
    </div>
    {isDeterminate ? <p>{Math.round(progress?.percent ?? 0)}%</p> : <p>{t("improvingQuality")}</p>}
    {progress?.downloadedBytes !== undefined ? (
      <p>{formatProgressBytes(progress.downloadedBytes)}{progress.totalBytes ? ` ${t("of")} ${formatProgressBytes(progress.totalBytes)}` : ""}</p>
    ) : progress?.durationSeconds ? (
      <p>{formatDuration(progress.durationSeconds * 1000)} {t("audio")}</p>
    ) : null}
  </section>;
}

type FlatWord = {
  globalIndex: number;
  segmentIndex: number;
  wordIndex: number;
  text: string;
  start: number;
  end: number;
};

function buildFlatWordIndex(segments: TranscriptSegment[]): FlatWord[] {
  const flat: FlatWord[] = [];
  segments.forEach((segment, segmentIndex) => {
    (segment.words ?? []).forEach((word, wordIndex) => {
      if (word.end > word.start) {
        flat.push({ globalIndex: flat.length, segmentIndex, wordIndex, text: word.text, start: word.start, end: word.end });
      }
    });
  });
  return flat;
}

function findActiveWordIndex(flatWords: FlatWord[], currentTime: number, lastIndex: number): number {
  if (flatWords.length === 0) return -1;
  const isActiveAtTime = (index: number) => {
    const word = flatWords[index];
    return currentTime >= word.start && currentTime < word.end;
  };

  if (lastIndex >= 0 && lastIndex < flatWords.length) {
    if (isActiveAtTime(lastIndex)) return lastIndex;
    if (lastIndex + 1 < flatWords.length && isActiveAtTime(lastIndex + 1)) return lastIndex + 1;
    if (lastIndex > 0 && isActiveAtTime(lastIndex - 1)) return lastIndex - 1;
  }

  let lo = 0;
  let hi = flatWords.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const word = flatWords[mid];
    if (currentTime < word.start) {
      hi = mid - 1;
    } else if (currentTime >= word.end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }

  return -1;
}

function TranscriptContent({ transcript, player, t }: { transcript: TranscriptData; player: ReturnType<typeof useAudioPlayer>; t: TFunction }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const flatWords = useMemo(() => buildFlatWordIndex(transcript.segments), [transcript.segments]);
  const wordIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    flatWords.forEach((word, index) => {
      map.set(`${word.segmentIndex}:${word.wordIndex}`, index);
    });
    return map;
  }, [flatWords]);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const lastIndexRef = useRef(-1);
  const animationFrameRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  const centerFollowActiveRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);

  const updateActiveWord = useCallback((time: number) => {
    const newIndex = findActiveWordIndex(flatWords, time, lastIndexRef.current);
    if (newIndex !== lastIndexRef.current) {
      lastIndexRef.current = newIndex;
      setActiveWordIndex(newIndex);
    }
  }, [flatWords]);

  useEffect(() => {
    if (!player.isPlaying) {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const tick = () => {
      updateActiveWord(player.readCurrentTime());
      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [player.isPlaying, player.readCurrentTime, updateActiveWord]);

  useEffect(() => {
    updateActiveWord(player.currentTime);
  }, [player.currentTime, updateActiveWord]);

  useEffect(() => () => {
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollRef.current = true;
    if (programmaticScrollTimeoutRef.current !== null) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 700);
  }, []);

  const scrollActiveLine = useCallback((behavior: ScrollBehavior = "auto", forceCenter = false) => {
    const container = containerRef.current;
    const line = activeLineRef.current;
    if (!container || !line) return;

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const containerRect = container.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const lineCenter = lineRect.top + lineRect.height / 2;
      const viewportCenter = containerRect.top + container.clientHeight / 2;
      const bottomGuard = containerRect.bottom - Math.min(64, container.clientHeight * 0.18);
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);

      if (forceCenter) {
        centerFollowActiveRef.current = true;
      } else if (!centerFollowActiveRef.current && lineCenter >= viewportCenter) {
        centerFollowActiveRef.current = true;
      }

      let nextScrollTop = container.scrollTop;
      if (centerFollowActiveRef.current) {
        nextScrollTop += lineCenter - viewportCenter;
      } else if (lineRect.bottom > bottomGuard) {
        nextScrollTop += lineRect.bottom - bottomGuard;
      } else {
        return;
      }

      nextScrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
      if (Math.abs(nextScrollTop - container.scrollTop) < 8) return;
      markProgrammaticScroll();
      container.scrollTo({ top: nextScrollTop, behavior });
    });
  }, [markProgrammaticScroll]);

  useEffect(() => {
    if (!isFollowing || activeWordIndex < 0) return;
    scrollActiveLine("auto");
  }, [activeWordIndex, isFollowing, scrollActiveLine]);

  const handleUserScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    setIsFollowing(false);
    centerFollowActiveRef.current = false;
  }, []);

  const handleWordClick = useCallback((word: FlatWord) => {
    centerFollowActiveRef.current = true;
    setIsFollowing(true);
    player.seekTo(word.start);
    updateActiveWord(word.start);
    window.setTimeout(() => scrollActiveLine("smooth", true), 0);
  }, [player.seekTo, scrollActiveLine, updateActiveWord]);

  const resumeFollowing = useCallback(() => {
    centerFollowActiveRef.current = true;
    setIsFollowing(true);
    updateActiveWord(player.readCurrentTime());
    window.setTimeout(() => scrollActiveLine("smooth", true), 0);
  }, [player.readCurrentTime, scrollActiveLine, updateActiveWord]);

  const hasTimedWords = flatWords.length > 0;

  return (
    <div className="transcript-content-wrapper">
      {!hasTimedWords && (
        <p className="transcript-unavailable">{t("timedTranscriptUnavailable")}</p>
      )}
      <div
        ref={containerRef}
        className="transcript-copy transcript-scroll-area"
        onScroll={handleUserScroll}
      >
        {transcript.segments.map((segment, segmentIndex) => (
          <p
            key={`segment-${segmentIndex}`}
            ref={activeWordIndex >= 0 && flatWords[activeWordIndex]?.segmentIndex === segmentIndex ? activeLineRef : null}
            className="transcript-segment"
          >
            {(segment.words?.length ?? 0) > 0 ? (
              segment.words!.map((word, wordIndex) => {
                const flatIndex = wordIndexMap.get(`${segmentIndex}:${wordIndex}`) ?? -1;
                const isActive = flatIndex === activeWordIndex;
                const timedWord = flatIndex >= 0 ? flatWords[flatIndex] : null;
                const isClickable = timedWord !== null;
                return (
                  <span key={`word-wrap-${segmentIndex}-${wordIndex}`}>
                    {wordIndex > 0 ? " " : ""}
                    <span
                      ref={isActive ? activeWordRef : null}
                      className={`transcript-word${isActive ? " is-active" : ""}${isClickable ? " is-timed" : ""}`}
                      onClick={() => isClickable && handleWordClick(timedWord!)}
                      role={isClickable ? "button" : undefined}
                      tabIndex={isClickable ? 0 : undefined}
                      onKeyDown={(e) => { if (isClickable && (e.key === "Enter" || e.key === " ")) handleWordClick(timedWord!); }}
                      aria-label={word.text}
                    >
                      {word.text}
                    </span>
                  </span>
                );
              })
            ) : (
              <span className="transcript-word">{segment.text}</span>
            )}
          </p>
        ))}
      </div>
      {hasTimedWords && !isFollowing && (
        <button className="follow-transcript-btn" onClick={resumeFollowing}>
          {t("followTranscript")}
        </button>
      )}
    </div>
  );
}

export function TranscriptView({
  recording,
  transcript,
  t,
  appLanguage,
  onRename,
  onMoveToProject,
  actions,
  projectName,
  canGoBack,
  onBack,
  onContextMenu,
}: {
  recording: RecordingMetadata;
  transcript: TranscriptData | null;
  t: TFunction;
  appLanguage: AppLanguage;
  onRename?: (title: string) => Promise<void> | void;
  onMoveToProject?: () => void;
  actions?: ContextMenuAction[];
  projectName?: string | null;
  canGoBack?: boolean;
  onBack?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}) {
  const [tab, setTab] = useState<"transcript" | "notes" | "summary">("transcript");
  const [isRenaming, setIsRenaming] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(recording.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const player = useAudioPlayer(recording.id, recording.mimeType, recording.durationSeconds);
  const tabs = [
    { id: "transcript" as const, label: t("transcript") },
    { id: "notes" as const, label: t("notes") },
    { id: "summary" as const, label: t("summary") },
  ];

  useEffect(() => {
    setDraftTitle(recording.title);
  }, [recording.title]);

  useEffect(() => {
    if (!isRenaming) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isRenaming]);

  useEffect(() => {
    if (!actionsOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (actionsRef.current?.contains(event.target as Node)) return;
      setActionsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActionsOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  async function commitRename() {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setDraftTitle(recording.title);
      setIsRenaming(false);
      return;
    }
    if (nextTitle !== recording.title) {
      await onRename?.(nextTitle);
    }
    setIsRenaming(false);
  }

  function cancelRename() {
    setDraftTitle(recording.title);
    setIsRenaming(false);
  }

  return (
    <section className="transcript-view">
      <header>
        {canGoBack && onBack ? <BackButton t={t} onBack={onBack} /> : null}
        <div className="transcript-title-row" onContextMenu={onContextMenu}>
          {isRenaming ? (
            <input
              ref={titleInputRef}
              className="inline-title-input transcript-title-input"
              value={draftTitle}
              maxLength={100}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              aria-label={t("renameRecording")}
            />
          ) : (
            <button
              className="editable-title-button transcript-title-button"
              onClick={() => {
                if (onRename) setIsRenaming(true);
              }}
              disabled={!onRename}
              title={onRename ? t("renameRecording") : undefined}
            >
            <h1>{localizedRecordingTitle(recording.title, t)}</h1>
            </button>
          )}
            {onRename || onMoveToProject || (actions && actions.length > 0) ? (
              <div className="recording-actions" ref={actionsRef}>
                <button className="icon-button" aria-label={t("recordingActions")} onClick={() => setActionsOpen((open) => !open)}>
                  <MoreHorizontal size={18} />
                </button>
                {actionsOpen ? (
                  <div className="recording-actions-menu">
                    {actions && actions.length > 0 ? actions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.id}
                          className={`${action.separatorBefore ? " has-separator" : ""}${action.destructive ? " is-destructive" : ""}`}
                          onClick={() => {
                            setActionsOpen(false);
                            action.onSelect();
                          }}
                        >
                          {Icon ? <Icon size={15} /> : null}{action.label}
                        </button>
                      );
                    }) : (
                      <>
                      {onRename ? (
                        <button onClick={() => { setActionsOpen(false); setIsRenaming(true); }}>
                          <Pencil size={15} />{t("renameRecording")}
                        </button>
                      ) : null}
                      {onMoveToProject ? (
                        <button onClick={() => { setActionsOpen(false); onMoveToProject(); }}>
                          <FolderInput size={15} />{t("moveToProject")}
                        </button>
                      ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        <p className="transcript-metadata">
          {formatRecordingDateTime(recording.createdAt, appLanguage)} <span aria-hidden="true">·</span> {formatDuration(recording.durationSeconds * 1000)} <span aria-hidden="true">·</span> {t("slovenian")}
          {projectName ? <><span aria-hidden="true">·</span> {projectName}</> : null}
        </p>
      </header>
      <div className="transcript-tabs" aria-label={t("recordingContent")}>
        {tabs.map((item) => (
          <button key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {tab === "transcript" ? (
        transcript && transcript.segments.length > 0 ? (
          <TranscriptContent transcript={transcript} player={player} t={t} />
        ) : (
          <p className="transcript-placeholder">{t("transcriptUnavailable")}</p>
        )
      ) : (
        <p className="transcript-placeholder">{t("tabPlaceholder")}</p>
      )}
      <AudioPlayer player={player} t={t} />
    </section>
  );
}
