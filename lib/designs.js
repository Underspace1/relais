/**
 * Designs : maquettes, prototypes, pages, slides… créés par Claude en HTML autonome
 * (à la manière de Claude Design). Rangés dans data/designs, affichés en aperçu isolé.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { slugify } from './skills.js';

const DIR = path.join(paths.data, 'designs');
const INDEX = path.join(DIR, 'index.json');
fs.mkdirSync(DIR, { recursive: true });

const ID_RE = /^[a-f0-9]{16}$/;

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return {}; }
}
function writeIndex(i) { fs.writeFileSync(INDEX, JSON.stringify(i, null, 2)); }

/** Enregistre (ou remplace, si id est fourni) une maquette. */
export function saveDesign({ id, title, html, kind = 'prototype', conversationId }) {
  const doc = String(html || '').trim();
  if (!doc) throw new Error('HTML vide.');
  if (doc.length > 3_000_000) throw new Error('Maquette trop grande (3 Mo max).');
  const index = readIndex();
  const finalId = id && ID_RE.test(id) && index[id] ? id : crypto.randomBytes(8).toString('hex');
  const full = /<html[\s>]/i.test(doc) ? doc : `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${String(title || 'Design').replace(/</g, '')}</title></head><body>\n${doc}\n</body></html>`;
  fs.writeFileSync(path.join(DIR, `${finalId}.html`), full);
  const prev = index[finalId];
  index[finalId] = {
    id: finalId,
    title: String(title || prev?.title || 'Design').slice(0, 100),
    kind,
    version: (prev?.version || 0) + 1,
    conversationId: conversationId || prev?.conversationId || null,
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  writeIndex(index);
  return { ...index[finalId], url: `/designs/${finalId}.html` };
}

export function listDesigns() {
  return Object.values(readIndex())
    .filter((d) => fs.existsSync(path.join(DIR, `${d.id}.html`)))
    .map((d) => ({ ...d, url: `/designs/${d.id}.html` }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readDesign(id) {
  if (!ID_RE.test(id)) return null;
  try { return fs.readFileSync(path.join(DIR, `${id}.html`), 'utf8'); } catch { return null; }
}

export function designInfo(id) {
  return readIndex()[id] || null;
}

export function deleteDesign(id) {
  if (!ID_RE.test(id)) return false;
  const index = readIndex();
  delete index[id];
  writeIndex(index);
  try { fs.unlinkSync(path.join(DIR, `${id}.html`)); } catch { /* déjà supprimé */ }
  return true;
}

/** Copie la maquette dans le projet (relais-designs/) pour que l'IA de code l'implémente. */
export function exportDesign(id, dir) {
  const html = readDesign(id);
  if (html == null) throw new Error('Design introuvable.');
  if (!dir || !fs.existsSync(dir)) throw new Error('Ouvre d’abord un projet.');
  const info = designInfo(id) || {};
  const out = path.join(dir, 'relais-designs');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${slugify(info.title || 'design') || 'design'}-${id.slice(0, 6)}.html`);
  fs.writeFileSync(file, html);
  return { file };
}
