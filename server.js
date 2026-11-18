import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { paths, getConfig, saveConfig, publicSettings } from './lib/config.js';
import { listConversations, getConversation, saveConversation, deleteConversation, newId } from './lib/store.js';
import { listSkills, getSkill, saveSkill, deleteSkill, listPacks, setSkillEnabled, setPackEnabled } from './lib/skills.js';
import { CATALOG, importClaudeSkills, importGithub, removePack } from './lib/skill-import.js';
import { listDesigns, readDesign, deleteDesign, exportDesign } from './lib/designs.js';
import { RELAYS, getRelay } from './lib/relays.js';
import { detectIntent, stripMentions, withEngine } from './public/intent.js';
import { connectorStatus, install, installJob, startLogin, loginState, submitLoginCode, cancelLogin, logout, invalidateStatus, slim } from './lib/connectors.js';
import { Turn, runClaude, runDirect, runRelayDirect, runProject, runTool, buildTools, available, toolSession, askAgent } from './lib/orchestrator.js';
import { PERMS, describeTool } from './lib/coders.js';
import { listProjects, touchProject, forgetProject, pickFolder, revealFolder, detectType } from './lib/projects.js';
import crypto from 'node:crypto';
import { listModels } from './lib/models.js';
import { usageSummary } from './lib/usage.js';
import { transcribe, voiceEngines } from './lib/voice.js';
import { orKeyInfo, AUTH_KEY } from './lib/llm.js';
import { readMemory as readUserMemory, writeMemory as writeUserMemory } from './lib/memory.js';
import { projectFiles, shellCommand, gitStatus, gitDiff, gitCommit, readMemory, writeMemory, readMcp, writeMcp, saveUpload, getUpload } from './lib/workspace.js';

const PORT = Number(getConfig().PORT) || 4321;
const BASE_URL = `http://127.0.0.1:${PORT}`;
// IA à qui l'on peut écrire directement (Perplexity : recherche web uniquement, pas de projet)
const MODES = ['claude', 'chatgpt', 'grok', 'gemini', 'perplexity'];
const NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', gemini: 'Gemini', perplexity: 'Perplexity', cursor: 'Cursor' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

const COMPACT_PROMPT = 'Résume toute cette conversation pour pouvoir la poursuivre avec un contexte réduit : objectif de l’utilisateur, décisions prises, fichiers créés ou modifiés (chemins), état actuel du travail, problèmes en cours et prochaines étapes. Sois complet mais concis, en Markdown. Ne modifie aucun fichier.';

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readRaw(req, max = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('Requête trop grande')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req, max = 2_000_000) {
  const buf = await readRaw(req, max);
  try { return buf.length ? JSON.parse(buf.toString('utf8')) : {}; }
  catch { throw new Error('JSON invalide'); }
}

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return json(res, 403, { error: 'Interdit' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Introuvable' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': root === paths.images || root === paths.uploads ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(root === paths.uploads ? { 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff' } : {}),
    });
    fs.createReadStream(file).pipe(res);
  });
}

/** Refuse les requêtes venant d'autres sites (le serveur n'écoute que localement). */
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { const u = new URL(o); return ['127.0.0.1', 'localhost'].includes(u.hostname); } catch { return false; }
}

/* ---------- Autorisations demandées par Claude Code (mode « Demander ») ---------- */
const pendingPerms = new Map();
const alwaysAllowed = new Map(); // conversation → outils autorisés pour la session

function makeAsker(convId, send, signal) {
  return (req) => new Promise((resolve) => {
    const tool = String(req.tool_name || '');
    const always = alwaysAllowed.get(convId) || new Set();
    // Mode plan : le plan est affiché dans l'interface, l'utilisateur l'approuve avant toute modification.
    if (tool === 'ExitPlanMode') return resolve({ behavior: 'deny', message: 'Le plan a été présenté à l’utilisateur. Arrête-toi ici sans rien modifier : il va l’approuver ou demander des changements.' });
    if (always.has(tool)) return resolve({ behavior: 'allow', updatedInput: req.input });
    const id = crypto.randomBytes(8).toString('hex');
    const d = describeTool(tool, req.input || {});
    let done = false;
    const finish = (decision, message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pendingPerms.delete(id);
      signal?.removeEventListener('abort', onAbort);
      send('permission_done', { id, decision });
      if (decision === 'always') { always.add(tool); alwaysAllowed.set(convId, always); }
      resolve(decision === 'deny'
        ? { behavior: 'deny', message: message || 'L’utilisateur a refusé cette action. Propose une autre approche ou demande-lui.' }
        : { behavior: 'allow', updatedInput: req.input });
    };
    const onAbort = () => finish('deny', 'Arrêté par l’utilisateur.');
    const timer = setTimeout(() => finish('deny', 'Pas de réponse de l’utilisateur.'), 280000);
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingPerms.set(id, finish);
    send('permission', { id, tool, title: d.title, detail: d.detail, diff: d.diff, kind: d.kind });
  });
}

/* ---------- Discussion (flux SSE) ---------- */
async function handleChat(req, res) {
  const { conversationId, text, mode = 'claude', skill, relay: relayId, direct: direct0, project, perm, effort, attachments: attIds, command, style, web } = await readBody(req);
  if (!String(text || '').trim()) return json(res, 400, { error: 'Message vide' });
  const attachments = (Array.isArray(attIds) ? attIds : []).slice(0, 12).map(getUpload).filter(Boolean);
  if (!MODES.includes(mode)) return json(res, 400, { error: 'Mode inconnu' });

  const cfg = getConfig();
  // Réglages de ce message : style de réponse, recherche web, réflexion
  cfg.responseStyle = typeof style === 'string' ? style : '';
  cfg.webSearch = !!web;
  cfg.effort = effort;
  await connectorStatus(cfg);
  const av = available(cfg);
  // Recherche web : avec Perplexity connecté, c'est lui qui cherche (à la place du plugin web d'OpenRouter).
  cfg.perplexitySearch = cfg.webSearch && av.perplexity;
  const isShell = command === 'shell';
  const isCompact = command === 'compact';
  const msgText = isCompact ? `${COMPACT_PROMPT}${String(text).replace(/^\/compact\s*/, '').trim() ? `\nPoints à garder en priorité : ${String(text).replace(/^\/compact\s*/, '').trim()}` : ''}` : String(text);
  const intent = isShell || isCompact ? { relay: null } : withEngine(detectIntent(text), av[{ chatgpt: 'imageChatgpt', grok: 'imageGrok', gemini: 'imageGemini' }[cfg.IMAGE_ENGINE]] ? cfg.IMAGE_ENGINE : 'chatgpt');
  // Une @mention (« @grok une image de… ») vaut un relais explicite ; sinon c'est un simple indice pour Claude.
  let relay = relayId ? getRelay(relayId) : intent.explicit ? getRelay(intent.relay) : null;
  const hint = !relay && intent.relay ? getRelay(intent.relay) : null;
  let direct = !!direct0;
  let effMode = mode;
  const IMAGE_AV = { chatgpt: 'imageChatgpt', grok: 'imageGrok', gemini: 'imageGemini' };
  // Sans Claude, on route quand même la demande vers l'IA disponible.
  if (mode === 'claude' && !av.claude && !(relay && direct)) {
    const target = relay || hint;
    const engineOk = (e) => (target?.kind === 'image' ? av[IMAGE_AV[e]] : av[e]);
    if (target && ['image', 'ask'].includes(target.kind) && engineOk(target.engine)) { relay = target; direct = true; }
    else effMode = ['chatgpt', 'gemini', 'grok', 'perplexity'].find((k) => av[k]) || 'claude';
  }
  // En conversation directe avec ChatGPT, Grok ou Gemini, une demande d'image part chez eux.
  if (!relay && IMAGE_AV[effMode] && av[IMAGE_AV[effMode]] && intent.kind === 'image') {
    relay = { id: `image-${effMode}`, label: `Image · ${NAMES[effMode]}`, kind: 'image', engine: effMode };
    direct = true;
  }
  let conv = conversationId && getConversation(conversationId);
  if (!conv) {
    const t = String(text).trim().replace(/\s+/g, ' ');
    let proj = null;
    if (project) { try { proj = touchProject(project).path; } catch (e) { return json(res, 400, { error: e.message }); } }
    conv = { id: newId(), title: t.length > 60 ? `${t.slice(0, 57)}…` : t, mode, createdAt: Date.now(), messages: [], project: proj };
  } else if (conv.project) {
    try { touchProject(conv.project); } catch { /* dossier déplacé */ }
  }
  conv.mode = mode;
  if (PERMS.includes(perm)) conv.perm = perm;
  const forcedSkill = skill ? getSkill(skill) : null;
  const inProject = !!conv.project;
  // En projet, l'IA choisie code elle-même ; seules les images « directes » passent à côté.
  if (inProject) {
    effMode = mode;
    if (relay && !(direct && relay.kind === 'image')) direct = false;
  }
  const directRelay = relay && direct && ['image', 'ask'].includes(relay.kind);
  if (isShell && !inProject) return json(res, 400, { error: 'Les commandes « ! » se lancent dans un projet ouvert.' });
  conv.messages.push({
    role: 'user', text: msgText, skill: forcedSkill?.slug, relay: relay?.id, direct: !!directRelay, at: Date.now(),
    ...(attachments.length ? { attachments } : {}), ...(command ? { command } : {}),
  });

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  send('conversation', { id: conv.id, title: conv.title, project: conv.project });
  const turn = new Turn(send);
  turn.convId = conv.id;
  const started = Date.now();
  const agent = isShell ? 'shell' : directRelay ? relay.engine : inProject ? effMode : (relay || effMode === 'claude') ? 'claude' : effMode;
  send('route', { agent, relay: relay?.label || null, direct: !!directRelay, project: inProject, fallback: !inProject && (effMode !== mode || (directRelay && !direct0)) });
  let error = null;

  try {
    if (isShell) {
      const cmd = String(text).replace(/^\s*!/, '').trim();
      turn.step({ id: 'shell', agent: 'shell', kind: 'command', title: `Commande · ${cmd.slice(0, 60)}`, input: cmd, status: 'running', output: '' });
      let acc = '';
      let last = 0;
      const r = await shellCommand(conv.project, cmd, {
        signal: controller.signal,
        onData: (d) => { acc += d; if (Date.now() - last > 200) { last = Date.now(); turn.step({ id: 'shell', output: acc.slice(-8000) }); } },
      });
      turn.step({ id: 'shell', status: r.code === 0 ? 'done' : 'error', output: r.output.slice(-20000) || '(aucune sortie)', exitCode: r.code });
    } else if (!MODES.some((k) => av[k])) throw new Error('Aucune IA n’est connectée. Ouvre Réglages → Connexions pour connecter Claude, ChatGPT, Grok, Gemini ou Perplexity.');
    else if (directRelay) await runRelayDirect({ cfg: inProject ? { ...cfg, PROJECT_DIR: conv.project, imageExport: true } : cfg, relay, text: stripMentions(text), turn, signal: controller.signal });
    else if (inProject) {
      if (agent === 'perplexity') throw new Error('Perplexity sert à chercher sur le web : il ne code pas dans un projet. Choisis Claude, ChatGPT, Grok ou Gemini (Claude peut lui confier des recherches).');
      if (!av[agent]) throw new Error(`${{ chatgpt: 'ChatGPT (Codex)', gemini: 'Gemini' }[agent] || NAMES[agent]} n’est pas connecté. Réglages → Connexions.`);
      await runProject({
        cfg, conv, agent, perm: isCompact ? 'read' : conv.perm || 'ask', effort: isCompact ? 'normal' : effort, forcedSkill, relay, hint, turn, signal: controller.signal, baseUrl: BASE_URL,
        askPermission: makeAsker(conv.id, send, controller.signal),
      });
    } else if (agent === 'claude') await runClaude({ cfg, conv, forcedSkill, relay, hint, turn, signal: controller.signal, baseUrl: BASE_URL });
    else await runDirect({ cfg, provider: agent, conv, forcedSkill, turn, signal: controller.signal });
  } catch (e) {
    error = controller.signal.aborted ? 'Arrêté.' : e.message;
    if (!controller.signal.aborted) console.error('[chat]', e.message);
  }

  conv.messages.push({ role: 'assistant', agent, skill: forcedSkill?.slug, relay: relay?.id, parts: turn.parts, error, ms: Date.now() - started, at: Date.now(), ...(turn.stats ? { stats: turn.stats } : {}), ...(command ? { command } : {}) });
  // /compact : le résumé remplace l'historique, les sessions des agents repartent de zéro.
  if (isCompact && !error) {
    const summary = turn.parts.filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
    if (summary) { conv.summary = summary; conv.compactFrom = conv.messages.length; conv.sessions = {}; send('compacted', { at: conv.compactFrom }); }
  }
  saveConversation(conv);
  if (error) send('error', { message: error });
  send('done', { ms: Date.now() - started });
  res.end();
}

/* ---------- Test d'une connexion ---------- */
async function testConnector(id) {
  const cfg = getConfig();
  const started = Date.now();
  const sink = new Turn(() => {});
  if (id === 'claude') {
    const conv = { messages: [{ role: 'user', text: 'Test de connexion : réponds uniquement « OK ».' }] };
    await runClaude({ cfg: { ...cfg, maxSteps: 2 }, conv, turn: sink, signal: AbortSignal.timeout(120000), baseUrl: BASE_URL });
    const text = sink.parts.filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
    return { ok: true, reply: text.slice(0, 200), ms: Date.now() - started };
  }
  const provider = id === 'codex' ? 'chatgpt' : id;
  const reply = await askAgent({ cfg, provider, prompt: provider === 'perplexity' ? 'Test de connexion : quelle est la date du jour ? Réponds en une phrase courte.' : 'Test de connexion : réponds uniquement « OK ».', signal: AbortSignal.timeout(120000) });
  return { ok: true, reply: String(reply).slice(0, 200), ms: Date.now() - started };
}

/* ---------- Routeur ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const m = req.method;

  try {
    if (m !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Origine refusée' });

    /* Pont MCP (appelé par Claude Code via lib/mcp-bridge.js) */
    if (p === '/internal/tools' && m === 'POST') {
      const { token } = await readBody(req);
      const s = toolSession(token);
      if (!s) return json(res, 403, { error: 'Jeton invalide' });
      return json(res, 200, { tools: buildTools(s.cfg, { coding: !!s.project }) });
    }
    if (p === '/internal/call' && m === 'POST') {
      const { token, name, input } = await readBody(req);
      const s = toolSession(token);
      if (!s) return json(res, 403, { error: 'Jeton invalide' });
      return json(res, 200, await runTool(name, input, s));
    }

    if (p === '/api/status' && m === 'GET') {
      const cfg = getConfig();
      await connectorStatus(cfg);
      return json(res, 200, { available: available(cfg), settings: publicSettings(), skills: listSkills().length, relays: RELAYS, voice: voiceEngines(cfg), platform: process.platform });
    }
    if (p === '/api/settings' && m === 'POST') {
      saveConfig(await readBody(req));
      invalidateStatus();
      await connectorStatus(getConfig());
      return json(res, 200, { settings: publicSettings(), available: available(getConfig()) });
    }

    if (p === '/api/connectors' && m === 'GET') {
      const status = await connectorStatus(getConfig(), { force: url.searchParams.has('force') });
      for (const id of ['claude', 'codex', 'grok', 'gemini']) { status[id].job = installJob(id); status[id].login = loginState(id); }
      return json(res, 200, status);
    }
    let r = p.match(/^\/api\/connectors\/(claude|codex|grok|gemini)\/login(\/code)?$/);
    if (r) {
      const [, id, isCode] = r;
      if (m === 'GET') return json(res, 200, loginState(id) || {});
      if (m === 'DELETE') { cancelLogin(id); return json(res, 200, { ok: true }); }
      if (m === 'POST' && isCode) { submitLoginCode(id, (await readBody(req)).code || ''); return json(res, 200, loginState(id)); }
      if (m === 'POST') return json(res, 200, startLogin(id, getConfig()));
    }
    /* OpenRouter : une seule clé, aucune installation */
    if (p === '/api/openrouter/key' && m === 'GET') {
      try { return json(res, 200, await orKeyInfo(getConfig())); } catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (p === '/api/openrouter/use' && m === 'POST') {
      // Bascule toutes les IA sur OpenRouter (les autres connexions restent enregistrées)
      const { agents = MODES } = await readBody(req);
      const patch = {};
      for (const a of agents) if (AUTH_KEY[a]) patch[AUTH_KEY[a]] = 'openrouter';
      saveConfig(patch);
      invalidateStatus();
      return json(res, 200, { settings: publicSettings(), available: available(getConfig()) });
    }
    if (p === '/api/connectors/slim' && m === 'POST') { const msg = slim(); invalidateStatus(); return json(res, 200, { message: msg }); }
    r = p.match(/^\/api\/connectors\/(claude|codex|grok|gemini|perplexity)\/(install|logout|test)$/);
    if (r && m === 'POST') {
      const [, id, action] = r;
      if (id === 'perplexity' && action !== 'test') return json(res, 400, { error: 'Perplexity n’a pas d’outil à installer.' });
      if (action === 'install') return json(res, 200, install(id));
      if (action === 'logout') { await logout(id, getConfig()); return json(res, 200, { ok: true }); }
      try { return json(res, 200, await testConnector(id)); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }

    if (p === '/api/chat' && m === 'POST') return await handleChat(req, res);

    /* Voix → texte */
    if (p === '/api/transcribe' && m === 'POST') {
      const wav = await readRaw(req, 30_000_000);
      try { return json(res, 200, await transcribe(getConfig(), wav, { lang: url.searchParams.get('lang') || undefined })); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* Pièces jointes */
    if (p === '/api/upload' && m === 'POST') {
      try { return json(res, 200, saveUpload(await readBody(req, 30_000_000))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* Mémoire (faits durables sur l'utilisateur) */
    if (p === '/api/memory' && m === 'GET') return json(res, 200, { text: readUserMemory() });
    if (p === '/api/memory' && m === 'PUT') return json(res, 200, { text: writeUserMemory((await readBody(req)).text) });

    /* Serveurs MCP supplémentaires */
    if (p === '/api/mcp' && m === 'GET') return json(res, 200, readMcp());
    if (p === '/api/mcp' && m === 'PUT') {
      try { return json(res, 200, writeMcp((await readBody(req)).text)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* Autorisations */
    r = p.match(/^\/api\/permission\/([a-f0-9]{16})$/);
    if (r && m === 'POST') {
      const finish = pendingPerms.get(r[1]);
      if (!finish) return json(res, 404, { error: 'Demande expirée.' });
      const { decision } = await readBody(req);
      finish(['allow', 'always', 'deny'].includes(decision) ? decision : 'deny');
      return json(res, 200, { ok: true });
    }

    /* Projets */
    if (p === '/api/projects' && m === 'GET') return json(res, 200, listProjects());
    if (p === '/api/projects' && m === 'POST') {
      try { return json(res, 200, touchProject((await readBody(req)).path)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/projects/pick' && m === 'POST') {
      const dir = await pickFolder();
      if (!dir) return json(res, 200, { cancelled: true });
      try { return json(res, 200, touchProject(dir)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/projects/forget' && m === 'POST') { forgetProject((await readBody(req)).path); return json(res, 200, { ok: true }); }
    if (p === '/api/projects/reveal' && m === 'POST') {
      try { revealFolder((await readBody(req)).path); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p.startsWith('/api/projects/') && ['files', 'git', 'git/diff', 'git/commit', 'memory'].includes(p.slice(14))) {
      const sub = p.slice(14);
      const body = m === 'GET' ? {} : await readBody(req);
      const dir = url.searchParams.get('path') || body.path;
      try {
        if (sub === 'files') return json(res, 200, projectFiles(dir, url.searchParams.get('q') || ''));
        if (sub === 'git') return json(res, 200, await gitStatus(dir));
        if (sub === 'git/diff') return json(res, 200, await gitDiff(dir, url.searchParams.get('file') || body.file));
        if (sub === 'git/commit' && m === 'POST') return json(res, 200, await gitCommit(dir, body.message));
        if (sub === 'memory' && m === 'GET') return json(res, 200, readMemory(dir, url.searchParams.get('name') || 'CLAUDE.md'));
        if (sub === 'memory' && m === 'PUT') return json(res, 200, writeMemory(dir, body.name || 'CLAUDE.md', body.text));
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/projects/info' && m === 'POST') {
      try { const { path: dir } = await readBody(req); return json(res, 200, { path: dir, name: path.basename(dir), type: detectType(dir) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/conversations' && m === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const list = listConversations();
      if (!q) return json(res, 200, list);
      // Recherche dans le contenu des messages, pas seulement les titres
      const hits = [];
      for (const c of list) {
        if ((c.title || '').toLowerCase().includes(q)) { hits.push(c); continue; }
        const full = getConversation(c.id);
        for (const msg of full?.messages || []) {
          const txt = msg.role === 'user' ? msg.text : (msg.parts || []).filter((x) => x.type === 'text').map((x) => x.text).join(' ');
          const i = String(txt || '').toLowerCase().indexOf(q);
          if (i >= 0) { hits.push({ ...c, snippet: String(txt).slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ') }); break; }
        }
      }
      return json(res, 200, hits);
    }
    if (p === '/api/conversations' && m === 'DELETE') {
      for (const c of listConversations()) deleteConversation(c.id);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/export' && m === 'GET') {
      const all = listConversations().map((c) => getConversation(c.id));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="relais-conversations.json"' });
      return res.end(JSON.stringify(all, null, 2));
    }
    r = p.match(/^\/api\/conversations\/([a-f0-9]{16})\/(truncate|fork|export\.md)$/);
    if (r) {
      const c = getConversation(r[1]);
      if (!c) return json(res, 404, { error: 'Introuvable' });
      if (r[2] === 'truncate' && m === 'POST') {
        // Modifier un message : on repart de ce point, les sessions des agents sont reconstruites depuis l'historique.
        const at = Math.max(0, Math.min(Number((await readBody(req)).at) || 0, c.messages.length));
        c.messages = c.messages.slice(0, at);
        c.sessions = {};
        if (c.compactFrom && c.compactFrom > at) { delete c.summary; delete c.compactFrom; }
        saveConversation(c);
        return json(res, 200, { ok: true, count: c.messages.length });
      }
      if (r[2] === 'fork' && m === 'POST') {
        const at = Number((await readBody(req)).at);
        const copy = { ...c, id: newId(), title: `${c.title} (copie)`.slice(0, 80), createdAt: Date.now(), messages: Number.isFinite(at) && at > 0 ? c.messages.slice(0, at) : c.messages, sessions: {}, pinned: false };
        saveConversation(copy);
        return json(res, 200, { id: copy.id });
      }
      if (r[2] === 'export.md' && m === 'GET') {
        const lines = [`# ${c.title}`, '', c.project ? `Projet : \`${c.project}\`\n` : ''];
        for (const msg of c.messages) {
          if (msg.role === 'user') { lines.push(`## Toi${msg.command === 'shell' ? ' (commande)' : ''}`, '', msg.text, ''); continue; }
          lines.push(`## ${msg.agent === 'shell' ? 'Terminal' : NAMES[msg.agent] || 'Claude'}`, '');
          for (const part of msg.parts || []) {
            if (part.type === 'text') lines.push(part.text, '');
            else if (part.type === 'step' && part.kind !== 'thinking') lines.push(`> ${part.title}${part.status === 'error' ? ' (erreur)' : ''}`, '');
            else if (part.type === 'plan') lines.push('### Plan', '', part.text, '');
            else if (part.type === 'todos') lines.push(...(part.items || []).map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.text}`), '');
            else if (part.type === 'image') lines.push(`![${part.prompt || 'image'}](${part.url})`, '');
          }
          if (msg.error) lines.push(`> Erreur : ${msg.error}`, '');
        }
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="relais-${c.id}.md"` });
        return res.end(lines.join('\n'));
      }
    }
    r = p.match(/^\/api\/conversations\/([a-f0-9]{16})$/);
    if (r && m === 'GET') { const c = getConversation(r[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'Introuvable' }); }
    if (r && m === 'DELETE') return json(res, 200, { ok: deleteConversation(r[1]) });
    if (r && m === 'PATCH') {
      const c = getConversation(r[1]);
      if (!c) return json(res, 404, { error: 'Introuvable' });
      const { title, pinned } = await readBody(req);
      if (title) c.title = String(title).slice(0, 80);
      if (pinned !== undefined) c.pinned = !!pinned;
      saveConversation(c);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/models' && m === 'GET') return json(res, 200, await listModels(getConfig()));
    if (p === '/api/usage' && m === 'GET') return json(res, 200, usageSummary());

    if (p === '/api/images' && m === 'GET') {
      const imgs = fs.readdirSync(paths.images)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .map((f) => ({ url: `/images/${f}`, at: fs.statSync(path.join(paths.images, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      return json(res, 200, imgs);
    }

    if (p === '/api/skills' && m === 'GET') return json(res, 200, listSkills({ all: url.searchParams.has('all') }));
    if (p === '/api/skills' && m === 'POST') {
      try { return json(res, 200, saveSkill(await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/skills/packs' && m === 'GET') return json(res, 200, { packs: listPacks(), catalog: CATALOG.map(({ include, skip, ...c }) => c) });
    if (p === '/api/skills/import/claude' && m === 'POST') {
      try { return json(res, 200, { report: importClaudeSkills() }); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/skills/import/github' && m === 'POST') {
      const { id, repo } = await readBody(req);
      const preset = CATALOG.find((c) => c.id === id);
      try { return json(res, 200, await importGithub(preset || { repo })); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    r = p.match(/^\/api\/skills\/packs\/([a-z0-9-]{1,64})$/);
    if (r && m === 'POST') { const { enabled } = await readBody(req); return json(res, 200, { count: setPackEnabled(r[1], !!enabled) }); }
    if (r && m === 'DELETE') { try { return json(res, 200, { ok: removePack(r[1]) }); } catch (e) { return json(res, 400, { error: e.message }); } }
    r = p.match(/^\/api\/skills\/([a-z0-9-]{1,64})(\/toggle)?$/);
    if (r && r[2] && m === 'POST') {
      try { return json(res, 200, setSkillEnabled(r[1], !!(await readBody(req)).enabled)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (r && m === 'GET') { const s = getSkill(r[1]); return s ? json(res, 200, s) : json(res, 404, { error: 'Introuvable' }); }
    if (r && m === 'PUT') {
      try { return json(res, 200, saveSkill({ ...(await readBody(req)), slug: r[1] })); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (r && m === 'DELETE') return json(res, 200, { ok: deleteSkill(r[1]) });

    /* Designs (maquettes HTML créées par Claude) */
    if (p === '/api/designs' && m === 'GET') return json(res, 200, listDesigns());
    r = p.match(/^\/api\/designs\/([a-f0-9]{16})$/);
    if (r && m === 'DELETE') return json(res, 200, { ok: deleteDesign(r[1]) });
    if (r && m === 'POST') {
      try { const { dir } = await readBody(req); return json(res, 200, exportDesign(r[1], dir)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    r = p.match(/^\/designs\/([a-f0-9]{16})\.html$/);
    if (r && m === 'GET') {
      const html = readDesign(r[1]);
      if (html == null) return json(res, 404, { error: 'Introuvable' });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        // Isolé de Relais : la maquette ne peut pas appeler l'API locale, même ouverte seule.
        'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
        ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="design-${r[1]}.html"` } : {}),
      });
      return res.end(html);
    }

    if (p.startsWith('/images/') && m === 'GET') return serveFile(res, paths.images, p.slice(8));
    if (p.startsWith('/uploads/') && m === 'GET') return serveFile(res, paths.uploads, p.slice(9));
    if (p.startsWith('/api/') || p.startsWith('/internal/')) return json(res, 404, { error: 'Route inconnue' });
    if (m === 'GET') return serveFile(res, paths.public, p === '/' ? 'index.html' : p.slice(1));
    json(res, 405, { error: 'Méthode non autorisée' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Relais est prêt → ${BASE_URL}\n`);
  connectorStatus(getConfig()).catch(() => {});
});
