/**
 * Gemini avec ton compte Google, via Antigravity CLI (`agy`), l'outil officiel de Google.
 * Depuis le 18 juin 2026, Gemini CLI ne sert plus les comptes personnels (gratuit, Google AI Pro, Ultra) :
 * Google les a fait passer sur Antigravity CLI. Relais le pilote comme les autres outils officiels.
 *
 * Le format de sortie d'agy a évolué selon les versions : la lecture est volontairement souple
 * (champ `event` ou `type`, texte dans text / content / delta…).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './config.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const FLAG = path.join(paths.accounts, 'gemini', '.agy-connected');

function exists(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

/** Trouve agy : réglage GEMINI_CLI, dossier de Relais, emplacement de l'installeur officiel, puis le PATH. */
export function resolveAgy(cfg = {}) {
  const as = (file) => (file && exists(file) ? { cmd: file, pre: [], shell: /\.(cmd|bat)$/i.test(file), file } : null);
  if (cfg.GEMINI_CLI) return as(cfg.GEMINI_CLI);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(paths.tools, 'agy', `agy${EXE}`),
    ...(IS_WIN ? [path.join(local, 'agy', 'bin', 'agy.exe'), path.join(local, 'Programs', 'agy', 'agy.exe'), path.join(local, 'Programs', 'Antigravity CLI', 'agy.exe')] : [path.join(os.homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy']),
  ];
  for (const f of candidates) { const c = as(f); if (c) return c; }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const n of IS_WIN ? ['agy.exe', 'agy.cmd'] : ['agy']) { const c = as(path.join(dir, n)); if (c) return c; }
  }
  return null;
}

/** Installeur officiel de Google (une seule commande, comme indiqué par Google). */
export function agyInstallCommand() {
  return IS_WIN
    ? { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "irm 'https://antigravity.google/cli/install.ps1' | iex"] }
    : { cmd: 'bash', args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] };
}

export const agyConnected = () => exists(FLAG);
export function setAgyConnected(on) {
  try {
    if (on) { fs.mkdirSync(path.dirname(FLAG), { recursive: true }); fs.writeFileSync(FLAG, new Date().toISOString()); }
    else fs.rmSync(FLAG, { force: true });
  } catch { /* sans importance */ }
}

function run(c, args, { cwd, signal, onLine, timeoutMs = 15 * 60 * 1000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, [...c.pre, ...args], { cwd: cwd || paths.sandbox, windowsHide: true, shell: c.shell, env: { ...process.env, NO_COLOR: '1', ...env } });
    let stdout = '';
    let stderr = '';
    let buf = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Impossible de lancer Antigravity CLI : ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (onLine && buf.trim()) onLine(buf.trim());
      resolve({ code, stdout, stderr });
    });
  });
}

export async function agyVersion(cfg) {
  const c = resolveAgy(cfg);
  if (!c) return '';
  try { const r = await run(c, ['--version'], { timeoutMs: 15000 }); return (r.stdout.match(/\d+\.\d+[\w.-]*/) || [''])[0]; } catch { return ''; }
}

/** Texte d'une valeur JSON quelconque (réponse finale, morceau de message…). */
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (typeof v === 'object') {
    for (const k of ['text', 'delta', 'content', 'response', 'result', 'output', 'message', 'parts']) if (v[k] != null) { const t = textOf(v[k]); if (t) return t; }
  }
  return '';
}

/** Message d'erreur compréhensible. */
export function agyError(out) {
  const s = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
  if (/log ?in|sign ?in|auth|credential|unauthori[sz]ed|401/i.test(s)) { setAgyConnected(false); return 'Antigravity n’est pas connecté à ton compte Google : Réglages → Connexions → Gemini → Se connecter.'; }
  if (/quota|rate limit|429|exhausted/i.test(s)) return 'Limite de ton compte Google atteinte pour le moment. Réessaie plus tard (Google AI Pro relève les limites).';
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && !/^at /.test(l));
  return lines.slice(-2).join(' ') || 'Antigravity CLI n’a rien répondu.';
}

const argsFor = (cfg, prompt, format, extra = []) => {
  const a = ['-p', prompt, '--output-format', format, ...extra];
  if (cfg.GEMINI_ACCOUNT_MODEL) a.push('--model', cfg.GEMINI_ACCOUNT_MODEL);
  return a;
};

/** Question simple (sans modifier de fichier). */
export async function agyAsk({ cfg, prompt, signal, onText, cwd }) {
  const c = resolveAgy(cfg);
  if (!c) throw new Error('Gemini (compte Google) n’est pas prêt : Réglages → Connexions → Gemini → Se connecter avec mon compte.');
  const r = await run(c, argsFor(cfg, prompt, 'json', ['--mode', 'plan']), { signal, cwd });
  if (signal?.aborted) throw new Error('Arrêté.');
  let text = '';
  try { const j = JSON.parse(r.stdout.trim()); if (j.is_error || j.error) throw new Error(agyError(textOf(j.error) || JSON.stringify(j.error))); text = textOf(j); }
  catch (e) { if (e.message && !/JSON|Unexpected/.test(e.message)) throw e; text = r.stdout.trim(); }
  if (!text) throw new Error(r.code === 0 ? 'Antigravity CLI n’a rien renvoyé. Mets-le à jour (Réglages → Connexions → Gemini → Mettre à jour).' : agyError(r.stderr || r.stdout));
  setAgyConnected(true);
  onText?.(text);
  return text;
}

// Autorisations : plan = lecture seule ; accept-edits = fichiers sans demander ;
// sans surveillance (accès complet) = --dangerously-skip-permissions.
const MODE = { read: ['--mode', 'plan'], plan: ['--mode', 'plan'], ask: ['--mode', 'accept-edits'], auto: ['--mode', 'accept-edits'], full: ['--dangerously-skip-permissions'] };
const PATHKEYS = ['path', 'file_path', 'filePath', 'file', 'target_file', 'absolute_path'];

function describe(name, input = {}) {
  const n = String(name || 'outil');
  const file = PATHKEYS.map((k) => input[k]).find(Boolean);
  const short = (p) => String(p).split(/[\\/]/).pop();
  if (/write|create|edit|replace|patch/i.test(n)) {
    const neu = input.content ?? input.new_string ?? input.newString ?? input.new_str;
    const old = input.old_string ?? input.oldString ?? input.old_str;
    return { title: `Modifie · ${file ? short(file) : n}`, detail: file || n, kind: 'edit', diff: file && neu != null ? { path: file, old: old ?? '', new: String(neu) } : null };
  }
  if (/read|view|cat|open/i.test(n)) return { title: `Lit · ${file ? short(file) : n}`, detail: file || '', kind: 'read' };
  if (/shell|bash|command|exec|run/i.test(n)) return { title: `Commande · ${String(input.command || input.cmd || '').slice(0, 60)}`, detail: input.command || input.cmd || '', kind: 'command' };
  if (/grep|search|glob|find|list|ls/i.test(n)) return { title: `Cherche · ${String(input.pattern || input.query || input.path || '').slice(0, 50)}`, detail: JSON.stringify(input).slice(0, 400), kind: 'search' };
  if (/web|fetch|url/i.test(n)) return { title: `Web · ${String(input.url || input.query || '').slice(0, 60)}`, detail: input.url || input.query || '', kind: 'web' };
  return { title: n, detail: JSON.stringify(input).slice(0, 400), kind: 'tool' };
}

/** Gemini code dans un projet via Antigravity CLI (flux d'événements JSON, une ligne par événement). */
export async function agyCode({ cfg, dir, perm, prompt, turn, signal }) {
  const c = resolveAgy(cfg);
  if (!c) throw new Error('Gemini (compte Google) n’est pas prêt : Réglages → Connexions → Gemini → Se connecter avec mon compte.');
  const pending = new Map();
  let failure = null;
  let gotSomething = false;
  let n = 0;
  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    gotSomething = true;
    const kind = String(ev.event || ev.type || '').toLowerCase();
    const data = ev.data && typeof ev.data === 'object' ? { ...ev, ...ev.data } : ev;
    if (kind === 'model' || kind === 'init') { if (data.model || data.name) turn.meta?.({ model: data.model || data.name }); return; }
    if (/error/.test(kind)) { failure = textOf(data.error || data.message) || 'échec'; return; }
    if (/tool/.test(kind)) {
      const id = String(data.tool_id || data.call_id || data.id || data.tool_call_id || `t${++n}`);
      const done = /result|end|complete|done|output/.test(kind) || data.status === 'completed' || data.output != null || data.result != null;
      if (!done || !pending.has(id)) {
        const d = describe(data.tool_name || data.name || data.tool, data.parameters || data.args || data.arguments || data.input || {});
        pending.set(id, d);
        turn.step({ id, agent: 'gemini', title: d.title, status: done ? 'done' : 'running', input: d.detail, kind: d.kind, ...(d.diff ? { diff: d.diff } : {}) });
      }
      if (done) {
        const failed = data.status === 'error' || !!data.error;
        turn.step({ id, status: failed ? 'error' : 'done', output: String(textOf(data.error) || textOf(data.output ?? data.result) || '').slice(0, 4000) });
        pending.delete(id);
      }
      return;
    }
    if (/result|final|end|done/.test(kind)) {
      const st = data.stats || data.usage || {};
      turn.meta?.({ tokensIn: st.input_tokens || st.inputTokens || 0, tokensOut: st.output_tokens || st.outputTokens || 0, ms: st.duration_ms || data.duration_ms });
      if (data.is_error || data.status === 'error') failure = textOf(data.error) || failure || 'échec';
      return;
    }
    if (/thought|thinking|reason/.test(kind)) return;
    const role = data.role || data.message?.role;
    if (role && role !== 'assistant' && role !== 'model') return;
    const t = textOf(data.delta ?? data.text ?? data.content ?? data.message);
    if (t) turn.text(t);
  };
  const r = await run(c, argsFor(cfg, prompt, 'stream-json', MODE[perm] || MODE.read), { cwd: dir, signal, onLine });
  if (signal?.aborted) throw new Error('Arrêté.');
  if (failure) throw new Error(agyError(failure));
  if (r.code !== 0 && !turn.parts.length) throw new Error(agyError(r.stderr || r.stdout));
  if (!gotSomething && !turn.parts.length) throw new Error('Antigravity CLI n’a rien renvoyé. Mets-le à jour (Réglages → Connexions → Gemini → Mettre à jour).');
  setAgyConnected(true);
}
