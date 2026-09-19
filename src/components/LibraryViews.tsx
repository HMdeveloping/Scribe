import { Archive, AudioLines, Check, FolderClosed, FolderInput, MoreHorizontal, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type MutableRefObject } from "react";
import { languageLocales, type AppLanguage, type TFunction } from "../i18n";
import type { Project, RecordingSummary } from "../types/library";
import type { ContextMenuAction } from "./ContextMenu";
import { BackButton } from "./BackButton";

export function formatLibraryDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor(safeSeconds / 60) % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

export function formatRecordingDateTime(value: string, appLanguage: AppLanguage) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && /^\d+$/.test(value)
    ? new Date(numeric * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const locale = languageLocales[appLanguage] ?? languageLocales.en;
  const formattedDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
  }).format(date);
  const formattedTime = new Intl.DateTimeFormat(locale, {
    timeStyle: "short",
  }).format(date);
  return `${formattedDate} · ${formattedTime}`;
}

function recordingCountLabel(count: number, t: TFunction) {
  return count === 1 ? t("recordingSingular") : t("recordingPlural");
}

export function localizedRecordingTitle(title: string, t: TFunction) {
  return title === "New recording" ? t("newRecordingTitle") : title;
}

function reconcileSelectedIds(current: Set<string>, visibleIds: string[]) {
  const visible = new Set(visibleIds);
  return new Set([...current].filter((id) => visible.has(id)));
}

export function isSelectionOwnedClick(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(
    "button, a, input, textarea, select, [role='button'], [role='menuitem'], [contenteditable='true']",
  ));
}

function clearSelectionFromBackground(event: MouseEvent, clear: () => void) {
  if (!isSelectionOwnedClick(event.target)) clear();
}

export function RecordingRow({
  recording,
  t,
  appLanguage,
  onOpen,
  actions,
  selected = false,
  selectionMode = false,
  onSelect,
  onContextMenu,
  onSelectionAffordancePointerEnter,
}: {
  recording: RecordingSummary;
  t: TFunction;
  appLanguage: AppLanguage;
  onOpen: (id: string) => void;
  actions?: ContextMenuAction[];
  selected?: boolean;
  selectionMode?: boolean;
  onSelect?: (event: MouseEvent, recording: RecordingSummary) => void;
  onContextMenu?: (event: MouseEvent, recording: RecordingSummary) => void;
  onSelectionAffordancePointerEnter?: () => void;
}) {
  return (
    <div className={`recording-row-shell selectable-row-shell${selected ? " is-selected" : ""}`} onContextMenu={(event) => onContextMenu?.(event, recording)}>
      <button
        className="selection-circle"
        aria-label={selected ? t("deselect") : t("select")}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.(event, recording);
        }}
        onPointerEnter={onSelectionAffordancePointerEnter}
      >
        {selected ? <Check size={13} /> : null}
      </button>
      <button className="recording-row" onClick={(event) => {
        if (selectionMode || event.metaKey || event.ctrlKey || event.shiftKey) {
          onSelect?.(event, recording);
        } else {
          onOpen(recording.id);
        }
      }}>
      <div className="recording-row-icon">
        <AudioLines size={17} strokeWidth={1.8} />
      </div>
      <div className="recording-row-copy">
        <strong>{localizedRecordingTitle(recording.title, t)}</strong>
        <span>
          {recording.projectName ? `${recording.projectName} · ` : ""}
          {formatRecordingDateTime(recording.createdAt, appLanguage)} · {formatLibraryDuration(recording.durationSeconds)} · {t("slovenian")}
        </span>
      </div>
      </button>
      {actions && actions.length > 0 ? (
        <button className="row-menu-button" aria-label={t("recordingActions")} onClick={(event) => {
          event.stopPropagation();
          onContextMenu?.(event, recording);
        }}>
          <MoreHorizontal size={17} />
        </button>
      ) : null}
    </div>
  );
}

export function HomeRecentRecordings({
  recordings,
  t,
  appLanguage,
  onOpenRecording,
  onViewAll,
  onMoveRecordings,
  onArchiveRecordings,
  onDeleteRecordings,
  getRecordingActions,
  onRecordingContextMenu,
  clearSelectionRef,
  selectionClearSignal = 0,
}: {
  recordings: RecordingSummary[];
  t: TFunction;
  appLanguage: AppLanguage;
  onOpenRecording: (id: string) => void;
  onViewAll: () => void;
  onMoveRecordings: (recordingIds: string[], projectId: string | null) => void;
  onArchiveRecordings: (recordingIds: string[]) => Promise<void> | void;
  onDeleteRecordings: (recordingIds: string[]) => Promise<boolean> | boolean;
  getRecordingActions: (recording: RecordingSummary) => ContextMenuAction[];
  onRecordingContextMenu: (event: MouseEvent, recording: RecordingSummary) => void;
  clearSelectionRef?: MutableRefObject<() => void>;
  selectionClearSignal?: number;
}) {
  const visibleRecordings = recordings.slice(0, 5);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAffordanceHovered, setSelectionAffordanceHovered] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const anchorIndexRef = useRef<number | null>(null);
  const visibleIds = visibleRecordings.map((recording) => recording.id);
  const selectedCount = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = selectedCount > 0 && !allSelected;
  const showHeaderSelector = selectedCount > 0 || selectionAffordanceHovered;

  useEffect(() => { if (selectionClearSignal > 0) setSelectedIds(new Set()); }, [selectionClearSignal]);

  useEffect(() => {
    if (!clearSelectionRef) return;
    clearSelectionRef.current = () => setSelectedIds(new Set());
    return () => { clearSelectionRef.current = () => {}; };
  }, [clearSelectionRef]);

  useEffect(() => {
    setSelectedIds((current) => reconcileSelectedIds(current, visibleIds));
  }, [visibleIds.join(":")]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (!listRef.current?.contains(document.activeElement)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(visibleIds));
      } else if (event.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
        event.preventDefault();
        void Promise.resolve(onDeleteRecordings([...selectedIds])).then((deleted) => {
          if (deleted) setSelectedIds(new Set());
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visibleIds.join(":"), selectedIds, onDeleteRecordings]);

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
  }

  function selectRecording(event: MouseEvent, recording: RecordingSummary) {
    const index = visibleRecordings.findIndex((item) => item.id === recording.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (event.shiftKey && anchorIndexRef.current !== null) {
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        visibleRecordings.slice(start, end + 1).forEach((item) => next.add(item.id));
      } else if (event.metaKey || event.ctrlKey || current.size > 0) {
        if (next.has(recording.id)) next.delete(recording.id);
        else next.add(recording.id);
      } else {
        next.add(recording.id);
      }
      return next;
    });
    anchorIndexRef.current = index;
  }

  async function finishBulk(action: Promise<void> | Promise<boolean> | void | boolean) {
    const result = await action;
    if (result !== false) setSelectedIds(new Set());
  }

  function handleContextMenu(event: MouseEvent, recording: RecordingSummary) {
    if (selectedIds.has(recording.id) && selectedIds.size > 1) {
      event.preventDefault();
      onRecordingContextMenu(event, recording);
      return;
    }
    setSelectedIds(new Set([recording.id]));
    onRecordingContextMenu(event, recording);
  }

  return (
    <section className="recent" onClick={(event) => {
      if (selectedIds.size > 0) clearSelectionFromBackground(event, () => setSelectedIds(new Set()));
    }}>
      <div className="recent-header">
        <h2>{t("recentRecordings")}</h2>
        {recordings.length > 0 ? (
          <button className="view-all-button" onClick={onViewAll}>{t("viewAll")}</button>
        ) : null}
      </div>

      {recordings.length > 0 ? (
        <div
          ref={listRef}
          className="recording-list selectable-list"
          onClick={(event) => {
            if (selectedIds.size > 0) clearSelectionFromBackground(event, () => setSelectedIds(new Set()));
          }}
          onPointerLeave={() => setSelectionAffordanceHovered(false)}
        >
          <div className="bulk-action-bar">
            <button
              className={`selection-circle select-all-control${!showHeaderSelector ? " is-hidden" : ""}${allSelected ? " is-selected" : ""}${someSelected ? " is-indeterminate" : ""}`}
              aria-label={t("selectAll")}
              aria-pressed={allSelected}
              onClick={toggleSelectAll}
            >
              {allSelected ? <Check size={13} /> : someSelected ? <span /> : null}
            </button>
            <div className="bulk-action-items">
              {selectedCount > 0 ? (
                <>
                <span>{selectedCount} {t("selected")}</span>
                <button onClick={() => onMoveRecordings([...selectedIds], null)}><FolderInput size={15} />{t("moveToProject")}</button>
                <button onClick={() => void finishBulk(onArchiveRecordings([...selectedIds]))}><Archive size={15} />{t("archive")}</button>
                <button className="is-destructive" onClick={() => void finishBulk(onDeleteRecordings([...selectedIds]))}><Trash2 size={15} />{t("deletePermanently")}</button>
                </>
              ) : null}
            </div>
          </div>
          {visibleRecordings.map((recording) => (
            <RecordingRow
              key={recording.id}
              recording={recording}
              t={t}
              appLanguage={appLanguage}
              onOpen={onOpenRecording}
              actions={getRecordingActions(recording)}
              selected={selectedIds.has(recording.id)}
              selectionMode={selectedIds.size > 0}
              onSelect={selectRecording}
              onContextMenu={handleContextMenu}
              onSelectionAffordancePointerEnter={() => setSelectionAffordanceHovered(true)}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">
            <AudioLines size={20} strokeWidth={1.7} />
          </div>
          <h3>{t("noRecordings")}</h3>
          <p>{t("recentAppear")}</p>
        </div>
      )}
    </section>
  );
}

export function ProjectDialog({
  title,
  defaultName,
  t,
  onCancel,
  onSubmit,
}: {
  title: string;
  defaultName?: string;
  t: TFunction;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit(String(form.get("name") ?? ""));
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="library-dialog" onSubmit={handleSubmit}>
        <h2>{title}</h2>
        <label>
          <span>{t("projectName")}</span>
          <input name="name" defaultValue={defaultName} maxLength={100} autoFocus />
        </label>
        <div className="dialog-actions">
          <button type="button" className="dialog-button dialog-button-secondary" onClick={onCancel}>{t("cancel")}</button>
          <button type="submit" className="dialog-button dialog-button-primary">{t("create")}</button>
        </div>
      </form>
    </div>
  );
}

export function RenameDialog({
  title,
  label,
  defaultValue,
  t,
  onCancel,
  onSubmit,
}: {
  title: string;
  label: string;
  defaultValue: string;
  t: TFunction;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit(String(form.get("name") ?? ""));
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="library-dialog" onSubmit={handleSubmit}>
        <h2>{title}</h2>
        <label>
          <span>{label}</span>
          <input name="name" defaultValue={defaultValue} maxLength={100} autoFocus />
        </label>
        <div className="dialog-actions">
          <button type="button" className="dialog-button dialog-button-secondary" onClick={onCancel}>{t("cancel")}</button>
          <button type="submit" className="dialog-button dialog-button-primary">{t("save")}</button>
        </div>
      </form>
    </div>
  );
}

export function ProjectsView({
  projects,
  t,
  onNewProject,
  onOpenProject,
  onDeleteProjects,
  getProjectActions,
  onProjectContextMenu,
  canGoBack,
  onBack,
}: {
  projects: Project[];
  t: TFunction;
  onNewProject: () => void;
  onOpenProject: (project: Project) => void;
  onDeleteProjects: (projects: Project[]) => Promise<boolean> | boolean;
  getProjectActions: (project: Project) => ContextMenuAction[];
  onProjectContextMenu: (event: MouseEvent, project: Project) => void;
  canGoBack: boolean;
  onBack: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAffordanceHovered, setSelectionAffordanceHovered] = useState(false);
  const anchorIndexRef = useRef<number | null>(null);
  const visibleIds = projects.map((project) => project.id);
  const selectedCount = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = selectedCount > 0 && !allSelected;
  const showHeaderSelector = selectedCount > 0 || selectionAffordanceHovered;

  useEffect(() => {
    setSelectedIds((current) => reconcileSelectedIds(current, visibleIds));
  }, [visibleIds.join(":")]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(visibleIds));
      } else if (event.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
        event.preventDefault();
        const selectedProjects = projects.filter((project) => selectedIds.has(project.id));
        void Promise.resolve(onDeleteProjects(selectedProjects)).then((deleted) => {
          if (deleted) setSelectedIds(new Set());
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visibleIds.join(":"), selectedIds, projects, onDeleteProjects]);

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
  }

  function selectProject(event: MouseEvent, project: Project) {
    const index = projects.findIndex((item) => item.id === project.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (event.shiftKey && anchorIndexRef.current !== null) {
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        projects.slice(start, end + 1).forEach((item) => next.add(item.id));
      } else if (event.metaKey || event.ctrlKey || current.size > 0) {
        if (next.has(project.id)) next.delete(project.id);
        else next.add(project.id);
      } else {
        next.add(project.id);
      }
      return next;
    });
    anchorIndexRef.current = index;
  }

  async function deleteSelectedProjects() {
    const selectedProjects = projects.filter((project) => selectedIds.has(project.id));
    const deleted = await onDeleteProjects(selectedProjects);
    if (deleted) setSelectedIds(new Set());
  }

  return (
    <section className="library-view" onClick={(event) => {
      if (selectedIds.size > 0) clearSelectionFromBackground(event, () => setSelectedIds(new Set()));
    }}>
      <header className="library-header">
        <div>
          {canGoBack ? <BackButton t={t} onBack={onBack} /> : null}
          <h1>{t("projects")}</h1>
        </div>
        <button className="library-primary-button" onClick={onNewProject}>
          <Plus size={17} />{t("newProject")}
        </button>
      </header>
      {projects.length > 0 ? (
        <div className="project-list selectable-list" onPointerLeave={() => setSelectionAffordanceHovered(false)}>
          <div className="bulk-action-bar">
            <button
              className={`selection-circle select-all-control${!showHeaderSelector ? " is-hidden" : ""}${allSelected ? " is-selected" : ""}${someSelected ? " is-indeterminate" : ""}`}
              aria-label={t("selectAll")}
              aria-pressed={allSelected}
              onClick={toggleSelectAll}
            >
              {allSelected ? <Check size={13} /> : someSelected ? <span /> : null}
            </button>
            <div className="bulk-action-items">
              {selectedCount > 0 ? (
                <>
                <span>{selectedCount} {t("selected")}</span>
                <button className="is-destructive" onClick={() => void deleteSelectedProjects()}><Trash2 size={15} />{t("deletePermanently")}</button>
                </>
              ) : null}
            </div>
          </div>
          {projects.map((project) => (
            <div key={project.id} className={`project-row-shell selectable-row-shell${selectedIds.has(project.id) ? " is-selected" : ""}`} onContextMenu={(event) => {
              if (!selectedIds.has(project.id)) setSelectedIds(new Set([project.id]));
              onProjectContextMenu(event, project);
            }}>
              <button
                className="selection-circle"
                aria-label={selectedIds.has(project.id) ? t("deselect") : t("select")}
                aria-pressed={selectedIds.has(project.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  selectProject(event, project);
                }}
                onPointerEnter={() => setSelectionAffordanceHovered(true)}
              >
                {selectedIds.has(project.id) ? <Check size={13} /> : null}
              </button>
              <button className="project-row" onClick={(event) => {
                if (selectedIds.size > 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
                  selectProject(event, project);
                } else {
                  onOpenProject(project);
                }
              }}>
                <div className="project-row-icon">
                  <FolderClosed size={17} strokeWidth={1.8} />
                </div>
                <div className="project-row-copy">
                  <strong>{project.name}</strong>
                  <span>{project.recordingCount} {recordingCountLabel(project.recordingCount, t)} · {formatLibraryDuration(project.totalDurationSeconds)}</span>
                </div>
              </button>
              {getProjectActions(project).length > 0 ? (
                <button className="row-menu-button" aria-label={t("projectActions")} onClick={(event) => {
                  event.stopPropagation();
                  onProjectContextMenu(event, project);
                }}>
                  <MoreHorizontal size={17} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="library-empty-copy">{t("noProjects")}</p>
      )}
    </section>
  );
}

export function RecordingsView({
  recordings,
  t,
  appLanguage,
  onOpenRecording,
  onOpenArchived,
  onMoveRecordings,
  onArchiveRecordings,
  onRestoreRecordings,
  onDeleteRecordings,
  getRecordingActions,
  onRecordingContextMenu,
  archived = false,
  canGoBack,
  onBack,
  selectionClearSignal = 0,
}: {
  recordings: RecordingSummary[];
  t: TFunction;
  appLanguage: AppLanguage;
  onOpenRecording: (id: string) => void;
  onOpenArchived?: () => void;
  onMoveRecordings: (recordingIds: string[], projectId: string | null) => void;
  onArchiveRecordings: (recordingIds: string[]) => Promise<void> | void;
  onRestoreRecordings: (recordingIds: string[]) => Promise<void> | void;
  onDeleteRecordings: (recordingIds: string[]) => Promise<boolean> | boolean;
  getRecordingActions: (recording: RecordingSummary) => ContextMenuAction[];
  onRecordingContextMenu: (event: MouseEvent, recording: RecordingSummary) => void;
  archived?: boolean;
  canGoBack: boolean;
  onBack: () => void;
  selectionClearSignal?: number;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAffordanceHovered, setSelectionAffordanceHovered] = useState(false);
  const anchorIndexRef = useRef<number | null>(null);
  const visibleIds = recordings.map((recording) => recording.id);
  const selectedCount = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = selectedCount > 0 && !allSelected;
  const showHeaderSelector = selectedCount > 0 || selectionAffordanceHovered;

  useEffect(() => { if (selectionClearSignal > 0) setSelectedIds(new Set()); }, [selectionClearSignal]);

  useEffect(() => setSelectedIds(new Set()), [archived]);
  useEffect(() => {
    setSelectedIds((current) => reconcileSelectedIds(current, visibleIds));
  }, [visibleIds.join(":")]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(visibleIds));
      } else if (event.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
        event.preventDefault();
        void Promise.resolve(onDeleteRecordings([...selectedIds])).then((deleted) => {
          if (deleted) setSelectedIds(new Set());
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visibleIds.join(":"), selectedIds, onDeleteRecordings]);

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
  }

  function selectRecording(event: MouseEvent, recording: RecordingSummary) {
    const index = recordings.findIndex((item) => item.id === recording.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (event.shiftKey && anchorIndexRef.current !== null) {
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        recordings.slice(start, end + 1).forEach((item) => next.add(item.id));
      } else if (event.metaKey || event.ctrlKey || current.size > 0) {
        if (next.has(recording.id)) next.delete(recording.id);
        else next.add(recording.id);
      } else {
        next.add(recording.id);
      }
      return next;
    });
    anchorIndexRef.current = index;
  }

  async function finishBulk(action: Promise<void> | Promise<boolean> | void | boolean) {
    const result = await action;
    if (result !== false) setSelectedIds(new Set());
  }

  function handleContextMenu(event: MouseEvent, recording: RecordingSummary) {
    if (selectedIds.has(recording.id) && selectedIds.size > 1) {
      event.preventDefault();
      onRecordingContextMenu(event, recording);
      return;
    }
    setSelectedIds(new Set([recording.id]));
    onRecordingContextMenu(event, recording);
  }

  return (
    <section className="library-view" onClick={(event) => {
      if (event.target === event.currentTarget && selectedIds.size > 0) setSelectedIds(new Set());
    }}>
      <header className="library-header">
        <div>
          {canGoBack ? <BackButton t={t} onBack={onBack} /> : null}
          <h1>{archived ? t("archived") : t("recordings")}</h1>
        </div>
        {!archived && onOpenArchived ? (
          <button className="library-secondary-button" onClick={onOpenArchived}>
            <Archive size={16} />{t("archived")}
          </button>
        ) : null}
      </header>
      {recordings.length > 0 ? (
        <div className="recording-list selectable-list" onPointerLeave={() => setSelectionAffordanceHovered(false)} onClick={(event) => {
      if (selectedIds.size > 0) clearSelectionFromBackground(event, () => setSelectedIds(new Set()));
        }}>
          <div className="bulk-action-bar">
            <button
              className={`selection-circle select-all-control${!showHeaderSelector ? " is-hidden" : ""}${allSelected ? " is-selected" : ""}${someSelected ? " is-indeterminate" : ""}`}
              aria-label={t("selectAll")}
              aria-pressed={allSelected}
              onClick={toggleSelectAll}
            >
              {allSelected ? <Check size={13} /> : someSelected ? <span /> : null}
            </button>
            <div className="bulk-action-items">
              {selectedCount > 0 ? (
                <>
                <span>{selectedCount} {t("selected")}</span>
                {!archived ? (
                  <>
                    <button onClick={() => onMoveRecordings([...selectedIds], null)}><FolderInput size={15} />{t("moveToProject")}</button>
                    <button onClick={() => void finishBulk(onArchiveRecordings([...selectedIds]))}><Archive size={15} />{t("archive")}</button>
                  </>
                ) : (
                  <button onClick={() => void finishBulk(onRestoreRecordings([...selectedIds]))}><RotateCcw size={15} />{t("restore")}</button>
                )}
                <button className="is-destructive" onClick={() => void finishBulk(onDeleteRecordings([...selectedIds]))}><Trash2 size={15} />{t("deletePermanently")}</button>
                </>
              ) : null}
            </div>
          </div>
          {recordings.map((recording) => (
            <RecordingRow
              key={recording.id}
              recording={recording}
              t={t}
              appLanguage={appLanguage}
              onOpen={onOpenRecording}
              actions={getRecordingActions(recording)}
              selected={selectedIds.has(recording.id)}
              selectionMode={selectedIds.size > 0}
              onSelect={selectRecording}
              onContextMenu={handleContextMenu}
              onSelectionAffordancePointerEnter={() => setSelectionAffordanceHovered(true)}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state library-empty-state">
          <div className="empty-icon">
            <AudioLines size={20} strokeWidth={1.7} />
          </div>
          <h3>{t("noRecordings")}</h3>
          <p>{t("recordingsAppear")}</p>
        </div>
      )}
    </section>
  );
}

export function ProjectDetailView({
  project,
  recordings,
  t,
  appLanguage,
  onNewRecording,
  onImportAudio,
  onOpenRecording,
  onRenameProject,
  onDeleteProject,
  onMoveRecordings,
  onArchiveRecordings,
  onDeleteRecordings,
  getRecordingActions,
  onRecordingContextMenu,
  onBack,
  selectionClearSignal = 0,
}: {
  project: Project;
  recordings: RecordingSummary[];
  t: TFunction;
  appLanguage: AppLanguage;
  onNewRecording: () => void;
  onImportAudio: () => void;
  onOpenRecording: (id: string) => void;
  onRenameProject: (name: string) => Promise<void> | void;
  onDeleteProject: () => void;
  onMoveRecordings: (recordingIds: string[], projectId: string | null) => void;
  onArchiveRecordings: (recordingIds: string[]) => Promise<void> | void;
  onDeleteRecordings: (recordingIds: string[]) => Promise<boolean> | boolean;
  getRecordingActions: (recording: RecordingSummary) => ContextMenuAction[];
  onRecordingContextMenu: (event: MouseEvent, recording: RecordingSummary) => void;
  onBack: () => void;
  selectionClearSignal?: number;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionAffordanceHovered, setSelectionAffordanceHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorIndexRef = useRef<number | null>(null);
  const visibleIds = recordings.map((recording) => recording.id);
  const selectedCount = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected = selectedCount > 0 && !allSelected;
  const showHeaderSelector = selectedCount > 0 || selectionAffordanceHovered;

  useEffect(() => { if (selectionClearSignal > 0) setSelectedIds(new Set()); }, [selectionClearSignal]);

  useEffect(() => {
    setDraftName(project.name);
  }, [project.name]);
  useEffect(() => {
    setSelectedIds((current) => reconcileSelectedIds(current, visibleIds));
  }, [visibleIds.join(":")]);

  useEffect(() => {
    if (!isRenaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  async function commitRename() {
    const nextName = draftName.trim();
    if (!nextName) {
      setDraftName(project.name);
      setIsRenaming(false);
      return;
    }
    if (nextName !== project.name) {
      await onRenameProject(nextName);
    }
    setIsRenaming(false);
  }

  function cancelRename() {
    setDraftName(project.name);
    setIsRenaming(false);
  }

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(visibleIds));
      } else if (event.key === "Escape" && selectedIds.size > 0) {
        setSelectedIds(new Set());
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.size > 0) {
        event.preventDefault();
        void Promise.resolve(onDeleteRecordings([...selectedIds])).then((deleted) => {
          if (deleted) setSelectedIds(new Set());
        });
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visibleIds.join(":"), selectedIds, onDeleteRecordings]);

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
  }

  function selectRecording(event: MouseEvent, recording: RecordingSummary) {
    const index = recordings.findIndex((item) => item.id === recording.id);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (event.shiftKey && anchorIndexRef.current !== null) {
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        recordings.slice(start, end + 1).forEach((item) => next.add(item.id));
      } else if (event.metaKey || event.ctrlKey || current.size > 0) {
        if (next.has(recording.id)) next.delete(recording.id);
        else next.add(recording.id);
      } else {
        next.add(recording.id);
      }
      return next;
    });
    anchorIndexRef.current = index;
  }

  async function finishBulk(action: Promise<void> | Promise<boolean> | void | boolean) {
    const result = await action;
    if (result !== false) setSelectedIds(new Set());
  }

  return (
    <section className="library-view" onClick={(event) => {
      if (selectedIds.size > 0) clearSelectionFromBackground(event, () => setSelectedIds(new Set()));
    }}>
      <header className="library-header">
        <div>
          <BackButton t={t} onBack={onBack} />
          {isRenaming ? (
            <input
              ref={inputRef}
              className="inline-title-input project-title-input"
              value={draftName}
              maxLength={100}
              onChange={(event) => setDraftName(event.target.value)}
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
              aria-label={t("rename")}
            />
          ) : (
            <button
              className="editable-title-button project-title-button"
              onClick={() => setIsRenaming(true)}
              title={t("rename")}
            >
              <h1>{project.name}</h1>
            </button>
          )}
          <p>{project.recordingCount} {recordingCountLabel(project.recordingCount, t)} · {formatLibraryDuration(project.totalDurationSeconds)}</p>
        </div>
        <div className="library-header-actions">
          {!project.isSynthetic ? <button className="library-secondary-button" onClick={onDeleteProject}>
            <Trash2 size={16} />{t("deleteProject")}
          </button> : null}
          <button className="library-secondary-button" onClick={onImportAudio} disabled={project.isSynthetic}>
            <Upload size={16} />{t("importAudio")}
          </button>
          <button className="library-primary-button" onClick={onNewRecording} disabled={project.isSynthetic}>
            <Plus size={17} />{t("newRecording")}
          </button>
        </div>
      </header>
      {recordings.length > 0 ? (
        <div className="recording-list selectable-list" onPointerLeave={() => setSelectionAffordanceHovered(false)} onClick={(event) => {
          if (selectedIds.size > 0) clearSelectionFromBackground(event, () => setSelectedIds(new Set()));
        }}>
          <div className="bulk-action-bar">
            <button
              className={`selection-circle select-all-control${!showHeaderSelector ? " is-hidden" : ""}${allSelected ? " is-selected" : ""}${someSelected ? " is-indeterminate" : ""}`}
              aria-label={t("selectAll")}
              aria-pressed={allSelected}
              onClick={toggleSelectAll}
            >
              {allSelected ? <Check size={13} /> : someSelected ? <span /> : null}
            </button>
            <div className="bulk-action-items">
              {selectedCount > 0 ? (
                <>
                <span>{selectedCount} {t("selected")}</span>
                <button onClick={() => onMoveRecordings([...selectedIds], project.id)}><FolderInput size={15} />{t("moveToProject")}</button>
                <button onClick={() => void finishBulk(onArchiveRecordings([...selectedIds]))}><Archive size={15} />{t("archive")}</button>
                <button className="is-destructive" onClick={() => void finishBulk(onDeleteRecordings([...selectedIds]))}><Trash2 size={15} />{t("deletePermanently")}</button>
                </>
              ) : null}
            </div>
          </div>
          {recordings.map((recording) => (
            <RecordingRow
              key={recording.id}
              recording={recording}
              t={t}
              appLanguage={appLanguage}
              onOpen={onOpenRecording}
              actions={getRecordingActions(recording)}
              selected={selectedIds.has(recording.id)}
              selectionMode={selectedIds.size > 0}
              onSelect={selectRecording}
              onContextMenu={onRecordingContextMenu}
              onSelectionAffordancePointerEnter={() => setSelectionAffordanceHovered(true)}
            />
          ))}
        </div>
      ) : (
        <p className="library-empty-copy">{t("noRecordings")}</p>
      )}
    </section>
  );
}

export function MoveToProjectDialog({
  projects,
  currentProjectId,
  t,
  onCancel,
  onMove,
}: {
  projects: Project[];
  currentProjectId: string | null;
  t: TFunction;
  onCancel: () => void;
  onMove: (projectId: string | null) => void;
}) {
  const options = [
    { id: null, name: t("noProject"), hint: t("noProject") },
    ...projects.map((project) => ({ id: project.id, name: project.name, hint: t("currentProject") })),
  ];

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="library-dialog move-dialog" role="dialog" aria-modal="true" aria-label={t("moveToProject")}>
        <h2>{t("moveToProject")}</h2>
        <div className="move-project-list">
          {options.map((option) => {
            const selected = option.id === currentProjectId;
            return (
              <button key={option.id ?? "unassigned"} className="move-project-option" onClick={() => onMove(option.id)}>
                <span>
                  <strong>{option.name}</strong>
                  {selected ? <small>{option.hint}</small> : null}
                </span>
                {selected ? <Check size={17} /> : null}
              </button>
            );
          })}
        </div>
        <div className="dialog-actions">
          <button type="button" className="dialog-button dialog-button-secondary" onClick={onCancel}>{t("cancel")}</button>
        </div>
      </div>
    </div>
  );
}
