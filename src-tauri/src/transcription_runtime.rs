//! Internal shared transcription bindings. No Tauri command is defined here.
//! Candidate/chunk orchestration remains separate from this production-facing surface.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) const CANONICAL_SAMPLE_RATE: u32 = 16_000;
pub(crate) const PRODUCTION_INFERENCE_ROUTE: &str = "c0";

pub(crate) fn terminal_outcome(success: bool, cancelled: bool) -> &'static str {
    if success {
        "SUCCESS"
    } else if cancelled {
        "CANCELLED"
    } else {
        "FAILURE"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProductionC0DiagnosticEvent {
    pub(crate) run_id: String,
    pub(crate) recording_id: String,
    pub(crate) event: String,
    pub(crate) chunk_index: Option<usize>,
    pub(crate) total_chunks: Option<usize>,
    pub(crate) start_frame: Option<u64>,
    pub(crate) end_frame: Option<u64>,
    pub(crate) parsed_word_count: Option<usize>,
    pub(crate) owned_word_count: Option<usize>,
    pub(crate) merged_word_count: Option<usize>,
    pub(crate) canonical_frames: Option<u64>,
    pub(crate) terminal_outcome: Option<String>,
    pub(crate) cleanup_completed: Option<bool>,
}

pub(crate) struct ProductionC0DiagnosticSink {
    path: std::path::PathBuf,
    run_id: String,
    recording_id: String,
}

impl ProductionC0DiagnosticSink {
    pub(crate) fn new(diagnostics_dir: &Path, run_id: &str, recording_id: &str) -> Self {
        Self {
            path: diagnostics_dir.join(format!("transcription-c0-{run_id}.jsonl")),
            run_id: run_id.to_string(),
            recording_id: recording_id.to_string(),
        }
    }

    pub(crate) fn emit(&self, event: ProductionC0DiagnosticEvent) {
        let Ok(line) = serde_json::to_vec(&event) else {
            return;
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = file.write_all(&line);
            let _ = file.write_all(b"\n");
        }
    }

    pub(crate) fn event(&self, name: &str) -> ProductionC0DiagnosticEvent {
        ProductionC0DiagnosticEvent {
            run_id: self.run_id.clone(),
            recording_id: self.recording_id.clone(),
            event: name.to_string(),
            chunk_index: None,
            total_chunks: None,
            start_frame: None,
            end_frame: None,
            parsed_word_count: None,
            owned_word_count: None,
            merged_word_count: None,
            canonical_frames: None,
            terminal_outcome: None,
            cleanup_completed: None,
        }
    }
}

pub(crate) fn production_c0_work_dir(
    recording_dir: &Path,
    run_id: &str,
) -> Result<PathBuf, String> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid transcription run id".to_string());
    }
    Ok(recording_dir.join(format!(".scribe-c0-work-{run_id}")))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParsedTranscriptionWord {
    pub(crate) text: String,
    pub(crate) start: f64,
    pub(crate) end: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct TranscriptionRuntimeContext {
    pub recording_id: String,
    pub source_path: PathBuf,
    pub recording_dir: PathBuf,
    pub processing_wav: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub whisper_cli: PathBuf,
    pub model_path: PathBuf,
    pub language: String,
}

impl TranscriptionRuntimeContext {
    pub(crate) fn from_resolved(
        recording_id: String,
        source_path: PathBuf,
        recording_dir: PathBuf,
        processing_wav: PathBuf,
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        whisper_cli: PathBuf,
        model_path: PathBuf,
        language: String,
    ) -> Self {
        Self {
            recording_id,
            source_path,
            recording_dir,
            processing_wav,
            ffmpeg,
            ffprobe,
            whisper_cli,
            model_path,
            language,
        }
    }
}

pub(crate) fn canonical_ffmpeg_args(source: &Path, output: &Path) -> Vec<String> {
    vec![
        "-y".into(),
        "-i".into(),
        source.display().to_string(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        CANONICAL_SAMPLE_RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-sample_fmt".into(),
        "s16".into(),
        output.display().to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_contract_matches_production_recipe() {
        let args = canonical_ffmpeg_args(Path::new("input"), Path::new("processing.wav"));
        assert!(args.windows(2).any(|w| w == ["-ac", "1"]));
        assert!(args.windows(2).any(|w| w == ["-ar", "16000"]));
        assert!(args.windows(2).any(|w| w == ["-c:a", "pcm_s16le"]));
    }

    #[test]
    fn production_c0_workspaces_are_run_scoped() {
        let recording_dir = Path::new("recording");
        assert_ne!(
            production_c0_work_dir(recording_dir, "run-a").unwrap(),
            production_c0_work_dir(recording_dir, "run-b").unwrap()
        );
    }

    #[test]
    fn production_c0_rejects_path_injection_in_run_id() {
        assert!(production_c0_work_dir(Path::new("recording"), "../other").is_err());
    }

    #[test]
    fn production_route_is_the_existing_c0_path() {
        assert_eq!(PRODUCTION_INFERENCE_ROUTE, "c0");
    }

    #[test]
    fn terminal_outcome_preserves_structured_result_classes() {
        assert_eq!(terminal_outcome(true, false), "SUCCESS");
        assert_eq!(terminal_outcome(false, true), "CANCELLED");
        assert_eq!(terminal_outcome(false, false), "FAILURE");
    }

    #[test]
    fn production_diagnostic_event_contains_structure_but_no_transcript_field() {
        let event = ProductionC0DiagnosticEvent {
            run_id: "run".into(),
            recording_id: "recording".into(),
            event: "PARSER_COMPLETED".into(),
            chunk_index: Some(0),
            total_chunks: Some(2),
            start_frame: Some(0),
            end_frame: Some(480000),
            parsed_word_count: Some(4),
            owned_word_count: Some(3),
            merged_word_count: None,
            canonical_frames: None,
            terminal_outcome: None,
            cleanup_completed: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("parsedWordCount"));
        assert!(!json.contains("text"));
    }
}
