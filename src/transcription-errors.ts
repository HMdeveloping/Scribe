export type TranscriptionErrorKind =
  | "model_missing"
  | "model_downloading"
  | "model_ready"
  | "ffmpeg_missing"
  | "whisper_missing"
  | "audio_missing"
  | "conversion_failed"
  | "transcript_unavailable"
  | "transcription";

export type ClassifiedTranscriptionError = {
  kind: TranscriptionErrorKind;
  diagnosticCode: string;
  message?: string;
};

const DIAGNOSTIC_CODES: Record<string, string> = {
  model_missing: "MODEL_NOT_FOUND",
  model_downloading: "MODEL_DOWNLOAD_IN_PROGRESS",
  model_ready: "MODEL_READY",
  ffmpeg_missing: "AUDIO_PREPROCESSING_FAILED",
  whisper_missing: "WHISPER_BINARY_NOT_FOUND",
  audio_missing: "AUDIO_PREPROCESSING_FAILED",
  conversion_failed: "AUDIO_PREPROCESSING_FAILED",
  audio_decode_failed: "AUDIO_PREPROCESSING_FAILED",
  model_download_failed: "MODEL_DOWNLOAD_FAILED",
  model_corrupted: "MODEL_LOAD_FAILED",
  model_load_failed: "MODEL_LOAD_FAILED",
  backend_initialization_failed: "BACKEND_INITIALIZATION_FAILED",
  permission_denied: "PERMISSION_DENIED",
  resource_path_invalid: "RESOURCE_PATH_INVALID",
  whisper_failed: "WHISPER_EXECUTION_FAILED",
  transcript_unavailable: "UNKNOWN_TRANSCRIPTION_ERROR",
  io: "UNKNOWN_TRANSCRIPTION_ERROR",
  cancelled: "TRANSCRIPTION_CANCELLED",
};

export function classifyTranscriptionError(reason: unknown): ClassifiedTranscriptionError {
  const kind = typeof reason === "object" && reason !== null && "kind" in reason
    ? String((reason as { kind: unknown }).kind)
    : "";
  const message = typeof reason === "object" && reason !== null && "message" in reason
    ? String((reason as { message: unknown }).message)
    : typeof reason === "string"
      ? reason
      : undefined;
  const diagnosticCode = DIAGNOSTIC_CODES[kind] ?? "UNKNOWN_TRANSCRIPTION_ERROR";

  if (kind === "model_missing") return { kind: "model_missing", diagnosticCode, message };
  if (kind === "model_downloading") return { kind: "model_downloading", diagnosticCode, message };
  if (kind === "model_ready") return { kind: "model_ready", diagnosticCode, message };
  if (kind === "ffmpeg_missing") return { kind: "ffmpeg_missing", diagnosticCode, message };
  if (kind === "whisper_missing") return { kind: "whisper_missing", diagnosticCode, message };
  if (kind === "invalid_recording") return { kind: "audio_missing", diagnosticCode: DIAGNOSTIC_CODES.audio_missing, message };
  if (kind === "conversion_failed" || kind === "audio_decode_failed") {
    return { kind: "conversion_failed", diagnosticCode: DIAGNOSTIC_CODES.conversion_failed, message };
  }
  if (kind === "transcript_unavailable") return { kind: "transcript_unavailable", diagnosticCode, message };
  return { kind: "transcription", diagnosticCode, message };
}
