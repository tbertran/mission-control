#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const STATUS_DIR = path.join(os.homedir(), '.claude', 'status');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function resolveOwnerPid() {
  let table;
  try {
    const raw = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    );
    table = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(table)) return null;

  const byPid = new Map();
  for (const p of table) byPid.set(p.ProcessId, p);

  let pid = process.ppid;
  for (let hop = 0; hop < 8; hop++) {
    const proc = byPid.get(pid);
    if (!proc) return null;
    if (String(proc.Name).toLowerCase() === 'claude.exe') return proc.ProcessId;
    pid = proc.ParentProcessId;
  }
  return null;
}

function statePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(sessionId, next) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = statePath(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file);
}

function removeSession(sessionId) {
  for (const f of [statePath(sessionId), path.join(STATUS_DIR, `${sessionId}.json`)]) {
    try {
      fs.unlinkSync(f);
    } catch {
    }
  }
}

// idle_prompt is excluded: it fires when the USER has gone quiet, not when Claude is blocked on them.
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

// PreToolUse fires once per tool call, far more often than the other four events this
// hook listens on. Writes for it are skipped below unless the state actually changes,
// so it only costs anything at the moment it earns its keep: the recovery transition.
const HIGH_FREQUENCY_EVENTS = new Set(['PreToolUse']);

function nextState(event, payload, prev) {
  switch (event) {
    case 'SessionStart':
      // compact restarts the session mid-turn; the turn is still running.
      return payload.source === 'compact' ? (prev?.state || 'working') : 'idle';
    case 'UserPromptSubmit':
      return 'working';
    case 'Stop':
      return 'idle';
    case 'Notification':
      if (BLOCKING_NOTIFICATIONS.has(payload.notification_type || payload.subtype)) return 'needs-input';
      return prev?.state === 'needs-input' ? 'working' : (prev?.state || 'idle');
    case 'PreToolUse':
      // A firing tool call proves active work regardless of prior state — a turn can
      // resume with more tool calls without a fresh UserPromptSubmit (e.g. a
      // continuation under a different inner session_id via an MCP tool).
      return 'working';
    default:
      return prev?.state || 'idle';
  }
}

function main() {
  const payload = JSON.parse(readStdin() || '{}');
  const sessionId = payload.session_id;
  if (!sessionId) return;

  const event = payload.hook_event_name || '';

  if (event === 'SessionEnd') {
    removeSession(sessionId);
    return;
  }

  const prev = readState(sessionId);
  const next = nextState(event, payload, prev);
  if (prev && next === prev.state && HIGH_FREQUENCY_EVENTS.has(event)) return;

  // On SessionStart, always re-resolve: a resumed/restarted process (crash + --continue)
  // gets a new OS pid, but a crash never fires SessionEnd, so `prev` survives with the
  // old, now-dead pid — trusting it here would pin liveness checks to a dead process
  // for the rest of the session.
  const pid = event === 'SessionStart' ? resolveOwnerPid() : (prev?.pid ?? resolveOwnerPid());

  writeState(sessionId, {
    sessionId,
    pid,
    cwd: payload.cwd || prev?.cwd || null,
    transcriptPath: payload.transcript_path || prev?.transcriptPath || null,
    state: next,
    event,
    at: Date.now(),
  });
}

try {
  main();
} catch {
  // A monitoring hook must never break the turn it observes.
}
process.exit(0);
