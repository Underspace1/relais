/**
 * Connexion par compte, 100 % portable : les outils officiels sont installés
 * dans relais/tools et leurs connexions/réglages rangés dans relais/data/accounts.
 *  - Claude  → Claude Code  (compte Claude Pro/Max)
 *  - ChatGPT → Codex        (compte ChatGPT, images comprises)
 *  - Grok    → Grok Build   (compte SuperGrok / X Premium+)
 *  - Gemini  → Gemini CLI   (compte Google : gratuit, Google AI Pro / Ultra)
 * Rien n'est écrit dans ton dossier utilisateur.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { recordClaudeRateLimit, recordResult, recordTokens, syncCodex } from './usage.js';
import { standardServers, trustedServers, syncGeminiMcp, syncCodexMcp } from './mcp-client.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const NM = path.join(paths.tools, 'node_modules');

export const HOMES = {
  claude: path.join(paths.accounts, 'claude'),
  codex: path.join(paths.accounts, 'codex'),
  grok: path.join(paths.accounts, 'grok'),
  gemini: path.join(paths.accounts, 'gemini'),
};

export const PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  grok: '@xai-official/grok',
  gemini: '@google/gemini-cli',
};

/** Environnement isolé : tout reste dans le dossier Relais. */
function portableEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Une clé API présente ferait facturer à l'usage au lieu de l'abonnement.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS']) delete env[k];
  env.CLAUDE_CONFIG_DIR = HOMES.claude;
  env.CODEX_HOME = HOMES.codex;
  env.GROK_HOME = HOMES.grok;
  // Gemini CLI range tout dans <GEMINI_CLI_HOME>/.gemini et se connecte avec le compte Google.
  env.GEMINI_CLI_HOME = HOMES.gemini;
  env.GOOGLE_GENAI_USE_GCA = 'true';
  env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  delete env.NO_BROWSER;
  delete env.DEBIAN_FRONTEND; // sinon Gemini CLI n'ouvre pas le navigateur pour la connexion
  env.NO_COLOR = '1';
  env.MCP_TOOL_TIMEOUT = '600000'; // laisse le temps d'autoriser une action depuis l'interface
  const p = env.PATH ?? env.Path ?? '';
  delete env.Path;
  env.PATH = `${paths.node}${path.delimiter}${p}`;
  return env;
}

/* ---------- Trouver les exécutables (uniquement dans le dossier) ---------- */
function asCommand(file, { viaNode = false } = {}) {
  if (!file || !fs.existsSync(file)) return null;
  if (viaNode || file.endsWith('.js')) return { cmd: process.execPath, pre: [file], shell: false, file };
  if (/\.(cmd|bat)$/i.test(file)) return { cmd: file, pre: [], shell: true, file };
  return { cmd: file, pre: [], shell: false, file };
}

export function resolveCli(id, cfg = {}) {
  const override = { claude: cfg.CLAUDE_CLI, codex: cfg.CODEX_CLI, grok: cfg.GROK_CLI, gemini: cfg.GEMINI_CLI }[id];
  if (override) return asCommand(override);
  if (id === 'claude') return asCommand(path.join(NM, '@anthropic-ai', 'claude-code', 'bin', `claude${EXE}`));
  if (id === 'codex') return asCommand(path.join(NM, '@openai', 'codex', 'bin', 'codex.js'));
  if (id === 'gemini') return asCommand(path.join(NM, '@google', 'gemini-cli', 'bundle', 'gemini.js'));
  if (id === 'grok') {
    return asCommand(path.join(HOMES.grok, 'bin', `grok${EXE}`))
      || asCommand(path.join(NM, '@xai-official', 'grok', 'bin', 'grok'), { viaNode: true });
  }
  return null;
}

function shellSafe(a) {
  const s = String(a).replace(/["%^&|<>!`\r\n]/g, ' ');
  return /\s/.test(s) || s === '' ? `"${s}"` : s;
}

/** Lance un outil, envoie `input` sur stdin, renvoie { code, stdout, stderr }. */
export function runCli(c, args, { input, cwd, signal, onStdout, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const finalArgs = [...c.pre, ...args].map((a) => (c.shell ? shellSafe(a) : a));
    const child = spawn(c.cmd, finalArgs, { cwd: cwd || paths.sandbox, shell: c.shell, windowsHide: true, env: portableEnv() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; onStdout?.(d); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Impossible de lancer ${path.basename(c.file)} : ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

function version(id) {
  try { return JSON.parse(fs.readFileSync(path.join(NM, ...PACKAGES[id].split('/'), 'package.json'), 'utf8')).version; } catch { return ''; }
}

/* ---------- État des connexions (mis en cache) ---------- */
let cache = { at: 0, data: null };

async function claudeStatus(cfg) {
  const c = resolveCli('claude', cfg);
  if (!c) return { installed: false, connected: false };
  try {
    const r = await runCli(c, ['auth', 'status'], { timeoutMs: 20000 });
    let j = {};
    try { j = JSON.parse(r.stdout.trim()); } catch { /* sortie texte */ }
    const connected = j.loggedIn === true || (r.code === 0 && j.authMethod && j.authMethod !== 'none');
    return {
      installed: true, version: version('claude'), connected,
      account: j.email || j.account?.email || '',
      detail: j.authMethod === 'api_key' ? 'Connecté avec une clé API (facturé à l’usage).' : '',
    };
  } catch (e) {
    return { installed: true, version: version('claude'), connected: false, detail: e.message };
  }
}

async function codexStatus(cfg) {
  const c = resolveCli('codex', cfg);
  if (!c) return { installed: false, connected: false };
  try {
    const r = await runCli(c, ['login', 'status'], { timeoutMs: 20000 });
    const out = `${r.stdout}\n${r.stderr}`.trim();
    const connected = r.code === 0 && !/not logged in/i.test(out);
    return { installed: true, version: version('codex'), connected, account: connected ? out.split('\n')[0] : '' };
  } catch (e) {
    return { installed: true, version: version('codex'), connected: false, detail: e.message };
  }
}

function grokStatus(cfg) {
  const c = resolveCli('grok', cfg);
  if (!c) return { installed: false, connected: false };
  // Grok Build n'a pas de commande d'état : on regarde s'il a enregistré une connexion.
  let connected = false;
  try {
    connected = fs.readdirSync(HOMES.grok).some((f) => !/^(bin|docs|logs|config\.toml|leader\.sock|\..*)$/i.test(f));
  } catch { /* dossier absent */ }
  return { installed: true, version: version('grok'), connected };
}

/** Gemini CLI : la connexion Google est un fichier oauth_creds.json, le compte est dans google_accounts.json. */
const GEMINI_DIR = path.join(HOMES.gemini, '.gemini');
function geminiStatus(cfg) {
  const c = resolveCli('gemini', cfg);
  if (!c) return { installed: false, connected: false };
  const connected = fs.existsSync(path.join(GEMINI_DIR, 'oauth_creds.json'));
  let account = '';
  try { account = JSON.parse(fs.readFileSync(path.join(GEMINI_DIR, 'google_accounts.json'), 'utf8')).active || ''; } catch { /* inconnu */ }
  const major = Number(process.versions.node.split('.')[0]);
  return {
    installed: true, version: version('gemini'), connected, account: connected ? account : '',
    detail: major < 20 ? `Gemini CLI demande Node.js 20 ou plus récent (Relais tourne avec Node ${process.versions.node}) : mets à jour Node (ou le dossier node/).` : '',
  };
}

export async function connectorStatus(cfg, { force } = {}) {
  if (!force && cache.data && Date.now() - cache.at < 20000) return cache.data;
  const [claude, codex] = await Promise.all([claudeStatus(cfg), codexStatus(cfg)]);
  const data = { claude, codex, grok: grokStatus(cfg), gemini: geminiStatus(cfg) };
  for (const k of Object.keys(data)) data[k].installing = !!jobs[k]?.running;
  cache = { at: Date.now(), data };
  return data;
}
export function invalidateStatus() { cache = { ...cache, at: 0 }; }
/** Dernier état connu (synchrone), ou null si jamais vérifié. */
export function lastStatus() { return cache.data; }

/* ---------- Allègement : on ne garde qu'une copie de chaque moteur ---------- */
const MB = 1024 * 1024;
function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch { return 0; }
}
export function slim() {
  let freed = 0;
  const drop = (p) => { const s = sizeOf(p); if (!s) return; fs.rmSync(p, { recursive: true, force: true }); freed += s; };
  // Claude Code : bin/claude.exe est déjà le moteur complet, le paquet de plateforme est un doublon.
  const claudeExe = path.join(NM, '@anthropic-ai', 'claude-code', 'bin', `claude${EXE}`);
  if (sizeOf(claudeExe) > 50 * MB) {
    for (const d of fs.existsSync(path.join(NM, '@anthropic-ai')) ? fs.readdirSync(path.join(NM, '@anthropic-ai')) : []) {
      if (/^claude-code-(win32|linux|darwin)/.test(d)) drop(path.join(NM, '@anthropic-ai', d));
    }
  }
  // Grok : grok.exe suffit ; la copie versionnée et l'archive compressée sont des doublons.
  const grokBin = path.join(HOMES.grok, 'bin');
  if (sizeOf(path.join(grokBin, `grok${EXE}`)) > 50 * MB) {
    for (const f of fs.existsSync(grokBin) ? fs.readdirSync(grokBin) : []) if (/^grok-[\d.]+/.test(f)) drop(path.join(grokBin, f));
    for (const d of fs.existsSync(path.join(NM, '@xai-official')) ? fs.readdirSync(path.join(NM, '@xai-official')) : []) {
      if (/^grok-(win32|linux|darwin)/.test(d)) drop(path.join(NM, '@xai-official', d));
    }
  }
  drop(path.join(paths.tools, '.npm-cache'));
  return `Allègement : ${Math.round(freed / MB)} Mo libérés.`;
}

/* ---------- Installation / mise à jour (dans relais/tools) ---------- */
const jobs = {};
export function installJob(id) { return jobs[id] || null; }

function runJob(job, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: paths.tools, windowsHide: true, env: portableEnv() });
    const add = (d) => { job.log = (job.log + d).slice(-8000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => { add(`\n${e.message}`); resolve(1); });
    child.on('close', resolve);
  });
}

export function install(id) {
  if (!PACKAGES[id]) throw new Error('Outil inconnu');
  if (jobs[id]?.running) return jobs[id];
  const job = (jobs[id] = { running: true, log: '', ok: null, startedAt: Date.now() });
  if (!fs.existsSync(path.join(paths.tools, 'package.json'))) {
    fs.writeFileSync(path.join(paths.tools, 'package.json'), '{ "name": "relais-tools", "private": true }\n');
  }
  const npmCli = path.join(paths.node, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  (async () => {
    let code = await runJob(job, process.execPath, [npmCli, 'install', '--prefix', paths.tools, '--cache', path.join(paths.tools, '.npm-cache'), '--no-fund', '--no-audit', `${PACKAGES[id]}@latest`]);
    if (code === 0 && id === 'grok') {
      // Décompresse l'exécutable natif de Grok dans relais/data/accounts/grok/bin
      code = await runJob(job, process.execPath, [path.join(NM, '@xai-official', 'grok', 'bin', 'grok'), '--version']);
    }
    if (code === 0) job.log += `\n${slim()}`;
    job.running = false;
    job.ok = code === 0;
    invalidateStatus();
  })();
  return job;
}

/* ---------- Connexion intégrée à Relais (aucune fenêtre externe) ----------
 * Codex et Grok : « code appareil » → Relais affiche le lien et le code.
 * Claude : lien de connexion → la page claude.com donne un code à coller dans Relais.
 */
const logins = {};
// Gemini CLI n'a pas de commande « login » : une première question déclenche la connexion Google
// (page ouverte dans le navigateur, retour automatique vers Gemini CLI).
const LOGIN_ARGS = {
  claude: ['auth', 'login', '--claudeai'], codex: ['login', '--device-auth'], grok: ['login', '--device-auth'],
  gemini: ['-p', 'Réponds uniquement « OK ».', '--output-format', 'text', '--skip-trust'],
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

export function loginState(id) {
  const j = logins[id];
  if (!j) return null;
  return { running: j.running, ok: j.ok, url: j.url, code: j.code, needsCode: j.needsCode, browser: !!j.browser, error: j.error, startedAt: j.startedAt };
}

export function startLogin(id, cfg) {
  const c = resolveCli(id, cfg);
  if (!c) throw new Error('Installe d’abord l’outil.');
  if (logins[id]?.running) return loginState(id);
  const child = spawn(c.cmd, [...c.pre, ...LOGIN_ARGS[id]], { cwd: paths.sandbox, windowsHide: true, env: portableEnv() });
  const job = (logins[id] = { running: true, ok: null, url: null, code: null, needsCode: false, error: null, log: '', child, startedAt: Date.now() });
  const onData = (d) => {
    job.log = (job.log + stripAnsi(d)).slice(-8000);
    const urls = job.log.match(/https?:\/\/[^\s"'<>]+/g) || [];
    job.url = urls.find((u) => /authorize|device|oauth|login/i.test(u)) || urls[0] || job.url;
    const code = job.log.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/);
    if (code && id !== 'claude') job.code = code[1];
    if (id === 'claude' && /paste code/i.test(job.log)) job.needsCode = true;
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  // Gemini CLI demande d'abord : « Opening authentication page in your browser. Do you want to continue? [Y/n] ».
  // On répond oui puis on ferme l'entrée : sinon Gemini CLI ne quitte pas une fois connecté.
  if (id === 'gemini') { job.browser = true; child.stdin.end('y\n'); }
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
  child.on('error', (e) => { job.error = e.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    job.running = false;
    job.ok = code === 0 && !job.cancelled;
    if (id === 'gemini' && !job.cancelled && fs.existsSync(path.join(GEMINI_DIR, 'oauth_creds.json'))) job.ok = true;
    if (!job.ok && !job.cancelled && !job.error) {
      const tail = job.log.trim().split('\n').filter((l) => !/^\s+at |256-color/.test(l)).slice(-3).join(' ');
      job.error = /expired|expir/i.test(tail) ? 'Le code a expiré, recommence.' : (tail || 'Connexion interrompue.');
    }
    invalidateStatus();
  });
  return loginState(id);
}

export function submitLoginCode(id, code) {
  const j = logins[id];
  if (!j?.running) throw new Error('Aucune connexion en cours.');
  j.child.stdin.write(`${String(code).trim()}\n`);
  j.needsCode = false;
}

export function cancelLogin(id) {
  const j = logins[id];
  if (j?.running) { j.cancelled = true; j.child.kill(); }
}

export async function logout(id, cfg) {
  if (id === 'gemini') {
    // Pas de commande de déconnexion : on oublie la connexion Google enregistrée.
    for (const f of ['oauth_creds.json', 'google_accounts.json']) fs.rmSync(path.join(GEMINI_DIR, f), { force: true });
    invalidateStatus();
    return;
  }
  const c = resolveCli(id, cfg);
  if (!c) return;
  await runCli(c, { claude: ['auth', 'logout'], codex: ['logout'], grok: ['logout'] }[id], { timeoutMs: 20000 });
  invalidateStatus();
}

/* ==========================================================================
   Exécution par compte
   ========================================================================== */
const tmpFile = (prefix, ext) => path.join(paths.tmp, `${prefix}-${crypto.randomBytes(6).toString('hex')}.${ext}`);

/** Claude Code en mode non interactif, avec les outils Relais exposés via MCP. */
export async function claudeAccountTurn({ cfg, systemPrompt, prompt, mcpUrl, token, signal, onText, onToolStart, onToolEnd }) {
  const c = resolveCli('claude', cfg);
  if (!c) throw new Error('Claude Code n’est pas installé. Réglages → Connexions → Claude → Installer.');

  const sysFile = tmpFile('sys', 'md');
  const mcpFile = tmpFile('mcp', 'json');
  fs.writeFileSync(sysFile, systemPrompt);
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: {
      ...standardServers(),
      relais: {
        command: process.execPath,
        args: [path.join(paths.root, 'lib', 'mcp-bridge.js')],
        env: { RELAIS_URL: mcpUrl, RELAIS_TOKEN: token },
      },
    },
  }));

  const fileTools = [cfg.projectFiles && 'Read,Edit,Write,Glob,Grep', cfg.webSearch && 'WebSearch,WebFetch'].filter(Boolean).join(',');
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence',
    '--model', cfg.CLAUDE_ACCOUNT_MODEL || 'sonnet',
    cfg.projectFiles ? '--append-system-prompt-file' : '--system-prompt-file', sysFile,
    '--mcp-config', mcpFile, '--strict-mcp-config',
    '--tools', fileTools,
    // Serveurs MCP « de confiance » : sans confirmation. Les autres passent par la demande d'autorisation de Relais.
    '--allowedTools', [...['relais', ...trustedServers()].map((n) => `mcp__${n}`), fileTools].filter(Boolean).join(','),
    '--permission-prompt-tool', 'mcp__relais__permission_prompt',
    '--max-turns', String(cfg.maxSteps),
  ];
  if (cfg.projectFiles) args.push('--permission-mode', 'acceptEdits');

  let buf = '';
  let result = null;
  const pending = new Map();
  const handle = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') onText(e.delta.text);
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'tool_use' && !String(b.name).startsWith('mcp__relais__')) { pending.set(b.id, b); onToolStart?.(b); }
      }
    } else if (ev.type === 'user') {
      const content = ev.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
          const text = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content || '');
          onToolEnd?.(pending.get(b.tool_use_id), text, !!b.is_error);
          pending.delete(b.tool_use_id);
        }
      }
    } else if (ev.type === 'rate_limit_event') recordClaudeRateLimit(ev.rate_limit_info);
    else if (ev.type === 'system' && ev.model) initModel = ev.model;
    else if (ev.type === 'result') { result = ev; recordResult('claude', ev, initModel || cfg.CLAUDE_ACCOUNT_MODEL); }
  };
  let initModel = null;

  try {
    const r = await runCli(c, args, {
      input: prompt,
      cwd: cfg.projectFiles ? cfg.PROJECT_DIR : paths.sandbox,
      signal,
      onStdout: (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      },
    });
    if (buf.trim()) handle(buf.trim());
    if (signal?.aborted) throw new Error('Arrêté.');
    if (result?.is_error) throw new Error(friendly('Claude', result.result || result.subtype));
    if (r.code !== 0 && !result) throw new Error(friendly('Claude', r.stderr || r.stdout));
    return result;
  } finally {
    fs.rm(sysFile, () => {});
    fs.rm(mcpFile, () => {});
  }
}

function friendly(who, msg) {
  const m = String(msg || '').trim().slice(-600);
  const where = { Claude: 'Claude', ChatGPT: 'ChatGPT', Grok: 'Grok', Gemini: 'Gemini' }[who] || who;
  if (/not logged in|log ?in|not authenticated|unauthori[sz]ed|401|sign in/i.test(m)) return `${where} n’est pas connecté à ton compte. Réglages → Connexions → ${where} → Se connecter.`;
  if (/rate limit|usage limit|quota|credit|exceeded/i.test(m)) return `Limite de ton abonnement ${where} atteinte. ${m}`;
  return `${where} : ${m || 'erreur inconnue'}`;
}

/** Codex (compte ChatGPT) : réponse texte. */
export async function codexAsk({ cfg, prompt, signal }) {
  const c = resolveCli('codex', cfg);
  if (!c) throw new Error('Codex n’est pas installé. Réglages → Connexions → ChatGPT → Installer.');
  try { syncCodexMcp(HOMES.codex); } catch { /* MCP facultatifs */ }
  const out = tmpFile('codex', 'txt');
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', out];
  if (cfg.CODEX_MODEL) args.push('--model', cfg.CODEX_MODEL);
  args.push('-');
  try {
    const r = await runCli(c, args, { input: prompt, signal });
    try { syncCodex(); } catch { /* utilisation indisponible */ }
    let text = '';
    try { text = fs.readFileSync(out, 'utf8').trim(); } catch { /* pas de fichier */ }
    if (r.code !== 0 && !text) throw new Error(friendly('ChatGPT', r.stderr || r.stdout));
    return text || r.stdout.trim();
  } finally {
    fs.rm(out, () => {});
  }
}

function listImages(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(png|jpe?g|webp)$/i.test(e.name)) out.push(f);
    }
  };
  walk(dir);
  return out;
}

/** Codex (compte ChatGPT) : génération d'image avec l'outil intégré, sans clé API. */
export async function codexImage({ cfg, prompt, size, signal }) {
  const dir = path.join(HOMES.codex, 'generated_images');
  const before = new Set(listImages(dir));
  const start = Date.now() - 2000;
  const shape = size === '1536x1024' ? 'landscape (3:2)' : size === '1024x1536' ? 'portrait (2:3)' : 'square (1:1)';
  const instruction = `$imagegen Generate exactly one image with your built-in image generation tool. Do not write code, scripts or files yourself. Format: ${shape}.\n\nImage prompt:\n${prompt}`;
  const text = await codexAsk({ cfg, prompt: instruction, signal });
  const fresh = listImages(dir).filter((f) => !before.has(f) && fs.statSync(f).mtimeMs >= start);
  if (!fresh.length) throw new Error(`ChatGPT n’a pas renvoyé d’image.${text ? ` Sa réponse : ${text.slice(0, 300)}` : ''}`);
  fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return fresh[0];
}

/** Grok Build (compte SuperGrok) : réponse texte. */
export async function grokAsk({ cfg, prompt, signal, onText }) {
  const c = resolveCli('grok', cfg);
  if (!c) throw new Error('Grok Build n’est pas installé. Réglages → Connexions → Grok → Installer.');
  const file = tmpFile('grok', 'md');
  fs.writeFileSync(file, prompt);
  const args = ['--prompt-file', file, '--output-format', 'plain', '--permission-mode', 'dontAsk', '--no-subagents', '--max-turns', '4'];
  if (cfg.GROK_ACCOUNT_MODEL) args.push('--model', cfg.GROK_ACCOUNT_MODEL);
  try {
    const r = await runCli(c, args, { signal, onStdout: onText });
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(friendly('Grok', r.stderr));
    recordTokens('grok', cfg.GROK_ACCOUNT_MODEL || 'défaut', 0, 0); // Grok ne donne pas ses tokens en mode texte : on compte la requête
    return r.stdout.trim();
  } finally {
    fs.rm(file, () => {});
  }
}

/* ---------- Gemini CLI (compte Google) ---------- */

/** Arguments communs : question par l'entrée standard, réponse en flux JSON. */
export function geminiArgs(cfg, extra = []) {
  const args = ['-p', '', '--output-format', 'stream-json', '--skip-trust', ...extra];
  if (cfg.GEMINI_ACCOUNT_MODEL) args.push('--model', cfg.GEMINI_ACCOUNT_MODEL);
  return args;
}

/** Lit une ligne du flux JSON de Gemini CLI. Renvoie l'événement, ou null. */
export function geminiEvent(line) {
  try { const ev = JSON.parse(line); return ev && typeof ev === 'object' && ev.type ? ev : null; } catch { return null; }
}

/** Compte les tokens d'un événement `result` de Gemini CLI. */
export function recordGeminiResult(ev, fallbackModel) {
  const models = Object.entries(ev?.stats?.models || {});
  if (models.length) for (const [m, u] of models) recordTokens('gemini', m, u.input_tokens || 0, u.output_tokens || 0);
  else recordTokens('gemini', fallbackModel || 'auto', ev?.stats?.input_tokens || 0, ev?.stats?.output_tokens || 0);
}

/** Gemini CLI (compte Google) : réponse texte, sans outil de modification. */
export async function geminiAsk({ cfg, prompt, signal, onText }) {
  const c = resolveCli('gemini', cfg);
  if (!c) throw new Error('Gemini CLI n’est pas installé. Réglages → Connexions → Gemini → Installer.');
  try { syncGeminiMcp(HOMES.gemini); } catch { /* MCP facultatifs */ }
  let text = '';
  let failure = null;
  let buf = '';
  const handle = (line) => {
    const ev = geminiEvent(line);
    if (!ev) return;
    if (ev.type === 'message' && ev.role === 'assistant' && ev.content) { text += ev.content; onText?.(ev.content); }
    else if (ev.type === 'error' && ev.severity !== 'warning') failure = ev.message;
    else if (ev.type === 'result') {
      recordGeminiResult(ev, cfg.GEMINI_ACCOUNT_MODEL);
      if (ev.status === 'error') failure = ev.error?.message || failure || 'échec';
    }
  };
  const r = await runCli(c, geminiArgs(cfg, ['--approval-mode', 'default']), {
    input: prompt,
    signal,
    onStdout: (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    },
  });
  if (buf.trim()) handle(buf.trim());
  if (signal?.aborted) throw new Error('Arrêté.');
  if (!text.trim() && (failure || r.code !== 0)) throw new Error(friendly('Gemini', failure || geminiError(r.stderr)));
  return text.trim();
}

/** Garde la phrase utile d'une erreur de Gemini CLI (sans la pile d'appels). */
export function geminiError(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((l) => l && !/^at |256-color|^\{$|^\}$|exitCode/.test(l));
  if (lines.some((l) => /Manual authorization is required|non-interactive|oauth|Login required/i.test(l))) return 'not logged in';
  return lines.slice(-2).join(' ');
}
