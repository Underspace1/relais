/**
 * Client MCP de Relais : branche les serveurs MCP (data/mcp.json) sur TOUTES les IA.
 *  - Claude Code, Gemini CLI et Codex reçoivent la liste et s'y connectent eux-mêmes ;
 *  - pour les IA par OpenRouter, clé API ou IA locale (et l'agent intégré), c'est Relais
 *    qui se connecte aux serveurs et expose leurs outils sous le nom mcp__<serveur>__<outil>.
 * Transports : stdio (programme local, JSON-RPC ligne par ligne) et HTTP « streamable » (serveur distant).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';
import { readMcp } from './workspace.js';

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'Relais', version: '3' };
const IS_WIN = process.platform === 'win32';

/** Serveurs actifs (ceux marqués « disabled » sont ignorés partout). */
export function activeServers() {
  const all = readMcp().mcpServers || {};
  return Object.fromEntries(Object.entries(all).filter(([, s]) => s && !s.disabled));
}

/** Noms des serveurs actifs marqués « de confiance » (appels sans confirmation). */
export const trustedServers = () => Object.entries(activeServers()).filter(([, s]) => s.autoApprove).map(([n]) => n);

/** Serveurs actifs au format .mcp.json standard (Claude Code), sans les options propres à Relais. */
export function standardServers() {
  return Object.fromEntries(Object.entries(activeServers()).map(([name, s]) => [name, s.url
    ? { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
    : { command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}) }]));
}

/** Nom d'outil accepté par toutes les API (lettres, chiffres, _ et -, 64 caractères max). */
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
export function toolName(server, tool) {
  const n = `mcp__${safe(server)}__${safe(tool)}`;
  return n.length <= 64 ? n : `${n.slice(0, 55)}_${crypto.createHash('md5').update(n).digest('hex').slice(0, 8)}`;
}

/* ---------- Connexion stdio ---------- */
class StdioConn {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.stderr = '';
  }

  start() {
    const env = { ...process.env, ...(this.cfg.env || {}) };
    const p = env.PATH ?? env.Path ?? '';
    delete env.Path;
    env.PATH = `${paths.node}${path.delimiter}${p}`; // npx du Node portable de Relais
    // Sous Windows, npx/uvx sont des .cmd : il faut passer par le shell.
    this.child = spawn(this.cfg.command, (this.cfg.args || []).map(String), { cwd: this.cfg.cwd || paths.sandbox, env, shell: IS_WIN, windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.feed(d));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.on('error', (e) => this.fail(new Error(`Impossible de lancer « ${this.cfg.command} » : ${e.message}`)));
    this.child.on('close', (code) => this.fail(new Error(`Le serveur MCP « ${this.name} » s’est arrêté (code ${code}).${this.stderr ? ` ${this.stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`)));
    this.child.stdin.on('error', () => {});
  }

  feed(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'Erreur MCP'));
        else resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // Requête du serveur (ex. ping, roots/list) : réponse minimale
        this.write({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [] } : {} });
      }
    }
  }

  fail(err) {
    this.dead = err;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
    this.pending.clear();
  }

  write(obj) { this.child.stdin.write(`${JSON.stringify(obj)}\n`); }

  request(method, params, timeoutMs = 60000, signal) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Le serveur MCP « ${this.name} » ne répond pas (${method}).`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => { clearTimeout(timer); this.pending.delete(id); reject(new Error('Arrêté.')); }, { once: true });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }
  close() { try { this.child?.kill(); } catch { /* déjà arrêté */ } }
}

/* ---------- Connexion HTTP « streamable » ---------- */
class HttpConn {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.nextId = 1;
    this.session = null;
  }

  start() {}

  async post(body, timeoutMs, signal) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(this.cfg.headers || {}) };
    if (this.session) headers['mcp-session-id'] = this.session;
    const ctrl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: signal && AbortSignal.any ? AbortSignal.any([ctrl, signal]) : ctrl });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202) return null;
    if (!res.ok) throw new Error(`Serveur MCP « ${this.name} » : HTTP ${res.status}${res.status === 401 ? ' (clé ou jeton refusé : ajoute un en-tête Authorization)' : ''}`);
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      // Réponse en flux : on garde le message qui porte notre id
      const text = await res.text();
      for (const chunk of text.split(/\r?\n\r?\n/)) {
        const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { const msg = JSON.parse(data); if (msg.id === body.id) return msg; } catch { /* fragment */ }
      }
      return null;
    }
    return res.json();
  }

  async request(method, params, timeoutMs = 60000, signal) {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal);
    if (!msg) throw new Error(`Serveur MCP « ${this.name} » : réponse vide.`);
    if (msg.error) throw new Error(msg.error.message || 'Erreur MCP');
    return msg.result;
  }

  notify(method, params) { this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, 15000).catch(() => {}); }
  close() {
    if (this.session) fetch(this.cfg.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...(this.cfg.headers || {}) } }).catch(() => {});
  }
}

/* ---------- Réserve de connexions ---------- */
const conns = new Map(); // nom → { key, conn, ready, tools, at, idle }
const IDLE_MS = 10 * 60 * 1000;

async function connect(name, cfg) {
  const key = JSON.stringify(cfg);
  const cur = conns.get(name);
  if (cur && cur.key === key && !cur.conn.dead) { touch(cur); return cur.ready; }
  cur?.conn.close();
  const conn = cfg.url ? new HttpConn(name, cfg) : new StdioConn(name, cfg);
  const entry = { key, conn };
  entry.ready = (async () => {
    conn.start();
    const init = await conn.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT }, 45000);
    conn.notify('notifications/initialized');
    entry.info = init?.serverInfo || null;
    return entry;
  })();
  conns.set(name, entry);
  touch(entry);
  try { return await entry.ready; } catch (e) { conn.close(); conns.delete(name); throw e; }
}

function touch(entry) {
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => { entry.conn.close(); if (conns.get(entry.conn.name) === entry) conns.delete(entry.conn.name); }, IDLE_MS);
  entry.idle.unref?.();
}

async function listServerTools(name, cfg) {
  const entry = await connect(name, cfg);
  if (entry.tools && Date.now() - entry.toolsAt < 60000) return entry.tools;
  const tools = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await entry.conn.request('tools/list', cursor ? { cursor } : {}, 30000);
    tools.push(...(r?.tools || []));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  entry.tools = tools;
  entry.toolsAt = Date.now();
  return tools;
}

/** Teste un serveur : renvoie { ok, server, tools: [{ name, description }] } ou { ok: false, error }. */
export async function testServer(name) {
  const cfg = (readMcp().mcpServers || {})[name];
  if (!cfg) return { ok: false, error: 'Serveur introuvable.' };
  try {
    const tools = await listServerTools(name, cfg);
    const entry = conns.get(name);
    return { ok: true, server: entry?.info, tools: tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) })) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Outils MCP au format de Relais ({ name, description, input_schema }), pour les IA que Relais pilote lui-même.
 * Un serveur en panne est simplement ignoré (son erreur est notée dans `errors`).
 */
const map = new Map(); // nom d'outil exposé → { server, tool }
export async function mcpTools({ timeoutMs = 25000 } = {}) {
  const out = [];
  const errors = [];
  await Promise.all(Object.entries(activeServers()).map(async ([name, cfg]) => {
    try {
      const tools = await Promise.race([listServerTools(name, cfg), new Promise((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), timeoutMs))]);
      for (const t of tools) {
        const n = toolName(name, t.name);
        map.set(n, { server: name, tool: t.name });
        out.push({
          name: n,
          description: `[MCP ${name}] ${String(t.description || t.title || t.name).slice(0, 900)}`,
          input_schema: t.inputSchema && typeof t.inputSchema === 'object' ? { type: 'object', ...t.inputSchema } : { type: 'object', properties: {} },
        });
      }
    } catch (e) { errors.push(`${name} : ${e.message}`); }
  }));
  return Object.assign(out, { errors });
}

export const isMcpTool = (name) => String(name).startsWith('mcp__') && map.has(name);
export const mcpTarget = (name) => map.get(name) || null;

/** Appelle un outil MCP. Renvoie { text, images: [{ mime, b64 }], isError }. */
export async function callMcpTool(name, args, { signal } = {}) {
  const t = map.get(name);
  if (!t) throw new Error(`Outil MCP inconnu : ${name}`);
  const cfg = activeServers()[t.server];
  if (!cfg) throw new Error(`Le serveur MCP « ${t.server} » est désactivé.`);
  const entry = await connect(t.server, cfg);
  const r = await entry.conn.request('tools/call', { name: t.tool, arguments: args || {} }, 10 * 60 * 1000, signal);
  const texts = [];
  const images = [];
  for (const c of r?.content || []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image' && c.data) images.push({ mime: c.mimeType || 'image/png', b64: c.data });
    else if (c.type === 'resource' && c.resource?.text) texts.push(c.resource.text);
    else if (c.type === 'resource_link') texts.push(`[Ressource : ${c.name || c.uri}] ${c.uri}`);
  }
  if (!texts.length && r?.structuredContent) texts.push(JSON.stringify(r.structuredContent, null, 2));
  return { text: texts.join('\n\n').slice(0, 60000), images, isError: !!r?.isError };
}

/* ==========================================================================
   Transmission aux outils officiels (ils se connectent eux-mêmes aux serveurs)
   ========================================================================== */

/** Gemini CLI : section mcpServers de <GEMINI_CLI_HOME>/.gemini/settings.json (le reste est conservé). */
export function syncGeminiMcp(geminiHome) {
  const file = path.join(geminiHome, '.gemini', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* nouveau */ }
  const servers = {};
  for (const [name, s] of Object.entries(activeServers())) {
    servers[name] = s.url
      ? { httpUrl: s.url, ...(s.headers ? { headers: s.headers } : {}), ...(s.autoApprove ? { trust: true } : {}) }
      : { command: s.command, args: s.args || [], ...(s.env ? { env: s.env } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), ...(s.autoApprove ? { trust: true } : {}) };
  }
  settings.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

/** Codex : bloc géré par Relais dans <CODEX_HOME>/config.toml (le reste du fichier est conservé). */
export function syncCodexMcp(codexHome) {
  const file = path.join(codexHome, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* nouveau */ }
  const START = '# >>> serveurs MCP gérés par Relais (ne pas modifier à la main)';
  const END = '# <<< serveurs MCP gérés par Relais';
  text = text.replace(new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`), '\n').trimEnd();
  const q = (v) => JSON.stringify(String(v)); // une chaîne TOML « basique » s'écrit comme en JSON
  const lines = [];
  for (const [name, s] of Object.entries(activeServers())) {
    const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : q(name);
    lines.push('', `[mcp_servers.${key}]`);
    if (s.url) lines.push(`url = ${q(s.url)}`);
    else {
      lines.push(`command = ${q(s.command)}`, `args = [${(s.args || []).map(q).join(', ')}]`);
      if (s.env && Object.keys(s.env).length) lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${q(k)} = ${q(v)}`).join(', ')} }`);
    }
  }
  if (lines.length) text = `${text}\n\n${START}${lines.join('\n')}\n${END}\n`;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(file, `${text.trim()}\n`);
}

export function closeAll() { for (const e of conns.values()) e.conn.close(); conns.clear(); }
process.on('exit', closeAll);
