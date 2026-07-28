import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

export async function readAccessToken() {
  const raw = await readFile(CREDS, 'utf-8');
  const o = JSON.parse(raw).claudeAiOauth;
  if (!o?.accessToken) throw new Error('no accessToken in credentials');
  return { token: o.accessToken, expiresAt: o.expiresAt, tier: o.rateLimitTier };
}

function pick(limit, legacy) {
  const percent = limit?.percent ?? legacy?.utilization ?? null;
  const resetsAt = limit?.resets_at ?? legacy?.resets_at ?? null;
  return { percent, resetsAt, severity: limit?.severity ?? 'normal' };
}

function mapUsage(data, tier, source, fetchedAt, stale) {
  const byKind = Object.fromEntries((data.limits || []).map((l) => [l.kind, l]));
  return {
    tier,
    source,
    stale: !!stale,
    fetchedAt,
    session: pick(byKind.session, data.five_hour),
    weekly: pick(byKind.weekly_all, data.seven_day),
    weeklyScoped: byKind.weekly_scoped
      ? { ...pick(byKind.weekly_scoped), model: byKind.weekly_scoped.scope?.model?.display_name }
      : null,
    weeklyOpus: data.seven_day_opus?.utilization ?? null,
    weeklySonnet: data.seven_day_sonnet?.utilization ?? null,
  };
}

export async function fetchLiveUsage() {
  const { token, tier } = await readAccessToken();
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-usage-widget/0.1',
    },
  });
  if (!res.ok) {
    const err = new Error(`usage endpoint HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return mapUsage(await res.json(), tier, 'live', Date.now(), false);
}

export async function readCachedUsage() {
  const raw = await readFile(CLAUDE_JSON, 'utf-8');
  const j = JSON.parse(raw);
  const c = j.cachedUsageUtilization;
  if (!c?.utilization) throw new Error('no cachedUsageUtilization in .claude.json');
  let tier = null;
  try {
    tier = (await readAccessToken()).tier;
  } catch {
    tier = null;
  }
  return mapUsage(c.utilization, tier, 'claude-cache', c.fetchedAtMs ?? null, true);
}
