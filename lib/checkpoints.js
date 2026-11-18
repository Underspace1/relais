/**
 * Points de restauration, comme dans Cursor : avant chaque message dans un projet, Relais enregistre
 * l'état des fichiers dans un dépôt Git PRIVÉ (data/checkpoints/), sans toucher au .git du projet
 * (qui peut d'ailleurs ne pas exister). Après la réponse : liste des fichiers modifiés, diff,
 * garder / annuler un fichier, refuser un bloc précis, ou revenir au point d'avant ce message.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';

const ROOT = path.join(paths.data, 'checkpoints');
const EXCLUDES = ['.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', 'target/', '.gradle/', '.cache/', '*.log', 'Thumbs.db', '.DS_Store'];
const MAX_FILE = 5 * 1024 * 1024; // fichiers plus gros ignorés (assets lourds)

const gitDirOf = (dir) => path.join(ROOT, `${crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16)}.git`);

function run(args, { cwd, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Relais', GIT_AUTHOR_EMAIL: 'relais@localhost', GIT_COMMITTER_NAME: 'Relais', GIT_COMMITTER_EMAIL: 'relais@localhost', LC_ALL: 'C' };
    let child;
    try { child = spawn('git', args, { cwd, windowsHide: true, env }); } catch (e) { reject(e); return; }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('Git n’est pas installé : les points de restauration en ont besoin (git-scm.com).') : e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/** git avec le dépôt privé de Relais et le dossier du projet comme copie de travail. */
const g = (dir, args, opts = {}) => run(['--git-dir', gitDirOf(dir), '--work-tree', path.resolve(dir), '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=off', '-c', 'core.longpaths=true', ...args], { cwd: path.resolve(dir), ...opts });

async function ensure(dir) {
  const gd = gitDirOf(dir);
  if (!fs.existsSync(path.join(gd, 'HEAD'))) {
    fs.mkdirSync(ROOT, { recursive: true });
    const r = await run(['init', '--bare', '-q', gd]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git init a échoué');
  }
  fs.mkdirSync(path.join(gd, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'info', 'exclude'), `${EXCLUDES.join('\n')}\n`);
}

/** Ajoute tout l'état actuel du projet à l'index privé (les très gros fichiers sont ignorés). */
async function stageAll(dir) {
  const r = await g(dir, ['add', '-A', '--ignore-errors', '.']);
  if (r.code !== 0 && !/warning/i.test(r.stderr)) throw new Error(r.stderr.trim().split('\n').pop() || 'git add a échoué');
  // Retire les fichiers trop lourds de l'index
  const big = await g(dir, ['ls-files', '-s', '--debug']).catch(() => null);
  if (big?.stdout) {
    const heavy = [];
    let cur = null;
    for (const line of big.stdout.split('\n')) {
      const m = line.match(/^\d+ [0-9a-f]+ \d\t(.+)$/);
      if (m) cur = m[1];
      const sz = line.match(/^\s+size:\s+(\d+)/);
      if (sz && cur && Number(sz[1]) > MAX_FILE) heavy.push(cur);
    }
    if (heavy.length) await g(dir, ['rm', '--cached', '-q', '--', ...heavy.slice(0, 200)]);
  }
}

/** Crée un point de restauration. Renvoie { sha, at } ou null si Git manque ou si le projet est trop gros. */
export async function createCheckpoint(dir, label = 'Point de restauration') {
  try {
    await ensure(dir);
    await stageAll(dir);
    const head = await g(dir, ['rev-parse', '-q', '--verify', 'HEAD']);
    const tree = (await g(dir, ['write-tree'])).stdout.trim();
    if (!tree) return null;
    const args = ['commit-tree', tree, '-m', String(label).slice(0, 200)];
    if (head.code === 0) args.splice(2, 0, '-p', head.stdout.trim());
    const sha = (await g(dir, args)).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    await g(dir, ['update-ref', 'HEAD', sha]);
    return { sha, at: Date.now() };
  } catch { return null; }
}

const STATUS = { A: 'ajouté', M: 'modifié', D: 'supprimé', R: 'renommé', T: 'modifié' };

/** Fichiers modifiés depuis le point `sha` : [{ path, status, add, del }]. */
export async function changesSince(dir, sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('Point de restauration invalide.');
  await stageAll(dir);
  const [ns, num] = await Promise.all([g(dir, ['diff', '--cached', '--name-status', '--no-renames', sha]), g(dir, ['diff', '--cached', '--numstat', '--no-renames', sha])]);
  const counts = new Map();
  for (const l of num.stdout.split('\n')) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) counts.set(m[3], { add: Number(m[1]) || 0, del: Number(m[2]) || 0, binary: m[1] === '-' });
  }
  return ns.stdout.split('\n').filter(Boolean).slice(0, 300).map((l) => {
    const [code, ...rest] = l.split('\t');
    const p = rest.join('\t');
    return { path: p, status: STATUS[code[0]] || code, code: code[0], ...(counts.get(p) || { add: 0, del: 0 }) };
  });
}

/** Diff d'un fichier depuis le point `sha`, découpé en blocs. */
export async function fileDiff(dir, sha, file) {
  safePath(dir, file);
  await stageAll(dir);
  const r = await g(dir, ['diff', '--cached', '--no-color', '--no-renames', sha, '--', file]);
  const text = r.stdout;
  const i = text.indexOf('\n@@');
  const header = i >= 0 ? text.slice(0, i + 1) : text;
  const hunks = i >= 0 ? text.slice(i + 1).split(/\n(?=@@ )/).map((h) => (h.endsWith('\n') ? h : `${h}\n`)) : [];
  return { header, hunks, binary: /Binary files/.test(text) };
}

function safePath(dir, file) {
  const root = path.resolve(dir);
  const full = path.resolve(root, String(file || ''));
  if (!file || (!full.startsWith(root + path.sep) && full !== root)) throw new Error('Chemin hors du projet.');
  return full;
}

/** Annule les modifications d'un fichier : il revient tel qu'il était au point `sha`. */
export async function revertFile(dir, sha, file) {
  const full = safePath(dir, file);
  const existed = (await g(dir, ['cat-file', '-e', `${sha}:${file.replace(/\\/g, '/')}`])).code === 0;
  if (existed) {
    const r = await g(dir, ['checkout', sha, '--', file]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Restauration impossible.');
  } else {
    fs.rmSync(full, { force: true });
    await g(dir, ['rm', '--cached', '-q', '--ignore-unmatch', '--', file]);
  }
}

/** Refuse un seul bloc de modifications (les autres sont gardés). */
export async function revertHunk(dir, sha, file, index) {
  const { header, hunks } = await fileDiff(dir, sha, file);
  const h = hunks[Number(index)];
  if (!h) throw new Error('Bloc introuvable (le fichier a peut-être changé).');
  // Fichier créé ou supprimé en entier : on annule tout le fichier
  if (/^(new|deleted) file mode/m.test(header) || hunks.length === 1) return revertFile(dir, sha, file);
  const patch = path.join(paths.tmp, `hunk-${crypto.randomBytes(5).toString('hex')}.patch`);
  fs.writeFileSync(patch, header + h);
  try {
    const r = await g(dir, ['apply', '-R', '--whitespace=nowarn', '--recount', patch]);
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n').pop() || 'Ce bloc ne peut pas être annulé seul.');
  } finally { fs.rm(patch, () => {}); }
}

/** Revient entièrement au point `sha` (fichiers modifiés, ajoutés et supprimés depuis). */
export async function restoreCheckpoint(dir, sha) {
  const files = await changesSince(dir, sha);
  for (const f of files) await revertFile(dir, sha, f.path);
  return files.length;
}
