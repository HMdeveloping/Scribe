import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SettingsViewData } from "../components/SettingsView";

export type DownloadProgress = {
  modelId: string;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  state: string;
};

export type WhisperDownloadController = {
  activeDownloadId: string | null;
  queuedDownloads: string[];
  downloadFailures: Record<string, boolean>;
  downloadProgress: Record<string, DownloadProgress>;
  requestModelDownload: (modelId: string) => void;
  cancelActiveDownload: (modelId: string) => Promise<void>;
  removeQueuedDownload: (modelId: string) => void;
  clearDownloadFailure: (modelId: string) => void;
};

export function useWhisperModelDownloads({
  getSettings,
  onRefreshSettings,
}: {
  getSettings: () => SettingsViewData | null;
  onRefreshSettings: (settings: SettingsViewData) => void;
}): WhisperDownloadController {
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [activeDownloadId, setActiveDownloadId] = useState<string | null>(null);
  const [queuedDownloads, setQueuedDownloads] = useState<string[]>([]);
  const [downloadFailures, setDownloadFailures] = useState<Record<string, boolean>>({});
  const activeDownloadIdRef = useRef<string | null>(null);
  const queuedDownloadsRef = useRef<string[]>([]);

  useEffect(() => {
    let disposed = false;
    void listen<DownloadProgress>("whisper-model-download-progress", (event) => {
      if (disposed) return;
      if (event.payload.state === "cancelled") {
        setDownloadProgress((current) => {
          const next = { ...current };
          delete next[event.payload.modelId];
          return next;
        });
        return;
      }
      setDownloadProgress((current) => ({
        ...current,
        [event.payload.modelId]: event.payload,
      }));
    }).then((unlisten) => {
      if (disposed) unlisten();
    });
    return () => {
      disposed = true;
    };
  }, []);

  function updateQueue(nextQueue: string[]) {
    queuedDownloadsRef.current = nextQueue;
    setQueuedDownloads(nextQueue);
  }

  function isInstalledModel(modelId: string) {
    return getSettings()?.models.some((model) => model.id === modelId && model.installed) ?? false;
  }

  async function refreshSettings() {
    const nextData = await invoke<SettingsViewData>("load_scribe_settings");
    onRefreshSettings(nextData);
  }

  function requestModelDownload(modelId: string) {
    if (isInstalledModel(modelId) || activeDownloadIdRef.current === modelId || queuedDownloadsRef.current.includes(modelId)) return;
    setDownloadFailures((current) => ({ ...current, [modelId]: false }));
    if (activeDownloadIdRef.current) {
      updateQueue([...queuedDownloadsRef.current, modelId]);
      return;
    }
    void runQueuedDownload(modelId);
  }

  async function runQueuedDownload(modelId: string) {
    activeDownloadIdRef.current = modelId;
    setActiveDownloadId(modelId);
    setDownloadFailures((current) => ({ ...current, [modelId]: false }));
    try {
      await invoke("download_whisper_model", { modelId });
      await refreshSettings();
      setDownloadProgress((current) => {
        const next = { ...current };
        delete next[modelId];
        return next;
      });
    } catch (reason) {
      console.error("Scribe: unable to download model", reason);
      setDownloadFailures((current) => ({ ...current, [modelId]: true }));
      setDownloadProgress((current) => {
        const next = { ...current };
        delete next[modelId];
        return next;
      });
    } finally {
      activeDownloadIdRef.current = null;
      setActiveDownloadId(null);
      const [nextDownload, ...remainingDownloads] = queuedDownloadsRef.current;
      updateQueue(remainingDownloads);
      if (nextDownload) void runQueuedDownload(nextDownload);
    }
  }

  async function cancelActiveDownload(modelId: string) {
    await invoke("cancel_whisper_model_download", { modelId });
  }

  function removeQueuedDownload(modelId: string) {
    updateQueue(queuedDownloadsRef.current.filter((queuedModelId) => queuedModelId !== modelId));
  }

  function clearDownloadFailure(modelId: string) {
    setDownloadFailures((current) => ({ ...current, [modelId]: false }));
  }

  return {
    activeDownloadId,
    queuedDownloads,
    downloadFailures,
    downloadProgress,
    requestModelDownload,
    cancelActiveDownload,
    removeQueuedDownload,
    clearDownloadFailure,
  };
}
