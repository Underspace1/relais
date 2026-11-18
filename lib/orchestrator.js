import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { claudeStream, chatStream, generateImage } from './providers.js';
import { resolveCli, lastStatus, claudeAccountTurn, codexAsk, codexImage, grokAsk } from './connectors.js';
import { runCursorAgent } from './cursor.js';
import { runCoder } from './coders.js';
import { detectType } from './projects.js';
import { listSkills, getSkill, saveSkill, skillPrompt, readSkillFile } from './skills.js';
import { saveDesign } from './designs.js';

const LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok', cursor: 'Cursor' };

/* ---------- Le « tour » : enregistre les parties de la réponse et les envoie au navigateur ---------- */
export class Turn {
  constructor(send) {
    this.send = send;
    this.parts = [];
  }
  text(delta) {
    if (!delta) return;
    const last = this.parts.at(-1);
    if (last?.type === 'text') last.text += delta;
    else this.parts.push({ type: 'text', text: delta });
    this.send('text', { delta });
  }
  step(step) {
    const i = this.parts.findIndex((p) => p.type === 'step' && p.id === step.id);
    if (i >= 0) this.parts[i] = { ...this.parts[i], ...step };
    else this.parts.push({ type: 'step', startedAt: Date.now(), ...step });
    const part = this.parts[i >= 0 ? i : this.parts.length - 1];
    if (step.status && step.status !== 'running' && !part.ms) part.ms = Date.now() - (part.startedAt || Date.now());
    this.send('step', { step: part });
  }
  image(img) {
    this.parts.push({ type: 'image', ...img });
    this.send('image', { image: img });
  }
  design(d) {
    const i = this.parts.findIndex((p) => p.type === 'design' && p.id === d.id);
    if (i >= 0) this.parts[i] = { type: 'design', ...d };
    else this.parts.push({ type: 'design', ...d });
    this.send('design', { design: d });
  }
}

/** Un agent délégué : ses actions s'affichent dans le fil, son texte revient à Claude. */
class SubTurn {
  constructor(parent, prefix) {
    this.parent = parent;
    this.prefix = prefix;
    this.parts = [];
    this.textOut = '';
    this.send = parent.send;
  }
  text(d) { this.textOut += d; }
  step(s) { this.parent.step({ ...s, id: `${this.prefix}:${s.id}` }); }
  image(img) { this.parent.image(img); }
  design(d) { this.parent.design(d); }
  get convId() { return this.parent.convId; }
}

function throttle(fn, ms = 250) {
  let last = 0;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
  };
}

/* ==========================================================================
   Disponibilité des IA selon le mode de connexion
   ========================================================================== */
export function available(cfg) {
  const acc = (k) => cfg[k] === 'account';
  const st = lastStatus();
  // Installé ET pas signalé comme déconnecté (si l'état n'est pas encore connu, on suppose que oui)
  const ready = (id) => !!resolveCli(id, cfg) && st?.[id]?.connected !== false;
  return {
    claude: acc('CLAUDE_AUTH') ? ready('claude') : !!cfg.ANTHROPIC_API_KEY,
    chatgpt: acc('OPENAI_AUTH') ? ready('codex') : !!cfg.OPENAI_API_KEY,
    grok: acc('XAI_AUTH') ? ready('grok') : !!cfg.XAI_API_KEY,
    imageChatgpt: acc('OPENAI_AUTH') ? ready('codex') : !!cfg.OPENAI_API_KEY,
    imageGrok: !!cfg.XAI_API_KEY,
    cursor: cfg.cursorEnabled && !!cfg.cursorWorkspace,
  };
}

/** Demande texte à ChatGPT ou Grok, par compte ou par clé API. */
export async function askAgent({ cfg, provider, prompt, messages, signal, onText }) {
  const viaAccount = cfg[provider === 'chatgpt' ? 'OPENAI_AUTH' : 'XAI_AUTH'] === 'account';
  if (viaAccount) {
    const text = prompt ?? transcriptPrompt(messages);
    if (provider === 'chatgpt') {
      const answer = await codexAsk({ cfg, prompt: text, signal });
      onText?.(answer);
      return answer;
    }
    return grokAsk({ cfg, prompt: text, signal, onText });
  }
  return chatStream({ cfg, provider, messages: messages || [{ role: 'user', content: prompt }], signal, onText });
}

/** Génère une image et la range dans data/images (et dans le projet si demandé). */
export async function makeImage({ cfg, engine, prompt, size, signal }) {
  let img;
  if (engine === 'chatgpt' && cfg.OPENAI_AUTH === 'account') {
    const src = await codexImage({ cfg, prompt, size, signal });
    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}${path.extname(src).toLowerCase() || '.png'}`;
    fs.copyFileSync(src, path.join(paths.images, file));
    img = { id, url: `/images/${file}` };
  } else {
    if (engine === 'grok' && !cfg.XAI_API_KEY) throw new Error('Les images Grok passent par l’API xAI : ajoute une clé xAI dans Réglages → Connexions.');
    img = await generateImage({ cfg, engine, prompt, size, signal });
  }
  if (cfg.imageExport) {
    try {
      const dir = path.join(cfg.PROJECT_DIR, 'relais-assets');
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(img.url);
      fs.copyFileSync(path.join(paths.images, name), path.join(dir, name));
      img.exported = path.join(dir, name);
    } catch { /* export facultatif */ }
  }
  return img;
}

/* ==========================================================================
   Outils proposés à Claude
   ========================================================================== */
export function buildTools(cfg, { coding = false } = {}) {
  const av = available(cfg);
  const tools = [];
  const promptSchema = { type: 'object', properties: { prompt: { type: 'string', description: 'Consigne complète et autonome.' } }, required: ['prompt'] };
  if (coding) {
    tools.push({
      name: 'permission_prompt',
      description: 'Usage interne de Relais (demande d’autorisation à l’utilisateur). Ne l’appelle pas toi-même.',
      input_schema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    });
    if (av.chatgpt) tools.push({ name: 'codex_task', description: 'Confie une tâche de code à Codex (ChatGPT), qui travaille dans le même dossier projet avec les mêmes autorisations. Utile pour paralléliser, obtenir une seconde implémentation, ou une relecture qui corrige directement. Consigne précise : fichiers, comportement attendu, critères de réussite.', input_schema: promptSchema });
    if (av.grok) tools.push({ name: 'grok_task', description: 'Confie une tâche de code à Grok Build, qui travaille dans le même dossier projet avec les mêmes autorisations. Consigne précise : fichiers, comportement attendu, critères de réussite.', input_schema: promptSchema });
  }
  if (av.chatgpt) tools.push({ name: 'ask_chatgpt', description: 'Envoie une question ou une tâche à ChatGPT et renvoie sa réponse (deuxième avis, rédaction, idées). ChatGPT ne voit PAS la conversation : consigne complète.', input_schema: promptSchema });
  if (av.grok) tools.push({ name: 'ask_grok', description: 'Envoie une question ou une tâche à Grok et renvoie sa réponse (avis alternatif, ton direct, humour). Grok ne voit PAS la conversation : consigne complète.', input_schema: promptSchema });

  const engines = [av.imageChatgpt && 'chatgpt', av.imageGrok && 'grok'].filter(Boolean);
  if (engines.length) {
    const def = engines.includes(cfg.IMAGE_ENGINE) ? cfg.IMAGE_ENGINE : engines[0];
    tools.push({
      name: 'generate_image',
      description: `Génère une image et l'affiche directement à l'utilisateur. Moteurs : ${engines.join(', ')} (défaut : ${def}). "chatgpt" : fidélité au prompt et texte dans l'image. "grok" : rapide et stylisé. Prompt en anglais, précis : sujet, style, cadrage, lumière, palette.`,
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Prompt visuel détaillé, en anglais.' },
          engine: { type: 'string', enum: engines },
          size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: 'Carré, paysage ou portrait.' },
        },
        required: ['prompt'],
      },
    });
  }
  if (av.cursor) {
    tools.push({ name: 'cursor_task', description: `Délègue une tâche de code à l'agent Cursor, dans le dossier "${cfg.cursorWorkspace}". Consigne précise : fichiers, comportement attendu, critères de réussite.`, input_schema: promptSchema });
  }
  tools.push(
    {
      name: 'show_design',
      description: "Affiche à l'utilisateur un design visuel interactif (comme Claude Design) : maquette d'interface, prototype cliquable, page web, landing, one-pager, slides, UI de jeu Roblox, palette… Fournis UN document HTML autonome (CSS et JS inclus ; polices Google Fonts et bibliothèques CDN autorisées). Il s'affiche en aperçu live dans la conversation. Pour modifier un design déjà affiché, renvoie le HTML complet avec son design_id : la même carte se met à jour (nouvelle version).",
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Nom court du design.' },
          html: { type: 'string', description: 'Document HTML complet et autonome.' },
          kind: { type: 'string', enum: ['prototype', 'page', 'slides', 'composant', 'ui-jeu', 'affiche'], description: 'Type de design.' },
          design_id: { type: 'string', description: 'Pour mettre à jour un design existant (id renvoyé précédemment).' },
        },
        required: ['title', 'html'],
      },
    },
    { name: 'use_skill', description: "Charge les instructions complètes d'un skill de la liste. Fais-le dès qu'un skill correspond à la demande.", input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Slug du skill.' } }, required: ['name'] } },
    { name: 'read_skill_file', description: "Lit un fichier de référence d'un skill importé (ex. references/full.md), quand les instructions du skill le demandent.", input_schema: { type: 'object', properties: { skill: { type: 'string', description: 'Slug du skill.' }, path: { type: 'string', description: 'Chemin relatif dans le skill.' } }, required: ['skill', 'path'] } },
    {
      name: 'create_skill',
      description: "Crée ou met à jour un skill réutilisable. Seulement si l'utilisateur le demande.",
      input_schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string', description: 'Une phrase : quand utiliser ce skill.' }, instructions: { type: 'string', description: 'Instructions complètes en Markdown.' } }, required: ['name', 'description', 'instructions'] },
    },
  );
  return tools;
}

const shortDesc = (d) => { const t = String(d || '').replace(/\s+/g, ' ').trim(); return t.length > 180 ? `${t.slice(0, 177)}…` : t; };

const LANG = { fr: 'Réponds toujours en français.', en: 'Always answer in English.', auto: "Réponds dans la langue de l'utilisateur." };

export function buildSystem(cfg, { forcedSkill, relay, hint } = {}) {
  const tools = buildTools(cfg).map((t) => t.name);
  const skills = listSkills();
  const can = [
    tools.includes('ask_chatgpt') && '- demander à ChatGPT (`ask_chatgpt`)',
    tools.includes('ask_grok') && '- demander à Grok (`ask_grok`)',
    tools.includes('generate_image') && '- générer des images (`generate_image`)',
    tools.includes('cursor_task') && `- confier du code à Cursor (\`cursor_task\`)`,
    cfg.projectFiles && `- lire et modifier directement les fichiers du projet (${cfg.PROJECT_DIR})`,
    '- créer des designs visuels interactifs affichés en aperçu live (`show_design`)',
    '- charger un skill (`use_skill`, puis `read_skill_file` pour ses références) ou en créer un (`create_skill`)',
  ].filter(Boolean);

  let s = `Tu es Claude, l'orchestrateur de Relais : une application qui te relie à d'autres IA. Tu restes l'interlocuteur principal et tu délègues quand c'est utile.

Tu peux :
${can.join('\n')}

Comment choisir — l'utilisateur écrit simplement, c'est à toi de comprendre, sans attendre une demande explicite :
- Demande de visuel (image, logo, icône, miniature, dessin, affiche, texture, fond d'écran, « dessine… ») → generate_image. Moteur : celui que l'utilisateur nomme ; sinon "${cfg.IMAGE_ENGINE || 'chatgpt'}". Rédige toi-même un prompt anglais détaillé à partir de sa phrase.
- « demande à… », « avis de… », « qu'en pense… », @chatgpt, @grok → ask_chatgpt / ask_grok, puis donne ton commentaire.
- « compare », « les deux », « débat », décision importante → ask_chatgpt et ask_grok EN PARALLÈLE, puis tranche.
- Maquette, prototype, interface, écran, page web, landing, one-pager, slides, UI de jeu, « montre-moi à quoi ça ressemblerait » → show_design avec un HTML soigné et moderne (vraie hiérarchie, espacements réguliers, typo choisie, pas de lorem ipsum). Pour itérer (« plus sombre », « bouge le bouton »), renvoie le HTML complet avec le même design_id. Si un skill de design correspond (design-critique, design-system, ux-copy, accessibility-review…), charge-le.
- Code pour son projet → ${cfg.projectFiles ? 'travaille directement dans les fichiers du projet (lis avant de modifier)' : 'donne le code complet, fichier par fichier, en indiquant où le placer'}.
- Tout le reste (questions, explications, conversation) → réponds toi-même, sans déléguer.
- Ne demande pas la permission et n'annonce pas « je vais demander à… » : fais-le directement, puis résume.

Règles :
- Les autres IA ne voient pas cette conversation : envoie-leur des consignes complètes.
- Les images et les étapes s'affichent déjà à l'utilisateur : ne recopie ni URL ni réponse complète, résume en quelques lignes et propose la suite.
- Si un outil échoue, explique simplement le problème et la solution (souvent dans Réglages → Connexions).
- ${LANG[cfg.RESPONSE_LANGUAGE] || LANG.auto} Markdown sobre.`;

  if (cfg.PROJECT_DIR) s += `\n\nProjet de l'utilisateur : ${cfg.PROJECT_DIR}`;
  if (cfg.CUSTOM_INSTRUCTIONS) s += `\n\nÀ propos de l'utilisateur et de ses préférences :\n${cfg.CUSTOM_INSTRUCTIONS}`;
  if (skills.length) s += `\n\nSkills disponibles (charge celui qui correspond avec use_skill) :\n${skills.map((k) => `- ${k.slug} : ${shortDesc(k.description)}`).join('\n')}`;
  if (forcedSkill) s += `\n\nL'utilisateur a activé le skill « ${forcedSkill.name} ». Suis ces instructions :\n\n${skillPrompt(forcedSkill)}`;
  if (relay) s += `\n\nDEMANDE EXPLICITE DE L'UTILISATEUR (action « ${relay.label} ») : ${relay.instruction}`;
  else if (hint) s += `\n\nIndice : ce message ressemble à « ${hint.label} ». Si c'est bien l'intention, fais-le tout de suite : ${hint.instruction}`;
  return s;
}

/* ==========================================================================
   Historique
   ========================================================================== */
function flatten(m) {
  if (m.role === 'user') return m.text || '';
  const who = m.agent && m.agent !== 'claude' ? `[Réponse de ${LABEL[m.agent] || m.agent}]\n` : '';
  const body = (m.parts || [])
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'step') return `[${p.title}${p.output ? ` → ${String(p.output).slice(0, 800)}` : ''}]`;
      if (p.type === 'image') return `[Image générée (${p.engine}) — prompt : ${p.prompt}]`;
      if (p.type === 'design') return `[Design « ${p.title} » affiché — design_id : ${p.id}, version ${p.version}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return (who + body).trim();
}

export function history(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const content = flatten(m) || '(vide)';
    const prev = out.at(-1);
    if (prev?.role === role) prev.content += `\n\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** Pour les outils en ligne de commande : l'historique devient un seul texte. */
function transcriptPrompt(messages) {
  const h = history(messages);
  const last = h.pop();
  if (!h.length) return last?.content || '';
  const past = h.map((m) => `### ${m.role === 'user' ? 'Utilisateur' : 'Assistant'}\n${m.content}`).join('\n\n');
  return `Historique de la conversation :\n\n${past}\n\n---\n\nNouveau message de l'utilisateur :\n${last?.content || ''}`;
}

/* ==========================================================================
   Exécution d'un outil (commun aux modes compte et API)
   ========================================================================== */
export async function runTool(name, input = {}, ctx = {}) {
  const { id = crypto.randomBytes(6).toString('hex'), cfg, turn, signal } = ctx;
  try {
    switch (name) {
      case 'ask_chatgpt':
      case 'ask_grok': {
        const provider = name === 'ask_chatgpt' ? 'chatgpt' : 'grok';
        turn.step({ id, agent: provider, title: `Demande à ${LABEL[provider]}`, status: 'running', input: input.prompt, output: '' });
        let acc = '';
        const live = throttle(() => turn.step({ id, output: acc }));
        const answer = await askAgent({ cfg, provider, prompt: String(input.prompt || ''), signal, onText: (d) => { acc += d; live(); } });
        turn.step({ id, status: 'done', output: answer });
        return { content: answer || '(réponse vide)' };
      }
      case 'generate_image': {
        const engine = input.engine || cfg.IMAGE_ENGINE || 'chatgpt';
        const size = input.size || cfg.IMAGE_SIZE;
        turn.step({ id, agent: engine, title: `Image via ${LABEL[engine]}`, status: 'running', input: input.prompt });
        const img = await makeImage({ cfg, engine, prompt: String(input.prompt || ''), size, signal });
        turn.step({ id, status: 'done', output: img.exported ? `Image prête, copiée dans ${img.exported}` : 'Image prête.' });
        turn.image({ ...img, prompt: input.prompt, engine, size, stepId: id });
        return { content: `Image générée par ${LABEL[engine]} et déjà affichée à l'utilisateur.${img.exported ? ` Copiée dans ${img.exported}.` : ''}` };
      }
      case 'cursor_task': {
        turn.step({ id, agent: 'cursor', title: 'Tâche confiée à Cursor', status: 'running', input: input.prompt, output: '' });
        let acc = '';
        const live = throttle(() => turn.step({ id, output: acc }));
        const out = await runCursorAgent({ cfg: { ...cfg, CURSOR_WORKSPACE: cfg.cursorWorkspace }, prompt: String(input.prompt || ''), signal, onOutput: (d) => { acc += d; live(); } });
        turn.step({ id, status: 'done', output: out });
        return { content: out.slice(0, 20000) };
      }
      case 'permission_prompt': {
        const ask = ctx.askPermission;
        if (!ask) return { content: JSON.stringify({ behavior: 'deny', message: 'Aucune autorisation possible ici.' }) };
        return { content: JSON.stringify(await ask(input)) };
      }
      case 'codex_task':
      case 'grok_task': {
        const project = ctx.project;
        if (!project) throw new Error('Pas de projet ouvert.');
        const agent = name === 'codex_task' ? 'chatgpt' : 'grok';
        turn.step({ id, agent, title: `Tâche confiée à ${agent === 'chatgpt' ? 'Codex' : 'Grok'}`, status: 'running', input: input.prompt });
        const sub = new SubTurn(turn, id);
        await runCoder(agent, { cfg, dir: project.dir, perm: project.perm, prompt: String(input.prompt || ''), session: {}, turn: sub, signal });
        const summary = sub.textOut.trim() || '(terminé sans compte rendu)';
        turn.step({ id, status: 'done', output: summary });
        return { content: summary.slice(0, 20000) };
      }
      case 'use_skill': {
        const skill = getSkill(input.name);
        if (!skill) throw new Error(`Skill « ${input.name} » introuvable.`);
        if (!skill.enabled) throw new Error(`Le skill « ${skill.name} » est désactivé (Skills → activer).`);
        turn.step({ id, agent: 'skill', title: `Skill : ${skill.name}`, status: 'done', input: skill.description });
        return { content: skillPrompt(skill) };
      }
      case 'read_skill_file': {
        const text = readSkillFile(String(input.skill || ''), String(input.path || ''));
        turn.step({ id, agent: 'skill', title: `Référence · ${input.path}`, status: 'done', input: `${input.skill}/${input.path}` });
        return { content: text };
      }
      case 'show_design': {
        const d = saveDesign({ id: input.design_id, title: input.title, html: input.html, kind: input.kind, conversationId: turn.convId });
        turn.design({ id: d.id, title: d.title, kind: d.kind, version: d.version, url: d.url });
        return { content: `Design « ${d.title} » affiché (design_id : ${d.id}, version ${d.version}). Pour le modifier, renvoie le HTML complet avec ce design_id. Ne recopie pas le HTML dans ta réponse : résume les choix et propose des variantes.` };
      }
      case 'create_skill': {
        const skill = saveSkill({ name: input.name, description: input.description, body: input.instructions });
        turn.step({ id, agent: 'skill', title: `Skill créé : ${skill.name}`, status: 'done', input: skill.description, output: skill.body });
        turn.send('skills', {});
        return { content: `Skill « ${skill.name} » enregistré (slug : ${skill.slug}).` };
      }
      default:
        throw new Error(`Outil inconnu : ${name}`);
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    turn.step({ id, status: 'error', output: e.message });
    return { content: `Erreur : ${e.message}`, is_error: true };
  }
}

/* ---------- Jetons temporaires pour le pont MCP (mode compte) ---------- */
const toolSessions = new Map();
export function toolSession(token) { return toolSessions.get(token) || null; }

/* ==========================================================================
   Claude
   ========================================================================== */
export async function runClaude({ cfg, conv, forcedSkill, relay, hint, turn, signal, baseUrl }) {
  const system = buildSystem(cfg, { forcedSkill, relay, hint });
  if (cfg.CLAUDE_AUTH === 'account') return runClaudeAccount({ cfg, conv, system, turn, signal, baseUrl });
  return runClaudeApi({ cfg, conv, system, turn, signal });
}

const FILE_TOOL_LABEL = { Read: 'Lit', Edit: 'Modifie', Write: 'Crée', Glob: 'Cherche des fichiers', Grep: 'Cherche dans le code' };

async function runClaudeAccount({ cfg, conv, system, turn, signal, baseUrl }) {
  const token = crypto.randomBytes(16).toString('hex');
  toolSessions.set(token, { cfg, turn, signal });
  try {
    await claudeAccountTurn({
      cfg,
      systemPrompt: system,
      prompt: transcriptPrompt(conv.messages),
      mcpUrl: baseUrl,
      token,
      signal,
      onText: (d) => turn.text(d),
      onToolStart: (b) => {
        const target = b.input?.file_path || b.input?.pattern || b.input?.path || '';
        turn.step({ id: b.id, agent: 'claude', title: `${FILE_TOOL_LABEL[b.name] || b.name}${target ? ` · ${path.basename(String(target))}` : ''}`, status: 'running', input: target || JSON.stringify(b.input || {}) });
      },
      onToolEnd: (b, text, isError) => turn.step({ id: b.id, status: isError ? 'error' : 'done', output: String(text).slice(0, 3000) }),
    });
  } finally {
    toolSessions.delete(token);
  }
}

async function runClaudeApi({ cfg, conv, system, turn, signal }) {
  const tools = buildTools(cfg);
  const messages = history(conv.messages);
  for (let i = 0; i < cfg.maxSteps; i++) {
    const { content, stopReason } = await claudeStream({ cfg, system, messages, tools, signal, onText: (d) => turn.text(d) });
    const kept = content.filter((b) => !(b.type === 'text' && !b.text));
    messages.push({ role: 'assistant', content: kept.length ? kept : [{ type: 'text', text: '…' }] });
    if (stopReason !== 'tool_use') return;
    const uses = content.filter((b) => b.type === 'tool_use');
    const results = await Promise.all(uses.map(async (u) => {
      const r = await runTool(u.name, u.input, { id: u.id, cfg, turn, signal });
      return { type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) };
    }));
    messages.push({ role: 'user', content: results });
  }
  turn.text('\n\n_Limite d’étapes atteinte pour ce message._');
}

/* ==========================================================================
   Mode projet : l'IA code directement dans le dossier choisi
   ========================================================================== */
const PERM_TEXT = {
  read: 'Lecture seule : tu peux lire et analyser, mais pas modifier de fichier ni lancer de commande. Propose les changements sous forme de code.',
  ask: 'Chaque modification ou commande est soumise à l’accord de l’utilisateur.',
  full: 'Accès complet : tu peux modifier les fichiers et lancer des commandes sans confirmation. Reste prudent : jamais de suppression massive ni de commande destructive sans raison claire.',
};

function codingSystem(cfg, { dir, perm }) {
  const tools = buildTools(cfg, { coding: true }).map((t) => t.name);
  return `Tu travailles dans Relais, un poste de travail qui te relie à d'autres IA. Projet ouvert : ${dir} (${detectType(dir)}).
${PERM_TEXT[perm]}

Outils Relais en plus de tes outils de code :
${[
    tools.includes('ask_chatgpt') && '- mcp__relais__ask_chatgpt / ask_grok : demander un avis ou une relecture',
    tools.includes('generate_image') && '- mcp__relais__generate_image : créer une image (icône, texture, miniature…). Elle est copiée dans relais-assets/ du projet.',
    tools.includes('codex_task') && '- mcp__relais__codex_task : confier une sous-tâche de code à Codex dans ce même projet',
    tools.includes('grok_task') && '- mcp__relais__grok_task : confier une sous-tâche de code à Grok dans ce même projet',
    '- mcp__relais__use_skill / read_skill_file : charger un skill et ses références',
    '- mcp__relais__show_design : afficher une maquette HTML interactive à l’utilisateur avant de l’implémenter',
  ].filter(Boolean).join('\n')}

Quand l'utilisateur demande un visuel, utilise generate_image sans attendre qu'il le précise. Quand il dit « demande à ChatGPT/Grok », utilise l'outil correspondant.
${LANG[cfg.RESPONSE_LANGUAGE] || LANG.auto} Termine chaque tâche par un court résumé : fichiers modifiés, comment tester.${cfg.CUSTOM_INSTRUCTIONS ? `\n\nÀ propos de l'utilisateur :\n${cfg.CUSTOM_INSTRUCTIONS}` : ''}`;
}

export async function runProject({ cfg, conv, agent, perm, forcedSkill, relay, hint, turn, signal, baseUrl, askPermission }) {
  const dir = conv.project;
  const pcfg = { ...cfg, PROJECT_DIR: dir, imageExport: true, projectFiles: true };
  conv.sessions ||= {};
  const session = (conv.sessions[agent] ||= {});
  const lastText = conv.messages.at(-1)?.text || '';

  const extras = [
    forcedSkill && `[Skill « ${forcedSkill.name} » activé]\n${skillPrompt(forcedSkill, { canRead: agent === 'claude' })}`,
    relay && `[Action demandée : ${relay.label}] ${relay.instruction}`,
    !relay && hint && `[Indice : ça ressemble à « ${hint.label} ». ${hint.instruction}]`,
  ].filter(Boolean).join('\n\n');

  const build = () => {
    const body = session.id || conv.messages.length <= 1 ? lastText : transcriptPrompt(conv.messages);
    let p = extras ? `${extras}\n\n---\n\n${body}` : body;
    // Codex et Grok n'ont pas le prompt système de Relais : on leur donne le contexte au premier message.
    if (agent !== 'claude' && !session.id) {
      p = `Contexte : tu travailles dans le projet ${dir} (${detectType(dir)}). ${PERM_TEXT[perm]} ${LANG[cfg.RESPONSE_LANGUAGE] || LANG.auto} Termine par un court résumé : fichiers modifiés, comment tester.${cfg.CUSTOM_INSTRUCTIONS ? `\nÀ propos de l'utilisateur : ${cfg.CUSTOM_INSTRUCTIONS}` : ''}\n\n---\n\n${p}`;
    }
    return p;
  };

  const run = async () => {
    if (agent !== 'claude') return runCoder(agent, { cfg: pcfg, dir, perm, prompt: build(), session, turn, signal });
    const token = crypto.randomBytes(16).toString('hex');
    toolSessions.set(token, { cfg: pcfg, turn, signal, project: { dir, perm }, askPermission });
    try {
      return await runCoder('claude', { cfg: pcfg, dir, perm, prompt: build(), systemAppend: codingSystem(pcfg, { dir, perm }), session, mcp: { url: baseUrl, token }, turn, signal });
    } finally {
      toolSessions.delete(token);
    }
  };

  const hadSession = !!session.id;
  try {
    await run();
  } catch (e) {
    if (!hadSession && agent === 'claude') session.id = null; // la session n'a pas pu être créée
    // Session introuvable (ex. supprimée) : on repart d'une nouvelle session avec l'historique.
    if (hadSession && !session.id && !signal?.aborted) { await run(); return; }
    throw e;
  }
}

/* ==========================================================================
   Modes directs
   ========================================================================== */
export async function runDirect({ cfg, provider, conv, forcedSkill, turn, signal }) {
  let system = `Tu es ${LABEL[provider]}, utilisé dans Relais (un hub qui réunit plusieurs IA). ${LANG[cfg.RESPONSE_LANGUAGE] || LANG.auto} Markdown sobre.`;
  if (cfg.CUSTOM_INSTRUCTIONS) system += `\n\nÀ propos de l'utilisateur :\n${cfg.CUSTOM_INSTRUCTIONS}`;
  if (forcedSkill) system += `\n\nSuis ces instructions (skill « ${forcedSkill.name} ») :\n\n${forcedSkill.body}`;
  // (ChatGPT/Grok en direct n'ont pas d'outil pour lire les références : seules les instructions principales sont données.)
  const viaAccount = cfg[provider === 'chatgpt' ? 'OPENAI_AUTH' : 'XAI_AUTH'] === 'account';
  if (viaAccount) {
    const prompt = `${system}\n\n---\n\n${transcriptPrompt(conv.messages)}`;
    await askAgent({ cfg, provider, prompt, signal, onText: (d) => turn.text(d) });
  } else {
    await askAgent({ cfg, provider, messages: [{ role: 'system', content: system }, ...history(conv.messages)], signal, onText: (d) => turn.text(d) });
  }
}

/** Relais « direct » : la demande part telle quelle, sans passer par Claude. */
export async function runRelayDirect({ cfg, relay, text, turn, signal }) {
  if (relay.kind === 'image') {
    const r = await runTool('generate_image', { prompt: text, engine: relay.engine, size: relay.size }, { cfg, turn, signal });
    if (r.is_error) throw new Error(r.content.replace(/^Erreur : /, ''));
    return relay.engine;
  }
  if (relay.kind === 'ask') {
    await askAgent({ cfg, provider: relay.engine, prompt: text, signal, onText: (d) => turn.text(d) });
    return relay.engine;
  }
  throw new Error('Cette action a besoin de Claude.');
}
