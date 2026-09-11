use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_WHISPER_MODEL_ID: &str = "large-v3-turbo";
const DEFAULT_TRANSCRIPTION_LANGUAGE: &str = "sl";
const DEFAULT_APP_LANGUAGE: &str = "en";
const MODEL_SOURCE_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const SUPPORTED_LANGUAGES: &[&str] = &["sl", "en", "de", "es", "it", "hr", "fr", "pt", "nl", "pl"];
static ACTIVE_MODEL_DOWNLOAD: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static CANCELLED_MODEL_DOWNLOADS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct WhisperModelDefinition {
    id: &'static str,
    name: &'static str,
    filename: &'static str,
    badge: &'static str,
    description: &'static str,
    expected_bytes: Option<u64>,
}

const WHISPER_MODELS: &[WhisperModelDefinition] = &[
    WhisperModelDefinition {
        id: "small",
        name: "Small",
        filename: "ggml-small.bin",
        badge: "Fast",
        description: "Fastest, lower accuracy",
        expected_bytes: Some(487_601_967),
    },
    WhisperModelDefinition {
        id: "medium",
        name: "Medium",
        filename: "ggml-medium.bin",
        badge: "Balanced",
        description: "Balanced speed and accuracy",
        expected_bytes: Some(1_533_763_078),
    },
    WhisperModelDefinition {
        id: "large-v3-turbo",
        name: "Large v3 Turbo",
        filename: "ggml-large-v3-turbo.bin",
        badge: "Recommended",
        description: "High accuracy with faster processing",
        expected_bytes: Some(1_624_555_275),
    },
    WhisperModelDefinition {
        id: "large-v3",
        name: "Large v3",
        filename: "ggml-large-v3.bin",
        badge: "Best quality",
        description: "Best accuracy, slower and more demanding",
        expected_bytes: Some(3_099_699_757),
    },
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingMetadata {
    version: u8,
    id: String,
    title: String,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    imported_at: Option<String>,
    duration_seconds: u64,
    language: String,
    audio_file: String,
    mime_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
    recording_count: u64,
    total_duration_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSummary {
    id: String,
    project_id: Option<String>,
    project_name: Option<String>,
    title: String,
    created_at: String,
    updated_at: String,
    duration_seconds: f64,
    language: String,
    audio_file: String,
    mime_type: String,
    transcript_file: Option<String>,
    transcript_status: String,
    archived_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRecordingsResult {
    deleted_ids: Vec<String>,
    failed: Vec<BulkRecordingFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectsResult {
    deleted_ids: Vec<String>,
    cleared_recording_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkRecordingFailure {
    id: String,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingDetails {
    recording: RecordingMetadata,
    project_id: Option<String>,
    project_name: Option<String>,
    transcript_status: String,
    transcript: Option<TranscriptData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecordingResult {
    id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRecordingAudioResult {
    audio_bytes: Vec<u8>,
    mime_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    start: f64,
    end: f64,
    text: String,
    #[serde(default)]
    words: Vec<TranscriptWord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptData {
    version: u8,
    language: String,
    text: String,
    segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionConfig {
    model_filename: String,
    language: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScribeSettings {
    #[serde(default = "default_settings_version")]
    version: u8,
    #[serde(default = "default_whisper_model")]
    whisper_model: String,
    #[serde(default = "default_transcription_language")]
    transcription_language: String,
    #[serde(default = "default_transcription_language")]
    language: String,
    #[serde(default = "default_app_language")]
    app_language: String,
    #[serde(default = "default_onboarding_completed")]
    onboarding_completed: bool,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

struct LoadedSettings {
    settings: ScribeSettings,
    settings_file_existed: bool,
    onboarding_flag_present: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelOption {
    id: String,
    name: String,
    filename: String,
    badge: String,
    description: String,
    installed: bool,
    selected: bool,
    size_bytes: Option<u64>,
    expected_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsViewData {
    settings: ScribeSettings,
    models: Vec<WhisperModelOption>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    model_id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
    state: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportAudioProgress {
    import_id: String,
    recording_id: Option<String>,
    stage: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTranscriptionProgress {
    recording_id: String,
    stage: String,
    duration_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "message")]
pub enum TranscriptionError {
    ModelMissing(String),
    FfmpegMissing(String),
    WhisperMissing(String),
    ConversionFailed(String),
    WhisperFailed(String),
    TranscriptUnavailable(String),
    InvalidRecording(String),
    Io(String),
}

fn is_valid_recording_id(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(index, character)| {
            matches!(index, 8 | 13 | 18 | 23) && character == '-'
                || !matches!(index, 8 | 13 | 18 | 23) && character.is_ascii_hexdigit()
        })
}

fn recording_paths(
    app: &AppHandle,
    recording_id: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))?;
    let recording_dir = app_data_dir.join("recordings").join(recording_id);
    Ok((
        recording_dir.join("audio.webm"),
        recording_dir.join("recording.json"),
    ))
}

fn is_safe_recording_file_name(file_name: &str) -> bool {
    !file_name.is_empty()
        && file_name != "."
        && file_name != ".."
        && !file_name.contains('/')
        && !file_name.contains('\\')
}

fn audio_path_from_metadata(
    recording_dir: &Path,
    metadata: &RecordingMetadata,
) -> Result<PathBuf, String> {
    if !is_safe_recording_file_name(&metadata.audio_file) {
        return Err("Invalid audio file name".to_string());
    }
    Ok(recording_dir.join(&metadata.audio_file))
}

fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "webm" => "audio/webm",
        "mp4" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn is_supported_import_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "oga" | "opus" | "webm" | "mp4"
    )
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Imported audio")
        .chars()
        .take(100)
        .collect()
}

fn ffmpeg_duration_seconds(ffmpeg: &Path, audio_path: &Path) -> Result<u64, String> {
    let output = Command::new(ffmpeg)
        .arg("-i")
        .arg(audio_path)
        .output()
        .map_err(|error| format!("Unable to inspect audio duration: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let marker = "Duration: ";
    let Some(start) = stderr.find(marker).map(|index| index + marker.len()) else {
        return Err("Unable to determine audio duration".to_string());
    };
    let value = stderr[start..].split(',').next().unwrap_or("").trim();
    let parts = value.split(':').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err("Unable to parse audio duration".to_string());
    }
    let hours = parts[0]
        .parse::<f64>()
        .map_err(|_| "Unable to parse audio duration".to_string())?;
    let minutes = parts[1]
        .parse::<f64>()
        .map_err(|_| "Unable to parse audio duration".to_string())?;
    let seconds = parts[2]
        .parse::<f64>()
        .map_err(|_| "Unable to parse audio duration".to_string())?;
    Ok(((hours * 3600.0) + (minutes * 60.0) + seconds)
        .round()
        .max(0.0) as u64)
}

fn looks_like_media_timestamp(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() >= 10
        && trimmed
            .chars()
            .take(4)
            .all(|character| character.is_ascii_digit())
        && trimmed.as_bytes().get(4) == Some(&b'-')
        && trimmed.as_bytes().get(7) == Some(&b'-')
}

fn embedded_media_created_at(ffprobe: &Path, audio_path: &Path) -> Option<String> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_entries",
            "format_tags:stream_tags",
        ])
        .arg(audio_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).ok()?;
    let mut candidates = Vec::new();
    if let Some(tags) = parsed.get("format").and_then(|format| format.get("tags")) {
        collect_media_date_candidates(tags, &mut candidates);
    }
    if let Some(streams) = parsed.get("streams").and_then(Value::as_array) {
        for stream in streams {
            if let Some(tags) = stream.get("tags") {
                collect_media_date_candidates(tags, &mut candidates);
            }
        }
    }
    candidates
        .into_iter()
        .find(|value| looks_like_media_timestamp(value))
}

fn collect_media_date_candidates(tags: &Value, candidates: &mut Vec<String>) {
    let Some(map) = tags.as_object() else {
        return;
    };
    for (key, value) in map {
        let key = key.to_ascii_lowercase();
        if !(key.contains("creation") || key.contains("record") || key == "date") {
            continue;
        }
        if let Some(text) = value.as_str() {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                candidates.push(trimmed.to_string());
            }
        }
    }
}

fn system_time_text(value: SystemTime) -> Option<String> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs().to_string())
}

fn filesystem_source_created_at(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    metadata
        .created()
        .ok()
        .and_then(system_time_text)
        .or_else(|| metadata.modified().ok().and_then(system_time_text))
}

fn imported_source_created_at(app: &AppHandle, source: &Path, import_time: &str) -> String {
    resolve_ffprobe(app)
        .ok()
        .and_then(|ffprobe| embedded_media_created_at(&ffprobe, source))
        .or_else(|| filesystem_source_created_at(source))
        .unwrap_or_else(|| import_time.to_string())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve app data directory: {error}"))
}

fn now_text() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("scribe.db"))
}

fn open_database(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create database directory: {error}"))?;
    }
    let conn =
        Connection::open(&path).map_err(|error| format!("Unable to open database: {error}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Unable to enable database foreign keys: {error}"))?;
    migrate_database(app, &conn)?;
    import_existing_recordings(app, &conn)?;
    Ok(conn)
}

fn backup_database(app: &AppHandle) -> Result<(), String> {
    let path = db_path(app)?;
    if !path.is_file() {
        return Ok(());
    }

    let backup_dir = app_data_dir(app)?.join("backups");
    std::fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Unable to create database backup directory: {error}"))?;
    let backup_path = backup_dir.join(format!("scribe-{}.db", now_text()));
    std::fs::copy(&path, backup_path)
        .map_err(|error| format!("Unable to copy database backup: {error}"))?;

    let mut backups = std::fs::read_dir(&backup_dir)
        .map_err(|error| format!("Unable to read database backups: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_name().to_string_lossy().starts_with("scribe-")
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "db")
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|entry| {
        entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });

    while backups.len() > 8 {
        if let Some(entry) = backups.first() {
            let _ = std::fs::remove_file(entry.path());
        }
        backups.remove(0);
    }

    Ok(())
}

fn migrate_database(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| format!("Unable to read database version: {error}"))?;

    if let Err(error) = backup_database(app) {
        eprintln!("Scribe library: database backup skipped: {error}");
    }

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recordings (
          id TEXT PRIMARY KEY,
          project_id TEXT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          duration_seconds REAL NOT NULL,
          language TEXT NOT NULL,
          audio_file TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          transcript_file TEXT NULL,
          transcript_status TEXT NOT NULL,
          recording_dir TEXT NOT NULL,
          imported_at TEXT NULL,
          archived_at TEXT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_recordings_project_id ON recordings(project_id);
        "#,
    )
    .map_err(|error| format!("Unable to migrate database: {error}"))?;

    ensure_column(conn, "recordings", "archived_at", "TEXT NULL")?;
    ensure_column(conn, "recordings", "imported_at", "TEXT NULL")?;
    ensure_column(conn, "projects", "archived_at", "TEXT NULL")?;

    if version < 2 {
        conn.pragma_update(None, "user_version", 2)
            .map_err(|error| format!("Unable to set database version: {error}"))?;
    }

    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Unable to inspect {table} schema: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Unable to read {table} schema: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read {table} columns: {error}"))?;
    if columns.iter().any(|name| name == column) {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )
    .map_err(|error| format!("Unable to add {table}.{column}: {error}"))?;
    Ok(())
}

fn recording_dir_for_id(app: &AppHandle, recording_id: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("recordings").join(recording_id))
}

fn insert_or_update_recording_index(
    conn: &Connection,
    metadata: &RecordingMetadata,
    project_id: Option<&str>,
    recording_dir: &Path,
    transcript_file: Option<&str>,
    transcript_status: &str,
) -> Result<(), String> {
    let updated_at = now_text();
    conn.execute(
        r#"
        INSERT INTO recordings (
          id, project_id, title, created_at, updated_at, duration_seconds, language,
          audio_file, mime_type, transcript_file, transcript_status, recording_dir, imported_at, archived_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL)
        ON CONFLICT(id) DO UPDATE SET
          project_id = COALESCE(excluded.project_id, recordings.project_id),
          title = excluded.title,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          duration_seconds = excluded.duration_seconds,
          language = excluded.language,
          audio_file = excluded.audio_file,
          mime_type = excluded.mime_type,
          transcript_file = excluded.transcript_file,
          transcript_status = excluded.transcript_status,
          recording_dir = excluded.recording_dir,
          imported_at = COALESCE(excluded.imported_at, recordings.imported_at)
        "#,
        params![
            metadata.id,
            project_id,
            metadata.title,
            metadata.created_at,
            updated_at,
            metadata.duration_seconds as f64,
            metadata.language,
            metadata.audio_file,
            metadata.mime_type,
            transcript_file,
            transcript_status,
            recording_dir.to_string_lossy().to_string(),
            metadata.imported_at.as_deref(),
        ],
    )
    .map_err(|error| format!("Unable to index recording: {error}"))?;
    Ok(())
}

fn import_existing_recordings(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let recordings_dir = app_data_dir(app)?.join("recordings");
    let Ok(entries) = std::fs::read_dir(&recordings_dir) else {
        return Ok(());
    };

    for entry in entries.filter_map(Result::ok) {
        let recording_dir = entry.path();
        if !recording_dir.is_dir() {
            continue;
        }
        let Some(recording_id) = recording_dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_valid_recording_id(recording_id) {
            continue;
        }

        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Unable to check recording index: {error}"))?;
        if exists.is_some() {
            continue;
        }

        let metadata_path = recording_dir.join("recording.json");
        let metadata_json = match std::fs::read_to_string(&metadata_path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Scribe library: skipping recording without readable metadata: {error}");
                continue;
            }
        };
        let metadata: RecordingMetadata = match serde_json::from_str(&metadata_json) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Scribe library: skipping recording with invalid metadata: {error}");
                continue;
            }
        };
        if metadata.id != recording_id {
            eprintln!("Scribe library: skipping recording with mismatched metadata id");
            continue;
        }

        let has_transcript = recording_dir.join("transcript.json").is_file();
        let transcript_file = has_transcript.then_some("transcript.json");
        let transcript_status = if has_transcript { "ready" } else { "missing" };
        insert_or_update_recording_index(
            conn,
            &metadata,
            None,
            &recording_dir,
            transcript_file,
            transcript_status,
        )?;
    }

    Ok(())
}

pub fn initialize_library_on_startup(app: &AppHandle) {
    if let Err(error) = open_database(app) {
        eprintln!("Scribe library: startup initialization failed: {error}");
    }
}

fn uuid_like_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let value = nanos ^ (pid << 64);
    let hex = format!("{value:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn read_project_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        recording_count: row.get::<_, i64>(4)? as u64,
        total_duration_seconds: row.get(5)?,
    })
}

fn get_project_summary(conn: &Connection, project_id: &str) -> Result<ProjectSummary, String> {
    conn.query_row(
        r#"
        SELECT p.id, p.name, p.created_at, p.updated_at,
               COUNT(r.id) AS recording_count,
               COALESCE(SUM(r.duration_seconds), 0.0) AS total_duration_seconds
        FROM projects p
        LEFT JOIN recordings r ON r.project_id = p.id AND r.archived_at IS NULL
        WHERE p.id = ?1 AND p.archived_at IS NULL
        GROUP BY p.id
        "#,
        params![project_id],
        read_project_summary,
    )
    .map_err(|error| format!("Unable to read project: {error}"))
}

fn read_recording_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecordingSummary> {
    Ok(RecordingSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_name: row.get(2)?,
        title: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        duration_seconds: row.get(6)?,
        language: row.get(7)?,
        audio_file: row.get(8)?,
        mime_type: row.get(9)?,
        transcript_file: row.get(10)?,
        transcript_status: row.get(11)?,
        archived_at: row.get(12)?,
    })
}

fn get_recording_summary(
    conn: &Connection,
    recording_id: &str,
) -> Result<RecordingSummary, String> {
    conn.query_row(
        r#"
        SELECT r.id, r.project_id, p.name, r.title, r.created_at, r.updated_at,
               r.duration_seconds, r.language, r.audio_file, r.mime_type,
               r.transcript_file, r.transcript_status, r.archived_at
        FROM recordings r
        LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.id = ?1
        "#,
        params![recording_id],
        read_recording_summary,
    )
    .map_err(|error| format!("Unable to read recording: {error}"))
}

fn query_recordings(
    conn: &Connection,
    project_id: Option<&str>,
    archived: bool,
) -> Result<Vec<RecordingSummary>, String> {
    let archive_filter = if archived {
        "r.archived_at IS NOT NULL"
    } else {
        "r.archived_at IS NULL"
    };
    let sql = if project_id.is_some() {
        format!(
            r#"
        SELECT r.id, r.project_id, p.name, r.title, r.created_at, r.updated_at,
               r.duration_seconds, r.language, r.audio_file, r.mime_type,
               r.transcript_file, r.transcript_status, r.archived_at
        FROM recordings r
        LEFT JOIN projects p ON p.id = r.project_id
        WHERE r.project_id = ?1 AND {archive_filter}
        ORDER BY r.created_at DESC
        "#
        )
    } else {
        format!(
            r#"
        SELECT r.id, r.project_id, p.name, r.title, r.created_at, r.updated_at,
               r.duration_seconds, r.language, r.audio_file, r.mime_type,
               r.transcript_file, r.transcript_status, r.archived_at
        FROM recordings r
        LEFT JOIN projects p ON p.id = r.project_id
        WHERE {archive_filter}
        ORDER BY r.created_at DESC
        "#
        )
    };
    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| format!("Unable to list recordings: {error}"))?;
    let rows = if let Some(project_id) = project_id {
        statement
            .query_map(params![project_id], read_recording_summary)
            .map_err(|error| format!("Unable to read recordings: {error}"))?
    } else {
        statement
            .query_map([], read_recording_summary)
            .map_err(|error| format!("Unable to read recordings: {error}"))?
    };
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read recordings: {error}"))
}

fn default_settings() -> ScribeSettings {
    ScribeSettings {
        version: 1,
        whisper_model: DEFAULT_WHISPER_MODEL_ID.to_string(),
        transcription_language: DEFAULT_TRANSCRIPTION_LANGUAGE.to_string(),
        language: DEFAULT_TRANSCRIPTION_LANGUAGE.to_string(),
        app_language: DEFAULT_APP_LANGUAGE.to_string(),
        onboarding_completed: false,
        extra: BTreeMap::new(),
    }
}

fn default_settings_version() -> u8 {
    1
}

fn default_whisper_model() -> String {
    DEFAULT_WHISPER_MODEL_ID.to_string()
}

fn default_transcription_language() -> String {
    DEFAULT_TRANSCRIPTION_LANGUAGE.to_string()
}

fn default_app_language() -> String {
    DEFAULT_APP_LANGUAGE.to_string()
}

fn default_onboarding_completed() -> bool {
    false
}

fn is_supported_language(language: &str) -> bool {
    SUPPORTED_LANGUAGES.contains(&language)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("settings.json"))
}

fn model_definition(model_id: &str) -> &'static WhisperModelDefinition {
    WHISPER_MODELS
        .iter()
        .find(|model| model.id == model_id)
        .unwrap_or_else(|| {
            WHISPER_MODELS
                .iter()
                .find(|model| model.id == DEFAULT_WHISPER_MODEL_ID)
                .expect("default Whisper model must be configured")
        })
}

fn load_settings(app: &AppHandle) -> LoadedSettings {
    let fallback = || LoadedSettings {
        settings: default_settings(),
        settings_file_existed: false,
        onboarding_flag_present: false,
    };
    let Ok(path) = settings_path(app) else {
        return fallback();
    };
    let settings_file_existed = path.exists();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return fallback();
    };
    let onboarding_flag_present = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .map(|object| object.contains_key("onboardingCompleted"))
        })
        .unwrap_or(false);
    let Ok(mut settings) = serde_json::from_str::<ScribeSettings>(&raw) else {
        return LoadedSettings {
            settings: default_settings(),
            settings_file_existed,
            onboarding_flag_present,
        };
    };

    if !WHISPER_MODELS
        .iter()
        .any(|model| model.id == settings.whisper_model)
    {
        settings.whisper_model = DEFAULT_WHISPER_MODEL_ID.to_string();
    }
    if !is_supported_language(&settings.transcription_language) {
        settings.transcription_language = if is_supported_language(&settings.language) {
            settings.language.clone()
        } else {
            DEFAULT_TRANSCRIPTION_LANGUAGE.to_string()
        };
    }
    if !is_supported_language(&settings.language) {
        settings.language = settings.transcription_language.clone();
    }
    if !is_supported_language(&settings.app_language) {
        settings.app_language = DEFAULT_APP_LANGUAGE.to_string();
    }
    if settings_file_existed && !onboarding_flag_present {
        settings.onboarding_completed = true;
    }
    settings.version = 1;
    LoadedSettings {
        settings,
        settings_file_existed,
        onboarding_flag_present,
    }
}

fn load_or_create_settings(app: &AppHandle) -> ScribeSettings {
    let loaded = load_settings(app);
    let settings = loaded.settings;
    if !loaded.settings_file_existed
        || (loaded.settings_file_existed && !loaded.onboarding_flag_present)
    {
        if let Err(error) = save_settings_file(app, &settings) {
            eprintln!("Scribe settings: unable to persist settings: {error}");
        }
    }
    settings
}

fn save_settings_file(app: &AppHandle, settings: &ScribeSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Unable to resolve settings directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create settings directory: {error}"))?;
    let settings_json = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Unable to serialize settings: {error}"))?;
    std::fs::write(path, settings_json)
        .map_err(|error| format!("Unable to write settings: {error}"))
}

fn model_options(
    app: &AppHandle,
    settings: &ScribeSettings,
) -> Result<Vec<WhisperModelOption>, String> {
    let model_dir = app_data_dir(app)?.join("models").join("whisper");
    Ok(WHISPER_MODELS
        .iter()
        .map(|model| WhisperModelOption {
            id: model.id.to_string(),
            name: model.name.to_string(),
            filename: model.filename.to_string(),
            badge: model.badge.to_string(),
            description: model.description.to_string(),
            installed: model_dir.join(model.filename).is_file(),
            selected: model.id == settings.whisper_model,
            size_bytes: std::fs::metadata(model_dir.join(model.filename))
                .ok()
                .map(|metadata| metadata.len()),
            expected_bytes: model.expected_bytes,
        })
        .collect())
}

fn model_url(model: &WhisperModelDefinition) -> String {
    format!("{MODEL_SOURCE_BASE_URL}/{}", model.filename)
}

fn whisper_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("models").join("whisper"))
}

struct ActiveModelDownloadGuard;

impl Drop for ActiveModelDownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_MODEL_DOWNLOAD
            .get_or_init(|| Mutex::new(None))
            .lock()
        {
            *active = None;
        }
    }
}

fn acquire_model_download(model_id: &str) -> Result<ActiveModelDownloadGuard, String> {
    let mut active = ACTIVE_MODEL_DOWNLOAD
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Unable to lock model download state".to_string())?;
    if let Some(current) = active.as_ref() {
        return Err(format!("{current} is already downloading."));
    }
    *active = Some(model_id.to_string());
    Ok(ActiveModelDownloadGuard)
}

fn cancelled_model_downloads() -> &'static Mutex<HashSet<String>> {
    CANCELLED_MODEL_DOWNLOADS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn clear_model_download_cancellation(model_id: &str) {
    if let Ok(mut cancelled) = cancelled_model_downloads().lock() {
        cancelled.remove(model_id);
    }
}

fn is_model_download_cancelled(model_id: &str) -> bool {
    cancelled_model_downloads()
        .lock()
        .map(|cancelled| cancelled.contains(model_id))
        .unwrap_or(false)
}

fn emit_import_progress(
    app: &AppHandle,
    import_id: &str,
    recording_id: Option<&str>,
    stage: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let percent = total_bytes
        .filter(|total| *total > 0)
        .map(|total| downloaded_bytes as f64 * 100.0 / total as f64);
    let _ = app.emit(
        "import-audio-progress",
        ImportAudioProgress {
            import_id: import_id.to_string(),
            recording_id: recording_id.map(str::to_string),
            stage: stage.to_string(),
            downloaded_bytes,
            total_bytes,
            percent,
        },
    );
}

fn emit_transcription_progress(
    app: &AppHandle,
    recording_id: &str,
    stage: &str,
    duration_seconds: Option<u64>,
) {
    let _ = app.emit(
        "recording-transcription-progress",
        RecordingTranscriptionProgress {
            recording_id: recording_id.to_string(),
            stage: stage.to_string(),
            duration_seconds,
        },
    );
}

fn copy_with_progress(
    app: &AppHandle,
    import_id: &str,
    recording_id: &str,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    let total_bytes = std::fs::metadata(source)
        .ok()
        .map(|metadata| metadata.len());
    let mut input =
        File::open(source).map_err(|error| format!("Unable to open imported audio: {error}"))?;
    let mut output = File::create(destination)
        .map_err(|error| format!("Unable to create imported audio copy: {error}"))?;
    let mut buffer = [0_u8; 1024 * 1024];
    let mut copied = 0_u64;
    emit_import_progress(
        app,
        import_id,
        Some(recording_id),
        "importing",
        0,
        total_bytes,
    );
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read imported audio: {error}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Unable to copy imported audio: {error}"))?;
        copied += read as u64;
        emit_import_progress(
            app,
            import_id,
            Some(recording_id),
            "importing",
            copied,
            total_bytes,
        );
    }
    output
        .flush()
        .map_err(|error| format!("Unable to finish imported audio copy: {error}"))?;
    Ok(())
}

fn command_works(executable: &Path, arg: &str) -> bool {
    Command::new(executable)
        .arg(arg)
        .output()
        .map(|output| {
            output.status.success() || !output.stderr.is_empty() || !output.stdout.is_empty()
        })
        .unwrap_or(false)
}

fn path_command_works(executable: &str, arg: &str) -> bool {
    Command::new(executable)
        .arg(arg)
        .output()
        .map(|output| {
            output.status.success() || !output.stderr.is_empty() || !output.stdout.is_empty()
        })
        .unwrap_or(false)
}

fn runtime_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unsupported"
    }
}

fn platform_executable_name(base_name: &str) -> String {
    if cfg!(windows) {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    }
}

fn resolve_bundled_runtime_binary(app: &AppHandle, base_name: &str) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidate = resource_dir
        .join("bin")
        .join(runtime_target_triple())
        .join(platform_executable_name(base_name));
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn resolve_app_data_runtime_binary(
    app: &AppHandle,
    folder: &str,
    base_name: &str,
) -> Option<PathBuf> {
    let data_dir = app_data_dir(app).ok()?;
    Some(
        data_dir
            .join("bin")
            .join(folder)
            .join(platform_executable_name(base_name)),
    )
}

fn resolve_runtime_binary(
    app: &AppHandle,
    base_name: &str,
    app_data_folder: &str,
    probe_arg: &str,
    error: impl FnOnce() -> TranscriptionError,
) -> Result<PathBuf, TranscriptionError> {
    if let Some(candidate) = resolve_bundled_runtime_binary(app, base_name) {
        if command_works(&candidate, probe_arg) {
            return Ok(candidate);
        }
    }

    if let Some(candidate) = resolve_app_data_runtime_binary(app, app_data_folder, base_name) {
        if candidate.exists() && command_works(&candidate, probe_arg) {
            return Ok(candidate);
        }
    }

    if path_command_works(&platform_executable_name(base_name), probe_arg) {
        return Ok(PathBuf::from(platform_executable_name(base_name)));
    }

    Err(error())
}

fn resolve_ffmpeg(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    resolve_runtime_binary(app, "ffmpeg", "ffmpeg", "-version", || {
        TranscriptionError::FfmpegMissing(
            "FFmpeg is unavailable. Scribe should include FFmpeg in packaged builds.".to_string(),
        )
    })
}

fn resolve_ffprobe(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    resolve_runtime_binary(app, "ffprobe", "ffmpeg", "-version", || {
        TranscriptionError::FfmpegMissing(
            "FFprobe is unavailable. Scribe should include FFprobe in packaged builds.".to_string(),
        )
    })
}

fn resolve_whisper_cli(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    resolve_runtime_binary(app, "whisper-cli", "whisper", "-h", || {
        TranscriptionError::WhisperMissing(
            "whisper.cpp executable is unavailable. Scribe should include whisper-cli in packaged builds.".to_string(),
        )
    })
}

fn resolve_whisper_model(app: &AppHandle) -> Result<PathBuf, TranscriptionError> {
    let settings = load_or_create_settings(app);
    let model = model_definition(&settings.whisper_model);
    let model_path = app_data_dir(app)
        .map_err(TranscriptionError::Io)?
        .join("models")
        .join("whisper")
        .join(model.filename);

    if model_path.exists() {
        Ok(model_path)
    } else {
        Err(TranscriptionError::ModelMissing(format!(
            "{} is not installed. Place {} in the Scribe app data models/whisper directory.",
            model.name, model.filename
        )))
    }
}

fn parse_timestamp(value: &Value) -> f64 {
    if let Some(number) = value.as_f64() {
        return number;
    }

    let Some(text) = value.as_str() else {
        return 0.0;
    };
    let normalized = text.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    if parts.len() == 3 {
        let hours = parts[0].parse::<f64>().unwrap_or(0.0);
        let minutes = parts[1].parse::<f64>().unwrap_or(0.0);
        let seconds = parts[2].parse::<f64>().unwrap_or(0.0);
        return hours * 3600.0 + minutes * 60.0 + seconds;
    }
    if parts.len() == 2 {
        let minutes = parts[0].parse::<f64>().unwrap_or(0.0);
        let seconds = parts[1].parse::<f64>().unwrap_or(0.0);
        return minutes * 60.0 + seconds;
    }
    text.parse::<f64>().unwrap_or(0.0)
}

fn parse_segment_time(segment: &Value, key: &str) -> f64 {
    if let Some(value) = segment.get(key) {
        return parse_timestamp(value);
    }
    if let Some(value) = segment
        .get("timestamps")
        .and_then(|timestamps| timestamps.get(if key == "start" { "from" } else { "to" }))
    {
        return parse_timestamp(value);
    }
    if let Some(value) = segment
        .get("offsets")
        .and_then(|offsets| offsets.get(if key == "start" { "from" } else { "to" }))
    {
        return value.as_f64().unwrap_or(0.0) / 1000.0;
    }
    0.0
}

fn is_whisper_special_token(token_text: &str) -> bool {
    if token_text.is_empty() {
        return true;
    }
    let trimmed = token_text.trim();
    if trimmed.is_empty() {
        return true;
    }
    if (trimmed.starts_with("[_") && trimmed.ends_with("]"))
        || (trimmed.starts_with("<|") && trimmed.ends_with("|>"))
    {
        return true;
    }
    if trimmed == "|" {
        return true;
    }
    false
}

fn is_opening_punctuation(text: &str) -> bool {
    matches!(text, "(" | "[" | "{" | "“" | "‘" | "\"" | "«")
}

fn is_punctuation_only(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|character| {
            !character.is_alphanumeric() && !matches!(character, 'č' | 'š' | 'ž' | 'Č' | 'Š' | 'Ž')
        })
}

fn smooth_word_timings(mut words: Vec<TranscriptWord>) -> Vec<TranscriptWord> {
    const MIN_WORD_DURATION_SECONDS: f64 = 0.045;
    const MAX_LOCAL_EXTENSION_SECONDS: f64 = 0.12;

    for index in 0..words.len() {
        if !words[index].start.is_finite() || words[index].start < 0.0 {
            words[index].start = 0.0;
        }
        if !words[index].end.is_finite() || words[index].end < words[index].start {
            words[index].end = words[index].start;
        }

        if index > 0 {
            let previous_start = words[index - 1].start;
            let previous_end = words[index - 1].end;
            if words[index].start < previous_start {
                words[index].start = previous_start;
            }
            if words[index].start < previous_end {
                words[index].start = previous_end;
            }
            if words[index].end < words[index].start {
                words[index].end = words[index].start;
            }
        }
    }

    for index in 0..words.len() {
        let duration = words[index].end - words[index].start;
        if duration >= MIN_WORD_DURATION_SECONDS {
            continue;
        }

        let next_start = words.get(index + 1).map(|word| word.start);
        let desired_end = words[index].start + MIN_WORD_DURATION_SECONDS;
        let local_cap = words[index].end + MAX_LOCAL_EXTENSION_SECONDS;
        let capped_end = next_start
            .map(|start| desired_end.min(start))
            .unwrap_or(desired_end)
            .min(local_cap);

        if capped_end > words[index].end {
            words[index].end = capped_end;
        }
    }

    words
        .into_iter()
        .filter(|word| !word.text.is_empty() && word.end > word.start)
        .collect()
}

fn normalize_tokens_to_words(raw_tokens: &[Value]) -> Vec<TranscriptWord> {
    #[derive(Default)]
    struct Builder {
        text: String,
        start: f64,
        end: f64,
        has_timing: bool,
    }

    let mut builders: Vec<Builder> = Vec::new();
    let mut current: Option<Builder> = None;

    for token in raw_tokens {
        let token_text = token
            .get("text")
            .or_else(|| token.get("word"))
            .or_else(|| token.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if token_text.is_empty() {
            continue;
        }

        if is_whisper_special_token(token_text) {
            continue;
        }

        let token_start = parse_segment_time(token, "start");
        let token_end = parse_segment_time(token, "end");
        let has_timing = (token_start >= 0.0 || token_end >= 0.0) && token_end >= token_start;

        let starts_new_word = token_text.starts_with(' ')
            || token_text.starts_with('\t')
            || token_text.starts_with('Ġ')
            || is_opening_punctuation(token_text.trim());

        let cleaned = token_text
            .trim_start_matches(' ')
            .trim_start_matches('\t')
            .trim_start_matches('Ġ');

        if cleaned.is_empty() {
            continue;
        }

        if is_punctuation_only(cleaned) {
            if let Some(ref mut builder) = current {
                builder.text.push_str(cleaned);
                if has_timing {
                    if !builder.has_timing || token_start < builder.start {
                        builder.start = token_start;
                    }
                    if token_end >= builder.end {
                        builder.end = token_end;
                    }
                    builder.has_timing = true;
                }
            }
            continue;
        }

        if starts_new_word {
            if let Some(finished) = current.take() {
                builders.push(finished);
            }
            current = Some(Builder {
                text: cleaned.to_string(),
                start: token_start,
                end: token_end,
                has_timing,
            });
        } else if let Some(ref mut builder) = current {
            builder.text.push_str(cleaned);
            if has_timing {
                if !builder.has_timing || token_start < builder.start {
                    builder.start = token_start;
                }
                if token_end >= builder.end {
                    builder.end = token_end;
                }
                builder.has_timing = true;
            }
        } else {
            current = Some(Builder {
                text: cleaned.to_string(),
                start: token_start,
                end: token_end,
                has_timing,
            });
        }
    }

    if let Some(finished) = current.take() {
        builders.push(finished);
    }

    let words = builders
        .into_iter()
        .filter_map(|builder| {
            let text = builder.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let start = if builder.has_timing {
                builder.start
            } else {
                0.0
            };
            let end = if builder.has_timing { builder.end } else { 0.0 };
            let end = if end < start { start } else { end };
            Some(TranscriptWord { text, start, end })
        })
        .collect();

    smooth_word_timings(words)
}

fn parse_whisper_json(path: &Path, language: &str) -> Result<TranscriptData, TranscriptionError> {
    let raw = std::fs::read_to_string(path).map_err(|error| {
        TranscriptionError::TranscriptUnavailable(format!("Unable to read whisper output: {error}"))
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
        TranscriptionError::TranscriptUnavailable(format!(
            "Unable to parse whisper output: {error}"
        ))
    })?;

    let source_segments = value
        .get("segments")
        .and_then(Value::as_array)
        .or_else(|| value.get("transcription").and_then(Value::as_array))
        .ok_or_else(|| {
            TranscriptionError::TranscriptUnavailable(
                "Whisper output did not include transcript segments.".to_string(),
            )
        })?;

    let mut segments = Vec::new();

    for segment in source_segments {
        let text = segment
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }

        let segment_start = parse_segment_time(segment, "start");
        let segment_end = parse_segment_time(segment, "end");

        let words = if let Some(segment_words) = segment.get("words").and_then(Value::as_array) {
            let raw_words: Vec<Value> = segment_words.to_vec();
            normalize_tokens_to_words(&raw_words)
        } else if let Some(tokens) = segment.get("tokens").and_then(Value::as_array) {
            let raw_tokens: Vec<Value> = tokens.to_vec();
            normalize_tokens_to_words(&raw_tokens)
        } else {
            Vec::new()
        };

        let words = if words.is_empty() { Vec::new() } else { words };

        segments.push(TranscriptSegment {
            start: segment_start,
            end: segment_end,
            text,
            words,
        });
    }

    let text = segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    Ok(TranscriptData {
        version: 2,
        language: language.to_string(),
        text,
        segments,
    })
}

#[tauri::command]
pub fn save_recording(
    app: AppHandle,
    recording_id: String,
    audio_bytes: Vec<u8>,
    metadata: RecordingMetadata,
    project_id: Option<String>,
) -> Result<SaveRecordingResult, String> {
    if !is_valid_recording_id(&recording_id) || metadata.id != recording_id {
        return Err("Invalid recording id".to_string());
    }
    if let Some(ref id) = project_id {
        if !is_valid_recording_id(id) {
            return Err("Invalid project id".to_string());
        }
    }
    if metadata.audio_file != "audio.webm" {
        return Err("Invalid audio file name".to_string());
    }
    if audio_bytes.is_empty() {
        return Err("Recording is empty".to_string());
    }

    let (audio_path, metadata_path) = recording_paths(&app, &recording_id)?;
    let recording_dir = audio_path
        .parent()
        .ok_or_else(|| "Unable to resolve recording directory".to_string())?
        .to_path_buf();

    std::fs::create_dir_all(&recording_dir)
        .map_err(|error| format!("Unable to create recording directory: {error}"))?;
    std::fs::write(&audio_path, audio_bytes)
        .map_err(|error| format!("Unable to write audio file: {error}"))?;

    let metadata_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("Unable to serialize recording metadata: {error}"))?;
    std::fs::write(&metadata_path, metadata_json)
        .map_err(|error| format!("Unable to write recording metadata: {error}"))?;

    match open_database(&app).and_then(|conn| {
        insert_or_update_recording_index(
            &conn,
            &metadata,
            project_id.as_deref(),
            &recording_dir,
            None,
            "pending",
        )
    }) {
        Ok(()) => {}
        Err(error) => {
            eprintln!(
                "Scribe library: recording {} was saved to disk but indexing failed: {error}",
                recording_id
            );
        }
    }

    Ok(SaveRecordingResult { id: recording_id })
}

#[tauri::command]
pub async fn import_audio_recording(
    app: AppHandle,
    source_path: String,
    project_id: Option<String>,
    import_id: String,
) -> Result<RecordingDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_audio_recording_blocking(app, source_path, project_id, import_id)
    })
    .await
    .map_err(|error| format!("Import task failed: {error}"))?
}

fn import_audio_recording_blocking(
    app: AppHandle,
    source_path: String,
    project_id: Option<String>,
    import_id: String,
) -> Result<RecordingDetails, String> {
    if let Some(ref id) = project_id {
        if !is_valid_recording_id(id) {
            return Err("Invalid project id".to_string());
        }
    }

    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Selected audio file was not found".to_string());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_supported_import_extension(&extension) {
        return Err("Unsupported audio file type".to_string());
    }

    let ffmpeg = resolve_ffmpeg(&app).map_err(|error| match error {
        TranscriptionError::FfmpegMissing(message) => message,
        other => format!("{other:?}"),
    })?;
    let duration_seconds = ffmpeg_duration_seconds(&ffmpeg, &source)?;
    let imported_at = now_text();
    let source_created_at = imported_source_created_at(&app, &source, &imported_at);
    let recording_id = uuid_like_id();
    let audio_file = format!("audio.{extension}");
    let recording_dir = recording_dir_for_id(&app, &recording_id)?;
    std::fs::create_dir_all(&recording_dir)
        .map_err(|error| format!("Unable to create recording directory: {error}"))?;
    let audio_path = recording_dir.join(&audio_file);
    copy_with_progress(&app, &import_id, &recording_id, &source, &audio_path)?;

    let metadata = RecordingMetadata {
        version: 1,
        id: recording_id.clone(),
        title: title_from_path(&source),
        created_at: source_created_at,
        imported_at: Some(imported_at),
        duration_seconds,
        language: DEFAULT_TRANSCRIPTION_LANGUAGE.to_string(),
        audio_file,
        mime_type: mime_type_for_extension(&extension).to_string(),
    };
    let metadata_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("Unable to serialize recording metadata: {error}"))?;
    std::fs::write(recording_dir.join("recording.json"), metadata_json)
        .map_err(|error| format!("Unable to write recording metadata: {error}"))?;

    let conn = open_database(&app)?;
    insert_or_update_recording_index(
        &conn,
        &metadata,
        project_id.as_deref(),
        &recording_dir,
        None,
        "pending",
    )?;
    emit_import_progress(&app, &import_id, Some(&recording_id), "preparing", 0, None);
    get_recording(app, recording_id)
}

#[tauri::command]
pub fn load_recording_audio(
    app: AppHandle,
    recording_id: String,
) -> Result<LoadRecordingAudioResult, String> {
    if !is_valid_recording_id(&recording_id) {
        return Err("Invalid recording id".to_string());
    }

    let (_, metadata_path) = recording_paths(&app, &recording_id)?;
    let metadata_json = std::fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Unable to read recording metadata: {error}"))?;
    let metadata: RecordingMetadata = serde_json::from_str(&metadata_json)
        .map_err(|error| format!("Unable to parse recording metadata: {error}"))?;

    if metadata.id != recording_id {
        return Err("Recording metadata does not match requested audio".to_string());
    }
    let recording_dir = metadata_path
        .parent()
        .ok_or_else(|| "Unable to resolve recording directory".to_string())?;
    let audio_path = audio_path_from_metadata(recording_dir, &metadata)?;

    let audio_bytes = std::fs::read(&audio_path)
        .map_err(|error| format!("Unable to read recording audio: {error}"))?;

    Ok(LoadRecordingAudioResult {
        audio_bytes,
        mime_type: metadata.mime_type,
    })
}

#[tauri::command]
pub fn initialize_library(app: AppHandle) -> Result<(), String> {
    open_database(&app).map(|_| ())
}

#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectSummary, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is required".to_string());
    }
    if name.chars().count() > 100 {
        return Err("Project name is too long".to_string());
    }

    let conn = open_database(&app)?;
    let id = uuid_like_id();
    let now = now_text();
    conn.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, now, now],
    )
    .map_err(|error| format!("Unable to create project: {error}"))?;
    get_project_summary(&conn, &id)
}

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let conn = open_database(&app)?;
    let mut statement = conn
        .prepare(
            r#"
            SELECT p.id, p.name, p.created_at, p.updated_at,
                   COUNT(r.id) AS recording_count,
                   COALESCE(SUM(r.duration_seconds), 0.0) AS total_duration_seconds
            FROM projects p
            LEFT JOIN recordings r ON r.project_id = p.id AND r.archived_at IS NULL
            WHERE p.archived_at IS NULL
            GROUP BY p.id
            ORDER BY p.updated_at DESC, p.created_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to list projects: {error}"))?;
    let rows = statement
        .query_map([], read_project_summary)
        .map_err(|error| format!("Unable to read projects: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read projects: {error}"))
}

#[tauri::command]
pub fn rename_project(
    app: AppHandle,
    project_id: String,
    name: String,
) -> Result<ProjectSummary, String> {
    if !is_valid_recording_id(&project_id) {
        return Err("Invalid project id".to_string());
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("Project name is required".to_string());
    }
    if name.chars().count() > 100 {
        return Err("Project name is too long".to_string());
    }

    let conn = open_database(&app)?;
    conn.execute(
        "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_text(), project_id],
    )
    .map_err(|error| format!("Unable to rename project: {error}"))?;
    get_project_summary(&conn, &project_id)
}

#[tauri::command]
pub fn delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    delete_projects(app, vec![project_id]).map(|_| ())
}

#[tauri::command]
pub fn delete_projects(
    app: AppHandle,
    project_ids: Vec<String>,
) -> Result<DeleteProjectsResult, String> {
    eprintln!("[project-delete-rust] COMMAND ENTERED");
    eprintln!("[project-delete-rust] ids: {:?}", project_ids);
    if project_ids.is_empty() {
        return Err("No projects selected".to_string());
    }
    for project_id in &project_ids {
        if !is_valid_recording_id(project_id) {
            return Err("Invalid project id".to_string());
        }
    }

    let mut conn = open_database(&app)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("Unable to delete projects: {error}"))?;
    let mut deleted_ids = Vec::new();
    let mut cleared_recording_count = 0usize;

    for project_id in project_ids {
        eprintln!("[project-delete-rust] sqlite clear recording projects start: {project_id}");
        let cleared = tx
            .execute(
                "UPDATE recordings SET project_id = NULL, updated_at = ?1 WHERE project_id = ?2",
                params![now_text(), project_id],
            )
            .map_err(|error| format!("Unable to detach project recordings: {error}"))?;
        eprintln!("[project-delete-rust] recordings preserved: {cleared}");
        cleared_recording_count += cleared;

        eprintln!("[project-delete-rust] sqlite delete start: {project_id}");
        let changed = tx
            .execute("DELETE FROM projects WHERE id = ?1", params![project_id])
            .map_err(|error| format!("Unable to delete project: {error}"))?;
        eprintln!("[project-delete-rust] affected rows: {changed}");
        if changed == 0 {
            return Err("Project was not found".to_string());
        }

        let project_exists: Option<String> = tx
            .query_row(
                "SELECT id FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Unable to verify deleted project: {error}"))?;
        let attached_recordings: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM recordings WHERE project_id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("Unable to verify detached recordings: {error}"))?;
        eprintln!(
            "[project-delete-rust] verify projects absent: {}",
            project_exists.is_none()
        );
        eprintln!(
            "[project-delete-rust] verify recordings preserved/detached: {}",
            attached_recordings == 0
        );
        if project_exists.is_some() || attached_recordings != 0 {
            return Err("Project delete verification failed".to_string());
        }
        deleted_ids.push(project_id);
    }

    tx.commit()
        .map_err(|error| format!("Unable to finish deleting projects: {error}"))?;
    eprintln!("[project-delete-rust] success");
    Ok(DeleteProjectsResult {
        deleted_ids,
        cleared_recording_count,
    })
}

#[tauri::command]
pub fn assign_recording_to_project(
    app: AppHandle,
    recording_id: String,
    project_id: Option<String>,
) -> Result<RecordingSummary, String> {
    if !is_valid_recording_id(&recording_id) {
        return Err("Invalid recording id".to_string());
    }
    if let Some(ref id) = project_id {
        if !is_valid_recording_id(id) {
            return Err("Invalid project id".to_string());
        }
    }

    let conn = open_database(&app)?;
    conn.execute(
        "UPDATE recordings SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![project_id, now_text(), recording_id],
    )
    .map_err(|error| format!("Unable to move recording: {error}"))?;
    get_recording_summary(&conn, &recording_id)
}

fn validate_recording_ids(recording_ids: &[String]) -> Result<(), String> {
    if recording_ids.is_empty() {
        return Err("No recordings selected".to_string());
    }
    for recording_id in recording_ids {
        if !is_valid_recording_id(recording_id) {
            return Err("Invalid recording id".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn assign_recordings_to_project(
    app: AppHandle,
    recording_ids: Vec<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    validate_recording_ids(&recording_ids)?;
    if let Some(ref id) = project_id {
        if !is_valid_recording_id(id) {
            return Err("Invalid project id".to_string());
        }
    }

    let mut conn = open_database(&app)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("Unable to move recordings: {error}"))?;
    let now = now_text();
    for recording_id in recording_ids {
        let changed = tx
            .execute(
                "UPDATE recordings SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![project_id, now, recording_id],
            )
            .map_err(|error| format!("Unable to move recording: {error}"))?;
        if changed == 0 {
            return Err("Recording was not found".to_string());
        }
    }
    tx.commit()
        .map_err(|error| format!("Unable to finish moving recordings: {error}"))
}

#[tauri::command]
pub fn archive_recordings(app: AppHandle, recording_ids: Vec<String>) -> Result<(), String> {
    validate_recording_ids(&recording_ids)?;
    let mut conn = open_database(&app)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("Unable to archive recordings: {error}"))?;
    let now = now_text();
    for recording_id in recording_ids {
        let changed = tx
            .execute(
                "UPDATE recordings SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![now, recording_id],
            )
            .map_err(|error| format!("Unable to archive recording: {error}"))?;
        if changed == 0 {
            return Err("Recording was not found".to_string());
        }
    }
    tx.commit()
        .map_err(|error| format!("Unable to finish archiving recordings: {error}"))
}

#[tauri::command]
pub fn restore_recordings(app: AppHandle, recording_ids: Vec<String>) -> Result<(), String> {
    validate_recording_ids(&recording_ids)?;
    let mut conn = open_database(&app)?;
    let tx = conn
        .transaction()
        .map_err(|error| format!("Unable to restore recordings: {error}"))?;
    let now = now_text();
    for recording_id in recording_ids {
        let changed = tx
            .execute(
                "UPDATE recordings SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, recording_id],
            )
            .map_err(|error| format!("Unable to restore recording: {error}"))?;
        if changed == 0 {
            return Err("Recording was not found".to_string());
        }
    }
    tx.commit()
        .map_err(|error| format!("Unable to finish restoring recordings: {error}"))
}

#[tauri::command]
pub fn delete_recordings(
    app: AppHandle,
    recording_ids: Vec<String>,
) -> Result<DeleteRecordingsResult, String> {
    eprintln!("[delete-rust] COMMAND ENTERED");
    eprintln!("[delete-rust] ids received: {:?}", recording_ids);
    for recording_id in &recording_ids {
        eprintln!("[delete-rust] validating ID: {recording_id}");
    }
    validate_recording_ids(&recording_ids)?;
    let recordings_root = app_data_dir(&app)?.join("recordings");
    eprintln!(
        "[delete-rust] recordings root: {}",
        recordings_root.display()
    );
    let conn = open_database(&app)?;
    let mut deleted_ids = Vec::new();
    let mut failed = Vec::new();

    for recording_id in recording_ids {
        let exists: Option<String> = match conn
            .query_row(
                "SELECT id FROM recordings WHERE id = ?1",
                params![recording_id],
                |row| row.get(0),
            )
            .optional()
        {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Scribe library: unable to verify recording {recording_id}: {error}");
                failed.push(BulkRecordingFailure {
                    id: recording_id,
                    error: format!("Unable to verify recording index: {error}"),
                });
                continue;
            }
        };
        if exists.is_none() {
            eprintln!("Scribe library: recording {recording_id} was not found in SQLite");
            failed.push(BulkRecordingFailure {
                id: recording_id,
                error: "Recording was not found".to_string(),
            });
            continue;
        }

        let recording_dir = recordings_root.join(&recording_id);
        eprintln!("[delete-rust] resolved target: {}", recording_dir.display());
        eprintln!("[delete-rust] exists: {}", recording_dir.exists());
        if recording_dir == recordings_root || !recording_dir.starts_with(&recordings_root) {
            eprintln!("Scribe library: refused unsafe delete path for {recording_id}");
            failed.push(BulkRecordingFailure {
                id: recording_id,
                error: "Resolved path escaped recordings directory".to_string(),
            });
            continue;
        }

        eprintln!("[delete-rust] remove_dir_all start");
        if let Err(error) = std::fs::remove_dir_all(&recording_dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[delete-rust] remove_dir_all error: {error}");
                eprintln!("Scribe library: filesystem delete failed for {recording_id}: {error}");
                failed.push(BulkRecordingFailure {
                    id: recording_id,
                    error: format!("Unable to delete recording files: {error}"),
                });
                continue;
            }
            eprintln!("Scribe library: recording directory already missing for {recording_id}");
        } else {
            eprintln!("[delete-rust] remove_dir_all done");
        }

        eprintln!("[delete-rust] sqlite delete start");
        match conn.execute(
            "DELETE FROM recordings WHERE id = ?1",
            params![recording_id],
        ) {
            Ok(changed) if changed > 0 => {
                eprintln!("[delete-rust] sqlite affected rows: {changed}");
                let row_after_delete: Option<String> = conn
                    .query_row(
                        "SELECT id FROM recordings WHERE id = ?1",
                        params![recording_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!("Unable to verify deleted recording index: {error}")
                    })?;
                eprintln!(
                    "[delete-rust] verify path absent: {}",
                    !recording_dir.exists()
                );
                eprintln!(
                    "[delete-rust] verify db row absent: {}",
                    row_after_delete.is_none()
                );
                eprintln!(
                    "[delete] target exists after delete: {}",
                    recording_dir.exists()
                );
                eprintln!(
                    "[delete] sqlite row exists after delete: {}",
                    row_after_delete.is_some()
                );
                if recording_dir.exists() {
                    failed.push(BulkRecordingFailure {
                        id: recording_id,
                        error: "Recording files still exist after delete".to_string(),
                    });
                } else if row_after_delete.is_some() {
                    failed.push(BulkRecordingFailure {
                        id: recording_id,
                        error: "Recording index still exists after delete".to_string(),
                    });
                } else {
                    eprintln!("[delete-rust] success");
                    deleted_ids.push(recording_id);
                }
            }
            Ok(_) => {
                eprintln!("[delete-rust] sqlite affected rows: 0");
                eprintln!("Scribe library: SQLite delete changed no rows for {recording_id}");
                failed.push(BulkRecordingFailure {
                    id: recording_id,
                    error: "Recording index was not deleted".to_string(),
                });
            }
            Err(error) => {
                eprintln!("[delete-rust] sqlite delete error: {error}");
                eprintln!("Scribe library: SQLite delete failed for {recording_id}: {error}");
                failed.push(BulkRecordingFailure {
                    id: recording_id,
                    error: format!("Unable to delete recording index: {error}"),
                });
            }
        }
    }

    eprintln!("[delete] command complete");
    Ok(DeleteRecordingsResult {
        deleted_ids,
        failed,
    })
}

#[tauri::command]
pub fn list_recordings(app: AppHandle) -> Result<Vec<RecordingSummary>, String> {
    let conn = open_database(&app)?;
    query_recordings(&conn, None, false)
}

#[tauri::command]
pub fn list_archived_recordings(app: AppHandle) -> Result<Vec<RecordingSummary>, String> {
    let conn = open_database(&app)?;
    query_recordings(&conn, None, true)
}

#[tauri::command]
pub fn list_project_recordings(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<RecordingSummary>, String> {
    if !is_valid_recording_id(&project_id) {
        return Err("Invalid project id".to_string());
    }
    let conn = open_database(&app)?;
    query_recordings(&conn, Some(&project_id), false)
}

#[tauri::command]
pub fn get_recording(app: AppHandle, recording_id: String) -> Result<RecordingDetails, String> {
    if !is_valid_recording_id(&recording_id) {
        return Err("Invalid recording id".to_string());
    }

    let conn = open_database(&app)?;
    let summary = get_recording_summary(&conn, &recording_id)?;
    let recording_dir = recording_dir_for_id(&app, &recording_id)?;
    let metadata_path = recording_dir.join("recording.json");
    let metadata_json = std::fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Unable to read recording metadata: {error}"))?;
    let recording: RecordingMetadata = serde_json::from_str(&metadata_json)
        .map_err(|error| format!("Unable to parse recording metadata: {error}"))?;
    let transcript = if recording_dir.join("transcript.json").is_file() {
        match std::fs::read_to_string(recording_dir.join("transcript.json"))
            .ok()
            .and_then(|json| serde_json::from_str::<TranscriptData>(&json).ok())
        {
            Some(transcript) => Some(transcript),
            None => {
                eprintln!("Scribe library: transcript exists but could not be parsed");
                None
            }
        }
    } else {
        None
    };

    Ok(RecordingDetails {
        recording,
        project_id: summary.project_id,
        project_name: summary.project_name,
        transcript_status: summary.transcript_status,
        transcript,
    })
}

#[tauri::command]
pub fn rename_recording(
    app: AppHandle,
    recording_id: String,
    title: String,
) -> Result<RecordingDetails, String> {
    if !is_valid_recording_id(&recording_id) {
        return Err("Invalid recording id".to_string());
    }
    let title = title.trim();
    if title.is_empty() {
        return Err("Recording title is required".to_string());
    }
    if title.chars().count() > 100 {
        return Err("Recording title is too long".to_string());
    }

    let recording_dir = recording_dir_for_id(&app, &recording_id)?;
    let metadata_path = recording_dir.join("recording.json");
    let metadata_json = std::fs::read_to_string(&metadata_path)
        .map_err(|error| format!("Unable to read recording metadata: {error}"))?;
    let mut metadata: RecordingMetadata = serde_json::from_str(&metadata_json)
        .map_err(|error| format!("Unable to parse recording metadata: {error}"))?;
    metadata.title = title.to_string();
    let metadata_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("Unable to serialize recording metadata: {error}"))?;
    std::fs::write(&metadata_path, metadata_json)
        .map_err(|error| format!("Unable to write recording metadata: {error}"))?;

    let conn = open_database(&app)?;
    conn.execute(
        "UPDATE recordings SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now_text(), recording_id],
    )
    .map_err(|error| format!("Unable to rename recording: {error}"))?;
    get_recording(app, recording_id)
}

#[tauri::command]
pub fn get_transcription_config(app: AppHandle) -> TranscriptionConfig {
    let settings = load_or_create_settings(&app);
    let model = model_definition(&settings.whisper_model);
    TranscriptionConfig {
        model_filename: model.filename.to_string(),
        language: settings.transcription_language,
    }
}

#[tauri::command]
pub fn load_scribe_settings(app: AppHandle) -> Result<SettingsViewData, String> {
    let settings = load_or_create_settings(&app);
    Ok(SettingsViewData {
        models: model_options(&app, &settings)?,
        settings,
    })
}

#[tauri::command]
pub fn save_scribe_settings(
    app: AppHandle,
    whisper_model: Option<String>,
    app_language: Option<String>,
    transcription_language: Option<String>,
    onboarding_completed: Option<bool>,
) -> Result<SettingsViewData, String> {
    let mut settings = load_or_create_settings(&app);
    settings.version = 1;
    if let Some(model_id) = whisper_model {
        if !WHISPER_MODELS.iter().any(|model| model.id == model_id) {
            return Err("Unknown Whisper model".to_string());
        }
        settings.whisper_model = model_id;
    }
    if let Some(language) = app_language {
        if !is_supported_language(&language) {
            return Err("Unsupported application language".to_string());
        }
        settings.app_language = language;
    }
    if let Some(language) = transcription_language {
        if !is_supported_language(&language) {
            return Err("Unsupported transcription language".to_string());
        }
        settings.transcription_language = language.clone();
        settings.language = language;
    }
    if let Some(completed) = onboarding_completed {
        settings.onboarding_completed = completed;
    }
    save_settings_file(&app, &settings)?;

    Ok(SettingsViewData {
        models: model_options(&app, &settings)?,
        settings,
    })
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle, model_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || download_whisper_model_blocking(app, model_id))
        .await
        .map_err(|error| format!("Model download task failed: {error}"))?
}

#[tauri::command]
pub fn cancel_whisper_model_download(model_id: String) -> Result<(), String> {
    let active = ACTIVE_MODEL_DOWNLOAD
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Unable to lock model download state".to_string())?;
    if active.as_deref() == Some(model_id.as_str()) {
        drop(active);
        cancelled_model_downloads()
            .lock()
            .map_err(|_| "Unable to lock model cancellation state".to_string())?
            .insert(model_id);
    }
    Ok(())
}

fn download_whisper_model_blocking(app: AppHandle, model_id: String) -> Result<(), String> {
    let model = model_definition(&model_id);
    if model.id != model_id {
        return Err("Unknown Whisper model".to_string());
    }
    let _download_guard = acquire_model_download(model.id)?;
    clear_model_download_cancellation(model.id);

    let model_dir = whisper_model_dir(&app)?;
    std::fs::create_dir_all(&model_dir)
        .map_err(|error| format!("Unable to create model directory: {error}"))?;
    let final_path = model_dir.join(model.filename);
    let temp_path = model_dir.join(format!("{}.download", model.filename));

    if final_path.is_file() {
        return Ok(());
    }

    let url = model_url(model);
    let progress_model_id = model.id.to_string();
    let emit_progress = |state: &str, downloaded_bytes: u64, total_bytes: Option<u64>| {
        let percent = total_bytes
            .filter(|total| *total > 0)
            .map(|total| downloaded_bytes as f64 * 100.0 / total as f64);
        let _ = app.emit(
            "whisper-model-download-progress",
            ModelDownloadProgress {
                model_id: progress_model_id.clone(),
                downloaded_bytes,
                total_bytes,
                percent,
                state: state.to_string(),
            },
        );
    };

    emit_progress("downloading", 0, model.expected_bytes);

    let client = reqwest::blocking::Client::new();
    let mut response = client
        .get(&url)
        .send()
        .map_err(|error| format!("Unable to start model download: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Model download failed: {error}"))?;
    let total_bytes = response.content_length().or(model.expected_bytes);
    let mut file = File::create(&temp_path)
        .map_err(|error| format!("Unable to create temporary model file: {error}"))?;

    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        if is_model_download_cancelled(model.id) {
            let _ = std::fs::remove_file(&temp_path);
            emit_progress("cancelled", downloaded, total_bytes);
            clear_model_download_cancellation(model.id);
            return Ok(());
        }
        let read = response.read(&mut buffer).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Unable to read model download: {error}")
        })?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read]).map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Unable to write model download: {error}")
        })?;
        downloaded += read as u64;
        emit_progress("downloading", downloaded, total_bytes);
    }
    if is_model_download_cancelled(model.id) {
        let _ = std::fs::remove_file(&temp_path);
        emit_progress("cancelled", downloaded, total_bytes);
        clear_model_download_cancellation(model.id);
        return Ok(());
    }
    file.flush()
        .map_err(|error| format!("Unable to flush model download: {error}"))?;

    if downloaded == 0 {
        let _ = std::fs::remove_file(&temp_path);
        return Err("Downloaded model was empty".to_string());
    }
    if let Some(expected_bytes) = model.expected_bytes {
        if downloaded != expected_bytes {
            let _ = std::fs::remove_file(&temp_path);
            return Err("Downloaded model size did not match the expected size".to_string());
        }
    }

    emit_progress("installing", downloaded, Some(downloaded));
    std::fs::rename(&temp_path, &final_path)
        .map_err(|error| format!("Unable to install downloaded model: {error}"))?;
    emit_progress("installed", downloaded, Some(downloaded));
    Ok(())
}

#[tauri::command]
pub fn delete_whisper_model(app: AppHandle, model_id: String) -> Result<SettingsViewData, String> {
    let model = model_definition(&model_id);
    if model.id != model_id {
        return Err("Unknown Whisper model".to_string());
    }
    let settings = load_or_create_settings(&app);
    if settings.whisper_model == model.id {
        return Err("Select another installed model before deleting this one.".to_string());
    }

    let model_dir = whisper_model_dir(&app)?;
    let model_path = model_dir.join(model.filename);
    if !model_path.starts_with(&model_dir) {
        return Err("Refusing to delete a model outside the Whisper model directory.".to_string());
    }
    if model_path.is_file() {
        std::fs::remove_file(&model_path)
            .map_err(|error| format!("Unable to delete model: {error}"))?;
    }

    Ok(SettingsViewData {
        models: model_options(&app, &settings)?,
        settings,
    })
}

#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    recording_id: String,
) -> Result<TranscriptData, TranscriptionError> {
    tauri::async_runtime::spawn_blocking(move || transcribe_recording_blocking(app, recording_id))
        .await
        .map_err(|error| TranscriptionError::Io(format!("Transcription task failed: {error}")))?
}

fn transcribe_recording_blocking(
    app: AppHandle,
    recording_id: String,
) -> Result<TranscriptData, TranscriptionError> {
    if !is_valid_recording_id(&recording_id) {
        return Err(TranscriptionError::InvalidRecording(
            "Invalid recording id".to_string(),
        ));
    }

    let ffmpeg = resolve_ffmpeg(&app)?;
    let whisper_cli = resolve_whisper_cli(&app)?;
    let model_path = resolve_whisper_model(&app)?;
    let settings = load_or_create_settings(&app);
    let transcription_language = if is_supported_language(&settings.transcription_language) {
        settings.transcription_language
    } else {
        DEFAULT_TRANSCRIPTION_LANGUAGE.to_string()
    };
    let recording_dir =
        recording_dir_for_id(&app, &recording_id).map_err(TranscriptionError::Io)?;
    let metadata_path = recording_dir.join("recording.json");

    if !metadata_path.exists() {
        return Err(TranscriptionError::InvalidRecording(
            "Recording files are missing.".to_string(),
        ));
    }
    let metadata_json = std::fs::read_to_string(&metadata_path).map_err(|error| {
        TranscriptionError::Io(format!("Unable to read recording metadata: {error}"))
    })?;
    let metadata: RecordingMetadata = serde_json::from_str(&metadata_json).map_err(|error| {
        TranscriptionError::Io(format!("Unable to parse recording metadata: {error}"))
    })?;
    if metadata.id != recording_id {
        return Err(TranscriptionError::InvalidRecording(
            "Recording metadata does not match requested recording.".to_string(),
        ));
    }
    let audio_path =
        audio_path_from_metadata(&recording_dir, &metadata).map_err(TranscriptionError::Io)?;
    if !audio_path.exists() {
        return Err(TranscriptionError::InvalidRecording(
            "Recording audio is missing.".to_string(),
        ));
    }

    let processing_wav = recording_dir.join("processing.wav");
    let whisper_output_prefix = recording_dir.join("whisper-output");
    let whisper_output_json = recording_dir.join("whisper-output.json");
    let transcript_path = recording_dir.join("transcript.json");

    eprintln!("[transcription] model: {}", model_path.display());
    emit_transcription_progress(
        &app,
        &recording_id,
        "preparing",
        Some(metadata.duration_seconds),
    );

    let conversion_output = Command::new(&ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(&audio_path)
        .args(["-ac", "1", "-ar", "16000", "-sample_fmt", "s16"])
        .arg(&processing_wav)
        .output()
        .map_err(|error| {
            TranscriptionError::ConversionFailed(format!("Unable to start FFmpeg: {error}"))
        })?;

    if !conversion_output.status.success() {
        let stderr = String::from_utf8_lossy(&conversion_output.stderr);
        eprintln!("Scribe transcription: FFmpeg failed: {stderr}");
        return Err(TranscriptionError::ConversionFailed(
            "FFmpeg could not convert this recording.".to_string(),
        ));
    }

    emit_transcription_progress(
        &app,
        &recording_id,
        "transcribing",
        Some(metadata.duration_seconds),
    );

    let whisper_output = Command::new(&whisper_cli)
        .arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(&processing_wav)
        .arg("-l")
        .arg(&transcription_language)
        .args(["-fa", "-ojf", "-of"])
        .arg(&whisper_output_prefix)
        .output()
        .map_err(|error| {
            TranscriptionError::WhisperFailed(format!("Unable to start whisper.cpp: {error}"))
        })?;

    if !whisper_output.status.success() {
        let stderr = String::from_utf8_lossy(&whisper_output.stderr);
        eprintln!("Scribe transcription: whisper.cpp failed: {stderr}");
        return Err(TranscriptionError::WhisperFailed(
            "whisper.cpp could not transcribe this recording.".to_string(),
        ));
    }

    emit_transcription_progress(
        &app,
        &recording_id,
        "finalizing",
        Some(metadata.duration_seconds),
    );

    let transcript = parse_whisper_json(&whisper_output_json, &transcription_language)?;
    let transcript_json = serde_json::to_vec_pretty(&transcript).map_err(|error| {
        TranscriptionError::Io(format!("Unable to serialize transcript: {error}"))
    })?;
    std::fs::write(&transcript_path, transcript_json)
        .map_err(|error| TranscriptionError::Io(format!("Unable to write transcript: {error}")))?;

    let conn = open_database(&app).map_err(TranscriptionError::Io)?;
    let project_id: Option<String> = conn
        .query_row(
            "SELECT project_id FROM recordings WHERE id = ?1",
            params![recording_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| {
            TranscriptionError::Io(format!("Unable to read recording index: {error}"))
        })?
        .flatten();
    insert_or_update_recording_index(
        &conn,
        &metadata,
        project_id.as_deref(),
        &recording_dir,
        Some("transcript.json"),
        "ready",
    )
    .map_err(TranscriptionError::Io)?;

    if let Err(error) = std::fs::remove_file(&processing_wav) {
        eprintln!("Scribe transcription: unable to remove processing WAV: {error}");
    }
    if let Err(error) = std::fs::remove_file(&whisper_output_json) {
        eprintln!("Scribe transcription: unable to remove whisper output JSON: {error}");
    }

    Ok(transcript)
}
