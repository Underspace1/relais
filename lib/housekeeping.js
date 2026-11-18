/**
 * Ménage automatique : Relais ne doit ni grossir avec le temps, ni ralentir le PC.
 *
 * Au démarrage (puis toutes les 6 h) :
 *   - data/tmp et data/sandbox : vidés (fichiers temporaires)
 *   - pièces jointes jamais envoyées ou dont la conversation a été supprimée : effacées
 *   - historiques internes des outils officiels (sessions, journaux, caches) de plus de 30 jours : effacés
 *   - caches de téléchargement (npm, uv, pip) : vidés s'ils dépassent 300 Mo
 * Rien n'est effacé de ce qui t'appartient : conversations, images, designs, skills, réglages, connexions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;

function sizeOf(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch { return 0; }
}

function rm(p) {
  const s = sizeOf(p);
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); return s; } catch { return 0; }
}

/** Vide un dossier sans le supprimer (les fichiers verrouillés sont ignorés). */
function emptyDir(dir, olderThan = 0) {
  let freed = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  const limit = Date.now() - olderThan;
  for (const f of entries) {
    const p = path.join(dir, f);
    try { if (olderThan && fs.lstatSync(p).mtimeMs > limit) continue; } catch { continue; }
    freed += rm(p);
  }
  return freed;
}

/** Supprime, dans un dossier, les fichiers plus vieux que `age` (récursif), puis les dossiers vidés. */
function pruneOld(dir, age) {
  let freed = 0;
  const limit = Date.now() - age;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* en cours d'utilisation */ }
      } else {
        try { if (fs.lstatSync(p).mtimeMs < limit) { const s = fs.lstatSync(p).size; fs.rmSync(p, { force: true }); freed += s; } } catch { /* verrouillé */ }
      }
    }
  };
  walk(dir);
  return freed;
}

/** Pièces jointes encore utilisées par une conversation. */
function usedUploads() {
  const used = new Set();
  let files = [];
  try { files = fs.readdirSync(paths.convos).filter((f) => f.endsWith('.json')); } catch { return used; }
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(paths.convos, f), 'utf8');
      for (const m of text.matchAll(/\/uploads\/([a-f0-9]{16})\//g)) used.add(m[1]);
    } catch { /* fichier illisible */ }
  }
  return used;
}

// Sous-dossiers des outils officiels qui ne contiennent que de l'historique, des journaux ou du cache
// (jamais la connexion au compte ni les réglages). [dossier, ancienneté maximale]
const TOOL_JUNK = {
  claude: [['projects', 30], ['debug', 3], ['shell-snapshots', 3], ['todos', 30], ['statsig', 30], ['file-history', 30]],
  codex: [['sessions', 30], ['log', 7], ['generated_images', 1]],
  grok: [['logs', 7]],
  gemini: [['.gemini/tmp', 3]],
};

export function cleanup({ startup = false } = {}) {
  let freed = 0;
  // 1. Fichiers temporaires
  freed += emptyDir(paths.tmp, startup ? 0 : 3600 * 1000);
  freed += emptyDir(paths.sandbox, startup ? 0 : DAY);

  // 2. Pièces jointes orphelines (jamais envoyées, ou conversation supprimée), après 1 jour
  const used = usedUploads();
  try {
    for (const id of fs.readdirSync(paths.uploads)) {
      const p = path.join(paths.uploads, id);
      try { if (!used.has(id) && Date.now() - fs.statSync(p).mtimeMs > DAY) freed += rm(p); } catch { /* ignore */ }
    }
  } catch { /* pas encore de pièces jointes */ }

  // 3. Historiques internes des outils officiels (les sessions récentes restent reprenables)
  for (const [tool, subs] of Object.entries(TOOL_JUNK)) {
    for (const [sub, days] of subs) {
      const p = path.join(paths.accounts, tool, sub);
      if (fs.existsSync(p)) freed += pruneOld(p, days * DAY);
    }
  }

  // 4. Caches de téléchargement : vidés au-delà de 300 Mo, journaux npm toujours
  for (const c of ['.npm-cache', '.uv-cache', '.pip-cache']) {
    const p = path.join(paths.tools, c);
    if (fs.existsSync(path.join(p, '_logs'))) freed += rm(path.join(p, '_logs'));
    if (sizeOf(p) > 300 * MB) freed += rm(p);
  }
  return freed;
}

export function startHousekeeping() {
  const run = (startup) => {
    try {
      const freed = cleanup({ startup });
      if (freed > MB) console.log(`  Ménage : ${Math.round(freed / MB)} Mo libérés.`);
    } catch (e) { console.error('[ménage]', e.message); }
  };
  // Après le démarrage, pour ne pas le ralentir
  setTimeout(() => run(true), 3000).unref();
  setInterval(() => run(false), 6 * 3600 * 1000).unref();
}

/** Espace occupé par Relais, par catégorie (Réglages → Données). */
export function storageReport() {
  const p = (...x) => path.join(...x);
  const parts = [
    ['conversations', 'Conversations', paths.convos],
    ['images', 'Images générées', paths.images],
    ['uploads', 'Pièces jointes', paths.uploads],
    ['designs', 'Designs', p(paths.data, 'designs')],
    ['accounts', 'Connexions et historiques des outils', paths.accounts],
    ['tools', 'Outils officiels installés', paths.tools],
    ['webview', 'Fenêtre (préférences et cache)', p(paths.data, 'webview')],
    ['temp', 'Fichiers temporaires', [paths.tmp, paths.sandbox, p(paths.data, 'cache')]],
  ];
  const items = parts.map(([id, label, dirs]) => ({ id, label, bytes: [].concat(dirs).reduce((n, d) => n + sizeOf(d), 0) }));
  return { items, total: items.reduce((n, i) => n + i.bytes, 0), root: paths.root };
}
