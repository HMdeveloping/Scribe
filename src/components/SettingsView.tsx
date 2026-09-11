import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, LoaderCircle, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { languages, type AppLanguage, type TFunction } from "../i18n";
import type { WhisperDownloadController } from "../hooks/useWhisperModelDownloads";

export type WhisperModelOption = {
  id: string;
  name: string;
  filename: string;
  badge: string;
  description: string;
  installed: boolean;
  selected: boolean;
  sizeBytes?: number;
  expectedBytes?: number;
};

export type ScribeSettings = {
  version: 1;
  whisperModel: string;
  transcriptionLanguage: AppLanguage;
  language: AppLanguage;
  appLanguage: AppLanguage;
  onboardingCompleted: boolean;
};

export type SettingsViewData = {
  settings: ScribeSettings;
  models: WhisperModelOption[];
};

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "ready" | "error";

export type UpdateProgress = {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
};

const SETTINGS_SECTIONS = ["General", "Transcription", "Audio", "Appearance", "Storage", "About"];

function formatBytes(bytes?: number) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function localizedModel(model: WhisperModelOption, t: TFunction) {
  const labels: Record<string, { name: string; badge: string; description: string }> = {
    small: { name: t("small"), badge: t("fast"), description: t("smallDescription") },
    medium: { name: t("medium"), badge: t("balanced"), description: t("mediumDescription") },
    "large-v3-turbo": { name: t("largeV3Turbo"), badge: t("recommended"), description: t("turboDescription") },
    "large-v3": { name: t("largeV3"), badge: t("bestQuality"), description: t("largeDescription") },
  };
  return labels[model.id] ?? { name: model.name, badge: model.badge, description: model.description };
}

function LanguagePicker({
  title,
  description,
  selectedLanguage,
  onChoose,
  onClose,
}: {
  title: string;
  description: string;
  selectedLanguage: AppLanguage;
  onChoose: (language: AppLanguage) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="model-picker-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="model-picker" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <p>{description}</p>
        </header>
        <div className="model-list language-list">
          {languages.map((language) => (
            <button key={language.code} className="language-option" onClick={() => onChoose(language.code)}>
              <span className="model-check" aria-hidden="true">
                {selectedLanguage === language.code ? <Check size={17} /> : null}
              </span>
              <span>{language.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsView({
  appVersion,
  initialData,
  initialSection = "General",
  onSettingsChange,
  onCheckForUpdates,
  onShowWelcomeGuide,
  t,
  updateError,
  updateProgress,
  updateStatus,
  whisperDownloads,
}: {
  appVersion: string;
  initialData: SettingsViewData | null;
  initialSection?: string;
  onSettingsChange: (settings: SettingsViewData) => void;
  onCheckForUpdates: () => void;
  onShowWelcomeGuide: () => void;
  t: TFunction;
  updateError: string;
  updateProgress: UpdateProgress | null;
  updateStatus: UpdateStatus;
  whisperDownloads: WhisperDownloadController;
}) {
  const [data, setData] = useState<SettingsViewData | null>(null);
  const [activeSection, setActiveSection] = useState(initialSection);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [transcriptionLanguagePickerOpen, setTranscriptionLanguagePickerOpen] = useState(false);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<WhisperModelOption | null>(null);
  const [error, setError] = useState("");
  const { activeDownloadId, cancelActiveDownload, downloadFailures, downloadProgress, queuedDownloads, removeQueuedDownload, requestModelDownload } = whisperDownloads;

  useEffect(() => {
    if (initialData) setData(initialData);
  }, [initialData]);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    let disposed = false;
    void invoke<SettingsViewData>("load_scribe_settings")
      .then((nextData) => {
        if (disposed) return;
        setData(nextData);
        onSettingsChange(nextData);
      })
      .catch((reason) => {
        console.error("Scribe: unable to load settings", reason);
        if (!disposed) setError(t("unableLoadSettings"));
      });
    return () => {
      disposed = true;
    };
  }, [onSettingsChange]);

  const selectedModel = useMemo(() => {
    return data?.models.find((model) => model.selected) ?? null;
  }, [data]);
  async function chooseModel(modelId: string) {
    setSavingModel(modelId);
    setError("");
    try {
      const nextData = await invoke<SettingsViewData>("save_scribe_settings", {
        whisperModel: modelId,
      });
      setData(nextData);
      onSettingsChange(nextData);
      setPickerOpen(false);
    } catch (reason) {
      console.error("Scribe: unable to save settings", reason);
      setError(t("unableSaveSettings"));
    } finally {
      setSavingModel(null);
    }
  }

  async function chooseLanguage(language: AppLanguage) {
    if (!data) return;
    setError("");
    try {
      const nextData = await invoke<SettingsViewData>("save_scribe_settings", {
        appLanguage: language,
      });
      setData(nextData);
      onSettingsChange(nextData);
      setLanguagePickerOpen(false);
    } catch (reason) {
      console.error("Scribe: unable to save language", reason);
      setError(t("unableSaveSettings"));
    }
  }

  async function chooseTranscriptionLanguage(language: AppLanguage) {
    if (!data) return;
    setError("");
    try {
      const nextData = await invoke<SettingsViewData>("save_scribe_settings", {
        transcriptionLanguage: language,
      });
      setData(nextData);
      onSettingsChange(nextData);
      setTranscriptionLanguagePickerOpen(false);
    } catch (reason) {
      console.error("Scribe: unable to save transcription language", reason);
      setError(t("unableSaveSettings"));
    }
  }

  async function deleteModel(modelId: string) {
    try {
      const nextData = await invoke<SettingsViewData>("delete_whisper_model", { modelId });
      setData(nextData);
      onSettingsChange(nextData);
      setDeleteCandidate(null);
    } catch (reason) {
      console.error("Scribe: unable to delete model", reason);
      setError(t("deleteFailed"));
    }
  }

  const selectedLanguage = languages.find((language) => language.code === data?.settings.appLanguage) ?? languages[1];
  const selectedTranscriptionLanguage = languages.find((language) => language.code === data?.settings.transcriptionLanguage) ?? languages[0];
  const selectedModelCopy = selectedModel ? localizedModel(selectedModel, t) : null;

  return (
    <section className="settings-view" aria-label={t("settings")}>
      <header>
        <h1>{t("settings")}</h1>
      </header>

      <div className="settings-layout">
        <nav className="settings-sections" aria-label={t("settings")}>
          {SETTINGS_SECTIONS.map((section) => {
            const key = section.toLowerCase() as "general" | "transcription" | "audio" | "appearance" | "storage" | "about";
            return (
            <button key={section} className={section === activeSection ? "active" : ""} onClick={() => setActiveSection(section)}>
              {t(key)}
            </button>
            );
          })}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel-header">
            <h2>{t(activeSection.toLowerCase() as "general" | "transcription" | "audio" | "appearance" | "storage" | "about")}</h2>
          </div>

          {activeSection === "General" ? (
          <button className="settings-row" onClick={() => setLanguagePickerOpen(true)} disabled={!data}>
            <span>
              <strong>{t("applicationLanguage")}</strong>
              <small>{t("interfaceLanguage")}</small>
            </span>
            <span className="settings-row-value">
              {selectedLanguage.name}
              <ChevronRight size={17} />
            </span>
          </button>
          ) : null}

          {activeSection === "Transcription" ? (
          <>
          <p className="settings-section-copy">{t("localWhisperSettings")}</p>
          <button className="settings-row" onClick={() => setTranscriptionLanguagePickerOpen(true)} disabled={!data}>
            <span>
              <strong>{t("transcriptionLanguage")}</strong>
              <small>{t("recordingLanguage")}</small>
            </span>
            <span className="settings-row-value">
              {selectedTranscriptionLanguage.name}
              <ChevronRight size={17} />
            </span>
          </button>
          <button className="settings-row" onClick={() => setPickerOpen(true)} disabled={!data}>
            <span>
              <strong>{t("whisperModel")}</strong>
              <small>{selectedModelCopy?.description ?? t("chooseWhisperModel")}</small>
            </span>
            <span className="settings-row-value">
              {selectedModelCopy?.name ?? t("selectModel")}
              <ChevronRight size={17} />
            </span>
          </button>
          </>
          ) : null}

          {activeSection === "About" ? (
            <>
              <div className="settings-row static-settings-row">
                <span>
                  <strong>Scribe</strong>
                  <small>{t("version")} {appVersion}</small>
                </span>
                <span className="settings-row-value">{t(updateStatus === "ready" ? "updateReady" : updateStatus === "up-to-date" ? "upToDate" : updateStatus === "available" ? "updateAvailable" : "about")}</span>
              </div>
              <button className="settings-row" onClick={onCheckForUpdates} disabled={updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing"}>
                <span>
                  <strong>{t("checkForUpdates")}</strong>
                  <small>
                    {updateStatus === "checking" ? t("checkingForUpdates")
                      : updateStatus === "downloading" ? `${t("downloadingUpdate")} ${updateProgress?.percent !== undefined ? `${Math.round(updateProgress.percent)}%` : ""}`
                      : updateStatus === "installing" ? t("installingUpdate")
                      : updateStatus === "error" && updateError ? updateError
                      : t("secureUpdates")}
                  </small>
                </span>
                <span className="settings-row-value">
                  {updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing" ? <LoaderCircle size={15} /> : <ChevronRight size={17} />}
                </span>
              </button>
              <button className="settings-row" onClick={onShowWelcomeGuide}>
                <span>
                  <strong>{t("showWelcomeGuide")}</strong>
                  <small>{t("showWelcomeGuideCopy")}</small>
                </span>
                <span className="settings-row-value">
                  <ChevronRight size={17} />
                </span>
              </button>
            </>
          ) : null}

          {!["General", "Transcription", "About"].includes(activeSection) ? (
            <p className="settings-section-copy">{t("comingSoon")}</p>
          ) : null}

          {error ? <p className="settings-error">{error}</p> : null}
        </div>
      </div>

      {pickerOpen && data ? (
        <div className="model-picker-backdrop" role="presentation" onMouseDown={() => setPickerOpen(false)}>
          <div className="model-picker" role="dialog" aria-modal="true" aria-label={t("whisperModel")} onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>{t("whisperModel")}</h2>
              <p>{t("chooseWhisperModel")}</p>
            </header>

            <div className="model-list">
              {data.models.map((model) => {
                const modelProgress = downloadProgress[model.id];
                const isActiveDownload = activeDownloadId === model.id || modelProgress?.state === "downloading" || modelProgress?.state === "installing";
                const isQueued = queuedDownloads.includes(model.id);
                return (
                <div key={model.id} className="model-option">
                  <span className="model-check" aria-hidden="true">
                    {model.selected ? <Check size={17} /> : null}
                  </span>
                  <button className="model-select-button" onClick={() => void chooseModel(model.id)} disabled={savingModel !== null || !model.installed}>
                    <span className="model-copy">
                      <strong>{localizedModel(model, t).name} <em>{localizedModel(model, t).badge}</em></strong>
                      <small>{localizedModel(model, t).description}</small>
                      <small>{formatBytes(model.sizeBytes ?? model.expectedBytes)}</small>
                    </span>
                  </button>
                  <span className={`model-installed${model.installed ? " is-installed" : ""}`}>
                    {savingModel === model.id ? <LoaderCircle size={14} /> : model.installed ? t("installed") : isActiveDownload ? (modelProgress?.state === "installing" ? t("installingModel") : t("downloading")) : isQueued ? t("queued") : t("notInstalled")}
                  </span>
                  {model.installed ? (
                    <button
                      className="model-action-button"
                      aria-label={t("delete")}
                      disabled={model.selected || isActiveDownload}
                      title={model.selected ? t("deleteSelectedModelDisabled") : undefined}
                      onClick={() => setDeleteCandidate(model)}
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : (
                    <button
                      className="model-action-button text-action"
                      aria-label={isQueued ? t("cancelDownload") : undefined}
                      disabled={modelProgress?.state === "installing"}
                      onClick={() => {
                        if (isActiveDownload) {
                          void cancelActiveDownload(model.id).catch((reason) => {
                            console.error("Scribe: unable to cancel model download", reason);
                            setError(t("cancelDownloadFailed"));
                          });
                        } else if (isQueued) {
                          removeQueuedDownload(model.id);
                        } else {
                          requestModelDownload(model.id);
                        }
                      }}
                    >
                      {modelProgress?.state === "installing" ? t("installingModel") : isActiveDownload ? t("cancelDownload") : isQueued ? <X size={15} /> : downloadFailures[model.id] ? t("retry") : t("download")}
                    </button>
                  )}
                  {modelProgress?.state === "downloading" || modelProgress?.state === "installing" ? (
                    <div className="model-progress">
                      <span>{modelProgress.state === "installing" ? t("installingModel") : t("downloading")} {modelProgress.percent !== undefined ? `${Math.round(modelProgress.percent ?? 0)}%` : ""}</span>
                      <span>{formatBytes(modelProgress.downloadedBytes)}{modelProgress.totalBytes ? ` ${t("of")} ${formatBytes(modelProgress.totalBytes)}` : ""}</span>
                      <progress value={modelProgress.totalBytes ? modelProgress.downloadedBytes : undefined} max={modelProgress.totalBytes ?? undefined} />
                    </div>
                  ) : isQueued ? <p className="model-queued-note">{t("queued")}</p> : downloadFailures[model.id] ? <p className="model-inline-error">{t("downloadFailed")}</p> : null}
                </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {languagePickerOpen && data ? <LanguagePicker
        title={t("applicationLanguage")}
        description={t("chooseLanguage")}
        selectedLanguage={data.settings.appLanguage}
        onChoose={(language) => void chooseLanguage(language)}
        onClose={() => setLanguagePickerOpen(false)}
      /> : null}

      {transcriptionLanguagePickerOpen && data ? <LanguagePicker
        title={t("transcriptionLanguage")}
        description={t("chooseTranscriptionLanguage")}
        selectedLanguage={data.settings.transcriptionLanguage}
        onChoose={(language) => void chooseTranscriptionLanguage(language)}
        onClose={() => setTranscriptionLanguagePickerOpen(false)}
      /> : null}

      {deleteCandidate ? (
        <div className="modal-backdrop modal-backdrop-polished" role="presentation" onMouseDown={() => setDeleteCandidate(null)}>
          <div className="library-dialog confirm-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-label={t("delete")} onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-dialog-icon" aria-hidden="true">
              <Trash2 size={18} />
            </div>
            <div className="confirm-dialog-copy">
              <h2>{t("deleteModelTitle")}</h2>
              <p>{t("deleteModelCopy")}</p>
            </div>
            <div className="dialog-actions confirm-dialog-actions">
              <button className="dialog-button dialog-button-secondary" onClick={() => setDeleteCandidate(null)}>{t("cancel")}</button>
              <button className="dialog-button dialog-button-danger" onClick={() => void deleteModel(deleteCandidate.id)}>{t("delete")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
