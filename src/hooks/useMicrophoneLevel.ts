import { useEffect, useRef, useState } from "react";
import type { TranslationKey } from "../i18n";

const BAR_COUNT = 40;
const ANALYSER_INTERVAL_MS = 1000 / 30;
const NOISE_GATE = 0.016;
const INPUT_GAIN = 1.9;
const COMPRESSION_EXPONENT = 0.62;
const VISUAL_HEADROOM = 0.9;
const ATTACK = 0.26;
const RELEASE = 0.13;
const NEIGHBOR_BLEND = 0.18;

export function useMicrophoneLevel(paused: boolean) {
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [status, setStatus] = useState<"requesting" | "active" | "error">("requesting");
  const [error, setError] = useState<TranslationKey | "">("");
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const pausedRef = useRef(paused);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    let disposed = false;
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

    function stop() {
      disposed = true;
      cancelAnimationFrame(analyserSetupFrame);
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      setMediaStream(null);
      source?.disconnect();
      analyser?.disconnect();
      if (context && context.state !== "closed") void context.close().catch(() => {});
    }
    stopRef.current = stop;

    function fail(messageKey: TranslationKey) {
      if (disposed) return;
      setError(messageKey);
      setStatus("error");
      setLevels(Array(BAR_COUNT).fill(0));
      stop();
    }

    async function start() {
      // Skip the discarded effect in React StrictMode before requesting hardware.
      await Promise.resolve();
      if (disposed) return;
      const requestedAt = performance.now();
      console.info("[recording-lifecycle] get_user_media_requested", {
        performanceNowMs: Math.round(requestedAt),
      });
      try {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
          if (import.meta.env.DEV) console.error("Scribe: microphone API unavailable", {
            mediaDevicesAvailable: Boolean(navigator.mediaDevices),
            getUserMediaType: typeof navigator.mediaDevices?.getUserMedia,
            origin: window.location.origin,
            isSecureContext: window.isSecureContext,
          });
          fail("microphoneUnavailableDetail");
          return;
        }
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
        const acquiredAt = performance.now();
        if (disposed) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        console.info("[recording-lifecycle] get_user_media_ready", {
          audioTracks: acquired.getAudioTracks().length,
          active: acquired.active,
          latencyMs: Math.round(acquiredAt - requestedAt),
          performanceNowMs: Math.round(acquiredAt),
        });
        stream = acquired;
        setMediaStream(acquired);
        stream.getAudioTracks().forEach((track) => {
          track.onended = () => fail("microphoneDisconnectedDetail");
        });
        setStatus("active");

        analyserSetupFrame = requestAnimationFrame(() => {
          if (disposed || !stream) return;
          void (async () => {
            const analyserRequestedAt = performance.now();
            context = new AudioContext();
            analyser = context.createAnalyser();
            analyser.fftSize = 512;
            source = context.createMediaStreamSource(stream!);
            source.connect(analyser);
            // Do not connect to the speakers: analysis must not produce feedback.
            await context.resume();
            if (disposed || !analyser) return;
            console.info("[recording-lifecycle] audio_context_ready", {
              state: context.state,
              latencyMs: Math.round(performance.now() - analyserRequestedAt),
              afterGetUserMediaMs: Math.round(performance.now() - acquiredAt),
              performanceNowMs: Math.round(performance.now()),
            });
            const samples = new Uint8Array(analyser.fftSize);
            function update(time: number) {
              if (disposed || !analyser) return;
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
            console.warn("Scribe: microphone visualization initialization failed", reason);
          });
        });
      } catch (reason) {
        if (import.meta.env.DEV) console.error("Scribe: microphone initialization failed", reason);
        const name = reason instanceof DOMException ? reason.name : "";
        fail(name === "NotAllowedError" || name === "SecurityError"
          ? "microphonePermissionDetail"
          : "microphoneError");
      }
    }
    void start();
    return stop;
  }, []);

  return { levels, status, error, stream: mediaStream, stop: () => stopRef.current() };
}
