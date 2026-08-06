import { readdir, stat, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getGitFiles } from './gitStatus.js';

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
const STATUS_DIR = path.join(os.homedir(), '.claude', 'status');
const config = await loadConfig();
const EXCLUDE_CWD_SUBSTRINGS = config.excludeCwdSubstrings;

const TAIL_BYTES = 65_536;
const OWNER_SCAN_MS = 15_000;
const LEGACY_HEARTBEAT_MS = 45_000;
const LEGACY_WORKING_STALE_MS = 5 * 60_000;
const ORPHAN_PRUNE_MS = 48 * 3600_000;

let ownerPids = null;
let ownerPidsAt = 0;
let ownerScanInFlight = false;

function scanOwnerPids() {
  if (ownerScanInFlight) return;
  ownerScanInFlight = true;
  execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object -ExpandProperty ProcessId"],
    { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    (err, stdout) => {
      ownerScanInFlight = false;
      if (err) return;
      const pids = String(stdout).split(/\r?\n/).map((l) => Number(l.trim())).filter(Number.isInteger);
      if (!pids.length) return;
      ownerPids = new Set(pids);
      ownerPidsAt = Date.now();
    }
  );
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// process.kill proves *a* process lives; the scanned set proves it is claude.exe and not a recycled pid.
function isOwnerAlive(pid) {
  if (!pidExists(pid)) return false;
  if (ownerPids && Date.now() - ownerPidsAt < OWNER_SCAN_MS * 4) return ownerPids.has(pid);
  return true;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

async function listJsonIds(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name.slice(0, -5));
  } catch {
    return [];
  }
}

async function loadState(sessionId) {
  return readJson(path.join(STATE_DIR, `${sessionId}.json`));
}

async function loadHeartbeat(sessionId) {
  const file = path.join(STATUS_DIR, `${sessionId}.json`);
  let st;
  try {
    st = await stat(file);
  } catch {
    return null;
  }
  const data = await readJson(file);
  if (!data) return null;
  return { data, ageMs: Date.now() - st.mtimeMs };
}

const tailCache = new Map();

async function loadTail(file) {
  if (!file) return { records: [], size: null };
  let st;
  try {
    st = await stat(file);
  } catch {
    return { records: [], size: null };
  }
  const hit = tailCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return { records: hit.records, size: st.size };

  let text = '';
  try {
    const { open } = await import('node:fs/promises');
    const handle = await open(file, 'r');
    try {
      const start = Math.max(0, st.size - TAIL_BYTES);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      text = buf.toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return { records: [], size: st.size };
  }

  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // truncated first line of the tail slice, or a torn trailing write
    }
  }
  tailCache.set(file, { mtimeMs: st.mtimeMs, records });
  if (tailCache.size > 64) tailCache.delete(tailCache.keys().next().value);
  return { records, size: st.size };
}

const sizeHistory = new Map();

function stableSizeSince(file, size, now) {
  const prev = sizeHistory.get(file);
  if (!prev || prev.size !== size) {
    sizeHistory.set(file, { size, since: now });
    if (sizeHistory.size > 128) sizeHistory.delete(sizeHistory.keys().next().value);
    return now;
  }
  return prev.since;
}

function basename(p) {
  if (!p) return null;
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;
}

function truncate(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const TOOL_LABELS = {
  Bash: (i) => `Running: ${truncate(i.command || i.description || '', 46)}`,
  PowerShell: (i) => `Running: ${truncate(i.command || i.description || '', 46)}`,
  Read: (i) => `Reading ${truncate(basename(i.file_path), 40)}`,
  Write: (i) => `Writing ${truncate(basename(i.file_path), 40)}`,
  Edit: (i) => `Editing ${truncate(basename(i.file_path), 40)}`,
  MultiEdit: (i) => `Editing ${truncate(basename(i.file_path), 40)}`,
  NotebookEdit: (i) => `Editing ${truncate(basename(i.notebook_path), 40)}`,
  Grep: (i) => `Searching for "${truncate(i.pattern, 28)}"`,
  Glob: () => 'Listing files',
  Task: (i) => `Delegating: ${truncate(i.description || i.subagent_type || '', 40)}`,
  Agent: (i) => `Delegating: ${truncate(i.description || i.subagent_type || '', 40)}`,
  Workflow: () => 'Running a workflow',
  WebFetch: (i) => `Fetching ${truncate(i.url, 40)}`,
  WebSearch: () => 'Searching the web',
  TodoWrite: () => 'Updating the task list',
  TaskCreate: () => 'Updating the task list',
  TaskUpdate: () => 'Updating the task list',
  AskUserQuestion: () => 'Needs your input',
  ExitPlanMode: () => 'Proposing a plan',
};

function lastToolLabel(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const block = [...r.message.content].reverse().find((c) => c.type === 'tool_use');
    if (!block) continue;
    const fn = TOOL_LABELS[block.name];
    if (!fn) return `Using ${block.name}`;
    try {
      return fn(block.input || {});
    } catch {
      return `Using ${block.name}`;
    }
  }
  return null;
}

function activityLabel(state, records, backgroundAgents) {
  const suffix = backgroundAgents > 0
    ? ` (${backgroundAgents} subagent${backgroundAgents === 1 ? '' : 's'} still running)`
    : '';
  if (state === 'needs-input') return 'Needs your input' + suffix;
  if (state === 'idle') {
    return backgroundAgents > 0
      ? `Idle — ${backgroundAgents} subagent${backgroundAgents === 1 ? '' : 's'} still running`
      : 'On station — waiting for input';
  }
  return (lastToolLabel(records) || 'Thinking…') + suffix;
}

// Background agents have no OS process and no state file of their own; this
// turn_duration field is the only on-disk signal they're still running.
function pendingBackgroundAgentCount(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === 'system' && r.subtype === 'turn_duration' && Number.isInteger(r.pendingBackgroundAgentCount)) {
      return r.pendingBackgroundAgentCount;
    }
  }
  return 0;
}

function latestField(records, field) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i][field]) return records[i][field];
  }
  return null;
}

function deriveTitle(records) {
  let aiTitle = null;
  let customTitle = null;
  let lastPrompt = null;
  for (const r of records) {
    if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
    if (r.type === 'custom-title' && r.customTitle) customTitle = r.customTitle;
    if (r.type === 'last-prompt' && r.lastPrompt) lastPrompt = r.lastPrompt;
  }
  return customTitle || aiTitle || (lastPrompt ? truncate(lastPrompt, 80) : null);
}

const LOCAL_COMMAND_TAGS = [
  '<command-name>', '<command-message>', '<command-args>',
  '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>',
];

function isRealUserPrompt(r) {
  if (r.type !== 'user' || r.isMeta) return false;
  const content = r.message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trimStart();
    if (LOCAL_COMMAND_TAGS.some((tag) => trimmed.startsWith(tag))) return false;
  }
  return true;
}

function isTurnEnd(r) {
  return r.type === 'system' && (r.subtype === 'turn_duration' || r.subtype === 'stop_hook_summary');
}

// Only for sessions predating the state hook, which have no state file to read.
function legacyState(records) {
  let promptAt = null;
  let endAt = null;
  for (const r of records) {
    const ts = Date.parse(r.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (isRealUserPrompt(r)) promptAt = ts;
    else if (isTurnEnd(r)) endAt = ts;
  }
  if (promptAt == null && endAt == null) return { state: 'idle', since: null };
  if (endAt != null && (promptAt == null || endAt >= promptAt)) return { state: 'idle', since: endAt };
  return { state: 'working', since: promptAt };
}

async function pruneOrphans(ids) {
  const now = Date.now();
  for (const { dir, id } of ids) {
    const file = path.join(dir, `${id}.json`);
    try {
      const st = await stat(file);
      if (now - st.mtimeMs > ORPHAN_PRUNE_MS) await unlink(file);
    } catch {
    }
  }
}

function excluded(cwd, transcriptPath) {
  const hay = `${cwd || ''}|${transcriptPath || ''}`.toLowerCase();
  return EXCLUDE_CWD_SUBSTRINGS.some((s) => hay.includes(s));
}

async function buildSession(sessionId) {
  const [state, heartbeat] = await Promise.all([loadState(sessionId), loadHeartbeat(sessionId)]);
  if (!state && !heartbeat) return null;

  const hb = heartbeat?.data;
  const cwd = hb?.workspace?.project_dir || hb?.cwd || state?.cwd || null;
  const transcriptPath = hb?.transcript_path || state?.transcriptPath || null;
  if (excluded(cwd, transcriptPath)) return null;

  let live;
  let stateName;
  let since;

  if (state && Number.isInteger(state.pid)) {
    live = isOwnerAlive(state.pid);
    stateName = state.state;
    since = state.at;
  } else if (state) {
    live = !!heartbeat && heartbeat.ageMs <= LEGACY_HEARTBEAT_MS;
    stateName = state.state;
    since = state.at;
  } else {
    live = heartbeat.ageMs <= LEGACY_HEARTBEAT_MS;
    stateName = null;
    since = null;
  }

  if (!live) return null;

  const { records, size } = await loadTail(transcriptPath);

  if (stateName == null) {
    const derived = legacyState(records);
    stateName = derived.state;
    since = derived.since;
    if (stateName === 'working' && size != null) {
      const stableSince = stableSizeSince(transcriptPath, size, Date.now());
      if (Date.now() - stableSince > LEGACY_WORKING_STALE_MS) {
        stateName = 'idle';
        since = stableSince;
      }
    }
  }

  const backgroundAgents = pendingBackgroundAgentCount(records);
  const gitFiles = await getGitFiles(cwd);

  return {
    sessionId,
    clone: basename(cwd) || 'unknown',
    cwd,
    gitFiles,
    gitBranch: latestField(records, 'gitBranch'),
    title: hb?.session_name || deriveTitle(records) || '(untitled session)',
    model: hb?.model?.display_name || null,
    effort: hb?.effort?.level || null,
    contextPct: hb?.context_window?.used_percentage ?? null,
    contextWindowSize: hb?.context_window?.context_window_size ?? null,
    rateLimit5h: hb?.rate_limits?.five_hour?.used_percentage ?? null,
    rateLimit7d: hb?.rate_limits?.seven_day?.used_percentage ?? null,
    costUsd: hb?.cost?.total_cost_usd ?? null,
    state: stateName === 'needs-input' ? 'working' : stateName,
    needsInput: stateName === 'needs-input',
    backgroundAgents,
    activity: activityLabel(stateName, records, backgroundAgents),
    activitySinceMs: since,
    live: true,
    tracked: !!(state && Number.isInteger(state.pid)),
    ownerPid: state?.pid ?? null,
  };
}

const EXPLICIT_CLONE_ORDER = config.cloneOrder;

function orderClones(sessions) {
  if (EXPLICIT_CLONE_ORDER.length) return EXPLICIT_CLONE_ORDER;
  const latest = new Map();
  for (const s of sessions) {
    const prev = latest.get(s.clone) ?? -Infinity;
    latest.set(s.clone, Math.max(prev, s.activitySinceMs || 0));
  }
  return [...latest.keys()].sort((a, b) => (latest.get(b) - latest.get(a)) || a.localeCompare(b));
}

export async function listActiveSessions() {
  if (Date.now() - ownerPidsAt > OWNER_SCAN_MS) scanOwnerPids();

  const [stateIds, statusIds] = await Promise.all([listJsonIds(STATE_DIR), listJsonIds(STATUS_DIR)]);
  const ids = [...new Set([...stateIds, ...statusIds])];

  const sessions = (await Promise.all(ids.map(buildSession))).filter(Boolean);

  const liveIds = new Set(sessions.map((s) => s.sessionId));
  pruneOrphans([
    ...stateIds.filter((id) => !liveIds.has(id)).map((id) => ({ dir: STATE_DIR, id })),
    ...statusIds.filter((id) => !liveIds.has(id)).map((id) => ({ dir: STATUS_DIR, id })),
  ]).catch(() => {});

  const order = orderClones(sessions);
  const rank = new Map(order.map((c, i) => [c, i]));
  sessions.sort((a, b) => {
    const ra = rank.get(a.clone) ?? order.length, rb = rank.get(b.clone) ?? order.length;
    if (ra !== rb) return ra - rb;
    return (b.activitySinceMs || 0) - (a.activitySinceMs || 0);
  });
  return sessions;
}
