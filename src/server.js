import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listActiveSessions } from './sessions.js';
import { ackSession } from './bellAck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = path.join(__dirname, '..', 'public', 'panel.html');
const PORT = Number(process.env.PORT || 4174);

let cache = null;
let cacheAt = 0;
const CACHE_MS = 1500;

async function getSessions() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  cache = await listActiveSessions();
  cacheAt = now;
  return cache;
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
    if (url.pathname === '/api/ack' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionId } = JSON.parse(body || '{}');
          const session = (await getSessions()).find((s) => s.sessionId === sessionId);
          ackSession(sessionId, session?.bellAt ?? null);
          res.writeHead(204);
          res.end();
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(String(err?.message || err));
        }
      });
      return;
    }
    if (url.pathname === '/panel' || url.pathname === '/') {
      const html = await readFile(PANEL_HTML, 'utf-8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err?.stack || err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mission-control listening on http://127.0.0.1:${PORT}`);
});
