/**
 * Cursor comme moteur de code : avec un seul abonnement Cursor, ChatGPT, Gemini, Grok (et Claude)
 * codent dans tes projets via l'agent en ligne de commande de Cursor (« cursor-agent »),
 * chacun avec son modèle. Claude reste le chef d'orchestre : il peut confier des sous-tâches
 * à « l'IA X via Cursor ».
 *
 * L'agent s'installe avec le script officiel de Cursor (cursor.com/install) et garde sa connexion
 * dans ton profil Windows, comme l'app Cursor : une connexion faite dans Cursor resservira ici.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './config.js';

const IS_WIN = process.platform === 'win32';
export const CURSOR_AGENTS = ['claude', 'chatgpt', 'gemini', 'grok'];
const FAMILY = { claude: /(sonnet|opus|claude|haiku)/i, chatgpt: /(gpt|o\d|codex)/i, gemini: /gemini/i, grok: /grok/i };
// Si la liste des modèles est indisponible : noms courants de cursor-agent (réglables dans Connexions → Cursor)
const FALLBACK = { claude: 'sonnet-4.5', chatgpt: 'gpt-5', gemini: 'gemini-2.5-pro', grok: 'grok' };
export const MODEL_KEY = { claude: 'CURSOR_MODEL_CLAUDE', chatgpt: 'CURSOR_MODEL_CHATGPT', gemini: 'CURSOR_MODEL_GEMINI', grok: 'CURSOR_MODEL_GROK' };

/* ---------- Trouver cursor-agent ---------- */
function onPath(names) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const n of names) { const f = path.join(d.replace(/"/g, ''), n); if (fs.existsSync(f)) return f; }
  return null;
}

function asCommand(file) {
  if (!file || !fs.existsSync(file)) return null;
  if (/\.(cmd|bat)$/i.test(file)) return { cmd: file, pre: [], shell: true, file };
  if (/\.ps1$/i.test(file)) return { cmd: 'powershell.exe', pre: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], shell: false, file };
  return { cmd: file, pre: [], shell: false, file };
}

/** L'exécutable de l'agent Cursor, ou null s'il n'est pas installé. */
export function resolveCursor(cfg = {}) {
  const custom = String(cfg.CURSOR_COMMAND || '').trim();
  if (custom && custom !== 'cursor-agent' && (custom.includes('/') || custom.includes('\\'))) return asCommand(custom);
  const names = IS_WIN ? ['cursor-agent.cmd', 'cursor-agent.exe', 'cursor-agent.ps1', 'agent.cmd'] : ['cursor-agent', 'agent'];
  const found = onPath(custom && custom !== 'cursor-agent' ? [custom, ...names] : names);
  if (found) return asCommand(found);
  const home = os.homedir();
  const guesses = IS_WIN
    ? [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'cursor-agent', 'cursor-agent.cmd'), path.join(home, '.local', 'bin', 'cursor-agent.cmd')]
    : [path.join(home, '.local', 'bin', 'cursor-agent'), '/usr/local/bin/cursor-agent'];
  for (const g of guesses) { const c = asCommand(g); if (c) return c; }
  return null;
}

/* ---------- Lancer l'agent ---------- */
function shellSafe(a) {
  const s = String(a).replace(/["%^&|<>!`\r\n]/g, ' ');
  return /\s/.test(s) || s === '' ? `"${s}"` : s;
}

function cursorEnv() {
  const env = { ...process.env, NO_COLOR: '1', CI: '1' };
  const p = env.PATH ?? env.Path ?? '';
  delete env.Path;
  env.PATH = `${paths.node}${path.delimiter}${p}`;
  return env;
}

export function runCursor(c, args, { input, cwd, signal, onStdout, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const finalArgs = [...c.pre, ...args].map((a) => (c.shell ? shellSafe(a) : a));
    const child = spawn(c.cmd, finalArgs, { cwd: cwd || paths.sandbox, shell: c.shell, windowsHide: true, env: cursorEnv() });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; onStdout?.(d); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Impossible de lancer l’agent Cursor : ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/** La consigne passe en argument : via un .cmd, Windows limite la ligne à ~8 000 caractères (on garde la fin, la plus récente). */
function fitArg(c, text) {
  const max = c.shell ? 7000 : 30000;
  const t = String(text);
  return t.length <= max ? t : `[…début de l’historique coupé…]\n${t.slice(-max + 40)}`;
}

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/* ---------- État de la connexion ---------- */
export async function cursorStatus(cfg) {
  const c = resolveCursor(cfg);
  if (!c) return { installed: false, connected: false };
  try {
    const r = await runCursor(c, ['status'], { timeoutMs: 20000 });
    const out = strip(`${r.stdout}\n${r.stderr}`).trim();
    const loggedOut = /not (logged|signed|authenticated)|log ?in required|please (log|sign) ?in/i.test(out);
    const connected = !loggedOut && (r.code === 0 || /logged in|signed in|authenticated/i.test(out));
    const account = (out.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || '';
    return { installed: true, connected, account, version: '', detail: connected ? '' : out.split('\n').slice(-1)[0].slice(0, 200) };
  } catch (e) { return { installed: true, connected: false, detail: e.message }; }
}

/* ---------- Modèles ---------- */
let modelCache = { at: 0, list: [] };
export async function cursorModels(cfg, { force = false } = {}) {
  if (!force && modelCache.list.length && Date.now() - modelCache.at < 30 * 60 * 1000) return modelCache.list;
  const c = resolveCursor(cfg);
  if (!c) return [];
  let r = await runCursor(c, ['models'], { timeoutMs: 30000 }).catch(() => null);
  if (!r || r.code !== 0) r = await runCursor(c, ['--list-models'], { timeoutMs: 30000 }).catch(() => null);
  const list = [];
  for (const line of strip(`${r?.stdout || ''}\n${r?.stderr || ''}`).split('\n')) {
    // « - gpt-5 », « gpt-5 - GPT-5 (default) », « * sonnet-4.5  Claude 4.5 Sonnet »
    const m = line.match(/^\s*(?:[-*•>]\s*)?([a-z0-9][a-z0-9.:_-]{1,60})(?:\s+[-–:]\s+|\s{2,}|\s*\(|\s*$)(.*)$/i);
    if (!m || /^(available|models?|usage|error|note|tip|current)$/i.test(m[1])) continue;
    if (!/\d|auto|grok|composer/i.test(m[1])) continue;
    list.push({ id: m[1], label: m[2].replace(/[()]/g, '').trim() || m[1], isDefault: /default|current|\(\*\)/i.test(line) });
  }
  if (list.length) modelCache = { at: Date.now(), list };
  return list;
}

/** Le modèle Cursor de chaque IA : choisi dans les réglages, sinon le plus récent de sa famille. */
export async function cursorModelFor(cfg, agent) {
  if (cfg[MODEL_KEY[agent]]) return cfg[MODEL_KEY[agent]];
  try {
    const list = await cursorModels(cfg);
    const all = list.filter((m) => FAMILY[agent].test(m.id));
    const best = all.filter((m) => !/thinking|mini|nano|fast/i.test(m.id));
    const pick = (best.length ? best : all).sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0];
    if (pick) return pick.id;
  } catch { /* liste indisponible */ }
  return FALLBACK[agent];
}

/** IA qui codent via Cursor dans les projets (réglage CURSOR_CODERS, ex. « chatgpt,gemini,grok »). */
export function cursorCoders(cfg) {
  return String(cfg.CURSOR_CODERS || '').split(',').map((s) => s.trim()).filter((s) => CURSOR_AGENTS.includes(s));
}

/* ==========================================================================
   Lecture du flux « stream-json » de l'agent Cursor
   Événements : system/init, user, assistant, tool_call (started / completed), result.
   ========================================================================== */
const short = (s, n = 60) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Décrit un appel d'outil Cursor ({ readToolCall: { args, result } }, { shellToolCall: … }…). */
export function describeCursorTool(toolCall = {}) {
  const key = Object.keys(toolCall).find((k) => /ToolCall$/i.test(k)) || Object.keys(toolCall)[0] || 'tool';
  const body = toolCall[key] || {};
  const a = body.args || body.arguments || {};
  const kind = key.replace(/ToolCall$/i, '').toLowerCase();
  const file = a.path || a.filePath || a.file_path || a.target_file || a.targetFile || '';
  const base = file ? path.basename(String(file)) : '';
  const map = {
    read: ['Lit', base, 'read'], write: ['Crée', base, 'edit'], edit: ['Modifie', base, 'edit'], strreplace: ['Modifie', base, 'edit'],
    delete: ['Supprime', base, 'edit'], shell: ['Commande', a.command || a.cmd, 'command'], terminal: ['Commande', a.command, 'command'],
    grep: ['Cherche dans le code', a.pattern || a.query, 'read'], glob: ['Cherche des fichiers', a.globPattern || a.pattern, 'read'],
    ls: ['Liste', file || a.directory || '.', 'read'], list: ['Liste', file || '.', 'read'], codebasesearch: ['Cherche dans le code', a.query, 'read'],
    websearch: ['Recherche web', a.query || a.searchTerm, 'read'], fetch: ['Lit une page web', a.url, 'read'],
    updatetodos: ['Liste de tâches', '', 'todos'], todo: ['Liste de tâches', '', 'todos'], mcp: ['Outil MCP', a.name || a.toolName, 'read'],
  };
  const [verb, target, k] = map[kind] || [kind || 'Outil', base, 'read'];
  let diff = null;
  if (a.fileText !== undefined || a.contents !== undefined) diff = { path: file, old: '', new: String(a.fileText ?? a.contents).slice(0, 6000) };
  else if (a.oldString !== undefined || a.old_string !== undefined) diff = { path: file, old: String(a.oldString ?? a.old_string ?? ''), new: String(a.newString ?? a.new_string ?? '') };
  const res = body.result || {};
  const ok = res.success !== undefined ? res.success : res;
  const failed = !!(res.error || res.failure || res.rejected);
  const output = typeof ok === 'string' ? ok : ok && (ok.stdout || ok.output || ok.content || ok.message) ? String(ok.stdout || ok.output || ok.content || ok.message) : '';
  return {
    title: target ? `${verb} · ${short(target)}` : verb, kind: k, diff,
    detail: a.command || file || a.pattern || a.query || a.url || '',
    todos: Array.isArray(a.todos) ? a.todos : null,
    output: failed ? String(res.error?.message || res.error || res.failure?.message || 'échec') : output, failed,
  };
}

/** Lecteur ligne par ligne qui alimente le fil de Relais. */
export function cursorStreamParser({ agent, turn, onSession, onResult }) {
  let gotText = false;
  let lastText = '';
  return (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id || ev.chatId || ev.chat_id) onSession?.(ev.session_id || ev.chatId || ev.chat_id);
    if (ev.type === 'system') { if (ev.model) turn.meta?.({ model: `${ev.model} (Cursor)` }); return; }
    if (ev.type === 'assistant') {
      const content = ev.message?.content;
      const text = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('') : typeof content === 'string' ? content : ev.text || '';
      if (text && text !== lastText) { turn.text(`${gotText && !/^\s/.test(text) && !ev.delta ? '\n\n' : ''}${text}`); gotText = true; lastText = text; }
      return;
    }
    if (ev.type === 'tool_call') {
      const id = ev.call_id || ev.callId || ev.id || `c-${Date.now()}`;
      const d = describeCursorTool(ev.tool_call || ev.toolCall || {});
      if (d.todos) {
        turn.todos?.(d.todos.map((t) => ({ text: t.content || t.text || t.description || '', status: String(t.status || 'pending').toLowerCase().replace('todo_status_', '').replace('in_progress', 'in_progress') })), agent);
        return;
      }
      const done = ev.subtype === 'completed' || ev.subtype === 'finished';
      // L'événement de fin ne répète pas toujours les arguments : on ne remplace que ce qui est connu.
      turn.step({
        id, agent, title: d.title, kind: d.kind, status: !done ? 'running' : d.failed ? 'error' : 'done',
        ...(d.detail ? { input: d.detail } : {}), ...(d.diff ? { diff: d.diff } : {}), ...(done && d.output ? { output: String(d.output).slice(0, 4000) } : {}),
      });
      return;
    }
    if (ev.type === 'result') {
      if (!gotText && ev.result) turn.text(String(ev.result));
      const u = ev.usage || {};
      turn.meta?.({ ms: ev.duration_ms, tokensIn: u.input_tokens || u.inputTokens || 0, tokensOut: u.output_tokens || u.outputTokens || 0 });
      onResult?.(ev);
    }
  };
}

function lineReader(handle) {
  let buf = '';
  const feed = (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(l); }
  };
  feed.flush = () => { if (buf.trim()) handle(buf.trim()); buf = ''; };
  return feed;
}

function friendly(msg) {
  const m = strip(msg).trim().slice(-700);
  if (/not (logged|signed|authenticated)|log ?in|unauthori[sz]ed|401/i.test(m)) return 'L’agent Cursor n’est pas connecté à ton compte. Réglages → Connexions → Cursor → Se connecter.';
  if (/rate limit|usage limit|quota|exceeded|upgrade/i.test(m)) return `Limite de ton abonnement Cursor atteinte. ${m}`;
  if (/model/i.test(m) && /(not found|invalid|unknown|unavailable)/i.test(m)) return `Ce modèle n’existe pas dans Cursor : choisis-en un autre dans Réglages → Connexions → Cursor. (${m})`;
  return `Cursor : ${m || 'erreur inconnue'}`;
}

/**
 * Fait coder une IA dans le projet via l'agent Cursor.
 * Autorisations : « full » et « auto » autorisent les commandes (--force) ; « read » et « plan » demandent
 * de ne rien modifier (et les points de restauration de Relais permettent de tout annuler).
 */
export async function cursorCode({ cfg, agent, dir, perm, prompt, session, turn, signal }) {
  const c = resolveCursor(cfg);
  if (!c) throw new Error('L’agent Cursor n’est pas installé. Réglages → Connexions → Cursor → Installer.');
  const model = await cursorModelFor(cfg, agent);
  const args = ['-p', '--output-format', 'stream-json', '--model', model];
  if (perm === 'full' || perm === 'auto') args.push('--force');
  if (session.id) args.push('--resume', session.id);
  const guard = perm === 'read' ? '[Lecture seule : analyse et propose, ne modifie aucun fichier et ne lance aucune commande.]\n\n'
    : perm === 'plan' ? '[Mode plan : explore puis présente un plan détaillé et numéroté. Ne modifie rien avant l’accord de l’utilisateur.]\n\n' : '';
  let result = null;
  const feed = lineReader(cursorStreamParser({ agent, turn, onSession: (id) => { session.id = id; }, onResult: (r) => { result = r; } }));
  const r = await runCursor(c, [...args, fitArg(c, `${guard}${prompt}`)], { cwd: dir, signal, onStdout: feed });
  feed.flush();
  if (signal?.aborted) throw new Error('Arrêté.');
  if (result?.is_error || result?.subtype === 'error') throw new Error(friendly(result.result || result.error || r.stderr));
  if (r.code !== 0 && !result && !turn.parts?.length) {
    if (session.id && /session|chat|not found/i.test(r.stderr)) session.id = null;
    throw new Error(friendly(r.stderr || r.stdout));
  }
  return result;
}

/** Question simple (sans modification), par exemple pour Ctrl K. Renvoie le texte. */
export async function cursorAsk({ cfg, agent = 'claude', prompt, cwd, signal }) {
  const c = resolveCursor(cfg);
  if (!c) throw new Error('L’agent Cursor n’est pas installé.');
  const model = await cursorModelFor(cfg, agent);
  const r = await runCursor(c, ['-p', '--output-format', 'text', '--model', model, fitArg(c, prompt)], { cwd, signal, timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(friendly(r.stderr));
  return strip(r.stdout).trim();
}

/* Ancien outil « cursor_task » (discussion) : l'agent Cursor travaille dans le dossier choisi. */
export async function runCursorAgent({ cfg, prompt, signal, onOutput }) {
  const cwd = cfg.CURSOR_WORKSPACE;
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`Dossier de travail Cursor introuvable : "${cwd}"`);
  const c = resolveCursor(cfg);
  if (!c) throw new Error('L’agent Cursor n’est pas installé. Réglages → Connexions → Cursor → Installer.');
  const args = ['-p', '--output-format', 'text'];
  if (String(cfg.CURSOR_ALLOW_WRITES) === 'true') args.push('--force');
  const r = await runCursor(c, [...args, fitArg(c, prompt)], { cwd, signal, onStdout: onOutput, timeoutMs: 10 * 60 * 1000 });
  if (r.code !== 0) throw new Error(friendly(r.stderr || r.stdout));
  return strip(r.stdout).trim() || '(Cursor a terminé sans rien afficher)';
}

/* ---------- Installation, connexion ---------- */
/** Commande officielle d'installation de l'agent Cursor. */
export function installCommand() {
  return IS_WIN
    ? { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "irm 'https://cursor.com/install?win32=true' | iex"] }
    : { cmd: 'bash', args: ['-c', 'curl https://cursor.com/install -fsS | bash'] };
}
