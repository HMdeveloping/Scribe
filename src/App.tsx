import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  AudioLines,
  Archive,
  FolderInput,
  Home,
  FolderClosed,
  Pencil,
  RotateCcw,
  Search,
  Mic,
  Upload,
  Settings,
  ArrowRight,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
} from "lucide-react";

import "./App.css";
import scribeIcon from "./assets/scribe-icon.png";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import {
  RecordingView,
  TranscriptView,
  FinalizingView,
  type RecordingMetadata,
  type TranscriptionProgress,
  type TranscriptData,
} from "./components/RecordingWorkflow";
import {
  HomeRecentRecordings,
  MainContentSelectionBoundary,
  SidebarNavigationItem,
  localizedRecordingTitle,
  MoveToProjectDialog,
  ProjectDialog,
  ProjectDetailView,
  ProjectsView,
  RecordingsView,
  RenameDialog,
  SidebarSelectionBoundary,
} from "./components/LibraryViews";
import { ContextMenu, type ContextMenuAction, type ContextMenuState } from "./components/ContextMenu";
import { localizedModel, SettingsView, type SettingsViewData, type UpdateProgress, type UpdateStatus } from "./components/SettingsView";
import { Onboarding } from "./components/Onboarding";
import { WebviewContextMenuGuard } from "./components/WebviewContextMenuGuard";
import { useWhisperModelDownloads } from "./hooks/useWhisperModelDownloads";
import { createTranslator, currentGreetingKey, type AppLanguage, type TranslationKey } from "./i18n";
import type { Project, RecordingDetails, RecordingSummary } from "./types/library";

const isMicrosoftStoreBuild = import.meta.env.VITE_SCRIBE_CHANNEL === "microsoft-store";

type TranscriptionErrorKind = "model_missing" | "model_downloading" | "model_ready" | "ffmpeg_missing" | "whisper_missing" | "audio_missing" | "conversion_failed" | "transcript_unavailable" | "transcription";

type ClassifiedTranscriptionError = {
  kind: TranscriptionErrorKind;
  message?: string;
};

type UpdaterErrorKind = "network" | "server" | "configuration" | "unknown";

type ClassifiedUpdaterError = {
  kind: UpdaterErrorKind;
  titleKey: TranslationKey;
  copyKey: TranslationKey;
  message: string;
  name?: string;
};

function updaterErrorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function classifyUpdaterError(reason: unknown): ClassifiedUpdaterError {
  const message = updaterErrorMessage(reason);
  const lowerMessage = message.toLowerCase();
  const name = reason instanceof Error ? reason.name : undefined;

  if (/(network|dns|resolve|connection|connect|offline|timed?\s*out|timeout|could not fetch|failed to fetch|request error)/i.test(message)) {
    return {
      kind: "network",
      titleKey: "couldntCheckForUpdates",
      copyKey: "updateCheckNetworkCopy",
      message,
      name,
    };
  }

  if (
    /(signature|sign|pubkey|public key|invalid|parse|json|platform|target|darwin|windows|not contained|not found in|config)/i.test(message) ||
    lowerMessage.includes("no updater")
  ) {
    return {
      kind: "configuration",
      titleKey: "updateCheckConfigurationTitle",
      copyKey: "updateCheckConfigurationCopy",
      message,
      name,
    };
  }

  if (/(http|status|404|403|500|502|503|endpoint|server|unavailable|not found|latest\.json)/i.test(message)) {
    return {
      kind: "server",
      titleKey: "updateCheckServerTitle",
      copyKey: "updateCheckServerCopy",
      message,
      name,
    };
  }

  return {
    kind: "unknown",
    titleKey: "updateCheckConfigurationTitle",
    copyKey: "updateCheckConfigurationCopy",
    message,
    name,
  };
}

function logUpdaterError(context: "manual" | "startup" | "install", reason: unknown) {
  const classified = classifyUpdaterError(reason);
  console.error("Scribe updater operation failed", {
    context,
    kind: classified.kind,
    name: classified.name,
    message: classified.message,
  });
  return classified;
}

const releaseNotes: Record<string, { itemKeys: TranslationKey[] }> = {
  "0.1.17": {
    itemKeys: [
      "whatsNew0117TranscriptReadability",
      "whatsNew0117MacIcon",
    ],
  },
  "0.1.16": {
    itemKeys: [
      "whatsNew0116ReliabilityReadability",
    ],
  },
  "0.1.15": {
    itemKeys: [
      "whatsNew0115ZeroDurationLoops",
    ],
  },
  "0.1.14": {
    itemKeys: [
      "whatsNew0114RepetitionHallucinations",
    ],
  },
  "0.1.13": {
    itemKeys: [
      "whatsNew0113ViewportLayout",
    ],
  },
  "0.1.12": {
    itemKeys: [
      "whatsNew0112FollowLayout",
    ],
  },
  "0.1.11": {
    itemKeys: [
      "whatsNew0111TranscriptReadability",
      "whatsNew0111FollowTranscript",
      "whatsNew0111PlayerLayout",
      "whatsNew0111RecordingStart",
      "whatsNew0111Icon",
    ],
  },
  "0.1.10": {
    itemKeys: [
      "whatsNew0110RecordingStart",
      "whatsNew0110FollowTranscript",
      "whatsNew0110UpdaterLocalization",
      "whatsNew0110TranscriptCharacters",
      "whatsNew0110Icon",
    ],
  },
  "0.1.9": {
    itemKeys: [
      "whatsNew019RecordingStart",
      "whatsNew019WordFollow",
      "whatsNew019TranscriptFollow",
      "whatsNew019Icon",
    ],
  },
  "0.1.8": {
    itemKeys: [
      "whatsNew018ImportTranscription",
      "whatsNew018RecordingStart",
      "whatsNew018MacInstaller",
      "whatsNew018Icon",
    ],
  },
  "0.1.7": {
    itemKeys: [
      "whatsNew017RecordingStartup",
      "whatsNew017ImportDiagnostics",
      "whatsNew017MacInstaller",
    ],
  },
  "0.1.6": {
    itemKeys: [
      "whatsNew016ImportedTranscription",
      "whatsNew016MacInstall",
      "whatsNew016MacIcon",
      "whatsNew016Troubleshooting",
    ],
  },
  "0.1.5": {
    itemKeys: [
      "whatsNew015ModelDownloads",
      "whatsNew015LargeModels",
    ],
  },
  "0.1.4": {
    itemKeys: [
      "whatsNew014ReliableRecording",
      "whatsNew014LongImports",
      "whatsNew014ImmediateVisibility",
      "whatsNew014Localization",
      "whatsNew014LayoutFixes",
    ],
  },
};

type ImportAudioProgress = {
  importId: string;
  recordingId?: string;
  stage: "importing" | "preparing" | "transcribing" | "finalizing";
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
};

type RecordingProgressEvent = {
  recordingId: string;
  runId: string;
  stage: "preparing" | "transcribing" | "finalizing";
  durationSeconds?: number;
  percent?: number;
};

type SidebarMode = "auto" | "expanded" | "collapsed";
type ViewName = "home" | "projects" | "recordings" | "archived-recordings" | "project-detail" | "recording" | "transcript" | "settings";
type NavEntry = {
  view: ViewName;
  projectId?: string | null;
  recordingId?: string | null;
};

type DeleteRecordingsResult = {
  deletedIds: string[];
  failed: { id: string; error: string }[];
};

type DeleteProjectsResult = {
  deletedIds: string[];
  clearedRecordingCount: number;
};

type UpdateDetails = {
  version: string;
  body?: string;
  date?: string;
};

function isTopLevelView(viewName: ViewName) {
  return viewName === "home" || viewName === "projects" || viewName === "recordings" || viewName === "settings";
}

function classifyTranscriptionError(reason: unknown): ClassifiedTranscriptionError {
  const kind = typeof reason === "object" && reason !== null && "kind" in reason
    ? String((reason as { kind: unknown }).kind)
    : "";
  const message = typeof reason === "object" && reason !== null && "message" in reason
    ? String((reason as { message: unknown }).message)
    : undefined;

  if (kind === "model_missing") return { kind: "model_missing", message };
  if (kind === "model_downloading") return { kind: "model_downloading", message };
  if (kind === "ffmpeg_missing") return { kind: "ffmpeg_missing", message };
  if (kind === "whisper_missing") return { kind: "whisper_missing", message };
  if (kind === "invalid_recording") return { kind: "audio_missing", message };
  if (kind === "conversion_failed") return { kind: "conversion_failed", message };
  if (kind === "transcript_unavailable") return { kind: "transcript_unavailable", message };
  return { kind: "transcription", message };
}

function recordingTimeValue(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+$/.test(value)) {
    return numeric * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByLibraryRecency(items: RecordingSummary[]) {
  return [...items].sort((left, right) => {
    const updatedDelta = recordingTimeValue(right.updatedAt) - recordingTimeValue(left.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return recordingTimeValue(right.createdAt) - recordingTimeValue(left.createdAt);
  });
}

function App() {
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  const [view, setView] = useState<ViewName>("home");
  const [history, setHistory] = useState<NavEntry[]>([]);
  const [finalizing, setFinalizing] = useState(false);
  const [recording, setRecording] = useState<RecordingMetadata | null>(null);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [archivedRecordings, setArchivedRecordings] = useState<RecordingSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projectRecordings, setProjectRecordings] = useState<RecordingSummary[]>([]);
  const [recordingProjectId, setRecordingProjectId] = useState<string | null>(null);
  const [recordingProjectName, setRecordingProjectName] = useState<string | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ recordingIds: string[]; projectId: string | null } | null>(null);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const [projectDeleteTargetIds, setProjectDeleteTargetIds] = useState<string[]>([]);
  const [projectDeleteDialogOpen, setProjectDeleteDialogOpen] = useState(false);
  const [projectDeleteInProgress, setProjectDeleteInProgress] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<Project | null>(null);
  const [renameRecordingTarget, setRenameRecordingTarget] = useState<RecordingSummary | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [appLanguage, setAppLanguage] = useState<AppLanguage>("en");
  const [transcriptionError, setTranscriptionError] = useState<ClassifiedTranscriptionError | undefined>();
  const [finalizingProgress, setFinalizingProgress] = useState<TranscriptionProgress | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("auto");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const titlebarToggleRef = useRef<HTMLButtonElement>(null);
  const activeSelectionClearRef = useRef<() => void>(() => {});
  const [sharedRecordingSelectedIds, setSharedRecordingSelectedIds] = useState<Set<string>>(new Set());
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [isNarrowSidebarRange, setIsNarrowSidebarRange] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 980px)").matches;
  });
  const t = useMemo(() => createTranslator(appLanguage), [appLanguage]);
  const activeRecordingProgressIdRef = useRef<string | null>(null);
  const activeTranscriptionRunRef = useRef<{ recordingId: string; runId: string } | null>(null);
  const activeTranscriptionOriginRef = useRef<"new" | "existing" | "imported" | null>(null);
  const activeTranscriptionPromiseRef = useRef<Promise<unknown> | null>(null);
  const transcriptionCommandStartedRef = useRef(false);
  const activeImportProgressIdRef = useRef<string | null>(null);
  const updateRef = useRef<Update | null>(null);
  const dismissedUpdateVersionRef = useRef<string | null>(null);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateDetails, setUpdateDetails] = useState<UpdateDetails | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState("");
  const [updateErrorCopy, setUpdateErrorCopy] = useState("");
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [settingsData, setSettingsData] = useState<SettingsViewData | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingDismissedThisSession, setOnboardingDismissedThisSession] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState("General");
  const [recordingSessionKey, setRecordingSessionKey] = useState(0);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const freshInstallRef = useRef(false);
  const baselinedFreshInstallVersionRef = useRef<string | null>(null);


  const currentNavEntry = useCallback((): NavEntry => ({
    view,
    projectId: activeProject?.id ?? recordingProjectId ?? null,
    recordingId: recording?.id ?? null,
  }), [activeProject?.id, recording?.id, recordingProjectId, view]);

  const applyNavEntry = useCallback(async (entry: NavEntry) => {
    setFinalizing(false);
    setContextMenu(null);
    if (entry.view === "project-detail" && entry.projectId) {
      const project = projects.find((item) => item.id === entry.projectId) ?? activeProject;
      if (project) {
        setActiveProject(project);
        setProjectRecordings(recordings.filter((item) => item.projectId === project.id));
      }
    }
    setView(entry.view);
  }, [activeProject, projects, recordings]);

  const navigate = useCallback((entry: NavEntry, mode: "push" | "replace" | "top" = "push") => {
    if (mode === "push") {
      setHistory((stack) => {
        const current = currentNavEntry();
        const last = stack[stack.length - 1];
        if (last?.view === current.view && last.projectId === current.projectId && last.recordingId === current.recordingId) {
          return stack;
        }
        return [...stack, current];
      });
    } else if (mode === "replace") {
      setHistory((stack) => stack);
    } else {
      setHistory([]);
    }
    void applyNavEntry(entry);
  }, [applyNavEntry, currentNavEntry]);

  const goBack = useCallback(() => {
    setHistory((stack) => {
      const previous = stack[stack.length - 1];
      if (previous) void applyNavEntry(previous);
      return stack.slice(0, -1);
    });
  }, [applyNavEntry]);

  const discardActiveRecording = useCallback(() => {
    setFinalizing(false);
    setRecording(null);
    setTranscript(null);
    setTranscriptionError(undefined);
    setFinalizingProgress(null);
    setRecordingProjectId(null);
    setRecordingProjectName(null);
    setRecordingSessionKey((current) => current + 1);
    setHistory((stack) => {
      const previous = stack[stack.length - 1] ?? { view: "home" as const };
      void applyNavEntry(previous);
      return stack.slice(0, -1);
    });
  }, [applyNavEntry]);

  const canGoBack = history.length > 0 && !isTopLevelView(view) && view !== "recording" && !finalizing;

  const syncSettings = useCallback((nextSettings: SettingsViewData) => {
    setSettingsData(nextSettings);
    setAppLanguage(nextSettings.settings.appLanguage);
  }, []);

  const applySavedRecording = useCallback((details: RecordingDetails) => {
    setRecording(details.recording);
    setTranscript(details.transcript);
    setRecordingProjectId(details.projectId);
    setRecordingProjectName(details.projectName);
    const summary: RecordingSummary = {
      id: details.recording.id,
      projectId: details.projectId,
      projectName: details.projectName,
      title: details.recording.title,
      createdAt: details.recording.createdAt,
      updatedAt: details.recording.createdAt,
      durationSeconds: details.recording.durationSeconds,
      language: details.recording.language,
      audioFile: details.recording.audioFile,
      mimeType: details.recording.mimeType,
      transcriptFile: details.transcript ? "transcript.json" : null,
      transcriptStatus: details.transcriptStatus,
      archivedAt: null,
    };
    setRecordings((current) => sortByLibraryRecency([summary, ...current.filter((item) => item.id !== summary.id)]));
    setArchivedRecordings((current) => current.filter((item) => item.id !== summary.id));
    setProjectRecordings((current) => {
      if (!details.projectId || activeProject?.id !== details.projectId) return current.filter((item) => item.id !== summary.id);
      return sortByLibraryRecency([summary, ...current.filter((item) => item.id !== summary.id)]);
    });
    setProjects((current) => current.map((project) => {
      const hadRecording = recordings.some((item) => item.id === summary.id && item.projectId === project.id);
      const hasRecording = details.projectId === project.id;
      if (hadRecording === hasRecording) return project;
      return {
        ...project,
        recordingCount: Math.max(0, project.recordingCount + (hasRecording ? 1 : -1)),
        totalDurationSeconds: Math.max(0, project.totalDurationSeconds + (hasRecording ? summary.durationSeconds : -summary.durationSeconds)),
      };
    }));
  }, [activeProject?.id, recordings]);

  const whisperDownloads = useWhisperModelDownloads({
    getSettings: () => settingsData,
    onRefreshSettings: syncSettings,
  });

  const checkForUpdates = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (isMicrosoftStoreBuild) return;
    if (import.meta.env.DEV && silent) return;
    setUpdateError("");
    setUpdateErrorCopy("");
    setUpdateProgress(null);
    setUpdateStatus("checking");
    try {
      const nextUpdate = await check();
      updateRef.current = nextUpdate;
      if (!nextUpdate) {
        setUpdateDetails(null);
        setUpdateStatus("up-to-date");
        if (!silent) setUpdateDialogOpen(true);
        return;
      }
      const details = {
        version: nextUpdate.version,
        body: nextUpdate.body,
        date: nextUpdate.date,
      };
      setUpdateDetails(details);
      setUpdateStatus("available");
      if (!silent || dismissedUpdateVersionRef.current !== details.version) {
        setUpdateDialogOpen(true);
      }
    } catch (reason) {
      const classified = logUpdaterError(silent ? "startup" : "manual", reason);
      if (silent) {
        setUpdateStatus("idle");
        setUpdateError("");
        setUpdateErrorCopy("");
        return;
      }
      setUpdateStatus("error");
      setUpdateError(t(classified.titleKey));
      setUpdateErrorCopy(t(classified.copyKey));
      setUpdateDialogOpen(true);
    }
  }, [t]);

  const installAvailableUpdate = useCallback(async () => {
    if (isMicrosoftStoreBuild) return;
    const availableUpdate = updateRef.current;
    if (!availableUpdate) return;
    let downloadedBytes = 0;
    setUpdateError("");
    setUpdateErrorCopy("");
    setUpdateProgress({ downloadedBytes: 0 });
    setUpdateStatus("downloading");
    try {
      await availableUpdate.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          downloadedBytes = 0;
          setUpdateProgress({
            downloadedBytes,
            totalBytes: event.data.contentLength,
            percent: event.data.contentLength ? 0 : undefined,
          });
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setUpdateProgress((current) => {
            const totalBytes = current?.totalBytes;
            return {
              downloadedBytes,
              totalBytes,
              percent: totalBytes ? downloadedBytes * 100 / totalBytes : undefined,
            };
          });
        } else {
          setUpdateStatus("installing");
        }
      });
      setUpdateStatus("ready");
    } catch (reason) {
      logUpdaterError("install", reason);
      setUpdateStatus("error");
      setUpdateError(t("couldntInstallUpdate"));
      setUpdateErrorCopy(t("updateCheckConfigurationCopy"));
    }
  }, [t]);

  function closeUpdateDialog() {
    if (updateDetails) dismissedUpdateVersionRef.current = updateDetails.version;
    setUpdateDialogOpen(false);
  }

  function returnToRecordingOrigin(projectId: string | null = recordingProjectId) {
    setRecording(null);
    setTranscript(null);
    setFinalizing(false);
    const previous = history[history.length - 1];
    if (previous && previous.view !== "recording" && previous.view !== "transcript") {
      setHistory((stack) => stack.slice(0, -1));
      void applyNavEntry(previous);
      return;
    }
    if (projectId) {
      const project = projects.find((item) => item.id === projectId) ?? activeProject;
      if (project) {
        setActiveProject(project);
        setProjectRecordings(recordings.filter((item) => item.projectId === project.id));
        navigate({ view: "project-detail", projectId: project.id }, "top");
        return;
      }
    }
    navigate({ view: "home" }, "top");
  }

  useEffect(() => {
    void invoke<SettingsViewData>("load_scribe_settings")
      .then((settings) => {
        if (!settings.settingsFileExisted) freshInstallRef.current = true;
        syncSettings(settings);
        setSettingsLoaded(true);
      })
      .catch((reason) => {
        console.warn("Scribe: unable to load app language", reason);
        setSettingsLoaded(true);
      });
  }, [syncSettings]);

  useEffect(() => {
    if (settingsLoaded && settingsData && !settingsData.settings.onboardingCompleted && !onboardingDismissedThisSession) {
      setOnboardingOpen(true);
    }
  }, [onboardingDismissedThisSession, settingsData, settingsLoaded]);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch((reason) => console.warn("Scribe: unable to read app version", reason));
  }, []);

  useEffect(() => {
    if (!isMac) return;
    let disposed = false;
    const refreshFullscreen = async () => {
      try {
        const fullscreen = await getCurrentWindow().isFullscreen();
        if (!disposed) setIsFullscreen(fullscreen);
      } catch { /* native state may be unavailable during startup */ }
    };
    void refreshFullscreen();
    const timer = window.setInterval(() => void refreshFullscreen(), 250);
    const unlistenResize = getCurrentWindow().onResized(() => void refreshFullscreen());
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void unlistenResize.then((unlisten) => unlisten());
    };
  }, [isMac]);

  useEffect(() => {
    if (!settingsLoaded || !settingsData || onboardingOpen) return;
    const notes = releaseNotes[appVersion];
    if (!notes) return;
    if (!settingsData.settingsFileExisted || freshInstallRef.current) {
      if (
        settingsData.settings.lastSeenWhatsNewVersion !== appVersion
        && baselinedFreshInstallVersionRef.current !== appVersion
      ) {
        baselinedFreshInstallVersionRef.current = appVersion;
        void invoke<SettingsViewData>("save_scribe_settings", {
          lastSeenWhatsNewVersion: appVersion,
        })
          .then(syncSettings)
          .catch((reason) => console.error("Scribe: unable to save initial what's new state", reason));
      }
      return;
    }
    if (!settingsData.settings.onboardingCompleted) return;
    if (settingsData.settings.lastSeenWhatsNewVersion === appVersion) return;
    setWhatsNewOpen(true);
  }, [appVersion, onboardingOpen, settingsData, settingsLoaded, syncSettings]);

  async function dismissWhatsNew() {
    setWhatsNewOpen(false);
    try {
      const nextData = await invoke<SettingsViewData>("save_scribe_settings", {
        lastSeenWhatsNewVersion: appVersion,
      });
      syncSettings(nextData);
    } catch (reason) {
      console.error("Scribe: unable to save what's new state", reason);
    }
  }

  useEffect(() => {
    if (isMicrosoftStoreBuild) return;
    void checkForUpdates({ silent: true });
    const interval = window.setInterval(() => {
      void checkForUpdates({ silent: true });
    }, 5 * 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [checkForUpdates]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 980px)");
    const syncNarrowRange = () => setIsNarrowSidebarRange(mediaQuery.matches);
    syncNarrowRange();
    mediaQuery.addEventListener("change", syncNarrowRange);
    return () => mediaQuery.removeEventListener("change", syncNarrowRange);
  }, []);

  const refreshLibrary = useCallback(async () => {
    await invoke("initialize_library");
    const [nextProjects, nextRecordings, nextArchivedRecordings] = await Promise.all([
      invoke<Project[]>("list_projects"),
      invoke<RecordingSummary[]>("list_recordings"),
      invoke<RecordingSummary[]>("list_archived_recordings"),
    ]);
    setProjects(nextProjects);
    setRecordings(nextRecordings);
    setArchivedRecordings(nextArchivedRecordings);
    setActiveProject((current) => {
      if (!current) return current;
      const nextProject = nextProjects.find((project) => project.id === current.id) ?? null;
      if (nextProject) {
        setProjectRecordings(nextRecordings.filter((item) => item.projectId === nextProject.id));
      }
      return nextProject;
    });
  }, []);

  useEffect(() => {
    void refreshLibrary().catch((reason) => console.warn("Scribe: unable to load library", reason));
  }, [refreshLibrary]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void listen<ImportAudioProgress>("import-audio-progress", (event) => {
      if (disposed || event.payload.importId !== activeImportProgressIdRef.current) return;
      setFinalizingProgress({
        stage: event.payload.stage,
        percent: event.payload.percent,
        downloadedBytes: event.payload.downloadedBytes,
        totalBytes: event.payload.totalBytes,
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    void listen<RecordingProgressEvent>("recording-transcription-progress", (event) => {
      if (disposed || event.payload.recordingId !== activeRecordingProgressIdRef.current || event.payload.runId !== activeTranscriptionRunRef.current?.runId) return;
      setFinalizingProgress({
        stage: event.payload.stage,
        durationSeconds: event.payload.durationSeconds,
        percent: event.payload.percent,
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const isBackShortcut = (event.metaKey && event.key === "[") || (event.altKey && event.key === "ArrowLeft");
      if (!isBackShortcut || !canGoBack) return;
      event.preventDefault();
      goBack();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canGoBack, goBack]);

  async function transcribeRecording(nextRecording: RecordingMetadata) {
    console.info("[transcription-ui] attempt start", { recordingId: nextRecording.id });
    const runId = crypto.randomUUID();
    activeTranscriptionRunRef.current = { recordingId: nextRecording.id, runId };
    transcriptionCommandStartedRef.current = false;
    activeRecordingProgressIdRef.current = nextRecording.id;
    activeImportProgressIdRef.current = null;
    setFinalizing(true);
    setTranscriptionError(undefined);
    setFinalizingProgress({ stage: "preparing", durationSeconds: nextRecording.durationSeconds });
    let currentSettings = settingsData;
    try {
      const refreshedSettings = await invoke<SettingsViewData>("load_scribe_settings");
      syncSettings(refreshedSettings);
      currentSettings = refreshedSettings;
    } catch (reason) {
      console.error("Scribe: unable to refresh settings before transcription", reason);
    }
    const selectedModel = currentSettings?.models.find((model) => model.id === currentSettings.settings.whisperModel);
    if (!selectedModel) {
      activeTranscriptionRunRef.current = null;
      setTranscriptionError({ kind: "model_missing" });
      return;
    }
    const selectedModelPending = !selectedModel.installed && (
      whisperDownloads.activeDownloadId === selectedModel.id ||
      whisperDownloads.queuedDownloads.includes(selectedModel.id) ||
      whisperDownloads.downloadProgress[selectedModel.id]?.state === "downloading" ||
      whisperDownloads.downloadProgress[selectedModel.id]?.state === "installing"
    );
    if (selectedModelPending) {
      activeTranscriptionRunRef.current = null;
      setTranscriptionError({ kind: "model_downloading", message: t("modelDownloadingFriendly") });
      return;
    }
    if (!selectedModel.installed) {
      activeTranscriptionRunRef.current = null;
      setTranscriptionError({ kind: "model_missing" });
      return;
    }
    try {
      if (activeTranscriptionRunRef.current?.runId !== runId) return;
      transcriptionCommandStartedRef.current = true;
      console.info("[transcription-ui] invoking transcribe_recording", { recordingId: nextRecording.id });
      const transcriptionPromise = invoke<TranscriptData>("transcribe_recording", {
        recordingId: nextRecording.id,
        runId,
      });
      activeTranscriptionPromiseRef.current = transcriptionPromise;
      const nextTranscript = await transcriptionPromise;
      console.info("[transcription-ui] transcribe_recording success", { recordingId: nextRecording.id });
      setTranscript(nextTranscript);
      activeRecordingProgressIdRef.current = null;
      setFinalizingProgress(null);
      setFinalizing(false);
      navigate({ view: "transcript", recordingId: nextRecording.id, projectId: recordingProjectId }, "replace");
      void refreshLibrary();
    } catch (reason) {
      console.error("[transcription-ui] transcribe_recording failed", { recordingId: nextRecording.id, reason });
      activeTranscriptionRunRef.current = null;
      transcriptionCommandStartedRef.current = false;
      setTranscriptionError(classifyTranscriptionError(reason));
    } finally {
      if (activeTranscriptionRunRef.current?.recordingId === nextRecording.id) activeTranscriptionPromiseRef.current = null;
    }
  }

  async function cancelActiveTranscription() {
    const active = activeTranscriptionRunRef.current;
    if (!active) return;
    if (!transcriptionCommandStartedRef.current) {
      const discardNewRecording = activeTranscriptionOriginRef.current === "new" || activeTranscriptionOriginRef.current === "imported";
      activeTranscriptionRunRef.current = null;
      activeTranscriptionOriginRef.current = null;
      transcriptionCommandStartedRef.current = false;
      setFinalizing(false);
      setFinalizingProgress(null);
      if (discardNewRecording) {
        const result = await invoke<DeleteRecordingsResult>("delete_recordings", { recordingIds: [active.recordingId] });
        if (result.failed.length > 0) throw new Error(result.failed[0].error);
        await refreshLibrary();
        navigate({ view: "home" }, "top");
      }
      return;
    }
    await invoke("cancel_transcription", active);
    await activeTranscriptionPromiseRef.current?.catch(() => undefined);
    const discardNewRecording = activeTranscriptionOriginRef.current === "new" || activeTranscriptionOriginRef.current === "imported";
    activeTranscriptionRunRef.current = null;
    activeTranscriptionOriginRef.current = null;
    activeTranscriptionPromiseRef.current = null;
    transcriptionCommandStartedRef.current = false;
    setFinalizing(false);
    setFinalizingProgress(null);
    if (discardNewRecording) {
      const result = await invoke<DeleteRecordingsResult>("delete_recordings", { recordingIds: [active.recordingId] });
      if (result.failed.length > 0) throw new Error(result.failed[0].error);
      await refreshLibrary();
      setRecording(null);
      setTranscript(null);
      setRecordingProjectId(null);
      setRecordingProjectName(null);
      navigate({ view: "home" }, "top");
    }
  }

  function startRecording(projectId: string | null = null) {
    setRecordingSessionKey((current) => current + 1);
    setFinalizing(false);
    setFinalizingProgress(null);
    activeRecordingProgressIdRef.current = null;
    activeTranscriptionRunRef.current = null;
    activeTranscriptionOriginRef.current = null;
    activeTranscriptionPromiseRef.current = null;
    transcriptionCommandStartedRef.current = false;
    activeImportProgressIdRef.current = null;
    setRecording(null);
    setTranscript(null);
    setRecordingProjectId(projectId);
    setRecordingProjectName(projectId ? projects.find((project) => project.id === projectId)?.name ?? null : null);
    setTranscriptionError(undefined);
    navigate({ view: "recording", projectId }, "push");
  }

  async function openRecording(recordingId: string) {
    try {
      const details = await invoke<RecordingDetails>("get_recording", { recordingId });
      setRecording(details.recording);
      setTranscript(details.transcript);
      setRecordingProjectId(details.projectId);
      setRecordingProjectName(details.projectName);
      setTranscriptionError(undefined);
      setFinalizing(false);
      navigate({ view: "transcript", recordingId, projectId: details.projectId }, "push");
    } catch (reason) {
      console.error("Scribe: unable to open recording", reason);
    }
  }

  async function createProject(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const project = await invoke<Project>("create_project", { name: trimmed });
      setProjectDialogOpen(false);
      await refreshLibrary();
      setActiveProject(project);
      setProjectRecordings([]);
      navigate({ view: "project-detail", projectId: project.id }, "push");
    } catch (reason) {
      console.error("Scribe: unable to create project", reason);
    }
  }

  async function openProject(project: Project) {
    try {
      setActiveProject(project);
      setProjectRecordings(await invoke<RecordingSummary[]>("list_project_recordings", { projectId: project.id }));
      setFinalizing(false);
      navigate({ view: "project-detail", projectId: project.id }, "push");
    } catch (reason) {
      console.error("Scribe: unable to open project", reason);
    }
  }

  async function importAudio(projectId: string | null = null) {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: t("audio"),
          extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "webm", "mp4"],
        }],
      });
      if (typeof selected !== "string") return;

      const targetProject = projectId ? projects.find((project) => project.id === projectId) ?? activeProject : null;
      setFinalizing(true);
      setTranscriptionError(undefined);
      setRecording(null);
      setTranscript(null);
      setRecordingProjectId(projectId);
      setRecordingProjectName(targetProject?.name ?? null);
      const importId = crypto.randomUUID();
      activeImportProgressIdRef.current = importId;
      setFinalizingProgress({ stage: "importing", downloadedBytes: 0 });
      const details = await invoke<RecordingDetails>("import_audio_recording", {
        sourcePath: selected,
        projectId,
        importId,
      });
      applySavedRecording({ ...details, transcript: null });
      void refreshLibrary();
      activeTranscriptionOriginRef.current = "imported";
      void transcribeRecording(details.recording);
    } catch (reason) {
      console.error("Scribe: unable to import audio", reason);
      setFinalizing(false);
      setFinalizingProgress(null);
      activeImportProgressIdRef.current = null;
      setTranscriptionError(classifyTranscriptionError(reason));
      window.alert(typeof reason === "string" && reason.includes("Unsupported audio file type")
        ? t("importUnsupported")
        : typeof reason === "string" && reason.includes("not found")
          ? t("importSourceMissing")
          : typeof reason === "string" && reason.includes("inspect imported audio")
            ? t("importInspectFailed")
            : t("importFailed"));
    }
  }

  function requestDeleteProjects(projectIds: string[]) {
    const targetIds = [...projectIds];
    console.info("[project-delete-ui] requested ids", targetIds);
    setProjectDeleteTargetIds(targetIds);
    setProjectDeleteDialogOpen(true);
  }

  async function confirmDeleteProjects() {
    console.info("[project-delete-ui] confirm clicked");
    const targetIds = [...projectDeleteTargetIds];
    console.info("[project-delete-ui] ids at confirm time", targetIds);
    if (targetIds.length === 0) {
      console.error("[project-delete-ui] confirm blocked: no pending ids");
      return false;
    }
    setProjectDeleteInProgress(true);
    try {
      console.info("[project-delete-ui] invoking delete_projects", { projectIds: targetIds });
      const result = await invoke<DeleteProjectsResult>("delete_projects", { projectIds: targetIds });
      console.info("[project-delete-ui] resolved", result);
      if (result.deletedIds.length !== targetIds.length) {
        console.error("[project-delete-ui] delete count mismatch", result);
        window.alert(t("projectDeleteFailed"));
        return false;
      }
      if (activeProject && result.deletedIds.includes(activeProject.id)) {
        setActiveProject(null);
        setProjectRecordings([]);
        navigate({ view: "projects" }, "top");
      }
      await refreshLibrary();
      setProjectDeleteDialogOpen(false);
      setProjectDeleteTargetIds([]);
      return true;
    } catch (reason) {
      console.error("[project-delete-ui] rejected", reason);
      window.alert(t("projectDeleteFailed"));
      return false;
    } finally {
      setProjectDeleteInProgress(false);
    }
  }

  async function deleteProject(project: Project) {
    requestDeleteProjects([project.id]);
  }

  async function deleteActiveProject() {
    if (!activeProject) return;
    await deleteProject(activeProject);
  }

  async function deleteProjects(projectsToDelete: Project[]) {
    if (projectsToDelete.length === 0) return false;
    requestDeleteProjects(projectsToDelete.map((project) => project.id));
    return false;
  }

  async function renameCurrentRecording(title: string) {
    if (!recording) return;
    const details = await invoke<RecordingDetails>("rename_recording", { recordingId: recording.id, title });
    setRecording(details.recording);
    setTranscript(details.transcript);
    void refreshLibrary();
  }

  async function moveRecordings(recordingIds: string[], projectId: string | null) {
    try {
      if (recordingIds.length === 1) {
        const moved = await invoke<RecordingSummary>("assign_recording_to_project", { recordingId: recordingIds[0], projectId });
        if (recording?.id === recordingIds[0]) {
          setRecordingProjectId(moved.projectId);
          setRecordingProjectName(moved.projectName);
        }
      } else {
        await invoke("assign_recordings_to_project", { recordingIds, projectId });
        if (recording && recordingIds.includes(recording.id)) {
          setRecordingProjectId(projectId);
          setRecordingProjectName(projectId ? projects.find((project) => project.id === projectId)?.name ?? null : null);
        }
      }
      setMoveTarget(null);
      await refreshLibrary();
    } catch (reason) {
      console.error("Scribe: unable to move recordings", reason);
    }
  }

  async function archiveRecordings(recordingIds: string[]) {
    try {
      await invoke("archive_recordings", { recordingIds });
      await refreshLibrary();
      if (recording && recordingIds.includes(recording.id)) {
        returnToRecordingOrigin(recordingProjectId);
      }
    } catch (reason) {
      console.error("Scribe: unable to archive recordings", reason);
      window.alert(t("archiveFailed"));
    }
  }

  async function restoreRecordings(recordingIds: string[]) {
    try {
      await invoke("restore_recordings", { recordingIds });
      await refreshLibrary();
    } catch (reason) {
      console.error("Scribe: unable to restore recordings", reason);
      window.alert(t("restoreFailed"));
    }
  }

  function requestDeleteRecordings(recordingIds: string[]) {
    const targetIds = [...recordingIds];
    console.info("[delete-ui] delete action requested");
    console.info("[delete-ui] pending ids set:", targetIds);
    setDeleteTargetIds(targetIds);
    setDeleteDialogOpen(true);
    console.info("[delete-ui] dialog opened");
  }

  async function confirmDeleteRecordings() {
    console.info("[delete-ui] confirm button clicked");
    const targetIds = [...deleteTargetIds];
    console.info("[delete-ui] ids at confirm time:", targetIds);
    if (targetIds.length === 0) {
      console.error("[delete-ui] confirm blocked: no pending ids");
      return false;
    }
    setDeleteInProgress(true);
    console.info("[delete] confirmation accepted");
    try {
      console.info("[delete-ui] invoking delete_recordings", { recordingIds: targetIds });
      const result = await invoke<DeleteRecordingsResult>("delete_recordings", { recordingIds: targetIds });
      console.info("[delete-ui] invoke resolved:", result);
      if (result.failed.length > 0 || result.deletedIds.length !== targetIds.length) {
        console.error("Scribe: some recordings could not be deleted", result.failed);
        window.alert(t(targetIds.length === 1 ? "recordingDeleteFailed" : "recordingsDeleteFailed"));
        return false;
      }
      if (recording && result.deletedIds.includes(recording.id)) {
        returnToRecordingOrigin(recordingProjectId);
      }
      await refreshLibrary();
      setDeleteDialogOpen(false);
      setDeleteTargetIds([]);
      return true;
    } catch (reason) {
      console.error("[delete-ui] invoke rejected:", reason);
      window.alert(t(targetIds.length === 1 ? "recordingDeleteFailed" : "recordingsDeleteFailed"));
      return false;
    } finally {
      setDeleteInProgress(false);
    }
  }

  async function deleteRecordings(recordingIds: string[]) {
    requestDeleteRecordings(recordingIds);
    return false;
  }

  async function renameProject(project: Project, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const renamed = await invoke<Project>("rename_project", { projectId: project.id, name: trimmed });
      setRenameProjectTarget(null);
      if (activeProject?.id === project.id) setActiveProject(renamed);
      await refreshLibrary();
    } catch (reason) {
      console.error("Scribe: unable to rename project", reason);
    }
  }

  async function renameRecordingFromDialog(item: RecordingSummary, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const details = await invoke<RecordingDetails>("rename_recording", { recordingId: item.id, title: trimmed });
      setRenameRecordingTarget(null);
      if (recording?.id === item.id) {
        setRecording(details.recording);
        setTranscript(details.transcript);
      }
      await refreshLibrary();
    } catch (reason) {
      console.error("Scribe: unable to rename recording", reason);
    }
  }

  const recordingActions = useCallback((item: RecordingSummary, options: { includeOpen?: boolean } = {}): ContextMenuAction[] => {
    const archived = item.archivedAt !== null;
    const includeOpen = options.includeOpen ?? true;
    return [
      ...(includeOpen ? [{ id: "open", label: t("open"), onSelect: () => void openRecording(item.id) }] satisfies ContextMenuAction[] : []),
      ...(archived ? [] : [
        { id: "rename", label: t("rename"), icon: Pencil, onSelect: () => setRenameRecordingTarget(item) },
        { id: "move", label: t("moveToProject"), icon: FolderInput, onSelect: () => setMoveTarget({ recordingIds: [item.id], projectId: item.projectId }) },
        { id: "archive", label: t("archive"), icon: Archive, onSelect: () => void archiveRecordings([item.id]) },
      ] satisfies ContextMenuAction[]),
      ...(archived ? [
        { id: "restore", label: t("restore"), icon: RotateCcw, separatorBefore: true, onSelect: () => void restoreRecordings([item.id]) },
        { id: "delete", label: t("deleteRecording"), icon: Trash2, destructive: true, onSelect: () => requestDeleteRecordings([item.id]) },
      ] satisfies ContextMenuAction[] : [
        { id: "delete", label: t("deleteRecording"), icon: Trash2, destructive: true, separatorBefore: true, onSelect: () => requestDeleteRecordings([item.id]) },
      ] satisfies ContextMenuAction[]),
    ];
  }, [t, archivedRecordings, recordings, projects, recording]);

  const projectActions = useCallback((project: Project): ContextMenuAction[] => {
    return [
      { id: "open", label: t("open"), onSelect: () => void openProject(project) },
      { id: "rename", label: t("rename"), icon: Pencil, onSelect: () => setRenameProjectTarget(project) },
      { id: "delete", label: t("deleteProject"), icon: Trash2, destructive: true, separatorBefore: true, onSelect: () => requestDeleteProjects([project.id]) },
    ];
  }, [t]);

  function openContextMenu(event: MouseEvent, actions: ContextMenuAction[]) {
    if (actions.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, actions });
  }

  const sidebarCollapsed = sidebarMode === "auto"
    ? isNarrowSidebarRange
    : sidebarMode === "collapsed";
  const toggleSidebarLabel = sidebarCollapsed ? t("expandSidebar") : t("collapseSidebar");
  const activeRecordingSummary = useMemo<RecordingSummary | null>(() => {
    if (!recording) return null;
    return recordings.find((item) => item.id === recording.id)
      ?? archivedRecordings.find((item) => item.id === recording.id)
      ?? projectRecordings.find((item) => item.id === recording.id)
      ?? {
        id: recording.id,
        projectId: recordingProjectId,
        projectName: recordingProjectName,
        title: recording.title,
        createdAt: recording.createdAt,
        updatedAt: recording.createdAt,
        durationSeconds: recording.durationSeconds,
        language: recording.language,
        audioFile: recording.audioFile,
        mimeType: recording.mimeType,
        transcriptFile: transcript ? "transcript.json" : null,
        transcriptStatus: transcript ? "ready" : "missing",
        archivedAt: null,
      };
  }, [archivedRecordings, projectRecordings, recording, recordingProjectId, recordingProjectName, recordings, transcript]);

  const recentRecordings = useMemo(() => sortByLibraryRecency(recordings), [recordings]);
  const activeModelDownload = useMemo(() => {
    const activeId = whisperDownloads.activeDownloadId ?? whisperDownloads.queuedDownloads[0] ?? Object.entries(whisperDownloads.downloadFailures).find(([, failed]) => failed)?.[0];
    if (!activeId) return null;
    const model = settingsData?.models.find((item) => item.id === activeId);
    return {
      model,
      progress: whisperDownloads.downloadProgress[activeId],
      queued: whisperDownloads.queuedDownloads.includes(activeId),
      failed: whisperDownloads.downloadFailures[activeId],
    };
  }, [settingsData?.models, whisperDownloads.activeDownloadId, whisperDownloads.downloadFailures, whisperDownloads.downloadProgress, whisperDownloads.queuedDownloads]);

  const selectedTranscriptionModel = settingsData?.models.find((model) => model.id === settingsData.settings.whisperModel) ?? null;
  const selectedModelStillDownloading = selectedTranscriptionModel ? (
    !selectedTranscriptionModel.installed && (
      whisperDownloads.activeDownloadId === selectedTranscriptionModel.id ||
      whisperDownloads.queuedDownloads.includes(selectedTranscriptionModel.id) ||
      whisperDownloads.downloadProgress[selectedTranscriptionModel.id]?.state === "downloading" ||
      whisperDownloads.downloadProgress[selectedTranscriptionModel.id]?.state === "installing"
    )
  ) : false;

  useEffect(() => {
    if (transcriptionError?.kind === "model_downloading" && selectedTranscriptionModel?.installed) {
      setTranscriptionError({ kind: "model_ready" });
    }
  }, [selectedTranscriptionModel?.installed, transcriptionError?.kind]);

  function toggleSidebar() {
    setSidebarMode(sidebarCollapsed ? "expanded" : "collapsed");
  }

  async function dragWindowFromTitlebar(event: MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    try { await getCurrentWindow().startDragging(); } catch (error) {
      if (import.meta.env.DEV) console.warn("Scribe titlebar drag failed", error);
    }
  }

  async function toggleNativeTitlebarAction(event: MouseEvent<HTMLDivElement>) {
    if (event.detail < 2) return;
    try { await invoke("perform_native_titlebar_double_click"); } catch (error) {
      if (import.meta.env.DEV) console.warn("Scribe titlebar double-click failed", error);
    }
  }

  function openTranscriptionSettings() {
    setSettingsInitialSection("Transcription");
    navigate({ view: "settings" }, "top");
  }

  function clearSharedRecordingSelection() {
    setSharedRecordingSelectedIds(new Set());
    setSelectedProjectIds(new Set());
  }

  return (
    <div className={`app${isMac ? " is-macos" : ""}${isFullscreen ? " is-fullscreen" : ""}${sidebarCollapsed ? " sidebar-is-collapsed" : ""}`}>
      <WebviewContextMenuGuard />
      <div className="app-titlebar">
        <div className="titlebar-drag-region" onMouseDown={(event) => { void dragWindowFromTitlebar(event); }} onDoubleClick={(event) => { void toggleNativeTitlebarAction(event); }} aria-hidden="true" />
        <button ref={titlebarToggleRef} className="sidebar-toggle titlebar-sidebar-toggle" onClick={toggleSidebar} aria-label={toggleSidebarLabel} title={toggleSidebarLabel}>
          {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <div className="app-body">
      <SidebarSelectionBoundary className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}`} onClearSelection={() => {
        activeSelectionClearRef.current();
        setSharedRecordingSelectedIds(new Set());
        setSelectedProjectIds(new Set());
      }} onPointerDownCapture={() => setSharedRecordingSelectedIds(new Set())}>
        <div className="sidebar-top">
          <div className="sidebar-header">
            <button className="brand brand-button" onClick={() => navigate({ view: "home" }, "top")} aria-label={t("home")} title={sidebarCollapsed ? t("home") : undefined}>
              <div className="brand-logo">
                <img src={scribeIcon} alt="Scribe" />
              </div>
              <span>Scribe</span>
            </button>
            <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={toggleSidebarLabel} title={toggleSidebarLabel}>
              {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </div>

          <button className="new-recording" onClick={() => startRecording()} title={sidebarCollapsed ? t("newRecording") : undefined}>
            <svg className="gradient-plus" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <defs>
                <linearGradient id="new-recording-plus-gradient" x1="3" y1="3" x2="15" y2="15" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#4f6df5" />
                  <stop offset="0.55" stopColor="#8b5cf6" />
                  <stop offset="1" stopColor="#14b8a6" />
                </linearGradient>
              </defs>
              <path d="M9 3.5v11M3.5 9h11" stroke="url(#new-recording-plus-gradient)" strokeWidth="2.25" strokeLinecap="round" />
            </svg>
            <span>{t("newRecording")}</span>
          </button>

          <button className="sidebar-import-audio" onClick={() => void importAudio(null)} title={sidebarCollapsed ? t("importAudio") : undefined}>
            <Upload size={18} strokeWidth={2} />
            <span>{t("importAudio")}</span>
          </button>

          <nav className="navigation">
            <SidebarNavigationItem
              className={`nav-item${view === "home" ? " active" : ""}`}
              aria-current={view === "home" ? "page" : undefined}
              onClick={() => { clearSharedRecordingSelection(); navigate({ view: "home" }, "top"); }}
              title={sidebarCollapsed ? t("home") : undefined}
            >
              <Home size={18} strokeWidth={1.8} />
              <span>{t("home")}</span>
            </SidebarNavigationItem>

            <SidebarNavigationItem
              className={`nav-item${view === "projects" || view === "project-detail" ? " active" : ""}`}
              aria-current={view === "projects" || view === "project-detail" ? "page" : undefined}
              onClick={() => { clearSharedRecordingSelection(); navigate({ view: "projects" }, "top"); }}
              title={sidebarCollapsed ? t("projects") : undefined}
            >
              <FolderClosed size={18} strokeWidth={1.8} />
              <span>{t("projects")}</span>
            </SidebarNavigationItem>

            <SidebarNavigationItem
              className={`nav-item${view === "recordings" || view === "archived-recordings" ? " active" : ""}`}
              aria-current={view === "recordings" || view === "archived-recordings" ? "page" : undefined}
              onClick={() => { clearSharedRecordingSelection(); navigate({ view: "recordings" }, "top"); }}
              title={sidebarCollapsed ? t("recordings") : undefined}
            >
              <AudioLines size={18} strokeWidth={1.8} />
              <span>{t("recordings")}</span>
            </SidebarNavigationItem>

            <button className="nav-item disabled" title={sidebarCollapsed ? t("search") : undefined}>
              <Search size={18} strokeWidth={1.8} />
              <span>{t("search")}</span>
              <span className="coming-soon">{t("soon")}</span>
            </button>
          </nav>

          <div className="sidebar-section">
            <div className="section-label">{t("tools")}</div>

            <button className="nav-item disabled" title={sidebarCollapsed ? t("voiceTyping") : undefined}>
              <Mic size={18} strokeWidth={1.8} />
              <span>{t("voiceTyping")}</span>
              <span className="coming-soon">{t("soon")}</span>
            </button>
          </div>
        </div>

        <SidebarNavigationItem
          className={`settings-button${view === "settings" ? " active" : ""}`}
          onClick={() => {
            clearSharedRecordingSelection();
            setSettingsInitialSection("General");
            navigate({ view: "settings" }, "top");
          }}
          title={sidebarCollapsed ? t("settings") : undefined}
        >
          <Settings size={18} strokeWidth={1.8} />
          <span>{t("settings")}</span>
        </SidebarNavigationItem>
      </SidebarSelectionBoundary>

      <MainContentSelectionBoundary className="main-content" onBackgroundClick={() => {
        if (view === "home") activeSelectionClearRef.current();
        if (["recordings", "archived-recordings", "project-detail"].includes(view)) setSharedRecordingSelectedIds(new Set());
        if (view === "projects") setSelectedProjectIds(new Set());
      }}>
        {finalizing ? <FinalizingView
          errorKind={transcriptionError?.kind}
          errorMessage={transcriptionError?.message}
          progress={finalizingProgress}
          t={t}
          onRetry={() => {
            console.info("[transcription-ui] retry clicked", { recordingId: recording?.id ?? null });
            if (recording) void transcribeRecording(recording);
          }}
          retryDisabled={transcriptionError?.kind === "model_downloading" && selectedModelStillDownloading}
          onContinue={() => {
            activeTranscriptionRunRef.current = null;
            transcriptionCommandStartedRef.current = false;
            setFinalizing(false);
            setFinalizingProgress(null);
            setView("transcript");
          }}
          onOpenTranscriptionSettings={() => {
            activeTranscriptionRunRef.current = null;
            transcriptionCommandStartedRef.current = false;
            setFinalizing(false);
            setFinalizingProgress(null);
            openTranscriptionSettings();
          }}
          onCancel={() => { void cancelActiveTranscription(); }}
        /> : view === "recording" ? (
          <RecordingView key={recordingSessionKey} t={t} projectId={recordingProjectId} onStop={(nextRecording) => {
            setRecording(nextRecording);
            setTranscript(null);
            activeTranscriptionOriginRef.current = "new";
            void transcribeRecording(nextRecording);
          }} onSaved={applySavedRecording} onDiscard={discardActiveRecording} onStartNew={() => {
            console.info("[recording-ui] start-new clicked from too-short state");
            startRecording(recordingProjectId);
          }} />
        ) : view === "transcript" && recording ? <TranscriptView
          recording={recording}
          transcript={transcript}
          t={t}
          appLanguage={appLanguage}
          onRename={renameCurrentRecording}
          onMoveToProject={() => setMoveTarget({ recordingIds: [recording.id], projectId: recordingProjectId })}
          actions={activeRecordingSummary ? recordingActions(activeRecordingSummary, { includeOpen: false }) : undefined}
          projectName={recordingProjectName}
          canGoBack={canGoBack}
          onBack={goBack}
          onContextMenu={(event) => {
            if (activeRecordingSummary) {
              openContextMenu(event, recordingActions(activeRecordingSummary, { includeOpen: false }));
            }
          }}
        />
        : view === "projects" ? <ProjectsView
          projects={projects}
          t={t}
          onNewProject={() => setProjectDialogOpen(true)}
          onOpenProject={openProject}
          onDeleteProjects={deleteProjects}
          getProjectActions={projectActions}
          onProjectContextMenu={(event, project) => openContextMenu(event, projectActions(project))}
          canGoBack={canGoBack}
          onBack={goBack}
          selectedIds={selectedProjectIds}
          setSelectedIds={setSelectedProjectIds}
        />
        : view === "recordings" ? <RecordingsView
          recordings={recordings}
          t={t}
          appLanguage={appLanguage}
          onOpenRecording={openRecording}
          onOpenArchived={() => navigate({ view: "archived-recordings" }, "push")}
          onMoveRecordings={(recordingIds) => setMoveTarget({ recordingIds, projectId: null })}
          onArchiveRecordings={archiveRecordings}
          onRestoreRecordings={restoreRecordings}
          onDeleteRecordings={deleteRecordings}
          getRecordingActions={recordingActions}
          onRecordingContextMenu={(event, item) => openContextMenu(event, recordingActions(item))}
          canGoBack={canGoBack}
          onBack={goBack}
          selectedIds={sharedRecordingSelectedIds}
          setSelectedIds={setSharedRecordingSelectedIds}
        />
        : view === "archived-recordings" ? <RecordingsView
          recordings={archivedRecordings}
          t={t}
          appLanguage={appLanguage}
          onOpenRecording={openRecording}
          onMoveRecordings={(recordingIds) => setMoveTarget({ recordingIds, projectId: null })}
          onArchiveRecordings={archiveRecordings}
          onRestoreRecordings={restoreRecordings}
          onDeleteRecordings={deleteRecordings}
          getRecordingActions={recordingActions}
          onRecordingContextMenu={(event, item) => openContextMenu(event, recordingActions(item))}
          archived
          canGoBack={canGoBack}
          onBack={goBack}
          selectedIds={sharedRecordingSelectedIds}
          setSelectedIds={setSharedRecordingSelectedIds}
        />
        : view === "project-detail" && activeProject ? <ProjectDetailView
          project={activeProject}
          recordings={projectRecordings}
          t={t}
          appLanguage={appLanguage}
          onNewRecording={() => startRecording(activeProject.id)}
          onImportAudio={() => void importAudio(activeProject.id)}
          onOpenRecording={openRecording}
          onRenameProject={(name) => renameProject(activeProject, name)}
          onDeleteProject={deleteActiveProject}
          onMoveRecordings={(recordingIds) => setMoveTarget({ recordingIds, projectId: activeProject.id })}
          onArchiveRecordings={archiveRecordings}
          onDeleteRecordings={deleteRecordings}
          getRecordingActions={recordingActions}
          onRecordingContextMenu={(event, item) => openContextMenu(event, recordingActions(item))}
          onBack={goBack}
          selectedIds={sharedRecordingSelectedIds}
          setSelectedIds={setSharedRecordingSelectedIds}
        />
        : view === "settings" ? <SettingsView
          appVersion={appVersion}
          initialData={settingsData}
          initialSection={settingsInitialSection}
          onCheckForUpdates={() => void checkForUpdates()}
          onShowWelcomeGuide={() => {
            setOnboardingDismissedThisSession(false);
            setOnboardingOpen(true);
          }}
          onSettingsChange={syncSettings}
          t={t}
          updateError={updateError}
          updateProgress={updateProgress}
          updateStatus={updateStatus}
          whisperDownloads={whisperDownloads}
        /> : (
        <div className="home">
          <section className="hero">
            <h1>{t(currentGreetingKey())}</h1>
            <p>{t("whatWouldYouLike")}</p>

            <div className="actions">
              <button className="record-card" onClick={() => startRecording()}>
                <div className="record-icon">
                  <Mic size={21} strokeWidth={2.1} />
                </div>

                <div className="action-copy">
                  <strong>{t("startRecording")}</strong>
                  <span>{t("recordLecture")}</span>
                </div>

                <div className="record-arrow">
                  <ArrowRight size={18} strokeWidth={2} />
                </div>
              </button>

              <button className="action-card" onClick={() => void importAudio(null)}>
                <div className="secondary-action-icon">
                  <Upload size={20} strokeWidth={1.9} />
                </div>

                <div className="action-copy">
                  <strong>{t("importAudio")}</strong>
                  <span>{t("importFormats")}</span>
                </div>
              </button>
            </div>
            {activeModelDownload ? (
              <button className="home-download-status" onClick={openTranscriptionSettings}>
                <span>
                  <strong>{activeModelDownload.model ? localizedModel(activeModelDownload.model, t).name : t("whisperModel")}</strong>
                  <small>
                    {activeModelDownload.failed
                      ? t("downloadFailed")
                      : activeModelDownload.progress?.state === "installing"
                        ? t("installingModel")
                        : activeModelDownload.queued
                          ? t("queued")
                          : activeModelDownload.progress?.percent !== undefined
                            ? `${t("downloading")} ${Math.round(activeModelDownload.progress.percent)}%`
                            : t("downloading")}
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
            ) : null}
          </section>

          <HomeRecentRecordings
            recordings={recentRecordings}
            t={t}
            appLanguage={appLanguage}
            onOpenRecording={openRecording}
            onViewAll={() => navigate({ view: "recordings" }, "top")}
            onMoveRecordings={(recordingIds) => setMoveTarget({ recordingIds, projectId: null })}
            onArchiveRecordings={archiveRecordings}
            onDeleteRecordings={deleteRecordings}
            getRecordingActions={recordingActions}
            onRecordingContextMenu={(event, item) => openContextMenu(event, recordingActions(item))}
            clearSelectionRef={activeSelectionClearRef}
          />
        </div>
        )}
      </MainContentSelectionBoundary>
      </div>
      {projectDialogOpen ? (
        <ProjectDialog
          title={t("newProject")}
          t={t}
          onCancel={() => setProjectDialogOpen(false)}
          onSubmit={createProject}
        />
      ) : null}
      {moveTarget ? (
        <MoveToProjectDialog
          projects={projects}
          currentProjectId={moveTarget.projectId}
          t={t}
          onCancel={() => setMoveTarget(null)}
          onMove={(projectId) => void moveRecordings(moveTarget.recordingIds, projectId)}
        />
      ) : null}
      {renameProjectTarget ? (
        <RenameDialog
          title={t("rename")}
          label={t("projectName")}
          defaultValue={renameProjectTarget.name}
          t={t}
          onCancel={() => setRenameProjectTarget(null)}
          onSubmit={(name) => void renameProject(renameProjectTarget, name)}
        />
      ) : null}
      {renameRecordingTarget ? (
        <RenameDialog
          title={t("renameRecording")}
          label={t("renameRecording")}
          defaultValue={localizedRecordingTitle(renameRecordingTarget.title, t)}
          t={t}
          onCancel={() => setRenameRecordingTarget(null)}
          onSubmit={(name) => void renameRecordingFromDialog(renameRecordingTarget, name)}
        />
      ) : null}
      {deleteDialogOpen ? (
        <div className="modal-backdrop modal-backdrop-polished" role="presentation">
          <div className="library-dialog confirm-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("delete")}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Trash2 size={18} />
            </div>
            <div className="confirm-dialog-copy">
              <h2>
                {deleteTargetIds.length === 1
                  ? t("deleteRecordingConfirmTitle")
                  : t("deleteRecordingsConfirmTitle").replace("{count}", String(deleteTargetIds.length))}
              </h2>
              <p>
                {deleteTargetIds.length === 1
                  ? t("deleteRecordingConfirmCopy")
                  : t("deleteRecordingsConfirmCopy")}
              </p>
            </div>
            <div className="dialog-actions confirm-dialog-actions">
              <button
                type="button"
                className="dialog-button dialog-button-secondary"
                disabled={deleteInProgress}
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setDeleteTargetIds([]);
                }}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="dialog-button dialog-button-danger"
                disabled={deleteInProgress}
                onClick={() => void confirmDeleteRecordings()}
              >
                {deleteInProgress ? t("deleting") : t("delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {projectDeleteDialogOpen ? (
        <div className="modal-backdrop modal-backdrop-polished" role="presentation">
          <div className="library-dialog confirm-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("deleteProject")}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Trash2 size={18} />
            </div>
            <div className="confirm-dialog-copy">
              <h2>
                {projectDeleteTargetIds.length === 1
                  ? t("deleteProjectConfirmTitle")
                  : t("deleteProjectsConfirmTitle").replace("{count}", String(projectDeleteTargetIds.length))}
              </h2>
              <p>
                {projectDeleteTargetIds.length === 1
                  ? t("deleteProjectConfirmCopy")
                  : t("deleteProjectsConfirmCopy")}
              </p>
            </div>
            <div className="dialog-actions confirm-dialog-actions">
              <button
                type="button"
                className="dialog-button dialog-button-secondary"
                disabled={projectDeleteInProgress}
                onClick={() => {
                  setProjectDeleteDialogOpen(false);
                  setProjectDeleteTargetIds([]);
                }}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="dialog-button dialog-button-danger"
                disabled={projectDeleteInProgress}
                onClick={() => void confirmDeleteProjects()}
              >
                {projectDeleteInProgress ? t("deleting") : t("delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {updateDialogOpen ? (
        <div className="modal-backdrop modal-backdrop-polished" role="presentation" onMouseDown={updateStatus === "downloading" || updateStatus === "installing" ? undefined : closeUpdateDialog}>
          <div className="library-dialog confirm-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("checkForUpdates")} onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Settings size={18} />
            </div>
            <div className="confirm-dialog-copy">
              <h2>
                {updateStatus === "available" || updateStatus === "downloading" || updateStatus === "installing" || updateStatus === "ready"
                  ? t("updateAvailableTitle").replace("{version}", updateDetails?.version ?? "")
                  : updateStatus === "up-to-date"
                    ? t("upToDate")
                    : updateError || t("couldntCheckForUpdates")}
              </h2>
              <p>
                {updateStatus === "downloading"
                  ? `${t("downloadingUpdate")} ${updateProgress?.percent !== undefined ? `${Math.round(updateProgress.percent)}%` : ""}`
                  : updateStatus === "installing"
                    ? t("installingUpdate")
                    : updateStatus === "ready"
                      ? t("updateReadyCopy")
                      : updateStatus === "error"
                        ? updateErrorCopy || t("updateCheckConfigurationCopy")
                        : updateStatus === "up-to-date"
                          ? t("secureUpdates")
                        : t("updateAvailableCopy")}
              </p>
            </div>
            <div className="dialog-actions confirm-dialog-actions">
              {updateStatus === "available" ? (
                <>
                  <button type="button" className="dialog-button dialog-button-secondary" onClick={closeUpdateDialog}>{t("later")}</button>
                  <button type="button" className="dialog-button dialog-button-primary" onClick={() => void installAvailableUpdate()}>{t("updateNow")}</button>
                </>
              ) : updateStatus === "ready" ? (
                <button type="button" className="dialog-button dialog-button-primary" onClick={() => void relaunch()}>{t("restartAndUpdate")}</button>
              ) : updateStatus === "downloading" || updateStatus === "installing" ? null : (
                <button type="button" className="dialog-button dialog-button-secondary" onClick={closeUpdateDialog}>{t("ok")}</button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {whatsNewOpen && releaseNotes[appVersion] ? (
        <div className="modal-backdrop modal-backdrop-polished" role="presentation">
          <div className="library-dialog whats-new-dialog" role="dialog" aria-modal="true" aria-label={t("whatsNewTitle")}>
            <div className="whats-new-icon" aria-hidden="true">
              <img src={scribeIcon} alt="" />
            </div>
            <div className="whats-new-copy">
              <h2>{t("whatsNewTitle")}</h2>
              <p>Scribe {appVersion}</p>
              <ul>
                {releaseNotes[appVersion].itemKeys.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </div>
            <div className="dialog-actions confirm-dialog-actions">
              <button type="button" className="dialog-button dialog-button-primary" onClick={() => void dismissWhatsNew()}>{t("whatsNewGotIt")}</button>
            </div>
          </div>
        </div>
      ) : null}
      {onboardingOpen ? (
        <Onboarding
          data={settingsData}
          onClose={() => {
            setOnboardingOpen(false);
            setOnboardingDismissedThisSession(true);
            navigate({ view: "home" }, "top");
          }}
          onSettingsChange={syncSettings}
          t={t}
          whisperDownloads={whisperDownloads}
        />
      ) : null}
      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
    </div>
  );
}

export default App;
