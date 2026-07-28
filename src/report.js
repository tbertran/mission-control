import { fetchLiveUsage } from './usageApi.js';
import { aggregateSince } from './parse.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function bar(frac, width = 24) {
  const filled = Math.round(frac * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function windowStart(resetsAt, span, now) {
  const reset = Date.parse(resetsAt);
  if (Number.isFinite(reset)) return reset - span;
  return now - span;
}

function timeLeft(resetsAt) {
  const ms = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const h = Math.floor(ms / HOUR);
  const m = Math.floor((ms % HOUR) / 60000);
  return `${h}h ${m}m`;
}

async function main() {
  const now = Date.now();
  const live = await fetchLiveUsage();

  console.log('\n  LIVE UTILIZATION (authoritative, from Anthropic)  ·  tier ' + live.tier);
  console.log('  ' + '─'.repeat(58));
  line('Session (5h)', live.session.percent, live.session.resetsAt);
  line('Weekly (7d)', live.weekly.percent, live.weekly.resetsAt);
  if (live.weeklyScoped)
    line(`Weekly (${live.weeklyScoped.model})`, live.weeklyScoped.percent, live.weeklyScoped.resetsAt);

  const sessStart = windowStart(live.session.resetsAt, 5 * HOUR, now);
  const weekStart = windowStart(live.weekly.resetsAt, 7 * DAY, now);

  await windowReport('SESSION WINDOW  (what is consuming your current 5h block)', sessStart, live.session.percent);
  await windowReport('WEEKLY WINDOW  (what is consuming your 7d allowance)', weekStart, live.weekly.percent);
  console.log('');

  function line(label, pct, resetsAt) {
    const f = (pct || 0) / 100;
    console.log(`  ${label.padEnd(18)} ${bar(f)} ${String(pct).padStart(3)}%   resets in ${timeLeft(resetsAt)}`);
  }
}

async function windowReport(title, sinceMs, authoritativePct) {
  const agg = await aggregateSince(sinceMs);
  console.log('\n  ' + title);
  console.log('  ' + '─'.repeat(58));
  if (agg.grandTotal === 0) {
    console.log('  (no activity in window)');
    return;
  }
  for (const s of agg.surfaces) {
    const estPct = authoritativePct != null ? (s.costShare * authoritativePct).toFixed(1) : '?';
    console.log(
      `  ${s.surface.padEnd(18)} ${bar(s.costShare, 18)} ${(s.costShare * 100).toFixed(0).padStart(3)}% cost  ` +
        `~${estPct}% of limit  ·  ${fmt(s.total).padStart(7)} tok vol  (${s.sessions} sess)`,
    );
  }
  console.log(`  ${'TOTAL'.padEnd(18)} ${' '.repeat(23)}                  ${fmt(agg.grandTotal).padStart(7)} tok vol`);
  const top = agg.sessions.slice(0, 6);
  console.log('\n  top sessions in window (by cost):');
  for (const s of top) {
    const when = new Date(s.firstTs).toLocaleString('en-CA', { hour12: false }).replace(',', '');
    console.log(
      `    ${when}  ${s.surface.padEnd(16)} ${fmt(s.total).padStart(7)} tok  ${s.project}`,
    );
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
