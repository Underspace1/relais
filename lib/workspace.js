/**
 * Outils de l'espace de travail, comme dans Claude Code :
 *   - liste des fichiers du projet (pour les @mentions)
 *   - état Git, diff par fichier, commit
 *   - mémoire du projet (CLAUDE.md)
 *   - commandes « ! » lancées directement dans le dossier
 *   - serveurs MCP supplémentaires
 *   - pièces jointes (images, fichiers texte)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { validateProject } from './projects.js';

const IS_WIN = process.platform === 'win32';
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vs', 'bin', 'obj', 'relais-assets']);

/* ---------- Fichiers du projet ---------- */
const fileCache = new Map();

function walk(root, limit = 6000) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { out.push({ path: r, dir: true }); stack.push(r); } }
      else out.push({ path: r });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function projectFiles(dir, q = '') {
  const root = validateProject(dir);
  let c = fileCache.get(root);
  if (!c || Date.now() - c.at > 15000) { c = { at: Date.now(), list: walk(root) }; fileCache.set(root, c); }
  const query = String(q).toLowerCase().replace(/\\/g, '/');
  if (!query) return c.list.filter((f) => !f.path.includes('/')).slice(0, 40);
  const scored = [];
  for (const f of c.list) {
    const p = f.path.toLowerCase();
    const base = p.split('/').pop();
    let s = -1;
    if (base === query) s = 0;
    else if (base.startsWith(query)) s = 1;
    else if (p.startsWith(query)) s = 2;
    else if (base.includes(query)) s = 3;
    else if (p.includes(query)) s = 4;
    if (s >= 0) scored.push([s, p.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 40).map((x) => x[2]);
}

/** Lit les fichiers mentionnés avec @chemin, pour les donner en contexte. */
export function expandMentions(dir, text) {
  const root = validateProject(dir);
  const found = [];
  for (const m of String(text).matchAll(/(?:^|\s)@([\w./\\-]+[\w/])/g)) {
    const rel = m[1].replace(/\\/g, '/');
    if (/^(chatgpt|gpt|grok|gemini|perplexity|pplx|image|design|claude|cursor)$/i.test(rel)) continue;
    const full = path.resolve(root, rel);
    if (!full.startsWith(root)) continue;
    try {
      const st = fs.statSync(full);
      found.push({ path: rel, dir: st.isDirectory() });
    } catch { /* pas un fichier */ }
  }
  return found;
}

/* ---------- Commandes ---------- */
function run(cmd, args, { cwd, input, timeoutMs = 60000, signal, onData, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; onData?.(d); });
    child.stderr.on('data', (d) => { stderr += d; onData?.(d); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/** Commande « ! » tapée par l'utilisateur, exécutée dans le dossier du projet. */
export async function shellCommand(dir, command, { signal, onData } = {}) {
  const cwd = validateProject(dir);
  const [cmd, args] = IS_WIN
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]]
    : ['/bin/sh', ['-c', command]];
  const r = await run(cmd, args, { cwd, timeoutMs: 10 * 60 * 1000, signal, onData });
  return { code: r.code, output: `${r.stdout}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}` };
}

/* ---------- Git ---------- */
async function git(cwd, args, opts = {}) {
  try { return await run('git', args, { cwd, ...opts }); }
  catch (e) { throw new Error(e.code === 'ENOENT' ? 'Git n’est pas installé sur ce PC (git-scm.com).' : e.message); }
}

const STATUS = { M: 'modifié', A: 'ajouté', D: 'supprimé', R: 'renommé', C: 'copié', U: 'conflit', '?': 'nouveau' };

export async function gitStatus(dir) {
  const cwd = validateProject(dir);
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { repo: false };
  const [st, br, num] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all']),
    git(cwd, ['log', '-1', '--format=%h %s']),
    git(cwd, ['diff', '--numstat', 'HEAD']),
  ]);
  const counts = new Map();
  for (const l of num.stdout.split('\n')) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) counts.set(m[3], { add: Number(m[1]) || 0, del: Number(m[2]) || 0 });
  }
  const lines = st.stdout.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('##') ? lines.shift().slice(3) : '';
  const branch = head.split('...')[0].replace(/^No commits yet on /, '');
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(head.match(/behind (\d+)/)?.[1] || 0);
  const files = lines.slice(0, 400).map((l) => {
    const code = l.slice(0, 2);
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    p = p.replace(/^"|"$/g, '');
    const k = code.trim()[0] || '?';
    return { path: p, code, status: STATUS[k] || code.trim(), staged: code[0] !== ' ' && code[0] !== '?', ...(counts.get(p) || {}) };
  });
  return { repo: true, branch, ahead, behind, last: br.stdout.trim(), files };
}

export async function gitDiff(dir, file) {
  const cwd = validateProject(dir);
  const full = path.resolve(cwd, file);
  if (!full.startsWith(cwd)) throw new Error('Chemin hors du projet.');
  const r = await git(cwd, ['diff', 'HEAD', '--no-color', '--', file]);
  if (r.stdout.trim()) return { diff: r.stdout.slice(0, 400000) };
  // Fichier non suivi : on le montre en entier comme un ajout
  try {
    const text = fs.readFileSync(full, 'utf8').slice(0, 200000);
    return { diff: `--- /dev/null\n+++ b/${file}\n${text.split('\n').map((l) => `+${l}`).join('\n')}`, untracked: true };
  } catch { return { diff: '' }; }
}

export async function gitCommit(dir, message) {
  const cwd = validateProject(dir);
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Écris un message de commit.');
  const add = await git(cwd, ['add', '-A']);
  if (add.code !== 0) throw new Error(add.stderr.trim() || 'git add a échoué');
  const r = await git(cwd, ['commit', '-m', msg]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || 'git commit a échoué');
  return { ok: true, output: r.stdout.trim() };
}

/* ---------- Mémoire et règles du projet (CLAUDE.md, AGENTS.md, règles Cursor…) ---------- */
const MEMORY_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules'];
const RULE_RE = /^\.cursor\/rules\/[\w][\w .-]{0,60}\.mdc$/;
const okMemory = (name) => MEMORY_FILES.includes(name) || RULE_RE.test(name);

export function readMemory(dir, name = 'CLAUDE.md') {
  const root = validateProject(dir);
  if (!okMemory(name)) throw new Error('Fichier non pris en charge.');
  const file = path.join(root, name);
  return { name, path: file, exists: fs.existsSync(file), text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
}

export function writeMemory(dir, name, text) {
  const root = validateProject(dir);
  if (!okMemory(name)) throw new Error('Fichier non pris en charge.');
  const file = path.join(root, name);
  // Une règle vidée est supprimée
  if (RULE_RE.test(name) && !String(text ?? '').trim()) { fs.rmSync(file, { force: true }); return readMemory(dir, name); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text ?? ''));
  return readMemory(dir, name);
}

/* ---------- Serveurs MCP supplémentaires (donnés à Claude Code) ---------- */
export function readMcp() {
  try { return JSON.parse(fs.readFileSync(paths.mcpFile, 'utf8')); } catch { return { mcpServers: {} }; }
}

export function writeMcp(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw new Error(`JSON invalide : ${e.message}`); }
  if (!data || typeof data !== 'object' || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) throw new Error('Le fichier doit contenir un objet « mcpServers ».');
  if (data.mcpServers.relais) throw new Error('Le nom « relais » est réservé.');
  for (const [name, s] of Object.entries(data.mcpServers)) {
    if (!s || typeof s !== 'object' || !(s.command || s.url)) throw new Error(`Serveur « ${name} » : il faut « command » (local) ou « url » (distant).`);
  }
  fs.writeFileSync(paths.mcpFile, JSON.stringify(data, null, 2));
  return data;
}

/* ---------- Pièces jointes ---------- */
const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|lua|luau|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|css|scss|html|htm|xml|yml|yaml|toml|ini|cfg|csv|tsv|log|sh|ps1|bat|sql|rbxmx|rbxlx|vue|svelte|php|swift|dart|env\.example)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MAX_UPLOAD = 20 * 1024 * 1024;

export function saveUpload({ name, data }) {
  const clean = path.basename(String(name || 'fichier')).replace(/[^\w.\- ()À-ÿ]/g, '_').slice(0, 120) || 'fichier';
  const m = String(data || '').match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!m) throw new Error('Fichier illisible.');
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  if (buf.length > MAX_UPLOAD) throw new Error('Fichier trop lourd (20 Mo maximum).');
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(paths.uploads, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, clean);
  fs.writeFileSync(file, buf);
  const kind = IMAGE_EXT.test(clean) || /^image\//.test(m[1]) ? 'image' : TEXT_EXT.test(clean) || /^text\//.test(m[1]) ? 'text' : 'file';
  return { id, name: clean, path: file, url: `/uploads/${id}/${encodeURIComponent(clean)}`, kind, size: buf.length, mime: m[1] || '' };
}

export function getUpload(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id))) return null;
  const dir = path.join(paths.uploads, id);
  let name;
  try { [name] = fs.readdirSync(dir); } catch { return null; }
  if (!name) return null;
  const file = path.join(dir, name);
  const size = fs.statSync(file).size;
  const kind = IMAGE_EXT.test(name) ? 'image' : TEXT_EXT.test(name) ? 'text' : 'file';
  return { id, name, path: file, url: `/uploads/${id}/${encodeURIComponent(name)}`, kind, size };
}

/** Texte à ajouter au message pour que l'IA voie les pièces jointes. */
export function attachmentsPrompt(list, { inlineImages = false } = {}) {
  if (!list?.length) return '';
  const parts = list.map((a) => {
    if (a.kind === 'text' && a.size < 200000) {
      let body = '';
      try { body = fs.readFileSync(a.path, 'utf8'); } catch { /* supprimé */ }
      return `### Fichier joint : ${a.name}\n\`\`\`\n${body}\n\`\`\``;
    }
    if (a.kind === 'image') return inlineImages ? `[Image jointe : ${a.name}]` : `[Image jointe : ${a.name} — lis-la avec ton outil de lecture : ${a.path}]`;
    return `[Fichier joint : ${a.name} — chemin : ${a.path}]`;
  });
  return `\n\n---\nPièces jointes :\n\n${parts.join('\n\n')}`;
}

/* ---------- Explorateur et éditeur de code ---------- */
function inProject(dir, rel = '') {
  const root = validateProject(dir);
  const full = path.resolve(root, String(rel || '').replace(/\\/g, '/'));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Chemin hors du projet.');
  return { root, full, rel: path.relative(root, full).split(path.sep).join('/') };
}

/** Un niveau de l'arborescence (chargé à la demande quand on déplie un dossier). */
export function projectTree(dir, rel = '') {
  const { full, rel: r } = inProject(dir, rel);
  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { throw new Error('Dossier illisible.'); }
  return entries
    .filter((e) => e.name !== '.git' && !(e.isDirectory() && SKIP_DIRS.has(e.name) && e.name !== 'bin'))
    .map((e) => ({ name: e.name, path: r ? `${r}/${e.name}` : e.name, dir: e.isDirectory() }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
    .slice(0, 2000);
}

const MAX_EDIT = 2 * 1024 * 1024;

export function readProjectFile(dir, rel) {
  const { full, rel: r } = inProject(dir, rel);
  const st = fs.statSync(full);
  if (st.isDirectory()) throw new Error('C’est un dossier.');
  if (st.size > MAX_EDIT) return { path: r, tooBig: true, size: st.size };
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) return { path: r, binary: true, size: st.size };
  return { path: r, text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
}

export function writeProjectFile(dir, rel, text, { mtime } = {}) {
  const { full, rel: r } = inProject(dir, rel);
  if (!r) throw new Error('Nom de fichier manquant.');
  // Le fichier a changé sur le disque depuis l'ouverture (une IA l'a modifié) : on ne l'écrase pas en silence
  if (mtime && fs.existsSync(full) && Math.abs(fs.statSync(full).mtimeMs - Number(mtime)) > 1) {
    const e = new Error('Ce fichier a été modifié entre-temps (par une IA ?). Recharge-le avant d’enregistrer.');
    e.conflict = true;
    throw e;
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, String(text ?? ''));
  fileCache.delete(path.resolve(dir));
  return { path: r, size: fs.statSync(full).size, mtime: fs.statSync(full).mtimeMs };
}
