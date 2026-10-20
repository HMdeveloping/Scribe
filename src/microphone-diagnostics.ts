export type MicrophoneDiagnosticEvent = {
  sessionId: string;
  elapsedMs: number;
  event: string;
  details?: Record<string, string | number | boolean | null>;
};

const MAX_EVENTS = 120;
const events: MicrophoneDiagnosticEvent[] = [];
const sessionStarts = new Map<string, number>();

export function beginMicrophoneDiagnosticSession(sessionId: string) {
  while (sessionStarts.size >= 8) {
    const oldestSessionId = sessionStarts.keys().next().value;
    if (!oldestSessionId) break;
    sessionStarts.delete(oldestSessionId);
  }
  sessionStarts.set(sessionId, performance.now());
  recordMicrophoneDiagnostic(sessionId, "recording_session_created");
}

export function recordMicrophoneDiagnostic(
  sessionId: string,
  event: string,
  details?: Record<string, string | number | boolean | null>,
) {
  const startedAt = sessionStarts.get(sessionId) ?? performance.now();
  const diagnostic: MicrophoneDiagnosticEvent = {
    sessionId,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    event,
    ...(details ? { details } : {}),
  };
  events.push(diagnostic);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  console.info("[recording-lifecycle]", diagnostic);
}

export function getMicrophoneDiagnostics(sessionId: string) {
  const sessionEvents = events.filter((event) => event.sessionId === sessionId);
  return JSON.stringify({
    formatVersion: 1,
    sessionId,
    events: sessionEvents,
  }, null, 2);
}
