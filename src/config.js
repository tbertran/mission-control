import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'mission-control.config.json');

const DEFAULTS = {
  excludeCwdSubstrings: [],
  cloneOrder: [],
  surfaceNames: {},
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}
