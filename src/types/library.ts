import type { RecordingMetadata, TranscriptData } from "../components/RecordingWorkflow";

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  recordingCount: number;
  totalDurationSeconds: number;
  isSynthetic?: boolean;
};

export type RecordingSummary = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  language: string;
  audioFile: string;
  mimeType: string;
  transcriptFile: string | null;
  transcriptStatus: string;
  archivedAt: string | null;
};

export type RecordingDetails = {
  recording: RecordingMetadata;
  projectId: string | null;
  projectName: string | null;
  transcriptStatus: string;
  transcript: TranscriptData | null;
};
