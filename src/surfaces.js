import os from 'node:os';
import { loadConfig } from './config.js';

const config = await loadConfig();
const SURFACE_NAMES = config.surfaceNames;
const USER_PREFIX = new RegExp(`^C--Users-${os.userInfo().username}-?`, 'i');

function namedSurface(dirName) {
  const d = (dirName || '').toLowerCase();
  for (const [substr, label] of Object.entries(SURFACE_NAMES)) {
    if (d.includes(substr.toLowerCase())) return label;
  }
  return null;
}

export function classifySurface(dirName, entrypoint) {
  const named = namedSurface(dirName);
  if (named) return named;
  if (entrypoint === 'claude-vscode') return 'VS Code';
  if (entrypoint === 'sdk-cli') return 'SDK / automation';
  if (entrypoint === 'cli') return 'CLI';
  return 'Other';
}

export function projectLabel(dirName) {
  if (!dirName) return 'unknown';
  const named = namedSurface(dirName);
  if (named) return `${named} workspace`;
  const m = dirName.replace(USER_PREFIX, '').replace(/^C--/i, '');
  return m.replace(/-/g, '/') || dirName;
}
