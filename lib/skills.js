import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

/**
 * Deux formes de skills :
 * 1. Les skills Relais : un fichier Markdown dans /skills avec un en-tête
 *    ---
 *    name: Nom lisible
 *    description: Quand l'utiliser (Claude lit cette ligne pour décider)
 *    ---
 * 2. Les packs importés (format Claude « SKILL.md ») : /skills/packs/<pack>/pack.json
 *    + un dossier par skill contenant SKILL.md et ses fichiers de référence.
 *
 * Chaque skill peut être activé ou désactivé (data/skills-state.json).
 * Un skill désactivé n'est plus proposé aux IA ni dans le menu /.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKS = path.join(paths.skills, 'packs');
const STATE = path.join(paths.data, 'skills-state.json');
const TEXT_EXT = new Set(['.md', '.txt', '.luau', '.lua', '.json', '.yaml', '.yml', '.toml', '.py', '.js', '.ts', '.html', '.css', '.csv', '.xml', '.sh', '.ps1']);

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/* ---------- En-tête YAML (sous-ensemble : clé: valeur, blocs > et |, guillemets) ---------- */
function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).replace(/\\"/g, '"');
  return t;
}

function parseFront(raw) {
  const m = raw.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (/^[>|][-+]?$/.test(val.trim())) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      meta[key] = val.trim().startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else meta[key] = unquote(val);
  }
  return { meta, body: m[2] };
}

/* ---------- État activé / désactivé ---------- */
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

/* ---------- Index de tous les skills ---------- */
function readPack(id) {
  const dir = path.join(PACKS, id);
  let info = {};
  try { info = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')); } catch { /* pack sans fiche */ }
  return { id, dir, name: info.name || id, source: info.source || 'github', url: info.url || '', license: info.license || '', short: info.short || id, off: new Set(info.disabled || []), note: info.note || '' };
}

function findSkillDirs(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) { out.push(dir); return out; }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) findSkillDirs(path.join(dir, e.name), depth + 1, out);
  return out;
}

let cache = null;
let cacheAt = 0;

function buildIndex() {
  if (cache && Date.now() - cacheAt < 3000) return cache;
  const state = readState();
  const map = new Map();
  const add = (s) => {
    let slug = s.slug;
    if (map.has(slug)) slug = slugify(`${slug}-${s.packShort || 'x'}`);
    let n = 2;
    while (map.has(slug)) slug = `${s.slug}-${n++}`;
    s.slug = slug;
    s.enabled = typeof state[slug] === 'boolean' ? state[slug] : s.defaultOn;
    map.set(slug, s);
  };

  for (const f of fs.readdirSync(paths.skills)) {
    if (!f.endsWith('.md')) continue;
    const file = path.join(paths.skills, f);
    const { meta } = parseFront(fs.readFileSync(file, 'utf8'));
    add({ slug: f.slice(0, -3), name: meta.name || f.slice(0, -3), description: meta.description || '', source: 'relais', pack: null, file, dir: null, defaultOn: true });
  }

  let packIds = [];
  try { packIds = fs.readdirSync(PACKS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* pas de packs */ }
  for (const id of packIds) {
    const pack = readPack(id);
    for (const dir of findSkillDirs(pack.dir)) {
      const file = path.join(dir, 'SKILL.md');
      const { meta } = parseFront(fs.readFileSync(file, 'utf8'));
      const folder = path.basename(dir);
      const desc = [meta.description, meta.when_to_use].filter(Boolean).join(' ');
      add({
        slug: slugify(folder) || slugify(meta.name || 'skill'),
        name: meta.name || folder,
        description: desc,
        source: pack.source,
        pack: pack.id,
        packName: pack.name,
        packShort: pack.short,
        url: pack.url,
        license: pack.license,
        file,
        dir,
        defaultOn: !pack.off.has(folder),
      });
    }
  }
  cache = map;
  cacheAt = Date.now();
  return map;
}

function invalidate() { cache = null; }

function summary(s) {
  return {
    slug: s.slug, name: s.name, description: s.description, enabled: s.enabled,
    source: s.source, pack: s.pack, packName: s.packName || null, url: s.url || null, license: s.license || null,
    readonly: !!s.pack,
  };
}

/** Liste des skills. Par défaut, seulement ceux qui sont activés. */
export function listSkills({ all = false } = {}) {
  return [...buildIndex().values()]
    .filter((s) => all || s.enabled)
    .map(summary)
    .sort((a, b) => (a.pack ? 1 : 0) - (b.pack ? 1 : 0) || a.name.localeCompare(b.name, 'fr'));
}

/** Les packs installés, pour l'écran Skills. */
export function listPacks() {
  const all = [...buildIndex().values()];
  let ids = [];
  try { ids = fs.readdirSync(PACKS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { /* aucun */ }
  return ids.map((id) => {
    const p = readPack(id);
    const skills = all.filter((s) => s.pack === id);
    return { id, name: p.name, source: p.source, url: p.url, license: p.license, note: p.note, total: skills.length, enabled: skills.filter((s) => s.enabled).length };
  });
}

function skillFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || out.length >= 200) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (r !== 'SKILL.md' && TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push({ path: r, size: fs.statSync(path.join(d, e.name)).size });
    }
  };
  try { walk(dir, ''); } catch { /* dossier illisible */ }
  return out;
}

export function getSkill(slugOrName, { withFiles = true } = {}) {
  if (!slugOrName) return null;
  const idx = buildIndex();
  const key = String(slugOrName).replace(/^\//, '');
  let s = idx.get(key) || idx.get(slugify(key));
  if (!s) s = [...idx.values()].find((k) => k.name.toLowerCase() === key.toLowerCase());
  if (!s) return null;
  const { meta, body } = parseFront(fs.readFileSync(s.file, 'utf8'));
  const out = { ...summary(s), name: s.name || meta.name, body: body.trim() };
  if (s.dir && withFiles) {
    out.files = skillFiles(s.dir);
    out.dir = s.dir;
  }
  return out;
}

/** Texte complet à donner à une IA : instructions + liste des fichiers de référence. */
export function skillPrompt(skill, { canRead = true } = {}) {
  if (!skill) return '';
  let s = skill.body;
  if (skill.files?.length) {
    const list = skill.files.slice(0, 80).map((f) => `- ${f.path} (${Math.max(1, Math.round(f.size / 1024))} Ko)`).join('\n');
    s += `\n\n---\nFichiers de référence de ce skill (dossier : ${skill.dir}). ${canRead
      ? `Charge seulement ceux dont tu as besoin avec l'outil read_skill_file (skill="${skill.slug}", path="…").`
      : 'Lis seulement ceux dont tu as besoin, directement depuis ce dossier.'}\n${list}`;
  }
  return s;
}

/** Lit un fichier de référence d'un skill importé (sans sortir de son dossier). */
export function readSkillFile(slug, rel) {
  const s = buildIndex().get(slug) || buildIndex().get(slugify(slug || ''));
  if (!s?.dir) throw new Error(`Skill « ${slug} » introuvable ou sans fichiers.`);
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const file = path.resolve(s.dir, clean);
  if (!file.startsWith(path.resolve(s.dir) + path.sep)) throw new Error('Chemin hors du skill.');
  if (!fs.existsSync(file)) throw new Error(`Fichier « ${clean} » introuvable dans le skill ${s.slug}.`);
  const text = fs.readFileSync(file, 'utf8');
  return text.length > 120000 ? `${text.slice(0, 120000)}\n\n[… fichier tronqué]` : text;
}

/** Active ou désactive un skill. */
export function setSkillEnabled(slug, enabled) {
  const s = buildIndex().get(slug);
  if (!s) throw new Error('Skill introuvable.');
  const state = readState();
  if (enabled === s.defaultOn) delete state[slug];
  else state[slug] = !!enabled;
  writeState(state);
  invalidate();
  return getSkill(slug, { withFiles: false });
}

/** Active ou désactive tous les skills d'un pack (ou tous les skills Relais avec pack = "relais"). */
export function setPackEnabled(packId, enabled) {
  const state = readState();
  let n = 0;
  for (const s of buildIndex().values()) {
    if ((packId === 'relais' && !s.pack) || s.pack === packId) {
      if (enabled === s.defaultOn) delete state[s.slug];
      else state[s.slug] = !!enabled;
      n++;
    }
  }
  writeState(state);
  invalidate();
  return n;
}

export function saveSkill({ slug, name, description, body }) {
  const existing = slug && buildIndex().get(slug);
  if (existing?.pack) throw new Error('Ce skill vient d’un pack importé : il est en lecture seule. Crée un nouveau skill pour le personnaliser.');
  const finalSlug = SLUG_RE.test(slug || '') ? slug : slugify(name);
  if (!SLUG_RE.test(finalSlug)) throw new Error('Nom de skill invalide.');
  const clash = buildIndex().get(finalSlug);
  if (!slug && clash) throw new Error(`Un skill « ${finalSlug} » existe déjà.`);
  const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const content = `---\nname: ${oneLine(name) || finalSlug}\ndescription: ${oneLine(description)}\n---\n\n${String(body || '').trim()}\n`;
  fs.writeFileSync(path.join(paths.skills, `${finalSlug}.md`), content);
  invalidate();
  return getSkill(finalSlug);
}

export function deleteSkill(slug) {
  const s = buildIndex().get(slug);
  if (!s) return false;
  try {
    if (s.pack) fs.rmSync(s.dir, { recursive: true, force: true });
    else fs.unlinkSync(s.file);
    const state = readState();
    delete state[slug];
    writeState(state);
    invalidate();
    return true;
  } catch {
    return false;
  }
}
