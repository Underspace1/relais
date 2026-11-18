import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { paths, getConfig, saveConfig, publicSettings } from './lib/config.js';
import { listConversations, getConversation, saveConversation, deleteConversation, newId } from './lib/store.js';
import { listSkills, getSkill, saveSkill, deleteSkill, listPacks, setSkillEnabled, setPackEnabled } from './lib/skills.js';
import { CATALOG, importClaudeSkills, importGithub, removePack } from './lib/skill-import.js';
import { listDesigns, readDesign, deleteDesign, exportDesign } from './lib/designs.js';
import { RELAYS, getRelay } from './lib/relays.js';
import { detectIntent, stripMentions } from './public/intent.js';
import { connectorStatus, install, installJob, startLogin, loginState, submitLoginCode, cancelLogin, logout, invalidateStatus, slim } from './lib/connectors.js';
import { Turn, runClaude, runDirect, runRelayDirect, runProject, runTool, buildTools, available, toolSession, askAgent } from './lib/orchestrator.js';
import { PERMS, describeTool } from './lib/coders.js';
import { listProjects, touchProject, forgetProject, pickFolder, revealFolder, detectType } from './lib/projects.js';
import crypto from 'node:crypto';
import { listModels } from './lib/models.js';
import { usageSummary } from './lib/usage.js';

const PORT = Number(getConfig().PORT) || 4321;
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
};

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('Requête trop grande')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return json(res, 403, { error: 'Interdit' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Introuvable' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': root === paths.images ? 'public, max-age=31536000, immutable' : 'no-cache',
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
  const { conversationId, text, mode = 'claude', skill, relay: relayId, direct: direct0, project, perm } = await readBody(req);
  if (!String(text || '').trim()) return json(res, 400, { error: 'Message vide' });
  if (!['claude', 'chatgpt', 'grok'].includes(mode)) return json(res, 400, { error: 'Mode inconnu' });

  const cfg = getConfig();
  await connectorStatus(cfg);
  const av = available(cfg);
  const intent = detectIntent(text);
  // Une @mention (« @grok une image de… ») vaut un relais explicite ; sinon c'est un simple indice pour Claude.
  let relay = relayId ? getRelay(relayId) : intent.explicit ? getRelay(intent.relay) : null;
  const hint = !relay && intent.relay ? getRelay(intent.relay) : null;
  let direct = !!direct0;
  let effMode = mode;
  // Sans Claude, on route quand même la demande vers l'IA disponible.
  if (mode === 'claude' && !av.claude && !(relay && direct)) {
    const target = relay || hint;
    const engineOk = (e) => (target?.kind === 'image' ? av[e === 'grok' ? 'imageGrok' : 'imageChatgpt'] : av[e]);
    if (target && ['image', 'ask'].includes(target.kind) && engineOk(target.engine)) { relay = target; direct = true; }
    else if (av.chatgpt) effMode = 'chatgpt';
    else if (av.grok) effMode = 'grok';
  }
  // En conversation directe avec ChatGPT ou Grok, une demande d'image part chez eux.
  if (!relay && effMode !== 'claude' && intent.kind === 'image') {
    relay = { id: `image-${effMode}`, label: `Image · ${effMode === 'grok' ? 'Grok' : 'ChatGPT'}`, kind: 'image', engine: effMode };
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
  conv.messages.push({ role: 'user', text: String(text), skill: forcedSkill?.slug, relay: relay?.id, direct: !!directRelay, at: Date.now() });

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  send('conversation', { id: conv.id, title: conv.title, project: conv.project });
  const turn = new Turn(send);
  turn.convId = conv.id;
  const started = Date.now();
  const agent = directRelay ? relay.engine : inProject ? effMode : (relay || effMode === 'claude') ? 'claude' : effMode;
  send('route', { agent, relay: relay?.label || null, direct: !!directRelay, project: inProject, fallback: !inProject && (effMode !== mode || (directRelay && !direct0)) });
  let error = null;

  try {
    if (!av.claude && !av.chatgpt && !av.grok) throw new Error('Aucune IA n’est connectée. Ouvre Réglages → Connexions pour connecter ton compte Claude, ChatGPT ou Grok.');
    if (directRelay) await runRelayDirect({ cfg: inProject ? { ...cfg, PROJECT_DIR: conv.project, imageExport: true } : cfg, relay, text: stripMentions(text), turn, signal: controller.signal });
    else if (inProject) {
      const auth = { claude: 'CLAUDE_AUTH', chatgpt: 'OPENAI_AUTH', grok: 'XAI_AUTH' }[agent];
      if (cfg[auth] !== 'account') throw new Error(`Pour coder dans un projet, ${agent === 'chatgpt' ? 'ChatGPT' : agent === 'grok' ? 'Grok' : 'Claude'} doit être connecté par ton compte (Réglages → Connexions → Mon compte).`);
      if (!av[agent]) throw new Error(`${agent === 'chatgpt' ? 'ChatGPT (Codex)' : agent === 'grok' ? 'Grok' : 'Claude'} n’est pas connecté. Réglages → Connexions.`);
      await runProject({
        cfg, conv, agent, perm: conv.perm || 'ask', forcedSkill, relay, hint, turn, signal: controller.signal, baseUrl: BASE_URL,
        askPermission: makeAsker(conv.id, send, controller.signal),
      });
    } else if (agent === 'claude') await runClaude({ cfg, conv, forcedSkill, relay, hint, turn, signal: controller.signal, baseUrl: BASE_URL });
    else await runDirect({ cfg, provider: agent, conv, forcedSkill, turn, signal: controller.signal });
  } catch (e) {
    error = controller.signal.aborted ? 'Arrêté.' : e.message;
    if (!controller.signal.aborted) console.error('[chat]', e.message);
  }

  conv.messages.push({ role: 'assistant', agent, skill: forcedSkill?.slug, relay: relay?.id, parts: turn.parts, error, ms: Date.now() - started, at: Date.now() });
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
  const provider = id === 'codex' ? 'chatgpt' : 'grok';
  const reply = await askAgent({ cfg, provider, prompt: 'Test de connexion : réponds uniquement « OK ».', signal: AbortSignal.timeout(120000) });
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
      return json(res, 200, { available: available(cfg), settings: publicSettings(), skills: listSkills().length, relays: RELAYS });
    }
    if (p === '/api/settings' && m === 'POST') {
      saveConfig(await readBody(req));
      invalidateStatus();
      await connectorStatus(getConfig());
      return json(res, 200, { settings: publicSettings(), available: available(getConfig()) });
    }

    if (p === '/api/connectors' && m === 'GET') {
      const status = await connectorStatus(getConfig(), { force: url.searchParams.has('force') });
      for (const id of ['claude', 'codex', 'grok']) { status[id].job = installJob(id); status[id].login = loginState(id); }
      return json(res, 200, status);
    }
    let r = p.match(/^\/api\/connectors\/(claude|codex|grok)\/login(\/code)?$/);
    if (r) {
      const [, id, isCode] = r;
      if (m === 'GET') return json(res, 200, loginState(id) || {});
      if (m === 'DELETE') { cancelLogin(id); return json(res, 200, { ok: true }); }
      if (m === 'POST' && isCode) { submitLoginCode(id, (await readBody(req)).code || ''); return json(res, 200, loginState(id)); }
      if (m === 'POST') return json(res, 200, startLogin(id, getConfig()));
    }
    if (p === '/api/connectors/slim' && m === 'POST') { const msg = slim(); invalidateStatus(); return json(res, 200, { message: msg }); }
    r = p.match(/^\/api\/connectors\/(claude|codex|grok)\/(install|logout|test)$/);
    if (r && m === 'POST') {
      const [, id, action] = r;
      if (action === 'install') return json(res, 200, install(id));
      if (action === 'logout') { await logout(id, getConfig()); return json(res, 200, { ok: true }); }
      try { return json(res, 200, await testConnector(id)); }
      catch (e) { return json(res, 200, { ok: false, error: e.message }); }
    }

    if (p === '/api/chat' && m === 'POST') return await handleChat(req, res);

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
    if (p === '/api/projects/info' && m === 'POST') {
      try { const { path: dir } = await readBody(req); return json(res, 200, { path: dir, name: path.basename(dir), type: detectType(dir) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (p === '/api/conversations' && m === 'GET') return json(res, 200, listConversations());
    if (p === '/api/conversations' && m === 'DELETE') {
      for (const c of listConversations()) deleteConversation(c.id);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/export' && m === 'GET') {
      const all = listConversations().map((c) => getConversation(c.id));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="relais-conversations.json"' });
      return res.end(JSON.stringify(all, null, 2));
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
