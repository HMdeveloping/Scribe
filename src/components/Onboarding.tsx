import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, Download, Headphones, Lock, Mic, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import scribeIcon from "../assets/scribe-icon.png";
import { languages, type AppLanguage, type TFunction } from "../i18n";
import { localizedModel, type SettingsViewData, type WhisperModelOption } from "./SettingsView";
import type { WhisperDownloadController } from "../hooks/useWhisperModelDownloads";

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

function modelState(model: WhisperModelOption, downloads: WhisperDownloadController, t: TFunction) {
  const progress = downloads.downloadProgress[model.id];
  if (model.installed) return t("installed");
  if (downloads.activeDownloadId === model.id || progress?.state === "downloading") return t("downloading");
  if (progress?.state === "installing") return t("installingModel");
  if (downloads.queuedDownloads.includes(model.id)) return t("queued");
  if (downloads.downloadFailures[model.id]) return t("downloadFailed");
  return t("notInstalled");
}

export function Onboarding({
  data,
  onClose,
  onSettingsChange,
  t,
  whisperDownloads,
}: {
  data: SettingsViewData | null;
  onClose: () => void;
  onSettingsChange: (settings: SettingsViewData) => void;
  t: TFunction;
  whisperDownloads: WhisperDownloadController;
}) {
  const [step, setStep] = useState(0);
  const [selectedModelId, setSelectedModelId] = useState("large-v3-turbo");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data?.settings.whisperModel) setSelectedModelId(data.settings.whisperModel);
  }, [data?.settings.whisperModel]);

  const selectedModel = useMemo(
    () => data?.models.find((model) => model.id === selectedModelId) ?? data?.models.find((model) => model.id === "large-v3-turbo") ?? data?.models[0],
    [data?.models, selectedModelId],
  );

  async function saveSettings(update: {
    appLanguage?: AppLanguage;
    transcriptionLanguage?: AppLanguage;
    whisperModel?: string;
    onboardingCompleted?: boolean;
  }) {
    const nextData = await invoke<SettingsViewData>("save_scribe_settings", update);
    onSettingsChange(nextData);
    return nextData;
  }

  async function finish({ download }: { download: boolean }) {
    if (!selectedModel) return;
    setSaving(true);
    try {
      const nextData = await saveSettings({
        whisperModel: selectedModel.id,
        onboardingCompleted: true,
      });
      const nextModel = nextData.models.find((model) => model.id === selectedModel.id);
      if (download && nextModel && !nextModel.installed) {
        whisperDownloads.requestModelDownload(nextModel.id, nextData);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function skip() {
    setSaving(true);
    try {
      await saveSettings({ onboardingCompleted: true });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const primaryLabel = step < 2
    ? t("continue")
    : selectedModel?.installed || whisperDownloads.activeDownloadId === selectedModel?.id || whisperDownloads.queuedDownloads.includes(selectedModel?.id ?? "")
      ? t("continue")
      : t("downloadAndContinue");

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-sheet" role="dialog" aria-modal="true" aria-label={t("welcomeToScribe")}>
        <header className="onboarding-brand">
          <img src={scribeIcon} alt="" />
          <span>Scribe</span>
        </header>

        <div className="onboarding-content">
          {step === 0 ? (
            <div className="onboarding-step">
              <div className="onboarding-spark" aria-hidden="true"><Sparkles size={18} /></div>
              <h1>{t("welcomeToScribe")}</h1>
              <p>{t("onboardingWelcomeCopy")}</p>
              <div className="onboarding-benefits">
                <span><Mic size={17} />{t("onboardingRecordImport")}</span>
                <span><Headphones size={17} />{t("onboardingLocalTranscription")}</span>
                <span><Lock size={17} />{t("onboardingPrivateRecordings")}</span>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="onboarding-step">
              <h1>{t("chooseYourLanguages")}</h1>
              <p>{t("onboardingLanguagesCopy")}</p>
              <div className="onboarding-language-grid">
                <label>
                  <span>{t("applicationLanguage")}</span>
                  <select
                    value={data?.settings.appLanguage ?? "en"}
                    onChange={(event) => void saveSettings({ appLanguage: event.target.value as AppLanguage })}
                    disabled={!data || saving}
                  >
                    {languages.map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>{t("transcriptionLanguage")}</span>
                  <select
                    value={data?.settings.transcriptionLanguage ?? "sl"}
                    onChange={(event) => void saveSettings({ transcriptionLanguage: event.target.value as AppLanguage })}
                    disabled={!data || saving}
                  >
                    {languages.map((language) => <option key={language.code} value={language.code}>{language.name}</option>)}
                  </select>
                </label>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="onboarding-step">
              <h1>{t("chooseTranscriptionModel")}</h1>
              <p>{t("onboardingModelCopy")}</p>
              <div className="onboarding-model-grid">
                {data?.models.map((model) => {
                  const copy = localizedModel(model, t);
                  const selected = selectedModelId === model.id;
                  return (
                    <button
                      key={model.id}
                      className={`onboarding-model-card${selected ? " selected" : ""}`}
                      onClick={() => setSelectedModelId(model.id)}
                      disabled={saving}
                    >
                      <span className="onboarding-model-card-top">
                        <strong>{copy.name}</strong>
                        <em>{copy.badge}</em>
                      </span>
                      <small>{copy.description}</small>
                      <span className="onboarding-model-meta">
                        <span>{formatBytes(model.sizeBytes ?? model.expectedBytes)}</span>
                        <span>{modelState(model, whisperDownloads, t)}</span>
                      </span>
                      {selected ? <Check className="onboarding-model-check" size={16} /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <footer className="onboarding-footer">
          <button className="onboarding-skip" onClick={() => void skip()} disabled={saving}>{t("skipForNow")}</button>
          <div className="onboarding-dots" aria-hidden="true">
            {[0, 1, 2].map((index) => <span key={index} className={index === step ? "active" : ""} />)}
          </div>
          <div className="onboarding-actions">
            {step > 0 ? (
              <button className="onboarding-secondary" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={saving}>
                <ChevronLeft size={15} />{t("back")}
              </button>
            ) : null}
            <button
              className="onboarding-primary"
              onClick={() => {
                if (step < 2) {
                  setStep((current) => current + 1);
                } else {
                  void finish({ download: !selectedModel?.installed });
                }
              }}
              disabled={!data || saving}
            >
              {step === 2 && !selectedModel?.installed ? <Download size={15} /> : null}
              {primaryLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
