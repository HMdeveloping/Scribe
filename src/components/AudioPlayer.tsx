import { LoaderCircle, Pause, Play } from "lucide-react";
import { formatPlaybackTime } from "../hooks/useAudioPlayer";
import type { TFunction } from "../i18n";

export interface AudioPlayerState {
  status: "loading" | "ready" | "error";
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  canSeek: boolean;
  togglePlayback: () => void;
  seekTo: (seconds: number) => void;
  readCurrentTime: () => number;
}

export function AudioPlayer({ player, t }: { player: AudioPlayerState; t: TFunction }) {
  const playDisabled = player.status === "loading";
  const scrubberDisabled = player.status !== "ready" || !player.canSeek;

  return (
    <div className="audio-player" aria-label="Audio player">
      <button disabled={playDisabled} aria-label={player.isPlaying ? "Pause recording" : "Play recording"} onClick={player.togglePlayback}>
        {player.status === "loading" ? <LoaderCircle size={18} /> : player.isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <span>{formatPlaybackTime(player.currentTime)}</span>
      <input
        className="audio-timeline"
        type="range"
        min="0"
        max={Math.max(player.duration, 0)}
        step="0.01"
        value={Math.min(player.currentTime, player.duration || 0)}
        disabled={scrubberDisabled}
        aria-label="Playback position"
        onInput={(event) => player.seekTo(Number(event.currentTarget.value))}
        onChange={(event) => player.seekTo(Number(event.currentTarget.value))}
      />
      <span>{formatPlaybackTime(player.duration)}</span>
      {player.status === "error" ? <span className="audio-error">{t("audioLoadError")}</span> : null}
    </div>
  );
}
