import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listActiveSessions } from './sessions.js';
import { buildSnapshot } from './snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const STATE_FILE = path.join(__dirname, '..', '.state', 'snapshot.json');
const PORT = Number(process.env.PORT || 4174);

let sessionsCache = null;
let sessionsCacheAt = 0;
const SESSIONS_CACHE_MS = 1500;

async function getSessions() {
  const now = Date.now();
  if (sessionsCache && now - sessionsCacheAt < SESSIONS_CACHE_MS) return sessionsCache;
  sessionsCache = await listActiveSessions();
  sessionsCacheAt = now;
  return sessionsCache;
}

let usageCache = { at: 0, data: null, inflight: null };
const USAGE_CACHE_MS = 2 * 60 * 1000;

async function loadUsageDisk() {
  try {
    const j = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
    if (j?.at && j?.data) usageCache = { at: j.at, data: j.data, inflight: null };
  } catch {
    return;
  }
}

async function saveUsageDisk(data) {
  try {
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify({ at: Date.now(), data }));
  } catch {
    return;
  }
}

async function getUsageSnapshot() {
  const now = Date.now();
  if (usageCache.data && now - usageCache.at < USAGE_CACHE_MS) return usageCache.data;
  if (usageCache.inflight) return usageCache.inflight;
  usageCache.inflight = buildSnapshot()
    .then((d) => {
      usageCache = { at: Date.now(), data: d, inflight: null };
      if (d?.live?.source === 'live') saveUsageDisk(d);
      return d;
    })
    .catch((e) => {
      usageCache.inflight = null;
      if (usageCache.data) return usageCache.data;
      throw e;
    });
  return usageCache.inflight;
}

async function serveFile(res, file, contentType) {
  const body = await readFile(path.join(PUBLIC, file));
  res.writeHead(200, { 'content-type': contentType });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/sessions') {
      const sessions = await getSessions();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ now: Date.now(), sessions }));
      return;
    }
    if (url.pathname === '/api/usage') {
      const data = await getUsageSnapshot();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === '/panel' || url.pathname === '/') {
      await serveFile(res, 'panel.html', 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname === '/usage-panel') {
      await serveFile(res, 'usage-panel.html', 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname === '/usage') {
      await serveFile(res, 'usage.html', 'text/html; charset=utf-8');
      return;
    }
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      await serveFile(res, 'favicon.svg', 'image/svg+xml');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err?.stack || err));
  }
});

loadUsageDisk().finally(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`mission-control listening on http://127.0.0.1:${PORT}`);
  });
});
