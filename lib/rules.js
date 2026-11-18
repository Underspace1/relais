/**
 * Règles du projet partagées par toutes les IA, comme les « Rules » de Cursor.
 * Sources lues : .cursor/rules/*.mdc, .cursorrules, AGENTS.md, CLAUDE.md, GEMINI.md.
 * Chaque outil lit déjà certains de ces fichiers lui-même ; Relais donne les autres à l'IA
 * pour que toutes suivent les mêmes règles.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX = 24000;
// Fichiers que chaque moteur lit déjà de lui-même
const NATIVE = {
  'claude-code': ['CLAUDE.md'],
  codex: ['AGENTS.md'],
  gemini: ['GEMINI.md'],
  grok: ['AGENTS.md'],
  cursor: ['.cursor/rules', '.cursorrules', 'AGENTS.md', 'CLAUDE.md'],
  builtin: [],
};

function read(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

/** Analyse l'en-tête d'un fichier .mdc (description, globs, alwaysApply). */
function parseMdc(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

/** Toutes les règles du projet : [{ source, title, when, text }]. */
export function projectRules(dir) {
  if (!dir) return [];
  const out = [];
  const rulesDir = path.join(dir, '.cursor', 'rules');
  try {
    for (const f of fs.readdirSync(rulesDir).filter((x) => /\.(mdc|md)$/i.test(x)).sort().slice(0, 40)) {
      const { meta, body } = parseMdc(read(path.join(rulesDir, f)));
      if (!body) continue;
      const when = /true/i.test(meta.alwaysApply || '') ? 'toujours' : meta.globs ? `pour les fichiers ${meta.globs}` : meta.description ? `quand c'est utile : ${meta.description}` : 'toujours';
      out.push({ source: '.cursor/rules', file: `.cursor/rules/${f}`, title: f.replace(/\.(mdc|md)$/i, ''), when, text: body });
    }
  } catch { /* pas de règles Cursor */ }
  for (const f of ['.cursorrules', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const text = read(path.join(dir, f));
    if (text) out.push({ source: f, file: f, title: f, when: 'toujours', text });
  }
  return out;
}

/** Texte des règles à donner à un moteur qui ne les lit pas lui-même (vide s'il n'y en a pas). */
export function rulesPrompt(dir, engine = 'builtin') {
  const native = NATIVE[engine] || [];
  const rules = projectRules(dir).filter((r) => !native.includes(r.source));
  if (!rules.length) return '';
  // Un même contenu dans plusieurs fichiers (CLAUDE.md copié en AGENTS.md…) n'est donné qu'une fois
  const seen = new Set();
  let text = '';
  for (const r of rules) {
    const key = r.text.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const block = `### ${r.file} (${r.when})\n${r.text}\n\n`;
    if (text.length + block.length > MAX) { text += `### ${r.file}\n(trop long : lis le fichier toi-même)\n\n`; continue; }
    text += block;
  }
  return `[Règles du projet — à suivre, quelle que soit l'IA]\n${text.trim()}`;
}
