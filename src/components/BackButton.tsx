import { ArrowLeft } from "lucide-react";
import type { TFunction } from "../i18n";

export function BackButton({ t, onBack }: { t: TFunction; onBack: () => void }) {
  return (
    <button className="back-button" aria-label={t("back")} title={t("back")} onClick={onBack}>
      <ArrowLeft size={17} />
      <span>{t("back")}</span>
    </button>
  );
}
