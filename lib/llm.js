/**
 * Appels directs aux modèles, sans aucun outil à installer :
 *   - OpenRouter : une seule clé pour Claude, ChatGPT, Grok (et d'autres)
 *   - clés API de chaque IA : Anthropic, OpenAI, xAI
 *
 * Format commun des messages (converti pour chaque API) :
 *   { role: 'user', text, images?: [{ mime, b64 }] }
 *   { role: 'assistant', text, toolCalls?: [{ id, name, input }] }
 *   { role: 'tool', id, name, content, isError? }
 * Outils : { name, description, input_schema } (schéma JSON).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { claudeStream } from './providers.js';

const OR_BASE = () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const OR_HEADERS = { 'X-Title': 'Relais' };

/* ==========================================================================
   Modèles OpenRouter : liste publique, choix automatique du plus récent
   ========================================================================== */
let orCache = { at: 0, list: [] };

export async function orModels({ force = false } = {}) {
  if (!force && orCache.list.length && Date.now() - orCache.at < 6 * 3600 * 1000) return orCache.list;
  const res = await fetch(`${OR_BASE()}/models`, { headers: OR_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OpenRouter (${res.status}) : liste des modèles indisponible`);
  const j = await res.json();
  const list = (j.data || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    created: m.created || 0,
    tools: (m.supported_parameters || []).includes('tools'),
    image: (m.architecture?.output_modalities || []).includes('image'),
    vision: (m.architecture?.input_modalities || []).includes('image'),
    price: m.pricing ? { in: Number(m.pricing.prompt) * 1e6, out: Number(m.pricing.completion) * 1e6 } : null,
  }));
  orCache = { at: Date.now(), list };
  return list;
}

// Familles utilisées quand aucun modèle n'est choisi : le plus récent de chaque famille.
export const OR_FAMILIES = {
  claude: { key: 'OPENROUTER_CLAUDE_MODEL', match: /^anthropic\/claude-.*sonnet/, any: /^anthropic\/claude/, fallback: 'anthropic/claude-sonnet-4.5' },
  chatgpt: { key: 'OPENROUTER_GPT_MODEL', match: /^openai\/gpt-\d(\.\d)?$/, any: /^openai\/gpt-\d/, fallback: 'openai/gpt-5' },
  grok: { key: 'OPENROUTER_GROK_MODEL', match: /^x-ai\/grok-\d(\.\d)?$/, any: /^x-ai\/grok/, fallback: 'x-ai/grok-4' },
};
const IMAGE_FALLBACK = 'google/gemini-2.5-flash-image';
const SKIP = /(mini|nano|audio|search|image|vision|realtime|beta|oss|instruct|:free|preview|haiku|code|fast)/;

export async function resolveOrModel(cfg, which) {
  if (which === 'image') {
    if (cfg.OPENROUTER_IMAGE_MODEL) return cfg.OPENROUTER_IMAGE_MODEL;
    try {
      const imgs = (await orModels()).filter((m) => m.image).sort((a, b) => b.created - a.created);
      return (imgs.find((m) => /^openai\//.test(m.id)) || imgs.find((m) => /^google\/gemini/.test(m.id)) || imgs[0])?.id || IMAGE_FALLBACK;
    } catch { return IMAGE_FALLBACK; }
  }
  const fam = OR_FAMILIES[which];
  if (cfg[fam.key]) return cfg[fam.key];
  try {
    const list = (await orModels()).filter((m) => m.tools).sort((a, b) => b.created - a.created);
    return (list.find((m) => fam.match.test(m.id) && !SKIP.test(m.id.split('/')[1]))
      || list.find((m) => fam.any.test(m.id) && !SKIP.test(m.id.split('/')[1]))
      || list.find((m) => fam.any.test(m.id)))?.id || fam.fallback;
  } catch { return fam.fallback; }
}

/** État de la clé OpenRouter : crédit restant, limite. */
export async function orKeyInfo(cfg) {
  if (!cfg.OPENROUTER_API_KEY) throw new Error('Aucune clé OpenRouter enregistrée.');
  const res = await fetch(`${OR_BASE()}/key`, { headers: { ...OR_HEADERS, authorization: `Bearer ${cfg.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? 'Clé OpenRouter refusée : vérifie-la sur openrouter.ai/keys.' : `OpenRouter (${res.status}) : ${j?.error?.message || res.statusText}`);
  const d = j.data || {};
  return { label: d.label || '', usage: d.usage ?? null, limit: d.limit ?? null, remaining: d.limit_remaining ?? null, free: !!d.is_free_tier };
}

/* ==========================================================================
   Choix du « moteur » selon la connexion de chaque IA
   ========================================================================== */
const AUTH_KEY = { claude: 'CLAUDE_AUTH', chatgpt: 'OPENAI_AUTH', grok: 'XAI_AUTH' };
const LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', grok: 'Grok' };

/** Renvoie le moteur direct (sans outil installé) d'une IA, ou null si elle passe par son outil officiel. */
export function backendOf(cfg, agent) {
  const auth = cfg[AUTH_KEY[agent]];
  if (auth === 'openrouter') return cfg.OPENROUTER_API_KEY ? { kind: 'openrouter', agent } : null;
  if (auth === 'api') {
    if (agent === 'claude') return cfg.ANTHROPIC_API_KEY ? { kind: 'anthropic', agent } : null;
    if (agent === 'chatgpt') return cfg.OPENAI_API_KEY ? { kind: 'openai', agent, base: 'https://api.openai.com/v1', key: cfg.OPENAI_API_KEY, model: cfg.OPENAI_MODEL } : null;
    if (agent === 'grok') return cfg.XAI_API_KEY ? { kind: 'openai', agent, base: 'https://api.x.ai/v1', key: cfg.XAI_API_KEY, model: cfg.GROK_MODEL } : null;
  }
  return null;
}

/* ==========================================================================
   Lecture d'un flux SSE
   ========================================================================== */
async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}

async function failText(res, who) {
  let detail = '';
  try { const j = await res.json(); detail = j?.error?.message || JSON.stringify(j); } catch { detail = res.statusText; }
  if (res.status === 401) detail = `clé refusée (${detail})`;
  if (res.status === 402) detail = `crédit insuffisant — recharge ton compte (${detail})`;
  if (res.status === 429) detail = `trop de requêtes, réessaie dans un instant (${detail})`;
  return new Error(`${who} (${res.status}) : ${detail}`);
}

/* ==========================================================================
   Conversion des messages
   ========================================================================== */
function toOpenAI(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(m.images?.length
        ? { role: 'user', content: [{ type: 'text', text: m.text || '' }, ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }))] }
        : { role: 'user', content: m.text || '' });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || (m.toolCalls?.length ? null : '…') };
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input || {}) } }));
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.id, content: String(m.content ?? '') });
    }
  }
  return out;
}

function toAnthropic(messages) {
  const out = [];
  const push = (role, blocks) => {
    const prev = out.at(-1);
    if (prev?.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', [...(m.images || []).map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.b64 } })), { type: 'text', text: m.text || '…' }]);
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const t of m.toolCalls || []) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }]);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.id, content: String(m.content ?? ''), ...(m.isError ? { is_error: true } : {}) }]);
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/* ==========================================================================
   Un tour de modèle (avec outils facultatifs), en flux
   ========================================================================== */
/**
 * @returns {Promise<{ text: string, toolCalls: {id,name,input}[], usage: {tokensIn,tokensOut,cost}, model: string, reasoning: string }>}
 */
export async function chatTurn({ cfg, backend, system, messages, tools = [], signal, onText, onReasoning, effort }) {
  if (!backend) throw new Error('Aucune connexion directe pour cette IA.');
  const who = backend.kind === 'openrouter' ? `${LABEL[backend.agent]} (OpenRouter)` : LABEL[backend.agent];

  if (backend.kind === 'anthropic') {
    const { content } = await claudeStream({
      cfg, system, messages: toAnthropic(messages), signal, onText,
      tools: tools.length ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : undefined,
    });
    return {
      text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
      reasoning: content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n'),
      usage: {}, model: cfg.CLAUDE_MODEL,
    };
  }

  const isOR = backend.kind === 'openrouter';
  const model = isOR ? await resolveOrModel(cfg, backend.agent) : backend.model;
  const body = { model, messages: toOpenAI(system, messages), stream: true };
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (isOR) {
    body.usage = { include: true };
    if (effort === 'high' || effort === 'max') body.reasoning = { effort: 'high' };
    // Recherche web d'OpenRouter : résultats ajoutés au contexte, sources citées par le modèle
    if (cfg.webSearch) body.plugins = [{ id: 'web', max_results: 5 }];
  } else body.stream_options = { include_usage: true };

  const res = await fetch(`${isOR ? OR_BASE() : backend.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${isOR ? cfg.OPENROUTER_API_KEY : backend.key}`, ...(isOR ? OR_HEADERS : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await failText(res, who);

  let text = '';
  let reasoning = '';
  const calls = [];
  let usage = {};
  let usedModel = model;
  for await (const data of sse(res)) {
    if (data === '[DONE]') break;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error(`${who} : ${j.error.message || JSON.stringify(j.error)}`);
    if (j.model) usedModel = j.model;
    if (j.usage) usage = { tokensIn: j.usage.prompt_tokens || 0, tokensOut: j.usage.completion_tokens || 0, cost: j.usage.cost };
    const d = j.choices?.[0]?.delta;
    if (!d) continue;
    if (d.content) { text += d.content; onText?.(d.content); }
    if (d.reasoning) { reasoning += d.reasoning; onReasoning?.(d.reasoning); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ||= { id: '', name: '', args: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].args += tc.function.arguments;
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { _raw: c.args }; }
    return { id: c.id || `call_${i}_${crypto.randomBytes(3).toString('hex')}`, name: c.name, input };
  });
  return { text, toolCalls, usage, model: usedModel, reasoning };
}

/** Question simple, sans outil : renvoie le texte. */
export async function simpleAsk({ cfg, backend, system, prompt, messages, signal, onText }) {
  const r = await chatTurn({ cfg, backend, system, messages: messages || [{ role: 'user', text: prompt }], signal, onText });
  return r.text;
}

/* ==========================================================================
   Images via OpenRouter (modèles qui produisent des images)
   ========================================================================== */
export async function orImage({ cfg, prompt, size = '1024x1024', signal }) {
  if (!cfg.OPENROUTER_API_KEY) throw new Error('Clé OpenRouter manquante (Réglages → Connexions).');
  const model = await resolveOrModel(cfg, 'image');
  const ratio = size === '1536x1024' ? '3:2' : size === '1024x1536' ? '2:3' : '1:1';
  const res = await fetch(`${OR_BASE()}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.OPENROUTER_API_KEY}`, ...OR_HEADERS },
    body: JSON.stringify({
      model,
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: ratio },
      messages: [{ role: 'user', content: `Generate one image (aspect ratio ${ratio}).\n\n${prompt}` }],
    }),
    signal,
  });
  if (!res.ok) throw await failText(res, 'Images (OpenRouter)');
  const j = await res.json();
  const msg = j.choices?.[0]?.message || {};
  const url = msg.images?.[0]?.image_url?.url || msg.images?.[0]?.url;
  if (!url) throw new Error(`Le modèle d’images ${model} n’a renvoyé aucune image.${msg.content ? ` Réponse : ${String(msg.content).slice(0, 200)}` : ''}`);
  let buf;
  let ext = 'png';
  const m = String(url).match(/^data:image\/(\w+);base64,(.+)$/s);
  if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; buf = Buffer.from(m[2], 'base64'); }
  else {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`Téléchargement de l’image impossible (${r.status})`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  const id = crypto.randomBytes(8).toString('hex');
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(paths.images, file), buf);
  return { id, url: `/images/${file}`, model };
}
