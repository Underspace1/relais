/**
 * Mémoire de Relais (comme la mémoire de l'app Claude) : quelques faits durables
 * sur l'utilisateur, relus à chaque conversation. Fichier Markdown modifiable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const FILE = path.join(paths.data, 'memory.md');
const MAX = 12000;

export function readMemory() {
  try { return fs.readFileSync(FILE, 'utf8'); } catch { return ''; }
}

export function writeMemory(text) {
  fs.writeFileSync(FILE, String(text ?? '').slice(0, MAX));
  return readMemory();
}

export function addMemory(fact) {
  const f = String(fact || '').replace(/\s+/g, ' ').trim();
  if (!f) throw new Error('Rien à retenir.');
  const cur = readMemory().trimEnd();
  if (cur.toLowerCase().includes(f.toLowerCase())) return cur;
  return writeMemory(`${cur ? `${cur}\n` : ''}- ${f}\n`);
}
