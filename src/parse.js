import { readdir, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifySurface, projectLabel } from './surfaces.js';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

async function listSessionFiles() {
  const out = [];
  let dirs;
  try {
    dirs = await readdir(PROJECTS, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(PROJECTS, d.name);
    let files;
    try {
      files = await readdir(full);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) out.push({ dirName: d.name, file: path.join(full, f) });
    }
  }
  return out;
}

function tokensOf(u) {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}

function totalTokens(t) {
  return t.input + t.output + t.cacheCreate + t.cacheRead;
}

export function weightedCost(t) {
  return t.input + 5 * t.output + 1.25 * t.cacheCreate + 0.1 * t.cacheRead;
}

async function parseFileEvents({ dirName, file }, sinceMs, seen) {
  const fh = await open(file, 'r');
  let surface = null;
  let entrypoint = null;
  let sessionId = null;
  let title = null;
  let customTitle = null;
  let lastPrompt = null;
  const events = [];
  try {
    const stream = fh.createReadStream({ encoding: 'utf-8' });
    let buf = '';
    for await (const chunk of stream) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) handleLine(line);
      }
    }
    if (buf) handleLine(buf);
  } finally {
    await fh.close();
  }

  function handleLine(line) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (entrypoint == null && d.entrypoint) entrypoint = d.entrypoint;
    if (sessionId == null && d.sessionId) sessionId = d.sessionId;
    if (surface == null && (d.entrypoint || d.cwd)) surface = classifySurface(dirName, d.entrypoint);
    if (d.type === 'ai-title') title = d.aiTitle || title;
    if (d.type === 'custom-title') customTitle = d.customTitle || customTitle;
    if (d.type === 'last-prompt') lastPrompt = d.lastPrompt || lastPrompt;
    if (d.type !== 'assistant') return;
    const m = d.message;
    const u = m?.usage;
    if (!u) return;
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts) || ts < sinceMs) return;
    const key = `${m.id}:${d.requestId}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ ts, model: m.model, ...tokensOf(u) });
  }

  if (events.length === 0) return null;
  if (surface == null) surface = classifySurface(dirName, entrypoint);
  return {
    surface,
    dirName,
    project: projectLabel(dirName),
    sessionId: sessionId || path.basename(file, '.jsonl'),
    title: customTitle || title || (lastPrompt ? lastPrompt.slice(0, 80) : null),
    entrypoint,
    events,
  };
}

// One disk pass over the widest range; callers bucket narrower windows from this in-memory.
export async function collectRecords(sinceMs) {
  const files = await listSessionFiles();
  const candidates = [];
  for (const f of files) {
    try {
      const s = await stat(f.file);
      if (s.mtimeMs >= sinceMs) candidates.push(f);
    } catch {
      continue;
    }
  }
  const seen = new Set();
  const records = [];
  for (const f of candidates) {
    const r = await parseFileEvents(f, sinceMs, seen);
    if (r) records.push(r);
  }
  return records;
}

export function bucketSessions(records, sinceMs, untilMs = Infinity) {
  const sessions = [];
  for (const rec of records) {
    const agg = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    const models = new Set();
    const perModel = {};
    let firstTs = null;
    let lastTs = null;
    let count = 0;
    for (const e of rec.events) {
      if (e.ts < sinceMs || e.ts >= untilMs) continue;
      agg.input += e.input;
      agg.output += e.output;
      agg.cacheCreate += e.cacheCreate;
      agg.cacheRead += e.cacheRead;
      if (e.model && e.model !== '<synthetic>') {
        models.add(e.model);
        const pm = (perModel[e.model] ||= { total: 0, weighted: 0 });
        pm.total += totalTokens(e);
        pm.weighted += weightedCost(e);
      }
      firstTs = firstTs == null ? e.ts : Math.min(firstTs, e.ts);
      lastTs = lastTs == null ? e.ts : Math.max(lastTs, e.ts);
      count++;
    }
    if (count === 0) continue;
    sessions.push({
      surface: rec.surface,
      dirName: rec.dirName,
      project: rec.project,
      sessionId: rec.sessionId,
      title: rec.title,
      entrypoint: rec.entrypoint,
      models: [...models],
      perModel,
      firstTs,
      lastTs,
      tokens: agg,
      total: totalTokens(agg),
      weighted: weightedCost(agg),
      messages: count,
    });
  }

  const bySurface = {};
  const byModel = {};
  const byDay = {};
  let grand = 0;
  let grandWeighted = 0;
  for (const s of sessions) {
    grand += s.total;
    grandWeighted += s.weighted;
    const b = (bySurface[s.surface] ||= {
      surface: s.surface,
      total: 0,
      weighted: 0,
      sessions: 0,
      messages: 0,
    });
    b.total += s.total;
    b.weighted += s.weighted;
    b.sessions++;
    b.messages += s.messages;
    for (const [model, pm] of Object.entries(s.perModel)) {
      const mm = (byModel[model] ||= { model, total: 0, weighted: 0 });
      mm.total += pm.total;
      mm.weighted += pm.weighted;
    }
    const day = new Date(s.firstTs).toISOString().slice(0, 10);
    const dd = (byDay[day] ||= { day, total: 0, weighted: 0 });
    dd.total += s.total;
    dd.weighted += s.weighted;
  }
  for (const b of Object.values(bySurface)) {
    b.share = grand ? b.total / grand : 0;
    b.costShare = grandWeighted ? b.weighted / grandWeighted : 0;
  }
  for (const m of Object.values(byModel)) m.costShare = grandWeighted ? m.weighted / grandWeighted : 0;
  sessions.sort((a, b) => b.weighted - a.weighted);
  return {
    since: sinceMs,
    grandTotal: grand,
    grandWeighted,
    surfaces: Object.values(bySurface).sort((a, b) => b.weighted - a.weighted),
    models: Object.values(byModel).sort((a, b) => b.weighted - a.weighted),
    days: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    sessions,
  };
}

export async function aggregateSince(sinceMs, untilMs = Infinity) {
  const records = await collectRecords(sinceMs);
  return bucketSessions(records, sinceMs, untilMs);
}
