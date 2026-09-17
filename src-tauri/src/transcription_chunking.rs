//! Pure, development-only chunk geometry and merge contracts.
//! This module is intentionally not registered as a Tauri command.

pub const SAMPLE_RATE: u64 = 16_000;
pub const CORE_FRAMES: u64 = 30 * SAMPLE_RATE;

#[cfg(debug_assertions)]
use serde::Deserialize;
#[cfg(debug_assertions)]
use std::io::Write;

pub fn source_audio_from_canonical_wav(bytes: &[u8]) -> Result<SourceAudio, &'static str> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("invalid RIFF/WAVE header");
    }
    let riff_size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if riff_size.checked_add(8).ok_or("RIFF size overflow")? > bytes.len() {
        return Err("truncated RIFF");
    }
    let limit = riff_size + 8;
    let mut pos = 12;
    let mut fmt = false;
    let mut data_len = None;
    while pos < limit {
        if pos.checked_add(8).ok_or("chunk overflow")? > limit {
            return Err("truncated chunk header");
        }
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let end = pos
            .checked_add(8)
            .and_then(|v| v.checked_add(size))
            .ok_or("chunk size overflow")?;
        if end > limit || end > bytes.len() {
            return Err("truncated chunk");
        }
        match &bytes[pos..pos + 4] {
            b"fmt " => {
                if size < 16 {
                    return Err("truncated fmt");
                }
                let p = pos + 8;
                let audio = u16::from_le_bytes(bytes[p..p + 2].try_into().unwrap());
                let channels = u16::from_le_bytes(bytes[p + 2..p + 4].try_into().unwrap());
                let rate = u32::from_le_bytes(bytes[p + 4..p + 8].try_into().unwrap());
                let bits = u16::from_le_bytes(bytes[p + 14..p + 16].try_into().unwrap());
                if audio != 1 || channels != 1 || rate != SAMPLE_RATE as u32 || bits != 16 {
                    return Err("unsupported canonical WAV format");
                }
                fmt = true;
            }
            b"data" => {
                if data_len.is_some() {
                    return Err("duplicate data chunk");
                }
                data_len = Some(size);
            }
            _ => {}
        }
        pos = end + (size & 1);
        if pos > limit {
            return Err("invalid RIFF padding");
        }
    }
    if !fmt {
        return Err("missing fmt chunk");
    }
    let len = data_len.ok_or("missing data chunk")?;
    if len % 2 != 0 {
        return Err("odd PCM data length");
    }
    Ok(SourceAudio {
        frames: (len / 2) as u64,
    })
}

pub fn parsed_words_to_words(
    words: Vec<crate::transcription_runtime::ParsedTranscriptionWord>,
) -> Vec<Word> {
    words
        .into_iter()
        .map(|w| Word {
            text: w.text,
            timing: Timing {
                start: w.start,
                end: w.end,
            },
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceAudio {
    pub frames: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkCore {
    pub index: u64,
    pub start_frame: u64,
    pub end_frame: u64,
}

impl SourceAudio {
    pub fn chunks(self) -> Vec<ChunkCore> {
        let mut result = Vec::new();
        let mut index = 0;
        while index * CORE_FRAMES < self.frames {
            let start = index * CORE_FRAMES;
            result.push(ChunkCore {
                index,
                start_frame: start,
                end_frame: (start + CORE_FRAMES).min(self.frames),
            });
            index += 1;
        }
        result
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    pub start: f64,
    pub end: f64,
}

impl Timing {
    pub fn remap(self, chunk: ChunkCore, source: SourceAudio) -> Option<Self> {
        if !self.start.is_finite()
            || !self.end.is_finite()
            || self.start < 0.0
            || self.end <= self.start
        {
            return None;
        }
        let cs = chunk.start_frame as f64 / SAMPLE_RATE as f64;
        let ce = chunk.end_frame as f64 / SAMPLE_RATE as f64;
        let ss = source.frames as f64 / SAMPLE_RATE as f64;
        let start = (cs + self.start).clamp(cs, ce).min(ss);
        let end = (cs + self.end).clamp(cs, ce).min(ss);
        (end > start).then_some(Self { start, end })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub timing: Timing,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChunkResult {
    pub core: ChunkCore,
    pub words: Vec<Word>,
    pub valid: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryReplacement {
    pub candidate_id: String,
    pub decode_window: Timing,
    pub owner: Timing,
    pub primary_chunk: u64,
    pub words: Vec<Word>,
    pub attempted: bool,
    pub succeeded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergedResult {
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionStage {
    Chunks,
    Merge,
    Recovery,
    Finalizer,
    Serialize,
    AtomicReplace,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateState {
    Preparing,
    ChunksComplete,
    PrimaryMergeComplete,
    RecoveryComplete,
    FinalizationComplete,
    SerializationComplete,
    AtomicReplacementComplete,
    Ready,
    Failed,
    Cancelled,
}

impl CandidateState {
    pub fn advance(self, next: Self) -> Result<Self, &'static str> {
        use CandidateState::*;
        let valid = matches!(
            (self, next),
            (Preparing, ChunksComplete)
                | (ChunksComplete, PrimaryMergeComplete)
                | (PrimaryMergeComplete, RecoveryComplete)
                | (RecoveryComplete, FinalizationComplete)
                | (FinalizationComplete, SerializationComplete)
                | (SerializationComplete, AtomicReplacementComplete)
                | (AtomicReplacementComplete, Ready)
        );
        if valid {
            Ok(next)
        } else {
            Err("invalid candidate state transition")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkAttempt {
    pub index: u64,
    pub attempts: u8,
    pub succeeded: bool,
}

impl ChunkAttempt {
    pub fn retry(self) -> Result<Self, &'static str> {
        if self.succeeded {
            Err("successful chunk cannot be rerun")
        } else if self.attempts >= 2 {
            Err("retry limit reached")
        } else {
            Ok(Self {
                attempts: self.attempts + 1,
                ..self
            })
        }
    }
}

pub fn progress(completed: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        (completed.min(total) as f64 / total as f64) * 100.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevRunPaths {
    pub root: std::path::PathBuf,
    pub chunks: std::path::PathBuf,
    pub whisper: std::path::PathBuf,
    pub recovery: std::path::PathBuf,
    pub pending_transcript: std::path::PathBuf,
    pub ledger: std::path::PathBuf,
    pub result: std::path::PathBuf,
}

impl DevRunPaths {
    pub fn new(recording_dir: &std::path::Path, run_id: &str) -> Result<Self, &'static str> {
        if run_id.is_empty() || run_id.contains('/') || run_id.contains('\\') {
            return Err("invalid run id");
        }
        let root = recording_dir.join(format!(".scribe-chunked-dev-{run_id}"));
        Ok(Self {
            chunks: root.join("chunks"),
            whisper: root.join("whisper"),
            recovery: root.join("recovery"),
            pending_transcript: root.join("transcript.pending.json"),
            ledger: root.join("run-ledger.jsonl"),
            result: root.join("run-result.json"),
            root,
        })
    }
}

#[cfg(debug_assertions)]
#[derive(Clone)]
pub struct DevProvenance {
    pub run_id: String,
    pub recording_id: String,
    pub started: std::time::Instant,
    pub ledger: std::path::PathBuf,
    pub result: std::path::PathBuf,
}

#[cfg(debug_assertions)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevTerminalResult {
    pub schema_version: u32,
    pub run_id: String,
    pub recording_id: String,
    pub terminal_state: String,
    pub persistence_occurred: bool,
}

#[cfg(debug_assertions)]
pub struct DevTerminalGuard {
    provenance: DevProvenance,
    cancel: std::sync::Arc<CancellationToken>,
    finished: bool,
}

#[cfg(debug_assertions)]
impl DevTerminalGuard {
    pub fn new(provenance: DevProvenance, cancel: std::sync::Arc<CancellationToken>) -> Self {
        Self {
            provenance,
            cancel,
            finished: false,
        }
    }
    pub fn success(&mut self, frames: u64, chunks: usize, words: usize) -> Result<(), String> {
        if self.finished {
            return Err("duplicate terminalization".into());
        }
        self.provenance
            .terminal("SUCCESS", Some(frames), Some(chunks), Some(words), None)?;
        self.provenance
            .event("COMMAND_SUCCEEDED", None, Some(100.0), None)?;
        self.finished = true;
        Ok(())
    }
    pub fn failure(&mut self, error: &str) -> Result<(), String> {
        self.finish_explicit("COMMAND_FAILED", "FAILURE", Some(error))
    }
    pub fn cancelled(&mut self) -> Result<(), String> {
        self.finish_explicit("COMMAND_CANCELLED", "CANCELLED", None)
    }
    fn finish_explicit(
        &mut self,
        event: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        if self.finished {
            return Err("duplicate terminalization".into());
        }
        self.provenance.terminal(state, None, None, None, error)?;
        self.provenance.event(event, None, None, error)?;
        self.finished = true;
        Ok(())
    }
    fn finish(&mut self) {
        if self.finished {
            return;
        }
        let cancelled = self.cancel.is_cancelled();
        let (event, state, error) = if cancelled {
            ("COMMAND_CANCELLED", "CANCELLED", None)
        } else {
            (
                "COMMAND_FAILED",
                "FAILURE",
                Some("candidate_execution_failed"),
            )
        };
        let _ = self.provenance.terminal(state, None, None, None, error);
        let _ = self.provenance.event(event, None, None, error);
        self.finished = true;
    }
}

#[cfg(debug_assertions)]
impl Drop for DevTerminalGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(debug_assertions)]
impl DevProvenance {
    pub fn new(paths: &DevRunPaths, run_id: &str, recording_id: &str) -> Self {
        Self {
            run_id: run_id.into(),
            recording_id: recording_id.into(),
            started: std::time::Instant::now(),
            ledger: paths.ledger.clone(),
            result: paths.result.clone(),
        }
    }
    pub fn event(
        &self,
        name: &str,
        chunk: Option<u64>,
        progress: Option<f64>,
        error: Option<&str>,
    ) -> Result<(), String> {
        let v = serde_json::json!({"schemaVersion":1,"runId":self.run_id,"recordingId":self.recording_id,"event":name,"timestampMs":self.started.elapsed().as_millis(),"chunk":chunk,"progress":progress,"error":error});
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.ledger)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut f, &v).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())?;
        f.sync_data().map_err(|e| e.to_string())
    }
    pub fn terminal(
        &self,
        state: &str,
        frames: Option<u64>,
        chunks: Option<usize>,
        words: Option<usize>,
        error: Option<&str>,
    ) -> Result<(), String> {
        let v = serde_json::json!({"schemaVersion":1,"runId":self.run_id,"recordingId":self.recording_id,"terminalState":state,"canonicalFrames":frames,"chunkCount":chunks,"mergedWordCount":words,"finalProgress":if state == "SUCCESS" {serde_json::json!(100.0)} else {serde_json::Value::Null},"error":error,"persistenceOccurred":false});
        let tmp = self.result.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(tmp, &self.result).map_err(|e| e.to_string())
    }
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvenanceStatus {
    Success,
    Failure,
    Cancelled,
    Incomplete,
    Invalid,
}

#[cfg(debug_assertions)]
pub fn validate_provenance_events(
    run_id: &str,
    events: &[(&str, &str)],
    terminal_result: Option<&str>,
    progress: &[f64],
) -> ProvenanceStatus {
    validate_provenance_bundle(run_id, events, terminal_result, false, progress)
}

#[cfg(debug_assertions)]
pub fn validate_provenance_bundle(
    run_id: &str,
    events: &[(&str, &str)],
    terminal_result: Option<&str>,
    persistence_occurred: bool,
    progress: &[f64],
) -> ProvenanceStatus {
    if progress
        .iter()
        .any(|p| !p.is_finite() || *p < 0.0 || *p > 100.0)
        || progress.windows(2).any(|w| w[1] < w[0])
    {
        return ProvenanceStatus::Invalid;
    }
    let terminals: Vec<&str> = events
        .iter()
        .filter_map(|(id, e)| {
            (*id == run_id
                && matches!(
                    *e,
                    "COMMAND_SUCCEEDED" | "COMMAND_FAILED" | "COMMAND_CANCELLED"
                ))
            .then_some(*e)
        })
        .collect();
    if persistence_occurred || events.iter().any(|(id, _)| *id != run_id) || terminals.len() > 1 {
        return ProvenanceStatus::Invalid;
    }
    let Some(event) = terminals.first().copied() else {
        return ProvenanceStatus::Incomplete;
    };
    let expected = match event {
        "COMMAND_SUCCEEDED" => "SUCCESS",
        "COMMAND_FAILED" => "FAILURE",
        "COMMAND_CANCELLED" => "CANCELLED",
        _ => unreachable!(),
    };
    if terminal_result != Some(expected) {
        return ProvenanceStatus::Invalid;
    }
    if event == "COMMAND_SUCCEEDED" && !events.iter().any(|(_, e)| *e == "PRIMARY_MERGE_COMPLETED")
    {
        return ProvenanceStatus::Invalid;
    }
    match event {
        "COMMAND_SUCCEEDED" => ProvenanceStatus::Success,
        "COMMAND_FAILED" => ProvenanceStatus::Failure,
        _ => ProvenanceStatus::Cancelled,
    }
}

#[cfg(debug_assertions)]
pub fn validate_serialized_provenance(
    run_id: &str,
    events: &[(&str, &str)],
    terminal_json: &str,
    progress: &[f64],
) -> ProvenanceStatus {
    let Ok(result) = serde_json::from_str::<DevTerminalResult>(terminal_json) else {
        return ProvenanceStatus::Invalid;
    };
    if result.schema_version != 1 || result.run_id != run_id || result.persistence_occurred {
        return ProvenanceStatus::Invalid;
    }
    validate_provenance_bundle(
        run_id,
        events,
        Some(&result.terminal_state),
        false,
        progress,
    )
}

#[derive(Debug, Default)]
pub struct CancellationToken(std::sync::atomic::AtomicBool);

/// A run-scoped cancellation handle. The owner creates one per transcription
/// run and clones it into every operation; it is never global.
pub type CancellationHandle = std::sync::Arc<CancellationToken>;
impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub fn candidate_whisper_args(
    model: &std::path::Path,
    wav: &std::path::Path,
    language: &str,
    output_prefix: &std::path::Path,
) -> Vec<String> {
    vec![
        "-m".into(),
        model.display().to_string(),
        "-f".into(),
        wav.display().to_string(),
        "-l".into(),
        language.into(),
        "-oj".into(),
        "-ojf".into(),
        "-of".into(),
        output_prefix.display().to_string(),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildDisposition {
    Succeeded,
    Failed,
    Cancelled,
}

pub fn run_candidate_child(
    mut command: std::process::Command,
    cancel: &CancellationToken,
) -> Result<ChildResult, String> {
    let mut child = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    loop {
        if cancel.is_cancelled() {
            let _ = child.kill();
            let status = child.wait().map_err(|e| format!("reap failed: {e}"))?;
            return Ok(ChildResult {
                disposition: ChildDisposition::Cancelled,
                exit_code: status.code(),
                used_cpu_fallback: false,
            });
        }
        match child.try_wait().map_err(|e| format!("wait failed: {e}"))? {
            Some(status) => {
                return Ok(ChildResult {
                    disposition: if status.success() {
                        ChildDisposition::Succeeded
                    } else {
                        ChildDisposition::Failed
                    },
                    exit_code: status.code(),
                    used_cpu_fallback: false,
                })
            }
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildResult {
    pub disposition: ChildDisposition,
    pub exit_code: Option<i32>,
    pub used_cpu_fallback: bool,
}

pub fn candidate_ffmpeg_args(
    input: &std::path::Path,
    output: &std::path::Path,
    chunk: ChunkCore,
) -> Vec<String> {
    let start = chunk.start_frame as f64 / SAMPLE_RATE as f64;
    let duration = (chunk.end_frame - chunk.start_frame) as f64 / SAMPLE_RATE as f64;
    vec![
        "-y".into(),
        "-ss".into(),
        format!("{start:.6}"),
        "-t".into(),
        format!("{duration:.6}"),
        "-i".into(),
        input.display().to_string(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        SAMPLE_RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-sample_fmt".into(),
        "s16".into(),
        output.display().to_string(),
    ]
}

pub trait ChunkExtractor {
    fn extract(&mut self, core: ChunkCore) -> Result<std::path::PathBuf, &'static str>;
}
pub trait ChunkInferenceRunner {
    fn run(
        &mut self,
        core: ChunkCore,
        wav: &std::path::Path,
        cpu: bool,
        cancel: &CancellationToken,
    ) -> Result<Vec<Word>, &'static str>;
}

pub struct RealChunkExtractor {
    pub ffmpeg: std::path::PathBuf,
    pub input: std::path::PathBuf,
    pub output_dir: std::path::PathBuf,
    pub cancel: std::sync::Arc<CancellationToken>,
}
impl ChunkExtractor for RealChunkExtractor {
    fn extract(&mut self, core: ChunkCore) -> Result<std::path::PathBuf, &'static str> {
        if self.cancel.is_cancelled() {
            return Err("cancelled");
        }
        let output = self.output_dir.join(format!(
            "chunk-{:06}-{}-{}.wav",
            core.index, core.start_frame, core.end_frame
        ));
        let mut command = std::process::Command::new(&self.ffmpeg);
        command.args(candidate_ffmpeg_args(&self.input, &output, core));
        let result = run_candidate_child(command, &self.cancel).map_err(|_| "child failure")?;
        if result.disposition != ChildDisposition::Succeeded {
            return Err(if result.disposition == ChildDisposition::Cancelled {
                "cancelled"
            } else {
                "ffmpeg failure"
            });
        }
        if !output.is_file() {
            return Err("missing chunk output");
        }
        Ok(output)
    }
}

pub struct RealChunkInferenceRunner {
    pub whisper_cli: std::path::PathBuf,
    pub model: std::path::PathBuf,
    pub language: String,
    pub output_dir: std::path::PathBuf,
    pub cancel: std::sync::Arc<CancellationToken>,
}
impl ChunkInferenceRunner for RealChunkInferenceRunner {
    fn run(
        &mut self,
        core: ChunkCore,
        wav: &std::path::Path,
        cpu: bool,
        cancel: &CancellationToken,
    ) -> Result<Vec<Word>, &'static str> {
        if cancel.is_cancelled() {
            return Err("cancelled");
        }
        let prefix = self.output_dir.join(format!("chunk-{:06}", core.index));
        let mut args = candidate_whisper_args(&self.model, wav, &self.language, &prefix);
        if cpu {
            args.insert(0, "-ng".into());
        }
        let mut command = std::process::Command::new(&self.whisper_cli);
        command.args(args);
        let result = run_candidate_child(command, cancel).map_err(|_| "child failure")?;
        if result.disposition != ChildDisposition::Succeeded {
            return Err(if result.disposition == ChildDisposition::Cancelled {
                "cancelled"
            } else {
                "whisper failure"
            });
        }
        let json = prefix.with_extension("json");
        if !json.is_file() {
            return Err("missing whisper JSON");
        }
        let parsed = crate::commands::recordings::parse_whisper_output_for_runtime(&json)
            .map_err(|_| "parse failure")?;
        Ok(parsed_words_to_words(parsed))
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevEvent {
    pub chunk: Option<u64>,
    pub kind: &'static str,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevObservation {
    pub chunk: Option<u64>,
    pub total_chunks: usize,
    pub owner_start_frame: Option<u64>,
    pub owner_end_frame: Option<u64>,
    pub stage: &'static str,
    pub attempt: Option<&'static str>,
    pub outcome: &'static str,
    pub word_count: Option<usize>,
}

pub type DevObserver<'a> = dyn FnMut(DevObservation) + 'a;

pub fn orchestrate_primary<E: ChunkExtractor, I: ChunkInferenceRunner>(
    source: SourceAudio,
    extractor: &mut E,
    inference: &mut I,
    cancel: &CancellationToken,
    events: &mut Vec<DevEvent>,
) -> Result<MergedResult, &'static str> {
    let mut observer = |o: DevObservation| {
        events.push(DevEvent {
            chunk: o.chunk,
            kind: o.stage,
        })
    };
    orchestrate_primary_observed(source, extractor, inference, cancel, &mut observer)
}

pub fn orchestrate_primary_observed<E: ChunkExtractor, I: ChunkInferenceRunner>(
    source: SourceAudio,
    extractor: &mut E,
    inference: &mut I,
    cancel: &CancellationToken,
    observer: &mut DevObserver<'_>,
) -> Result<MergedResult, &'static str> {
    let cores = source.chunks();
    let total_chunks = cores.len();
    let mut results = Vec::with_capacity(cores.len());
    for core in cores {
        if cancel.is_cancelled() {
            observer(DevObservation {
                chunk: Some(core.index),
                total_chunks,
                owner_start_frame: Some(core.start_frame),
                owner_end_frame: Some(core.end_frame),
                stage: "cancelled",
                attempt: None,
                outcome: "cancelled",
                word_count: None,
            });
            return Err("cancelled");
        }
        observer(DevObservation {
            chunk: Some(core.index),
            total_chunks,
            owner_start_frame: Some(core.start_frame),
            owner_end_frame: Some(core.end_frame),
            stage: "extraction",
            attempt: None,
            outcome: "start",
            word_count: None,
        });
        let wav = match extractor.extract(core) {
            Ok(wav) => {
                if cancel.is_cancelled() {
                    return Err("cancelled");
                }
                observer(DevObservation {
                    chunk: Some(core.index),
                    total_chunks,
                    owner_start_frame: Some(core.start_frame),
                    owner_end_frame: Some(core.end_frame),
                    stage: "extraction",
                    attempt: None,
                    outcome: "success",
                    word_count: None,
                });
                wav
            }
            Err(_) => {
                observer(DevObservation {
                    chunk: Some(core.index),
                    total_chunks,
                    owner_start_frame: Some(core.start_frame),
                    owner_end_frame: Some(core.end_frame),
                    stage: "extraction",
                    attempt: None,
                    outcome: "failure",
                    word_count: None,
                });
                return Err(if cancel.is_cancelled() {
                    "cancelled"
                } else {
                    "extraction failure"
                });
            }
        };
        if cancel.is_cancelled() {
            return Err("cancelled");
        }
        observer(DevObservation {
            chunk: Some(core.index),
            total_chunks,
            owner_start_frame: Some(core.start_frame),
            owner_end_frame: Some(core.end_frame),
            stage: "whisper",
            attempt: Some("normal"),
            outcome: "start",
            word_count: None,
        });
        let words = match inference.run(core, &wav, false, cancel) {
            Ok(words) => {
                observer(DevObservation {
                    chunk: Some(core.index),
                    total_chunks,
                    owner_start_frame: Some(core.start_frame),
                    owner_end_frame: Some(core.end_frame),
                    stage: "whisper",
                    attempt: Some("normal"),
                    outcome: "success",
                    word_count: Some(words.len()),
                });
                words
            }
            Err(_) => {
                if cancel.is_cancelled() {
                    return Err("cancelled");
                }
                observer(DevObservation {
                    chunk: Some(core.index),
                    total_chunks,
                    owner_start_frame: Some(core.start_frame),
                    owner_end_frame: Some(core.end_frame),
                    stage: "whisper",
                    attempt: Some("normal"),
                    outcome: "failure",
                    word_count: None,
                });
                observer(DevObservation {
                    chunk: Some(core.index),
                    total_chunks,
                    owner_start_frame: Some(core.start_frame),
                    owner_end_frame: Some(core.end_frame),
                    stage: "whisper",
                    attempt: Some("cpu_fallback"),
                    outcome: "start",
                    word_count: None,
                });
                let words = inference.run(core, &wav, true, cancel).map_err(|error| {
                    if cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        error
                    }
                })?;
                observer(DevObservation {
                    chunk: Some(core.index),
                    total_chunks,
                    owner_start_frame: Some(core.start_frame),
                    owner_end_frame: Some(core.end_frame),
                    stage: "whisper",
                    attempt: Some("cpu_fallback"),
                    outcome: "success",
                    word_count: Some(words.len()),
                });
                words
            }
        };
        observer(DevObservation {
            chunk: Some(core.index),
            total_chunks,
            owner_start_frame: Some(core.start_frame),
            owner_end_frame: Some(core.end_frame),
            stage: "owner_remap",
            attempt: None,
            outcome: "success",
            word_count: Some(owned_word_count(source, core, &words)),
        });
        results.push(ChunkResult {
            core,
            words,
            valid: true,
        });
    }
    if cancel.is_cancelled() {
        return Err("cancelled");
    }
    let merged = merge(source, &results)?;
    observer(DevObservation {
        chunk: None,
        total_chunks,
        owner_start_frame: None,
        owner_end_frame: None,
        stage: "merge",
        attempt: None,
        outcome: "success",
        word_count: Some(merged.words.len()),
    });
    Ok(merged)
}

pub fn merge(source: SourceAudio, chunks: &[ChunkResult]) -> Result<MergedResult, &'static str> {
    if chunks.iter().any(|chunk| !chunk.valid) {
        return Err("missing or malformed chunk");
    }
    let mut words = Vec::new();
    for chunk in chunks {
        for word in &chunk.words {
            let Some(owned_local) = owner_intersection(word.timing, chunk.core) else {
                continue;
            };
            let Some(timing) = owned_local.remap(chunk.core, source) else {
                return Err("invalid timing");
            };
            let midpoint = (timing.start + timing.end) / 2.0;
            let cs = chunk.core.start_frame as f64 / SAMPLE_RATE as f64;
            let ce = chunk.core.end_frame as f64 / SAMPLE_RATE as f64;
            if midpoint < cs || midpoint >= ce {
                return Err("ownership leakage");
            }
            words.push(Word {
                text: word.text.clone(),
                timing,
            });
        }
    }
    words.sort_by(|a, b| a.timing.start.total_cmp(&b.timing.start));
    if words
        .windows(2)
        .any(|pair| pair[1].timing.start < pair[0].timing.end)
    {
        return Err("duplicate or overlapping ownership");
    }
    Ok(MergedResult { words })
}

pub fn owned_word_count(source: SourceAudio, core: ChunkCore, words: &[Word]) -> usize {
    words
        .iter()
        .filter(|word| {
            owner_intersection(word.timing, core)
                .and_then(|local| local.remap(core, source))
                .is_some()
        })
        .count()
}

fn owner_intersection(timing: Timing, core: ChunkCore) -> Option<Timing> {
    if !timing.start.is_finite()
        || !timing.end.is_finite()
        || timing.end <= timing.start
        || timing.end <= 0.0
    {
        return None;
    }
    let duration = (core.end_frame - core.start_frame) as f64 / SAMPLE_RATE as f64;
    let start = timing.start.max(0.0);
    let end = timing.end.min(duration);
    (end > start).then_some(Timing { start, end })
}

pub fn splice_recovery(
    primary: &MergedResult,
    replacement: &RecoveryReplacement,
) -> Result<MergedResult, &'static str> {
    if !replacement.attempted || !replacement.succeeded {
        return Ok(primary.clone());
    }
    let mut words: Vec<Word> = primary
        .words
        .iter()
        .filter(|word| {
            word.timing.end <= replacement.owner.start || word.timing.start >= replacement.owner.end
        })
        .cloned()
        .collect();
    for word in &replacement.words {
        if word.timing.start < replacement.owner.start
            || word.timing.end > replacement.owner.end
            || word.timing.end <= word.timing.start
        {
            return Err("recovery escaped owner");
        }
        words.push(word.clone());
    }
    words.sort_by(|a, b| a.timing.start.total_cmp(&b.timing.start));
    if words
        .windows(2)
        .any(|pair| pair[1].timing.start < pair[0].timing.end)
    {
        return Err("recovery overlap");
    }
    Ok(MergedResult { words })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn word(text: &str, start: f64, end: f64) -> Word {
        Word {
            text: text.into(),
            timing: Timing { start, end },
        }
    }
    #[test]
    fn geometry_cases_and_no_drift() {
        assert_eq!(SourceAudio { frames: 0 }.chunks(), vec![]);
        assert_eq!(
            SourceAudio {
                frames: 12 * SAMPLE_RATE
            }
            .chunks()
            .len(),
            1
        );
        assert_eq!(
            SourceAudio {
                frames: 30 * SAMPLE_RATE
            }
            .chunks()
            .len(),
            1
        );
        assert_eq!(
            SourceAudio {
                frames: 30 * SAMPLE_RATE + 1
            }
            .chunks()[1]
                .end_frame,
            30 * SAMPLE_RATE + 1
        );
        let long = SourceAudio {
            frames: 1000 * CORE_FRAMES + 7,
        };
        let cs = long.chunks();
        assert_eq!(cs.last().unwrap().end_frame, long.frames);
        assert!(cs.windows(2).all(|w| w[0].end_frame == w[1].start_frame));
    }
    #[test]
    fn remap_clamp_and_invalid() {
        let source = SourceAudio {
            frames: 31 * SAMPLE_RATE,
        };
        let c = source.chunks()[1];
        assert_eq!(
            Timing {
                start: 0.5,
                end: 1.5
            }
            .remap(c, source)
            .unwrap(),
            Timing {
                start: 30.5,
                end: 31.0
            }
        );
        assert!(Timing {
            start: -1.0,
            end: 1.0
        }
        .remap(c, source)
        .is_none());
        assert!(Timing {
            start: 1.0,
            end: 1.0
        }
        .remap(c, source)
        .is_none());
    }

    #[test]
    fn gate4_exclusive_boundary_timing_regression() {
        let core = ChunkCore {
            index: 0,
            start_frame: 0,
            end_frame: CORE_FRAMES,
        };
        assert!(owner_intersection(
            Timing {
                start: 30.0,
                end: 30.045
            },
            core
        )
        .is_none());
        assert_eq!(
            owner_intersection(
                Timing {
                    start: 29.98,
                    end: 30.045
                },
                core
            ),
            Some(Timing {
                start: 29.98,
                end: 30.0
            })
        );
        assert_eq!(
            owner_intersection(
                Timing {
                    start: 29.95,
                    end: 30.0
                },
                core
            ),
            Some(Timing {
                start: 29.95,
                end: 30.0
            })
        );
        assert!(owner_intersection(
            Timing {
                start: 30.001,
                end: 30.045
            },
            core
        )
        .is_none());
        let later = ChunkCore {
            index: 1,
            start_frame: CORE_FRAMES,
            end_frame: 2 * CORE_FRAMES,
        };
        assert_eq!(
            owner_intersection(
                Timing {
                    start: 0.0,
                    end: 0.25
                },
                later
            ),
            Some(Timing {
                start: 0.0,
                end: 0.25
            })
        );
    }

    #[test]
    fn gate4_boundary_word_is_skipped_by_merge_without_aborting() {
        let source = SourceAudio {
            frames: 2 * CORE_FRAMES,
        };
        let cores = source.chunks();
        let merged = merge(
            source,
            &[
                ChunkResult {
                    core: cores[0],
                    valid: true,
                    words: vec![word("kept", 29.8, 29.9), word("boundary", 30.0, 30.045)],
                },
                ChunkResult {
                    core: cores[1],
                    valid: true,
                    words: vec![word("later", 0.1, 0.2)],
                },
            ],
        )
        .expect("boundary-only word must not abort merge");
        assert_eq!(
            merged
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            vec!["kept", "later"]
        );
    }
    #[test]
    fn merge_rejects_missing_leak_and_overlap() {
        let s = SourceAudio {
            frames: 31 * SAMPLE_RATE,
        };
        let cs = s.chunks();
        assert!(merge(
            s,
            &[ChunkResult {
                core: cs[0],
                words: vec![],
                valid: false
            }]
        )
        .is_err());
        assert!(merge(
            s,
            &[ChunkResult {
                core: cs[0],
                words: vec![word("x", 30.0, 30.1)],
                valid: true
            }]
        )
        .expect("empty exclusive-owner intersection is skipped")
        .words
        .is_empty());
        let x = ChunkResult {
            core: cs[0],
            words: vec![word("a", 1.0, 2.0), word("b", 1.5, 2.5)],
            valid: true,
        };
        assert!(merge(s, &[x]).is_err());
    }
    #[test]
    fn recovery_is_owner_clipped_and_failed_is_noop() {
        let p = MergedResult {
            words: vec![
                word("before", 1.0, 2.0),
                word("old", 10.0, 11.0),
                word("after", 20.0, 21.0),
            ],
        };
        let r = RecoveryReplacement {
            candidate_id: "r".into(),
            decode_window: Timing {
                start: 0.0,
                end: 25.0,
            },
            owner: Timing {
                start: 9.0,
                end: 12.0,
            },
            primary_chunk: 0,
            words: vec![word("new", 10.0, 10.5)],
            attempted: true,
            succeeded: true,
        };
        let out = splice_recovery(&p, &r).unwrap();
        assert_eq!(
            out.words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            vec!["before", "new", "after"]
        );
        let mut bad = r.clone();
        bad.words = vec![word("leak", 12.0, 12.5)];
        assert!(splice_recovery(&p, &bad).is_err());
        bad.attempted = false;
        assert_eq!(splice_recovery(&p, &bad).unwrap(), p);
    }
    #[test]
    fn transaction_ready_is_terminal_only() {
        assert_ne!(TransactionStage::Chunks, TransactionStage::Ready);
        assert_ne!(TransactionStage::Serialize, TransactionStage::Ready);
        assert_eq!(TransactionStage::Ready, TransactionStage::Ready);
    }
    #[test]
    fn transaction_order_rejects_early_ready_and_failure_is_not_ready() {
        let s = CandidateState::Preparing;
        assert!(s.advance(CandidateState::Ready).is_err());
        let s = s
            .advance(CandidateState::ChunksComplete)
            .unwrap()
            .advance(CandidateState::PrimaryMergeComplete)
            .unwrap()
            .advance(CandidateState::RecoveryComplete)
            .unwrap()
            .advance(CandidateState::FinalizationComplete)
            .unwrap()
            .advance(CandidateState::SerializationComplete)
            .unwrap()
            .advance(CandidateState::AtomicReplacementComplete)
            .unwrap();
        assert_eq!(
            s.advance(CandidateState::Ready).unwrap(),
            CandidateState::Ready
        );
        assert_ne!(CandidateState::Cancelled, CandidateState::Ready);
    }
    #[test]
    fn retry_bookkeeping_never_reruns_success() {
        let ok = ChunkAttempt {
            index: 2,
            attempts: 1,
            succeeded: true,
        };
        assert!(ok.retry().is_err());
        let failed = ChunkAttempt {
            index: 2,
            attempts: 1,
            succeeded: false,
        };
        assert_eq!(failed.clone().retry().unwrap().attempts, 2);
        assert!(failed.retry().unwrap().retry().is_err());
    }
    #[test]
    fn progress_is_bounded_and_deterministic() {
        assert_eq!(progress(0, 0), 0.0);
        assert_eq!(progress(3, 10), 30.0);
        assert_eq!(progress(12, 10), 100.0);
    }
    #[test]
    fn candidate_paths_are_run_scoped_and_args_preserve_contract() {
        let p = DevRunPaths::new(std::path::Path::new("/tmp/r"), "abc").unwrap();
        assert!(p.root.ends_with(".scribe-chunked-dev-abc"));
        assert!(DevRunPaths::new(std::path::Path::new("/tmp/r"), "a/b").is_err());
        let a = candidate_whisper_args(
            std::path::Path::new("m"),
            std::path::Path::new("w"),
            "sl",
            std::path::Path::new("o"),
        );
        assert_eq!(
            a,
            vec!["-m", "m", "-f", "w", "-l", "sl", "-oj", "-ojf", "-of", "o"]
        );
    }
    #[test]
    fn cancellation_token_is_monotonic() {
        let c = CancellationToken::default();
        assert!(!c.is_cancelled());
        c.cancel();
        assert!(c.is_cancelled());
        c.cancel();
        assert!(c.is_cancelled());
    }
    #[test]
    fn extraction_args_use_integer_derived_absolute_boundaries() {
        let c = SourceAudio {
            frames: CORE_FRAMES + 1,
        }
        .chunks()[1];
        let a = candidate_ffmpeg_args(
            std::path::Path::new("processing.wav"),
            std::path::Path::new("chunk.wav"),
            c,
        );
        assert!(a.windows(2).any(|w| w == ["-ss", "30.000000"]));
        assert!(a.windows(2).any(|w| w == ["-t", "0.000063"]));
    }
    fn wav(
        frames: usize,
        channels: u16,
        rate: u32,
        bits: u16,
        audio: u16,
        extra: bool,
        pad: bool,
    ) -> Vec<u8> {
        let data = frames * 2 * channels as usize;
        let fmt_size = 16usize;
        let extra_size = if extra { 12 } else { 0 };
        let total =
            4 + (8 + fmt_size) + extra_size + 8 + data + if pad && data % 2 == 1 { 1 } else { 0 };
        let mut b = Vec::with_capacity(total + 8);
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(total as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&(16u32).to_le_bytes());
        b.extend_from_slice(&audio.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * channels as u32 * bits as u32 / 8).to_le_bytes());
        b.extend_from_slice(&(channels * bits / 8).to_le_bytes());
        b.extend_from_slice(&bits.to_le_bytes());
        if extra {
            b.extend_from_slice(b"JUNK");
            b.extend_from_slice(&(4u32).to_le_bytes());
            b.extend_from_slice(&[0; 4]);
        }
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data as u32).to_le_bytes());
        b.resize(b.len() + data, 0);
        if pad && data % 2 == 1 {
            b.push(0);
        }
        b
    }
    #[test]
    fn wav_parser_valid_geometry_and_padding() {
        for n in [0, 480000, 480001, 960000] {
            let s =
                source_audio_from_canonical_wav(&wav(n, 1, 16000, 16, 1, n == 0, false)).unwrap();
            assert_eq!(s.frames, n as u64);
        }
        assert_eq!(
            source_audio_from_canonical_wav(&wav(3, 1, 16000, 16, 1, true, true))
                .unwrap()
                .frames,
            3
        );
        assert_eq!(
            source_audio_from_canonical_wav(&wav(480001, 1, 16000, 16, 1, false, false))
                .unwrap()
                .chunks()
                .last()
                .unwrap()
                .end_frame,
            480001
        );
    }
    #[test]
    fn wav_parser_rejects_invalid_structure_and_format() {
        let good = wav(1, 1, 16000, 16, 1, false, false);
        for bad in [
            wav(1, 2, 16000, 16, 1, false, false),
            wav(1, 1, 8000, 16, 1, false, false),
            wav(1, 1, 16000, 8, 1, false, false),
            wav(1, 1, 16000, 16, 3, false, false),
        ] {
            assert!(source_audio_from_canonical_wav(&bad).is_err());
        }
        assert!(source_audio_from_canonical_wav(&good[..10]).is_err());
        let mut no_data = good.clone();
        no_data.truncate(no_data.len() - 10);
        assert!(source_audio_from_canonical_wav(&no_data).is_err());
    }
    #[test]
    fn parsed_word_conversion_is_structural() {
        let got = parsed_words_to_words(vec![
            crate::transcription_runtime::ParsedTranscriptionWord {
                text: "č".into(),
                start: 1.25,
                end: 2.5,
            },
        ]);
        assert_eq!(got, vec![word("č", 1.25, 2.5)]);
        assert!(parsed_words_to_words(vec![]).is_empty());
    }
    struct FakeExtract;
    impl ChunkExtractor for FakeExtract {
        fn extract(&mut self, c: ChunkCore) -> Result<std::path::PathBuf, &'static str> {
            Ok(std::path::PathBuf::from(format!("{}.wav", c.index)))
        }
    }
    struct FakeInfer {
        failed_once: Option<u64>,
        calls: Vec<(u64, bool)>,
    }
    impl ChunkInferenceRunner for FakeInfer {
        fn run(
            &mut self,
            c: ChunkCore,
            _: &std::path::Path,
            cpu: bool,
            cancel: &CancellationToken,
        ) -> Result<Vec<Word>, &'static str> {
            self.calls.push((c.index, cpu));
            if cancel.is_cancelled() {
                return Err("cancelled");
            }
            if !cpu && self.failed_once == Some(c.index) {
                return Err("normal failure");
            }
            let start = 0.001;
            Ok(vec![word("w", start, start + 0.1)])
        }
    }
    #[test]
    fn fake_orchestrator_is_sequential_and_fallback_is_per_chunk() {
        let source = SourceAudio {
            frames: CORE_FRAMES * 2 + 100,
        };
        let mut e = FakeExtract;
        let mut i = FakeInfer {
            failed_once: Some(1),
            calls: vec![],
        };
        let mut events = vec![];
        let result = orchestrate_primary(
            source,
            &mut e,
            &mut i,
            &CancellationToken::default(),
            &mut events,
        )
        .unwrap();
        assert_eq!(result.words.len(), 3);
        assert_eq!(i.calls, vec![(0, false), (1, false), (1, true), (2, false)]);
        assert_eq!(events.last().unwrap().kind, "merge");
    }
    #[test]
    fn fake_orchestrator_aborts_before_merge_on_final_failure_or_cancel() {
        struct Bad;
        impl ChunkInferenceRunner for Bad {
            fn run(
                &mut self,
                _: ChunkCore,
                _: &std::path::Path,
                _: bool,
                _: &CancellationToken,
            ) -> Result<Vec<Word>, &'static str> {
                Err("bad")
            }
        }
        let source = SourceAudio {
            frames: CORE_FRAMES * 2,
        };
        let mut e = FakeExtract;
        let mut i = Bad;
        let mut events = vec![];
        assert!(orchestrate_primary(
            source,
            &mut e,
            &mut i,
            &CancellationToken::default(),
            &mut events
        )
        .is_err());
        assert!(!events.iter().any(|x| x.kind == "merge"));
        let c = CancellationToken::default();
        c.cancel();
        let mut e = FakeExtract;
        let mut i = Bad;
        assert!(orchestrate_primary(source, &mut e, &mut i, &c, &mut vec![]).is_err());
    }

    #[test]
    fn pre_cancelled_token_starts_no_operation_and_returns_cancelled() {
        struct CountingExtract(bool);
        impl ChunkExtractor for CountingExtract {
            fn extract(&mut self, _: ChunkCore) -> Result<std::path::PathBuf, &'static str> {
                self.0 = true;
                Ok("never.wav".into())
            }
        }
        let c = CancellationToken::default();
        c.cancel();
        let mut e = CountingExtract(false);
        let mut i = FakeInfer {
            failed_once: None,
            calls: vec![],
        };
        assert_eq!(
            orchestrate_primary(
                SourceAudio {
                    frames: CORE_FRAMES
                },
                &mut e,
                &mut i,
                &c,
                &mut vec![]
            ),
            Err("cancelled")
        );
        assert!(!e.0);
        assert!(i.calls.is_empty());
    }

    #[test]
    fn cancellation_during_extraction_stops_before_whisper_and_merge() {
        struct CancellingExtract {
            token: CancellationHandle,
            calls: usize,
        }
        impl ChunkExtractor for CancellingExtract {
            fn extract(&mut self, _: ChunkCore) -> Result<std::path::PathBuf, &'static str> {
                self.calls += 1;
                self.token.cancel();
                Err("extraction failure")
            }
        }
        let c = std::sync::Arc::new(CancellationToken::default());
        let mut e = CancellingExtract {
            token: c.clone(),
            calls: 0,
        };
        let mut i = FakeInfer {
            failed_once: None,
            calls: vec![],
        };
        assert!(orchestrate_primary(
            SourceAudio {
                frames: CORE_FRAMES
            },
            &mut e,
            &mut i,
            &c,
            &mut vec![]
        )
        .is_err());
        assert_eq!(e.calls, 1);
        assert!(i.calls.is_empty());
        assert!(c.is_cancelled());
    }

    #[test]
    fn cancellation_during_normal_failure_does_not_trigger_cpu_fallback() {
        struct CancelOnNormal {
            token: CancellationHandle,
        }
        impl ChunkInferenceRunner for CancelOnNormal {
            fn run(
                &mut self,
                _: ChunkCore,
                _: &std::path::Path,
                cpu: bool,
                _: &CancellationToken,
            ) -> Result<Vec<Word>, &'static str> {
                assert!(!cpu);
                self.token.cancel();
                Err("normal failure")
            }
        }
        let c = std::sync::Arc::new(CancellationToken::default());
        let mut e = FakeExtract;
        let mut i = CancelOnNormal { token: c.clone() };
        assert!(orchestrate_primary(
            SourceAudio {
                frames: CORE_FRAMES
            },
            &mut e,
            &mut i,
            &c,
            &mut vec![]
        )
        .is_err());
    }

    #[test]
    fn run_scoped_cancellation_isolation() {
        let a = std::sync::Arc::new(CancellationToken::default());
        let b = std::sync::Arc::new(CancellationToken::default());
        a.cancel();
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
    }

    #[test]
    fn owned_child_is_killed_and_reaped_on_cancellation() {
        let token = CancellationToken::default();
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let thread_token = std::sync::Arc::new(token);
        let child_token = thread_token.clone();
        let handle = std::thread::spawn(move || run_candidate_child(command, &child_token));
        std::thread::sleep(std::time::Duration::from_millis(50));
        thread_token.cancel();
        let result = handle.join().unwrap().unwrap();
        assert_eq!(result.disposition, ChildDisposition::Cancelled);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn provenance_workspace_without_command_is_incomplete() {
        assert_eq!(
            validate_provenance_events("r", &[], None, &[]),
            ProvenanceStatus::Incomplete
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn provenance_success_failure_cancel_and_conflicts_are_distinct() {
        assert_eq!(
            validate_provenance_events(
                "r",
                &[("r", "PRIMARY_MERGE_COMPLETED"), ("r", "COMMAND_SUCCEEDED")],
                Some("SUCCESS"),
                &[0.0, 100.0]
            ),
            ProvenanceStatus::Success
        );
        assert_eq!(
            validate_provenance_events("r", &[("r", "COMMAND_FAILED")], Some("FAILURE"), &[0.0]),
            ProvenanceStatus::Failure
        );
        assert_eq!(
            validate_provenance_events(
                "r",
                &[("r", "COMMAND_CANCELLED")],
                Some("CANCELLED"),
                &[0.0]
            ),
            ProvenanceStatus::Cancelled
        );
        assert_eq!(
            validate_provenance_events(
                "r",
                &[("r", "COMMAND_FAILED"), ("r", "COMMAND_SUCCEEDED")],
                Some("SUCCESS"),
                &[]
            ),
            ProvenanceStatus::Invalid
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn provenance_detects_run_id_and_progress_errors() {
        assert_eq!(
            validate_provenance_events(
                "r",
                &[("other", "COMMAND_SUCCEEDED")],
                Some("SUCCESS"),
                &[]
            ),
            ProvenanceStatus::Invalid
        );
        assert_eq!(
            validate_provenance_events(
                "r",
                &[("r", "COMMAND_SUCCEEDED")],
                Some("SUCCESS"),
                &[20.0, 10.0]
            ),
            ProvenanceStatus::Invalid
        );
        assert_eq!(
            validate_provenance_events("r", &[("r", "COMMAND_SUCCEEDED")], Some("FAILURE"), &[]),
            ProvenanceStatus::Invalid
        );
        let success = [("r", "PRIMARY_MERGE_COMPLETED"), ("r", "COMMAND_SUCCEEDED")];
        assert_eq!(
            validate_provenance_bundle("r", &success, Some("SUCCESS"), true, &[]),
            ProvenanceStatus::Invalid
        );
        assert_eq!(
            validate_provenance_bundle("r", &[("r", "COMMAND_FAILED")], Some("FAILURE"), true, &[]),
            ProvenanceStatus::Invalid
        );
        assert_eq!(
            validate_provenance_bundle(
                "r",
                &[("r", "COMMAND_CANCELLED")],
                Some("CANCELLED"),
                true,
                &[]
            ),
            ProvenanceStatus::Invalid
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn serialized_persistence_field_is_fail_closed_for_all_terminal_states() {
        for (state, event) in [
            ("SUCCESS", "COMMAND_SUCCEEDED"),
            ("FAILURE", "COMMAND_FAILED"),
            ("CANCELLED", "COMMAND_CANCELLED"),
        ] {
            let events = if state == "SUCCESS" {
                vec![("r", "PRIMARY_MERGE_COMPLETED"), ("r", event)]
            } else {
                vec![("r", event)]
            };
            let valid = format!(
                r#"{{"schemaVersion":1,"runId":"r","recordingId":"rec","terminalState":"{state}","persistenceOccurred":false}}"#
            );
            let persisted = valid.replace("false", "true");
            assert_ne!(
                validate_serialized_provenance("r", &events, &valid, &[0.0]),
                ProvenanceStatus::Invalid
            );
            assert_eq!(
                validate_serialized_provenance("r", &events, &persisted, &[0.0]),
                ProvenanceStatus::Invalid
            );
        }
        let missing =
            r#"{"schemaVersion":1,"runId":"r","recordingId":"rec","terminalState":"SUCCESS"}"#;
        let wrong_type = r#"{"schemaVersion":1,"runId":"r","recordingId":"rec","terminalState":"SUCCESS","persistenceOccurred":"false"}"#;
        let events = [("r", "PRIMARY_MERGE_COMPLETED"), ("r", "COMMAND_SUCCEEDED")];
        assert_eq!(
            validate_serialized_provenance("r", &events, missing, &[]),
            ProvenanceStatus::Invalid
        );
        assert_eq!(
            validate_serialized_provenance("r", &events, wrong_type, &[]),
            ProvenanceStatus::Invalid
        );
    }
}
