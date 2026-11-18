import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  root: ROOT,
  public: path.join(ROOT, 'public'),
  skills: path.join(ROOT, 'skills'),
  tools: path.join(ROOT, 'tools'),
  node: path.join(ROOT, 'node'),
  data: path.join(ROOT, 'data'),
  images: path.join(ROOT, 'data', 'images'),
  convos: path.join(ROOT, 'data', 'conversations'),
  tmp: path.join(ROOT, 'data', 'tmp'),
  accounts: path.join(ROOT, 'data', 'accounts'),
  sandbox: path.join(ROOT, 'data', 'sandbox'),
  configFile: path.join(ROOT, 'data', 'config.json'),
};

for (const dir of [paths.data, paths.images, paths.convos, paths.skills, paths.tmp, paths.sandbox, paths.tools,
  path.join(paths.accounts, 'claude'), path.join(paths.accounts, 'codex'), path.join(paths.accounts, 'grok')]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Tous les réglages, avec leur valeur par défaut. */
export const DEFAULTS = {
  // Connexion : "account" (abonnement, via l'outil officiel) ou "api" (clé API)
  CLAUDE_AUTH: 'account',
  OPENAI_AUTH: 'account',
  XAI_AUTH: 'account',

  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  XAI_API_KEY: '',

  // Modèles
  CLAUDE_ACCOUNT_MODEL: 'sonnet',
  CLAUDE_MODEL: 'claude-sonnet-5-5',
  CODEX_MODEL: '',
  OPENAI_MODEL: 'gpt-5',
  OPENAI_IMAGE_MODEL: 'gpt-image-1',
  GROK_ACCOUNT_MODEL: '',
  GROK_MODEL: 'grok-4',
  GROK_IMAGE_MODEL: 'grok-2-image',

  // Chemins personnalisés des outils (vide = détection automatique)
  CLAUDE_CLI: '',
  CODEX_CLI: '',
  GROK_CLI: '',

  // Comportement de Claude
  MAX_STEPS: '16',
  RESPONSE_LANGUAGE: 'auto',
  CUSTOM_INSTRUCTIONS: '',

  // Projet (ex. ton jeu Roblox)
  PROJECT_DIR: '',
  CLAUDE_PROJECT_FILES: 'false',

  // Images
  IMAGE_ENGINE: 'chatgpt',
  IMAGE_SIZE: '1024x1024',
  IMAGE_EXPORT: 'false',

  // Cursor
  CURSOR_ENABLED: 'false',
  CURSOR_WORKSPACE: '',
  CURSOR_COMMAND: 'cursor-agent',
  CURSOR_ALLOW_WRITES: 'false',

  PORT: '4321',
};

export const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'];
const ALL_KEYS = Object.keys(DEFAULTS);

function readDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
  } catch {
    return {};
  }
}

const bool = (v) => String(v).toLowerCase() === 'true';

/** Priorité : réglages de l'app > variables d'environnement > .env > défauts */
export function getConfig() {
  const env = readDotEnv();
  const saved = readSaved();
  const cfg = {};
  for (const k of ALL_KEYS) {
    const pick = [saved[k], process.env[k], env[k]].find((v) => v !== undefined && v !== '');
    cfg[k] = pick ?? DEFAULTS[k];
  }
  // Une valeur volontairement vidée dans l'app doit rester vide
  for (const k of ['CUSTOM_INSTRUCTIONS', 'PROJECT_DIR', 'CODEX_MODEL', 'GROK_ACCOUNT_MODEL', 'CLAUDE_CLI', 'CODEX_CLI', 'GROK_CLI', 'CURSOR_WORKSPACE']) {
    if (saved[k] === '') cfg[k] = '';
  }
  cfg.cursorEnabled = bool(cfg.CURSOR_ENABLED);
  cfg.cursorWorkspace = cfg.CURSOR_WORKSPACE || cfg.PROJECT_DIR;
  cfg.projectFiles = bool(cfg.CLAUDE_PROJECT_FILES) && !!cfg.PROJECT_DIR;
  cfg.imageExport = bool(cfg.IMAGE_EXPORT) && !!cfg.PROJECT_DIR;
  cfg.maxSteps = Math.min(Math.max(Number(cfg.MAX_STEPS) || 16, 2), 40);
  return cfg;
}

export function saveConfig(patch) {
  const saved = readSaved();
  for (const k of ALL_KEYS) {
    if (!(k in patch)) continue;
    const v = typeof patch[k] === 'string' ? patch[k].trim() : String(patch[k]);
    // Un champ secret vide signifie « ne pas changer ». "__clear__" efface.
    if (SECRET_KEYS.includes(k) && v === '') continue;
    if (v === '__clear__') delete saved[k];
    else saved[k] = v;
  }
  fs.writeFileSync(paths.configFile, JSON.stringify(saved, null, 2));
}

export function mask(key) {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Réglages lisibles par l'interface (clés masquées). */
export function publicSettings() {
  const c = getConfig();
  const out = {};
  for (const k of ALL_KEYS) out[k] = SECRET_KEYS.includes(k) ? '' : c[k];
  out.keys = { anthropic: mask(c.ANTHROPIC_API_KEY), openai: mask(c.OPENAI_API_KEY), xai: mask(c.XAI_API_KEY) };
  return out;
}
