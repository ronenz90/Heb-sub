import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function keyToPath(key) {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safe}.srt`);
}

export function getCached(key) {
  const p = keyToPath(key);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

export function setCached(key, content) {
  fs.writeFileSync(keyToPath(key), content, 'utf-8');
}

export function deleteCached(key) {
  const p = keyToPath(key);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
