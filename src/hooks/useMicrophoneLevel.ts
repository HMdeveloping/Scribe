import { useCallback, useEffect, useRef, useState } from "react";
import type { TranslationKey } from "../i18n";
import { beginMicrophoneDiagnosticSession, recordMicrophoneDiagnostic } from "../microphone-diagnostics";

const BAR_COUNT = 40;
const ANALYSER_INTERVAL_MS = 1000 / 30;
const NOISE_GATE = 0.016;
const INPUT_GAIN = 1.9;
const COMPRESSION_EXPONENT = 0.62;
const VISUAL_HEADROOM = 0.9;
const ATTACK = 0.26;
const RELEASE = 0.13;
const NEIGHBOR_BLEND = 0.18;

type MicrophonePermissionState = PermissionState | "unsupported";

export function useMicrophoneLevel(paused: boolean) {
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [status, setStatus] = useState<"requesting" | "active" | "error">("requesting");
  const [error, setError] = useState<TranslationKey | "">("");
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [attempt, setAttempt] = useState(0);
  const pausedRef = useRef(paused);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    let disposed = false;
    let terminal = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let frame = 0;
    let analyserSetupFrame = 0;
    const smoothed = new Float32Array(BAR_COUNT);
    const displayed = new Float32Array(BAR_COUNT);
    const rawTargets = new Float32Array(BAR_COUNT);
    const targets = new Float32Array(BAR_COUNT);
    let lastTime = 0;
    let lastAnalyserTime = -ANALYSER_INTERVAL_MS;

    function stopAnalysis() {
      cancelAnimationFrame(analyserSetupFrame);
      cancelAnimationFrame(frame);
      source?.disconnect();
      analyser?.disconnect();
      if (context && context.state !== "closed") void context.close().catch(() => {});
    }

    function stop() {
      if (disposed) return;
      disposed = true;
      terminal = true;
      stopAnalysis();
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
      stream?.getTracks().forEach((track) => {
        track.removeEventListener("ended", handleTrackEnded);
        track.removeEventListener("mute", handleTrackMute);
        track.removeEventListener("unmute", handleTrackUnmute);
        track.stop();
      });
      setMediaStream(null);
      recordMicrophoneDiagnostic(sessionId, "capture_resources_released");
    }
    stopRef.current = stop;

    function fail(messageKey: TranslationKey, preserveStream = false) {
      if (disposed || terminal) return;
      terminal = true;
      setError(messageKey);
      setStatus("error");
      setLevels(Array(BAR_COUNT).fill(0));
      recordMicrophoneDiagnostic(sessionId, "capture_failed", {
        category: messageKey,
        trackReadyState: stream?.getAudioTracks()[0]?.readyState ?? "unavailable",
      });
      stopAnalysis();
      if (!preserveStream) stop();
    }

    function handleTrackEnded() {
      if (disposed || terminal) return;
      recordMicrophoneDiagnostic(sessionId, "audio_track_ended", {
        trackReadyState: stream?.getAudioTracks()[0]?.readyState ?? "unknown",
      });
      setInterrupted(true);
      fail("microphoneDisconnectedDetail", true);
    }

    function handleTrackMute() {
      if (disposed || terminal) return;
      recordMicrophoneDiagnostic(sessionId, "audio_track_muted", {
        trackReadyState: stream?.getAudioTracks()[0]?.readyState ?? "unknown",
      });
    }

    function handleTrackUnmute() {
      if (disposed || terminal) return;
      recordMicrophoneDiagnostic(sessionId, "audio_track_unmuted", {
        trackReadyState: stream?.getAudioTracks()[0]?.readyState ?? "unknown",
      });
    }

    function handleDeviceChange() {
      if (disposed || terminal) return;
      recordMicrophoneDiagnostic(sessionId, "audio_input_device_change", {
        trackReadyState: stream?.getAudioTracks()[0]?.readyState ?? "unavailable",
        streamActive: stream?.active ?? false,
      });
    }

    async function start() {
      // Skip the discarded effect in React StrictMode before requesting hardware.
      await Promise.resolve();
      if (disposed) return;
      const requestedAt = performance.now();
      let permissionState: MicrophonePermissionState = "unsupported";
      try {
        if (navigator.permissions?.query) {
          permissionState = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
        }
      } catch {
        permissionState = "unsupported";
      }
      if (disposed || terminal) return;
      recordMicrophoneDiagnostic(sessionId, "capture_initialization_attempt", {
        attempt,
        permissionState,
        inputDeviceSelection: "os-default-input",
      });
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
          if (import.meta.env.DEV) console.error("Scribe: microphone API unavailable", {
            mediaDevicesAvailable: Boolean(navigator.mediaDevices),
            getUserMediaType: typeof navigator.mediaDevices?.getUserMedia,
            isSecureContext: window.isSecureContext,
          });
          fail("microphoneUnavailableDetail");
          return;
        }
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
        const acquiredAt = performance.now();
        if (disposed || terminal) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        const audioTracks = acquired.getAudioTracks();
        if (audioTracks.length === 0 || audioTracks.some((track) => track.readyState !== "live")) {
          acquired.getTracks().forEach((track) => track.stop());
          fail("microphoneUnavailableDetail");
          return;
        }
        recordMicrophoneDiagnostic(sessionId, "stream_acquisition_succeeded", {
          audioTrackCount: audioTracks.length,
          streamActive: acquired.active,
          latencyMs: Math.round(acquiredAt - requestedAt),
          trackReadyState: audioTracks[0]?.readyState ?? "unknown",
          inputDeviceSelection: "os-default-input",
        });
        stream = acquired;
        setMediaStream(acquired);
        audioTracks.forEach((track) => {
          track.addEventListener("ended", handleTrackEnded);
          track.addEventListener("mute", handleTrackMute);
          track.addEventListener("unmute", handleTrackUnmute);
        });
        recordMicrophoneDiagnostic(sessionId, "microphone_permission_result", { permissionState: "granted" });
        setStatus("active");

        analyserSetupFrame = requestAnimationFrame(() => {
          if (disposed || terminal || !stream) return;
          void (async () => {
            const analyserRequestedAt = performance.now();
            context = new AudioContext();
            analyser = context.createAnalyser();
            analyser.fftSize = 512;
            source = context.createMediaStreamSource(stream!);
            source.connect(analyser);
            // Do not connect to the speakers: analysis must not produce feedback.
            await context.resume();
            if (disposed || terminal || !analyser) return;
            recordMicrophoneDiagnostic(sessionId, "audio_capture_context_ready", {
              state: context.state,
              latencyMs: Math.round(performance.now() - analyserRequestedAt),
              afterStreamMs: Math.round(performance.now() - acquiredAt),
            });
            const samples = new Uint8Array(analyser.fftSize);
            function update(time: number) {
              if (disposed || terminal || !analyser) return;
              const delta = lastTime ? Math.min(time - lastTime, 100) : 16;
              lastTime = time;
              if (!pausedRef.current) {
                // Fresh microphone targets at 30 Hz keep the shape stable; rAF still
                // interpolates every visual frame for fluid motion.
                if (time - lastAnalyserTime >= ANALYSER_INTERVAL_MS) {
                  lastAnalyserTime = time;
                  analyser.getByteTimeDomainData(samples);
                  for (let index = 0; index < BAR_COUNT; index++) {
                    // Three samples from each distinct region retain the real wave's shape.
                    const center = Math.floor((index + 0.5) * samples.length / BAR_COUNT);
                    const amplitude = (Math.abs(samples[center - 1] - 128)
                      + Math.abs(samples[center] - 128)
                      + Math.abs(samples[center + 1] - 128)) / (3 * 128);
                    const gated = Math.max(0, amplitude - NOISE_GATE);
                    const gained = Math.min(1, gated * INPUT_GAIN);
                    rawTargets[index] = Math.pow(gained, COMPRESSION_EXPONENT) * VISUAL_HEADROOM;
                  }
                  // A light spatial blend removes isolated spikes without flattening the wave.
                  for (let index = 0; index < BAR_COUNT; index++) {
                    const left = rawTargets[Math.max(0, index - 1)];
                    const right = rawTargets[Math.min(BAR_COUNT - 1, index + 1)];
                    targets[index] = rawTargets[index] * (1 - NEIGHBOR_BLEND)
                      + ((left + right) / 2) * NEIGHBOR_BLEND;
                  }
                }
                let changed = false;
                for (let index = 0; index < BAR_COUNT; index++) {
                  const rate = targets[index] > smoothed[index] ? ATTACK : RELEASE;
                  const smoothing = 1 - Math.pow(1 - rate, delta / (1000 / 60));
                  smoothed[index] += (targets[index] - smoothed[index]) * smoothing;
                  if (smoothed[index] < 0.0001) smoothed[index] = 0;
                  if (Math.abs(smoothed[index] - displayed[index]) > 0.001
                    || (smoothed[index] === 0 && displayed[index] !== 0)) changed = true;
                }
                // Skip sub-pixel updates and idle frames once silence has settled.
                if (changed) {
                  displayed.set(smoothed);
                  setLevels(Array.from(smoothed));
                }
              }
              frame = requestAnimationFrame(update);
            }
            frame = requestAnimationFrame(update);
          })().catch((reason) => {
            recordMicrophoneDiagnostic(sessionId, "audio_capture_context_failed", {
              category: reason instanceof DOMException ? reason.name : "audio_context_error",
            });
          });
        });
      } catch (reason) {
        const name = reason instanceof DOMException ? reason.name : reason instanceof Error ? reason.name : "";
        let finalPermissionState: MicrophonePermissionState = "unsupported";
        try {
          if (navigator.permissions?.query) {
            finalPermissionState = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
          }
        } catch {
          // WebKit may not expose microphone permission state; retain the real error name.
        }
        // getUserMedia's NotAllowedError is the only browser-level result that
        // supports a permission-denied message, and only when the permission
        // state confirms denial. A granted permission plus NotAllowedError can
        // still mean the device/capture path failed on the current WebView.
        const permissionDenied = finalPermissionState === "denied";
        const errorKey: TranslationKey = name === "NotAllowedError" || name === "SecurityError"
          ? permissionDenied ? "microphonePermissionDetail" : "microphoneError"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "microphoneUnavailableDetail"
            : name === "NotReadableError" || name === "AbortError"
              ? "microphoneBusyDetail"
              : "microphoneError";
        const errorCategory = name === "NotAllowedError" || name === "SecurityError" ? "permission_or_policy"
          : name === "NotFoundError" || name === "OverconstrainedError" ? "input_unavailable"
            : name === "NotReadableError" || name === "AbortError" ? "capture_backend_unavailable"
              : "unknown_capture_error";
        recordMicrophoneDiagnostic(sessionId, "stream_acquisition_failed", {
          errorCategory,
          permissionState: finalPermissionState,
          errorKey,
          secureContext: window.isSecureContext,
        });
        fail(errorKey);
      }
    }
    beginMicrophoneDiagnosticSession(sessionId);
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
    void start();
    return stop;
  }, [attempt, sessionId]);

  const retry = useCallback(() => {
    recordMicrophoneDiagnostic(sessionId, "capture_recovery_attempted", { attempt: attempt + 1 });
    stopRef.current();
    setSessionId(crypto.randomUUID());
    setAttempt((current) => current + 1);
    setStatus("requesting");
    setError("");
    setInterrupted(false);
    setLevels(Array(BAR_COUNT).fill(0));
  }, [attempt, sessionId]);

  return { levels, status, error, stream: mediaStream, interrupted, sessionId, retry, stop: () => stopRef.current() };
}
