// Tracks which bellAt timestamp the user has already seen per session, so a repeat
// Stop event (a new bellAt) re-lights the indicator even if the prior one was acked.
const acked = new Map();

export function ackSession(sessionId, bellAt) {
  if (!sessionId) return;
  acked.set(sessionId, bellAt ?? Date.now());
}

export function needsBell(sessionId, bellAt) {
  if (!bellAt) return false;
  return acked.get(sessionId) !== bellAt;
}

export function pruneAcked(liveSessionIds) {
  for (const id of acked.keys()) {
    if (!liveSessionIds.has(id)) acked.delete(id);
  }
}
