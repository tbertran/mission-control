import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchLiveUsage, readCachedUsage } from './usageApi.js';
import { collectRecords, bucketSessions } from './parse.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function windowStart(resetsAt, span, now) {
  const reset = Date.parse(resetsAt);
  return Number.isFinite(reset) ? reset - span : now - span;
}

const PACIFIC_TZ = 'America/Los_Angeles';

function pacificMidnightMs(now) {
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(now)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const guess = Date.UTC(+datePart.year, +datePart.month - 1, +datePart.day, 0, 0, 0);
  const wallPart = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(guess)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const hour = wallPart.hour === '24' ? 0 : +wallPart.hour;
  const asIfUTC = Date.UTC(+wallPart.year, +wallPart.month - 1, +wallPart.day, hour, +wallPart.minute, +wallPart.second);
  return 2 * guess - asIfUTC;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function pacificMondayMidnightMs(now) {
  const todayMid = pacificMidnightMs(now);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC_TZ, weekday: 'short' }).format(now);
  const daysSinceMonday = (WEEKDAY_INDEX[wd] + 6) % 7;
  return todayMid - daysSinceMonday * DAY;
}

function pacificMonthStartMs(now) {
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
  })
    .formatToParts(now)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const guess = Date.UTC(+datePart.year, +datePart.month - 1, 1, 0, 0, 0);
  const wallPart = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(guess)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const hour = wallPart.hour === '24' ? 0 : +wallPart.hour;
  const asIfUTC = Date.UTC(+wallPart.year, +wallPart.month - 1, +wallPart.day, hour, +wallPart.minute, +wallPart.second);
  return 2 * guess - asIfUTC;
}

function estimate(agg, authoritativePct) {
  for (const s of agg.surfaces) s.estPct = authoritativePct != null ? s.costShare * authoritativePct : null;
  for (const m of agg.models) m.estPct = authoritativePct != null ? m.costShare * authoritativePct : null;
  return agg;
}

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.state');
const BACKOFF_FILE = path.join(STATE_DIR, 'backoff.json');
const LAST_LIVE_FILE = path.join(STATE_DIR, 'last-live.json');
const BACKOFF_STEPS_MIN = [5, 10, 20, 30];
let liveBackoffUntil = 0;
let backoffStep = 0;
let backoffLoaded = false;

async function loadBackoff() {
  if (backoffLoaded) return;
  backoffLoaded = true;
  try {
    const j = JSON.parse(await readFile(BACKOFF_FILE, 'utf-8'));
    liveBackoffUntil = j.until || 0;
    backoffStep = j.step || 0;
  } catch {
    return;
  }
}

async function saveBackoff() {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(BACKOFF_FILE, JSON.stringify({ until: liveBackoffUntil, step: backoffStep }));
  } catch {
    return;
  }
}

async function saveLastLive(live) {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(LAST_LIVE_FILE, JSON.stringify(live));
  } catch {
    return;
  }
}

async function readLastLive() {
  try {
    return JSON.parse(await readFile(LAST_LIVE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function sourceLabel(u) {
  const when = u.fetchedAt ? new Date(u.fetchedAt).toLocaleString('en-CA', { hour12: false }).replace(',', '') : 'an unknown time';
  const src = u.source === 'last-live' ? 'last live values' : 'Claude Code cached values';
  return `${src} from ${when}`;
}

async function bestStale() {
  const lastLive = await readLastLive();
  let cache = null;
  try {
    cache = await readCachedUsage();
  } catch {
    cache = null;
  }
  const cands = [];
  if (lastLive) {
    lastLive.source = 'last-live';
    cands.push(lastLive);
  }
  if (cache) cands.push(cache);
  if (!cands.length) throw new Error('no usage source available');
  cands.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
  const best = cands[0];
  best.stale = true;
  return best;
}

async function getUsage() {
  await loadBackoff();
  if (Date.now() < liveBackoffUntil) {
    const u = await bestStale();
    const mins = Math.ceil((liveBackoffUntil - Date.now()) / 60000);
    u.degraded = `backing off live polling after auth/rate-limit error (~${mins}m) — showing ${sourceLabel(u)}`;
    return u;
  }
  try {
    const live = await fetchLiveUsage();
    if (backoffStep !== 0 || liveBackoffUntil !== 0) {
      backoffStep = 0;
      liveBackoffUntil = 0;
      await saveBackoff();
    }
    await saveLastLive(live);
    return live;
  } catch (e) {
    if (e.status === 429 || e.status === 401) {
      const mins = BACKOFF_STEPS_MIN[Math.min(backoffStep, BACKOFF_STEPS_MIN.length - 1)];
      backoffStep++;
      liveBackoffUntil = Date.now() + mins * 60 * 1000;
      await saveBackoff();
    }
    const u = await bestStale();
    u.degraded =
      e.status === 429
        ? `rate-limited (429) — showing ${sourceLabel(u)}`
        : e.status === 401
          ? `unauthorized (401) — showing ${sourceLabel(u)}`
          : `live fetch failed (${e.message}) — showing ${sourceLabel(u)}`;
    return u;
  }
}

export async function buildSnapshot() {
  const now = Date.now();
  const live = await getUsage();
  const sessStart = windowStart(live.session.resetsAt, 5 * HOUR, now);
  const weekStart = windowStart(live.weekly.resetsAt, 7 * DAY, now);
  const todayStart = pacificMidnightMs(now);
  const threeDayStart = now - 3 * DAY;
  const workWeekStart = pacificMondayMidnightMs(now);
  const workWeekEnd = workWeekStart + 5 * DAY;
  const weekendStart = workWeekEnd;
  const weekendEnd = workWeekStart + 7 * DAY;
  const monthStart = pacificMonthStartMs(now);

  const earliestStart = Math.min(sessStart, weekStart, todayStart, threeDayStart, workWeekStart, monthStart);
  const records = await collectRecords(earliestStart);
  const session = bucketSessions(records, sessStart);
  const weekly = bucketSessions(records, weekStart);
  const today = bucketSessions(records, todayStart);
  const threeDay = bucketSessions(records, threeDayStart);
  const workWeek = bucketSessions(records, workWeekStart, workWeekEnd);
  const weekend = bucketSessions(records, weekendStart, weekendEnd);
  const month = bucketSessions(records, monthStart);
  estimate(session, live.session.percent);
  estimate(weekly, live.weekly.percent);
  estimate(today, null);
  estimate(threeDay, null);
  estimate(workWeek, null);
  estimate(weekend, null);
  estimate(month, null);
  return {
    generatedAt: now,
    live,
    windows: {
      session: { start: sessStart, resetsAt: live.session.resetsAt, percent: live.session.percent, agg: session },
      today: { start: todayStart, agg: today },
      threeDay: { start: threeDayStart, agg: threeDay },
      workWeek: { start: workWeekStart, end: workWeekEnd, agg: workWeek },
      weekend: { start: weekendStart, end: weekendEnd, agg: weekend },
      weekly: { start: weekStart, resetsAt: live.weekly.resetsAt, percent: live.weekly.percent, agg: weekly },
      month: { start: monthStart, agg: month },
    },
  };
}
