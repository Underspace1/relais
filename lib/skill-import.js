/**
 * Import de skills au format Claude (dossier + SKILL.md) :
 * - depuis ton compte Claude (skills synchronisés par Claude Code + plugins de l'app Claude, dont Design)
 * - depuis un dépôt GitHub (catalogue Roblox prêt à l'emploi, ou n'importe quel dépôt)
 * Tout est copié dans relais/skills/packs/<pack>/ : Relais reste portable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { slugify } from './skills.js';

const PACKS = path.join(paths.skills, 'packs');

/* Skills Claude qui dépendent d'outils absents de Relais : importés mais désactivés au départ. */
const CLAUDE_OFF = new Set([
  'built-in-browser', 'chrome-browser', 'computer-use', 'morning', 'docs', 'google-workspace', 'import-memory',
  'consolidate-memory', 'explain-usage', 'setup-claude', 'setup-cowork', 'internal-comms', 'slack-gif-creator',
  'brand-guidelines', 'learn', 'deep-research',
]);

/** Catalogue GitHub proposé dans l'écran Skills. Contenu relu avant d'être ajouté au catalogue. */
export const CATALOG = [
  {
    id: 'gh-roblox-brain',
    repo: 'TabooHarmony/roblox-brain',
    name: 'Roblox Brain',
    short: 'rb',
    license: 'MIT',
    blurb: '28 skills Roblox courts et sourcés : Luau, types, réseau, données, sécurité, GUI, monétisation, publication…',
    include: ['skills/'],
  },
  {
    id: 'gh-gamedev-roblox',
    repo: 'gamedev-skills/awesome-gamedev-agent-skills',
    name: 'Awesome GameDev — Roblox',
    short: 'gd',
    license: 'Apache-2.0',
    blurb: 'Roblox (Luau, DataStores, réseau, UI, économie de simulateur, Studio) + game feel, level design, UI/UX de jeu.',
    include: [
      'skills/other-engines/roblox-',
      'skills/disciplines/game-feel', 'skills/disciplines/game-ui-ux', 'skills/disciplines/level-design', 'skills/disciplines/save-systems',
      'skills/workflows/prototype-fast', 'skills/workflows/game-docs',
    ],
  },
  {
    id: 'gh-roblox-game',
    repo: 'brockmartin/roblox-game-skill',
    name: 'Roblox Game (complet)',
    short: 'rg',
    license: 'Aucune licence indiquée — usage personnel',
    blurb: 'Un gros skill « routeur » : modèles de jeux (simulateur, tycoon, obby, RPG, horreur, BR), audits sécurité/perf, publication.',
    include: [''],
    skip: ['docs/', 'README.md'],
  },
];

/* ---------- Outils ---------- */
function copyDir(src, dst, skip = []) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') || skip.includes(e.name) || skip.includes(`${e.name}/`)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function skillDirs(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) out.push(dir);
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') skillDirs(path.join(dir, e.name), depth + 1, out);
  return out;
}

function skillName(dir) {
  const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const m = raw.match(/^\uFEFF?---\r?\n[\s\S]*?^name\s*:\s*["']?([^"'\r\n]+)/m);
  return slugify(m ? m[1] : path.basename(dir)) || slugify(path.basename(dir));
}

function writePack(id, info) {
  fs.mkdirSync(path.join(PACKS, id), { recursive: true });
  fs.writeFileSync(path.join(PACKS, id, 'pack.json'), JSON.stringify({ ...info, importedAt: new Date().toISOString() }, null, 2));
}

function resetPack(id) {
  const dir = path.join(PACKS, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ==========================================================================
   Depuis ton compte Claude
   ========================================================================== */
function claudeDataRoots() {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data');
  try { return fs.readdirSync(base).map((d) => path.join(base, d)); } catch { return []; }
}

/** Plugins installés dans l'app Claude (ex. « design ») : dossiers contenant .claude-plugin/plugin.json + skills/. */
function findPlugins() {
  const found = new Map();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.claude-plugin') && entries.some((e) => e.name === 'skills')) {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
        const mtime = fs.statSync(dir).mtimeMs;
        const prev = found.get(info.name);
        if (!prev || prev.mtime < mtime) found.set(info.name, { ...info, dir, mtime });
      } catch { /* plugin illisible */ }
      return;
    }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  for (const root of claudeDataRoots()) walk(path.join(root, 'rpm'), 0);
  return [...found.values()];
}

export function importClaudeSkills() {
  const report = [];

  // 1. Skills de ton compte (synchronisés par Claude Code dans son dossier portable)
  const synced = path.join(paths.accounts, 'claude', 'skills', 'synced');
  const byName = new Map();
  try {
    for (const group of fs.readdirSync(synced)) {
      for (const dir of skillDirs(path.join(synced, group))) {
        const name = path.basename(dir);
        const mtime = fs.statSync(path.join(dir, 'SKILL.md')).mtimeMs;
        if (!byName.has(name) || byName.get(name).mtime < mtime) byName.set(name, { dir, mtime });
      }
    }
  } catch { /* pas encore synchronisé */ }
  if (byName.size) {
    const dst = resetPack('claude-compte');
    for (const [name, { dir }] of byName) copyDir(dir, path.join(dst, name));
    writePack('claude-compte', {
      name: 'Mes skills Claude', source: 'claude', short: 'cl',
      note: 'Les skills de ton compte Claude, synchronisés par Claude Code. Ceux qui ont besoin d’outils absents de Relais (navigateur, Slack, Google…) sont désactivés au départ.',
      disabled: [...byName.keys()].filter((n) => CLAUDE_OFF.has(n)),
    });
    report.push({ pack: 'claude-compte', count: byName.size });
  }

  // 2. Plugins de l'app Claude (Design, etc.)
  for (const p of findPlugins()) {
    const id = `claude-${slugify(p.name)}`;
    const dst = resetPack(id);
    let n = 0;
    for (const dir of skillDirs(path.join(p.dir, 'skills'))) { copyDir(dir, path.join(dst, path.basename(dir))); n++; }
    for (const extra of ['CONNECTORS.md', 'README.md']) {
      try { fs.copyFileSync(path.join(p.dir, extra), path.join(dst, extra)); } catch { /* facultatif */ }
    }
    const title = p.name === 'design' ? 'Claude Design' : `Claude · ${p.name}`;
    writePack(id, { name: title, source: 'claude', short: slugify(p.name).slice(0, 4), note: p.description || '', version: p.version || '' });
    report.push({ pack: id, count: n });
  }

  if (!report.length) throw new Error('Aucun skill Claude trouvé. Connecte Claude dans Réglages → Connexions puis envoie-lui un message : Claude Code synchronise alors tes skills.');
  return report;
}

/* ==========================================================================
   Depuis GitHub
   ========================================================================== */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} a échoué (${code})`))));
  });
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/github\.com\/([\w.-]+\/[\w.-]+)/i);
  const repo = m ? m[1] : s;
  if (!REPO_RE.test(repo)) throw new Error('Indique un dépôt GitHub : « propriétaire/nom » ou son adresse.');
  return repo;
}

export async function importGithub({ repo, id, name, short, license, include = [''], skip = [], blurb = '' }) {
  repo = parseRepo(repo);
  const packId = id || `gh-${slugify(repo.replace('/', '-'))}`;
  const work = path.join(paths.tmp, `gh-${crypto.randomBytes(5).toString('hex')}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const res = await fetch(`https://codeload.github.com/${repo}/zip/HEAD`, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(res.status === 404 ? `Dépôt « ${repo} » introuvable (ou privé).` : `GitHub a répondu ${res.status}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 80 * 1024 * 1024) throw new Error('Dépôt trop gros (plus de 80 Mo).');
    const zip = path.join(work, 'repo.zip');
    fs.writeFileSync(zip, buf);
    const out = path.join(work, 'x');
    fs.mkdirSync(out);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await run(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', out]);
    const [top] = fs.readdirSync(out);
    const root = path.join(out, top);

    const rel = (d) => path.relative(root, d).replace(/\\/g, '/');
    const dirs = skillDirs(root).filter((d) => include.some((p) => (rel(d) + '/').startsWith(p) || (p === '' && rel(d) === '')));
    if (!dirs.length) throw new Error('Aucun SKILL.md trouvé dans ce dépôt.');

    const dst = resetPack(packId);
    const used = new Set();
    for (const d of dirs) {
      let n = skillName(d);
      while (used.has(n)) n = `${n}-2`;
      used.add(n);
      copyDir(d, path.join(dst, n), skip);
    }
    for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE']) {
      try { fs.copyFileSync(path.join(root, lic), path.join(dst, lic)); } catch { /* absent */ }
    }
    writePack(packId, { name: name || repo, source: 'github', url: `https://github.com/${repo}`, short: short || slugify(repo.split('/')[1]).slice(0, 4), license: license || '', note: blurb });
    return { pack: packId, count: dirs.length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function removePack(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '')) throw new Error('Pack invalide.');
  fs.rmSync(path.join(PACKS, id), { recursive: true, force: true });
  return true;
}
