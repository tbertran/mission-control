import { execFile } from 'node:child_process';

const STATUS_TTL_MS = 4000;

const rootCache = new Map(); // cwd -> repo root ('' if cwd is not inside a repo)
const statusCache = new Map(); // repo root -> { files, at }

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function resolveRepoRoot(cwd) {
  if (!cwd) return '';
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  const out = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  const root = out ? out.trim() : '';
  rootCache.set(cwd, root);
  return root;
}

// Collapse the two-char XY porcelain code to the single most relevant letter for the badge.
function classify(xy) {
  if (xy === '??') return 'A';
  if (xy.includes('D')) return 'D';
  if (xy.includes('R')) return 'R';
  if (xy.includes('C')) return 'C';
  if (xy.includes('A')) return 'A';
  if (xy.includes('M')) return 'M';
  return xy.trim() || '?';
}

function parsePorcelain(out) {
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const file = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    files.push({ path: file, status: classify(xy) });
  }
  return files;
}

async function refreshStatus(root) {
  const out = await run('git', ['status', '--porcelain=v1', '-uall'], root);
  const files = out ? parsePorcelain(out) : [];
  statusCache.set(root, { files, at: Date.now() });
  return files;
}

export async function getGitFiles(cwd) {
  const root = await resolveRepoRoot(cwd);
  if (!root) return [];
  const hit = statusCache.get(root);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.files;
  if (hit) {
    refreshStatus(root).catch(() => {});
    return hit.files;
  }
  return refreshStatus(root);
}
