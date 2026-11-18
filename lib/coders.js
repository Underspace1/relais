/**
 * Agents de code : Claude Code, Codex, Grok Build et Gemini CLI travaillent dans le dossier du projet,
 * comme dans leur propre terminal, avec les modes d'autorisation de Claude Code :
 *   read : lecture seule          (aucune modification, aucune commande)
 *   plan : mode plan              (l'IA explore puis propose un plan, sans rien modifier)
 *   ask  : demander               (Claude te demande pour chaque modification/commande ;
 *                                  Codex, Grok et Gemini peuvent modifier les fichiers du projet, sans commandes risquées)
 *   auto : accepter les modifs    (fichiers modifiés sans demander, commandes soumises à ton accord)
 *   full : accès complet          (fichiers et commandes sans confirmation)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { resolveCli, runCli, geminiArgs, geminiEvent, geminiError, recordGeminiResult } from './connectors.js';
import { recordClaudeRateLimit, recordResult, syncCodex } from './usage.js';
import { readMcp } from './workspace.js';

export const PERMS = ['read', 'plan', 'ask', 'auto', 'full'];
const LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', gemini: 'Gemini' };
const tmpFile = (prefix, ext) => path.join(paths.tmp, `${prefix}-${crypto.randomBytes(6).toString('hex')}.${ext}`);
const short = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/* ---------- Présentation des actions (communes aux trois agents) ---------- */
export function describeTool(name, input = {}) {
  const n = String(name || '').replace(/^mcp__\w+__/, '');
  const file = input.file_path || input.path || input.filePath || input.notebook_path || '';
  const base = file ? path.basename(String(file)) : '';
  const map = {
    Read: ['Lit', base], read_file: ['Lit', base], view: ['Lit', base], read_many_files: ['Lit plusieurs fichiers', (input.include || input.paths || []).join?.(', ')],
    replace: ['Modifie', base], Edit: ['Modifie', base], MultiEdit: ['Modifie', base], edit_file: ['Modifie', base], str_replace: ['Modifie', base], search_replace: ['Modifie', base],
    Write: ['Crée', base], write_file: ['Crée', base], create_file: ['Crée', base],
    Glob: ['Cherche des fichiers', input.pattern], list_dir: ['Liste', file || '.'], ls: ['Liste', file || '.'],
    Grep: ['Cherche dans le code', input.pattern], grep: ['Cherche dans le code', input.pattern || input.query], grep_search: ['Cherche dans le code', input.pattern],
    list_directory: ['Liste', input.dir_path || input.path || '.'], run_shell_command: ['Commande', input.command],
    google_web_search: ['Recherche web', input.query], web_fetch: ['Lit une page web', input.url || input.prompt],
    Bash: ['Commande', input.command], bash: ['Commande', input.command], shell: ['Commande', input.command], run_terminal_cmd: ['Commande', input.command],
    PowerShell: ['Commande', input.command],
    WebFetch: ['Lit une page web', input.url], WebSearch: ['Recherche web', input.query], web_search: ['Recherche web', input.query],
    TodoWrite: ['Liste de tâches', ''], Task: ['Sous-agent', input.description], Agent: ['Sous-agent', input.description],
    ExitPlanMode: ['Plan proposé', ''], NotebookEdit: ['Modifie', base], KillShell: ['Arrête une commande', ''], BashOutput: ['Lit la sortie', ''],
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
  let thinkN = 0;
  return (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id) onSession?.(ev.session_id);
    if (ev.type === 'system' && ev.model) { initModel = ev.model; turn.meta?.({ model: ev.model, tools: ev.tools?.length, mcp: (ev.mcp_servers || []).map((m) => `${m.name}:${m.status}`) }); }
    if (ev.type === 'rate_limit_event' && agent === 'claude') { recordClaudeRateLimit(ev.rate_limit_info); return; }
    if (ev.type === 'result') recordResult(agent === 'claude' ? 'claude' : 'grok', ev, initModel || model);
    if (ev.type === 'stream_event') {
      const e = ev.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') { deltaSinceMessage = true; turn.text(e.delta.text); }
    } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text && !deltaSinceMessage) turn.text(b.text);
        if (b.type === 'thinking' && b.thinking?.trim()) {
          turn.step({ id: `think-${Date.now()}-${thinkN++}`, agent, kind: 'thinking', title: 'Réflexion', output: b.thinking, status: 'done' });
        }
        if (b.type === 'tool_use' && b.name === 'ExitPlanMode') {
          turn.plan?.({ id: b.id, agent, text: String(b.input?.plan || '') });
          continue;
        }
        if (b.type === 'tool_use' && b.name === 'TodoWrite') {
          const todos = (b.input?.todos || []).map((t) => ({ text: t.content || t.text || '', status: t.status || 'pending', active: t.activeForm || '' }));
          turn.todos?.(todos, agent);
          continue;
        }
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
      const u = ev.usage || {};
      turn.meta?.({
        cost: ev.total_cost_usd, turns: ev.num_turns, ms: ev.duration_ms,
        tokensIn: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        tokensOut: u.output_tokens || 0,
      });
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
  const extra = readMcp().mcpServers || {};
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ...extra, relais: { command: process.execPath, args: [path.join(paths.root, 'lib', 'mcp-bridge.js')], env: { RELAIS_URL: mcp.url, RELAIS_TOKEN: mcp.token } } } }));
  const extraTools = Object.keys(extra).map((n) => `mcp__${n}`).join(',');
  const allowMcp = ['mcp__relais', perm === 'full' || perm === 'auto' ? extraTools : ''].filter(Boolean).join(',');

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', cfg.CLAUDE_ACCOUNT_MODEL || 'sonnet',
    '--append-system-prompt-file', sysFile,
    '--mcp-config', mcpFile, '--strict-mcp-config',
    '--max-turns', '80',
  ];
  const prompter = ['--permission-prompt-tool', 'mcp__relais__permission_prompt'];
  if (perm === 'read') args.push('--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--allowedTools', 'mcp__relais,Read,Glob,Grep,WebSearch,WebFetch', '--permission-mode', 'default');
  else if (perm === 'plan') args.push('--permission-mode', 'plan', '--allowedTools', 'mcp__relais,Read,Glob,Grep,WebSearch,WebFetch,TodoWrite', ...prompter);
  else if (perm === 'full') args.push('--permission-mode', 'bypassPermissions', '--allowedTools', allowMcp);
  else if (perm === 'auto') args.push('--permission-mode', 'acceptEdits', '--allowedTools', `${allowMcp},Read,Glob,Grep,TodoWrite`, ...prompter);
  else args.push('--permission-mode', 'default', '--allowedTools', 'mcp__relais,Read,Glob,Grep,TodoWrite', ...prompter);
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
  else args.push('-c', `sandbox_mode="${perm === 'read' || perm === 'plan' ? 'read-only' : 'workspace-write'}"`);
  if (cfg.CODEX_MODEL) args.push('-c', `model="${cfg.CODEX_MODEL}"`);
  if (session.id) args.push('resume', session.id, '-');
  else args.push('-');

  let failure = null;
  const feed = lineReader((line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'thread.started' && ev.thread_id) session.id = ev.thread_id;
    else if (ev.type === 'turn.failed') failure = ev.error?.message || 'échec';
    else if (ev.type === 'turn.completed' && ev.usage) turn.meta?.({ tokensIn: ev.usage.input_tokens || 0, tokensOut: ev.usage.output_tokens || 0 });
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
          turn.todos?.((it.items || []).map((x) => ({ text: x.text, status: x.completed ? 'completed' : 'pending' })), 'chatgpt');
          break;
        case 'reasoning':
          if (done && it.text) turn.step({ id: it.id, agent: 'chatgpt', kind: 'thinking', title: 'Réflexion', output: it.text, status: 'done' });
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
    '--permission-mode', perm === 'full' ? 'bypassPermissions' : perm === 'ask' || perm === 'auto' ? 'acceptEdits' : 'default'];
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

/* ==========================================================================
   Gemini CLI (compte Google)
   ========================================================================== */
// Modes d'autorisation de Gemini CLI : default (rien sans accord : en mode non interactif, les modifications
// et commandes sont refusées), plan (lecture seule), auto_edit (fichiers sans demander), yolo (tout).
const GEMINI_MODE = { read: 'default', plan: 'plan', ask: 'auto_edit', auto: 'auto_edit', full: 'yolo' };

export async function geminiCode({ cfg, dir, perm, prompt, session, turn, signal }) {
  const c = resolveCli('gemini', cfg);
  if (!c) throw new Error('Gemini CLI n’est pas installé. Réglages → Connexions → Gemini.');
  const extra = ['--approval-mode', GEMINI_MODE[perm] || 'default'];
  if (session.id) extra.push('--resume', session.id);
  else { session.id = crypto.randomUUID(); extra.push('--session-id', session.id); }

  const pending = new Map();
  let failure = null;
  let result = null;
  const feed = lineReader((line) => {
    const ev = geminiEvent(line);
    if (!ev) return;
    switch (ev.type) {
      case 'init':
        if (ev.model) turn.meta?.({ model: ev.model });
        break;
      case 'message':
        if (ev.role === 'assistant' && ev.content) turn.text(ev.content);
        break;
      case 'tool_use': {
        const input = ev.parameters || {};
        if (ev.tool_name === 'write_todos') {
          turn.todos?.((input.todos || []).map((t) => ({ text: t.description || t.content || '', status: t.status === 'cancelled' ? 'completed' : t.status || 'pending' })), 'gemini');
          break;
        }
        const d = describeTool(ev.tool_name, input);
        pending.set(ev.tool_id, d);
        turn.step({ id: ev.tool_id, agent: 'gemini', title: d.title, status: 'running', input: d.detail, diff: d.diff, kind: d.kind });
        break;
      }
      case 'tool_result':
        if (pending.has(ev.tool_id)) {
          turn.step({ id: ev.tool_id, status: ev.status === 'error' ? 'error' : 'done', output: String(ev.error?.message || ev.output || '').slice(0, 4000) });
          pending.delete(ev.tool_id);
        }
        break;
      case 'error':
        if (ev.severity === 'warning') turn.step({ id: `warn-${Date.now()}`, agent: 'gemini', title: 'Avertissement', input: ev.message, status: 'error' });
        else failure = ev.message;
        break;
      case 'result': {
        result = ev;
        recordGeminiResult(ev, cfg.GEMINI_ACCOUNT_MODEL);
        const st = ev.stats || {};
        turn.meta?.({ tokensIn: st.input_tokens || 0, tokensOut: st.output_tokens || 0, ms: st.duration_ms, turns: st.tool_calls });
        if (ev.status === 'error') failure = ev.error?.message || failure || 'échec';
        break;
      }
      default:
        break;
    }
  });
  const r = await runCli(c, geminiArgs(cfg, extra), { input: prompt, cwd: dir, signal, onStdout: feed });
  feed.flush();
  if (signal?.aborted) throw new Error('Arrêté.');
  if (/Invalid session identifier|No previous sessions/i.test(r.stderr) && !result) { session.id = null; throw new Error('Session Gemini introuvable.'); }
  if (failure) throw new Error(friendly('Gemini', failure));
  if (r.code !== 0 && !result && !turn.parts.length) throw new Error(friendly('Gemini', geminiError(r.stderr || r.stdout)));
}

export async function runCoder(agent, opts) {
  if (agent === 'chatgpt') return codexCode(opts);
  if (agent === 'grok') return grokCode(opts);
  if (agent === 'gemini') return geminiCode(opts);
  return claudeCode(opts);
}

export { LABEL as CODER_LABEL };
