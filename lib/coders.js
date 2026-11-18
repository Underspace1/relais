/**
 * Agents de code : Claude Code, Codex et Grok Build travaillent dans le dossier du projet,
 * comme dans leur propre terminal, avec trois niveaux d'autorisation :
 *   read : lecture seule          (aucune modification, aucune commande)
 *   ask  : demander               (Claude te demande pour chaque modification/commande ;
 *                                  Codex et Grok peuvent modifier les fichiers du projet, sans commandes risquées)
 *   full : accès complet          (fichiers et commandes sans confirmation)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { resolveCli, runCli } from './connectors.js';
import { recordClaudeRateLimit, recordResult, syncCodex } from './usage.js';

export const PERMS = ['read', 'ask', 'full'];
const LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' };
const tmpFile = (prefix, ext) => path.join(paths.tmp, `${prefix}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
const short = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/* ---------- Présentation des actions (communes aux trois agents) ---------- */
export function describeTool(name, input = {}) {
  const n = String(name || '').replace(/^mcp__\w+__/, '');
  const file = input.file_path || input.path || input.filePath || input.notebook_path || '';
  const base = file ? path.basename(String(file)) : '';
  const map = {
    Read: ['Lit', base], read_file: ['Lit', base], view: ['Lit', base],
    Edit: ['Modifie', base], MultiEdit: ['Modifie', base], edit_file: ['Modifie', base], str_replace: ['Modifie', base], search_replace: ['Modifie', base],
    Write: ['Crée', base], write_file: ['Crée', base], create_file: ['Crée', base],
    Glob: ['Cherche des fichiers', input.pattern], list_dir: ['Liste', file || '.'], ls: ['Liste', file || '.'],
    Grep: ['Cherche dans le code', input.pattern], grep: ['Cherche dans le code', input.pattern || input.query],
    Bash: ['Commande', input.command], bash: ['Commande', input.command], shell: ['Commande', input.command], run_terminal_cmd: ['Commande', input.command],
    PowerShell: ['Commande', input.command],
    WebFetch: ['Lit une page web', input.url], WebSearch: ['Recherche web', input.query], web_search: ['Recherche web', input.query],
    TodoWrite: ['Plan de travail', ''], Task: ['Sous-agent', input.description],
  };
  const [verb, target] = map[n] || [n, base];
  const title = target ? `${verb} · ${short(target, 60)}` : verb;
  let diff = null;
  if (input.old_string !== undefined && input.new_string !== undefined) diff = { path: file, old: String(input.old_string), new: String(input.new_string) };
  else if (input.content !== undefined && file) diff = { path: file, old: '', new: String(input.content).slice(0, 6000) };
  const detail = input.command || file || input.pattern || input.url || input.query || (Object.keys(input).length ? JSON.stringify(input, null, 2).slice(0, 2000) : '');
  return { title, detail, diff, kind: /Commande/.test(verb) ? 'command' : /Modifie|Crée/.test(verb) ? 'edit' : 'read' };
}

/* ---------- Analyse des flux « messages » (Claude Code et Grok Build) ---------- */
function messageStreamParser({ agent, turn, onSession, onResult, model }) {
  const pending = new Map();
  let deltaSinceMessage = false;
  let initModel = null;
  return (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id) onSession?.(ev.session_id);
    if (ev.type === 'system' && ev.model) initModel = ev.model;
    if (ev.type === 'rate_limit_event' && agent === 'claude') { recordClaudeRateLimit(ev.rate_limit_info); return; }
    if (ev.type === 'result') recordResult(agent === 'claude' ? 'claude' : 'grok', ev, initModel || model);
    if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') { deltaSinceMessage = true; turn.text(e.delta.text); }
    } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text && !deltaSinceMessage) turn.text(b.text);
        if (b.type === 'tool_use' && !String(b.name).startsWith('mcp__relais__')) {
          const d = describeTool(b.name, b.input);
          pending.set(b.id, d);
          turn.step({ id: b.id, agent, title: d.title, status: 'running', input: d.detail, diff: d.diff, kind: d.kind });
        }
      }
      deltaSinceMessage = false;
    } else if (ev.type === 'user') {
      const content = ev.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
          const text = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content ?? '');
          turn.step({ id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: text.slice(0, 4000) });
          pending.delete(b.tool_use_id);
        }
      }
    } else if (ev.type === 'result') {
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

function friendly(who, msg) {
  const m = String(msg || '').trim().slice(-700);
  if (/not logged in|log ?in|not authenticated|unauthori[sz]ed|401|sign in/i.test(m)) return `${who} n’est pas connecté à ton compte. Réglages → Connexions → ${who} → Se connecter.`;
  if (/rate limit|usage limit|quota|credit|exceeded/i.test(m)) return `Limite de ton abonnement ${who} atteinte. ${m}`;
  return `${who} : ${m || 'erreur inconnue'}`;
}

/* ==========================================================================
   Claude Code
   ========================================================================== */
export async function claudeCode({ cfg, dir, perm, prompt, systemAppend, session, mcp, turn, signal }) {
  const c = resolveCli('claude', cfg);
  if (!c) throw new Error('Claude Code n’est pas installé. Réglages → Connexions → Claude.');
  const sysFile = tmpFile('sys', 'md');
  const mcpFile = tmpFile('mcp', 'json');
  fs.writeFileSync(sysFile, systemAppend || '');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { relais: { command: process.execPath, args: [path.join(paths.root, 'lib', 'mcp-bridge.js')], env: { RELAIS_URL: mcp.url, RELAIS_TOKEN: mcp.token } } } }));

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', cfg.CLAUDE_ACCOUNT_MODEL || 'sonnet',
    '--append-system-prompt-file', sysFile,
    '--mcp-config', mcpFile, '--strict-mcp-config',
    '--max-turns', '80',
  ];
  if (perm === 'read') args.push('--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--allowedTools', 'mcp__relais,Read,Glob,Grep,WebSearch,WebFetch', '--permission-mode', 'default');
  else if (perm === 'full') args.push('--permission-mode', 'bypassPermissions', '--allowedTools', 'mcp__relais');
  else args.push('--permission-mode', 'default', '--allowedTools', 'mcp__relais,Read,Glob,Grep', '--permission-prompt-tool', 'mcp__relais__permission_prompt');
  if (session.id) args.push('--resume', session.id);
  else { session.id = crypto.randomUUID(); args.push('--session-id', session.id); }

  let result = null;
  const feed = lineReader(messageStreamParser({ agent: 'claude', turn, model: cfg.CLAUDE_ACCOUNT_MODEL, onResult: (r) => { result = r; } }));
  try {
    const r = await runCli(c, args, { input: prompt, cwd: dir, signal, onStdout: feed });
    feed.flush();
    if (signal?.aborted) throw new Error('Arrêté.');
    if (result?.is_error) {
      if (/No conversation found|session/i.test(result.result || '') && session.id) { session.id = null; }
      throw new Error(friendly('Claude', result.result || result.subtype));
    }
    if (r.code !== 0 && !result) {
      if (/No conversation found/i.test(r.stderr)) session.id = null;
      throw new Error(friendly('Claude', r.stderr || r.stdout));
    }
    return result;
  } finally {
    fs.rm(sysFile, () => {});
    fs.rm(mcpFile, () => {});
  }
}

/* ==========================================================================
   Codex (ChatGPT)
   ========================================================================== */
export async function codexCode({ cfg, dir, perm, prompt, session, turn, signal }) {
  const c = resolveCli('codex', cfg);
  if (!c) throw new Error('Codex n’est pas installé. Réglages → Connexions → ChatGPT.');
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never'];
  if (perm === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
  else args.push('-c', `sandbox_mode="${perm === 'read' ? 'read-only' : 'workspace-write'}"`);
  if (cfg.CODEX_MODEL) args.push('-c', `model="${cfg.CODEX_MODEL}"`);
  if (session.id) args.push('resume', session.id, '-');
  else args.push('-');

  let failure = null;
  const feed = lineReader((line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'thread.started' && ev.thread_id) session.id = ev.thread_id;
    else if (ev.type === 'turn.failed') failure = ev.error?.message || 'échec';
    else if (ev.type === 'error' && ev.message && !/reconnect/i.test(ev.message)) failure = ev.message;
    else if (ev.type?.startsWith('item.')) {
      const it = ev.item || {};
      const done = ev.type === 'item.completed';
      switch (it.type) {
        case 'agent_message':
          if (done && it.text) turn.text(`${turn.parts.at(-1)?.type === 'text' ? '\n\n' : ''}${it.text}`);
          break;
        case 'command_execution':
          turn.step({
            id: it.id, agent: 'chatgpt', kind: 'command', title: `Commande · ${short(it.command, 60)}`, input: it.command,
            output: String(it.aggregated_output || '').slice(-4000),
            status: !done ? 'running' : (it.exit_code === 0 || it.status === 'completed' ? 'done' : 'error'),
          });
          break;
        case 'file_change': {
          const ch = it.changes || [];
          turn.step({
            id: it.id, agent: 'chatgpt', kind: 'edit',
            title: ch.length === 1 ? `${ch[0].kind === 'add' ? 'Crée' : ch[0].kind === 'delete' ? 'Supprime' : 'Modifie'} · ${path.basename(ch[0].path || '')}` : `Modifie ${ch.length} fichiers`,
            input: ch.map((x) => `${x.kind === 'add' ? '+' : x.kind === 'delete' ? '−' : '~'} ${x.path}`).join('\n'),
            status: !done ? 'running' : it.status === 'failed' ? 'error' : 'done',
          });
          break;
        }
        case 'web_search':
          turn.step({ id: it.id, agent: 'chatgpt', title: `Recherche web · ${short(it.query, 60)}`, input: it.query, status: done ? 'done' : 'running' });
          break;
        case 'todo_list':
          turn.step({ id: it.id, agent: 'chatgpt', title: 'Plan de travail', input: (it.items || []).map((x) => `${x.completed ? '✓' : '○'} ${x.text}`).join('\n'), status: 'done' });
          break;
        case 'mcp_tool_call':
          turn.step({ id: it.id, agent: 'chatgpt', title: `Outil · ${it.tool || ''}`, input: JSON.stringify(it.arguments || {}).slice(0, 1500), status: done ? 'done' : 'running' });
          break;
        case 'error':
          if (it.message) turn.step({ id: it.id, agent: 'chatgpt', title: 'Avertissement', input: it.message, status: 'error' });
          break;
        default:
          break;
      }
    }
  });
  const r = await runCli(c, args, { input: prompt, cwd: dir, signal, onStdout: feed });
  feed.flush();
  try { syncCodex(); } catch { /* utilisation indisponible */ }
  if (signal?.aborted) throw new Error('Arrêté.');
  if (failure) throw new Error(friendly('ChatGPT', failure));
  if (r.code !== 0 && !turn.parts.length) throw new Error(friendly('ChatGPT', r.stderr || r.stdout));
}

/* ==========================================================================
   Grok Build
   ========================================================================== */
export async function grokCode({ cfg, dir, perm, prompt, session, turn, signal }) {
  const c = resolveCli('grok', cfg);
  if (!c) throw new Error('Grok Build n’est pas installé. Réglages → Connexions → Grok.');
  const file = tmpFile('grok', 'md');
  fs.writeFileSync(file, prompt);
  const args = ['--prompt-file', file, '--output-format', 'streaming-messages-json', '--include-partial-messages', '--cwd', dir, '--max-turns', '80', '--no-subagents',
    '--permission-mode', perm === 'full' ? 'bypassPermissions' : perm === 'ask' ? 'acceptEdits' : 'default'];
  if (cfg.GROK_ACCOUNT_MODEL) args.push('--model', cfg.GROK_ACCOUNT_MODEL);
  if (session.id) args.push('--resume', session.id);
  let result = null;
  const feed = lineReader(messageStreamParser({ agent: 'grok', turn, model: cfg.GROK_ACCOUNT_MODEL, onSession: (id) => { session.id = id; }, onResult: (r) => { result = r; } }));
  try {
    const r = await runCli(c, args, { cwd: dir, signal, onStdout: feed });
    feed.flush();
    if (signal?.aborted) throw new Error('Arrêté.');
    const refused = (r.stderr.match(/permission required: [^\n]+/g) || []).slice(0, 5);
    if (refused.length) turn.step({ id: `refus-${Date.now()}`, agent: 'grok', title: 'Actions refusées (niveau d’autorisation)', status: 'error', input: refused.join('\n') });
    if (result?.is_error) throw new Error(friendly('Grok', result.result || result.subtype));
    if (r.code !== 0 && !result && !turn.parts.length) throw new Error(friendly('Grok', r.stderr || r.stdout));
  } finally {
    fs.rm(file, () => {});
  }
}

export async function runCoder(agent, opts) {
  if (agent === 'chatgpt') return codexCode(opts);
  if (agent === 'grok') return grokCode(opts);
  return claudeCode(opts);
}

export { LABEL as CODER_LABEL };
