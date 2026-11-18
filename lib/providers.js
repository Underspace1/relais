import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';

/* ---------- Lecture générique d'un flux SSE ---------- */
async function* sseEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
}

async function failText(res, who) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || JSON.stringify(j);
  } catch {
    detail = res.statusText;
  }
  return new Error(`${who} (${res.status}) : ${detail}`);
}

/* ---------- Claude (Anthropic Messages API, streaming + outils) ---------- */
export async function claudeStream({ cfg, system, messages, tools, onText, signal }) {
  if (!cfg.ANTHROPIC_API_KEY) throw new Error('Clé Anthropic manquante (Réglages).');
  const body = { model: cfg.CLAUDE_MODEL, max_tokens: 8192, system, messages, stream: true };
  if (tools?.length) body.tools = tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await failText(res, 'Claude');

  const content = [];
  let stopReason = null;
  for await (const data of sseEvents(res)) {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'content_block_start': {
        const b = { ...ev.content_block };
        if (b.type === 'text') b.text = '';
        if (b.type === 'tool_use') { b._json = ''; b.input = {}; }
        if (b.type === 'thinking') { b.thinking = b.thinking || ''; }
        content[ev.index] = b;
        break;
      }
      case 'content_block_delta': {
        const b = content[ev.index];
        if (!b) break;
        const d = ev.delta;
        if (d.type === 'text_delta') { b.text += d.text; onText?.(d.text); }
        else if (d.type === 'input_json_delta') b._json += d.partial_json;
        else if (d.type === 'thinking_delta') b.thinking += d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
        break;
      }
      case 'content_block_stop': {
        const b = content[ev.index];
        if (b?.type === 'tool_use') {
          try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; }
          delete b._json;
        }
        break;
      }
      case 'message_delta':
        stopReason = ev.delta?.stop_reason ?? stopReason;
        break;
      case 'error':
        throw new Error(`Claude : ${ev.error?.message || 'erreur de flux'}`);
    }
  }
  return { content: content.filter(Boolean), stopReason };
}

/* ---------- API compatibles OpenAI (ChatGPT, Grok) ---------- */
const PROVIDERS = {
  chatgpt: { base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', model: 'OPENAI_MODEL', label: 'ChatGPT' },
  grok: { base: 'https://api.x.ai/v1', key: 'XAI_API_KEY', model: 'GROK_MODEL', label: 'Grok' },
};

export async function chatStream({ cfg, provider, messages, onText, signal }) {
  const p = PROVIDERS[provider];
  if (!cfg[p.key]) throw new Error(`Clé ${p.label} manquante (Réglages).`);
  const res = await fetch(`${p.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg[p.key]}` },
    body: JSON.stringify({ model: cfg[p.model], messages, stream: true }),
    signal,
  });
  if (!res.ok) throw await failText(res, p.label);
  let text = '';
  for await (const data of sseEvents(res)) {
    if (data === '[DONE]') break;
    try {
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) { text += delta; onText?.(delta); }
    } catch { /* fragment ignoré */ }
  }
  return text;
}

export async function chatOnce({ cfg, provider, prompt, signal }) {
  return chatStream({ cfg, provider, messages: [{ role: 'user', content: prompt }], signal });
}

/* ---------- Gemini (clé API Google AI Studio) ---------- */
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_OPENAI_BASE = `${GEMINI_BASE}/openai`;

let geminiCache = { key: '', at: 0, list: [] };
/** Modèles Gemini disponibles avec la clé (mis en cache 6 h). */
export async function geminiModels(cfg) {
  if (!cfg.GEMINI_API_KEY) return [];
  if (geminiCache.key === cfg.GEMINI_API_KEY && Date.now() - geminiCache.at < 6 * 3600 * 1000) return geminiCache.list;
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, { headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw await failText(res, 'Gemini');
  const list = ((await res.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => /^gemini-/.test(m.id));
  geminiCache = { key: cfg.GEMINI_API_KEY, at: Date.now(), list };
  return list;
}

/** Numéro de version d'un modèle Gemini (« gemini-3.1-pro » → 3.1), pour trouver le plus récent. */
const geminiVersion = (id) => Number((String(id).match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
const newest = (list) => [...list].sort((a, b) => geminiVersion(b.id) - geminiVersion(a.id) || a.id.length - b.id.length)[0]?.id;

/** Modèle texte : celui choisi dans les réglages, sinon le Gemini Pro le plus récent (stable de préférence). */
export async function geminiTextModel(cfg) {
  if (cfg.GEMINI_MODEL) return cfg.GEMINI_MODEL;
  try {
    const pro = (await geminiModels(cfg)).filter((m) => /^gemini-[\d.]+-pro(-latest)?$|^gemini-[\d.]+-pro-preview(-\d\d-\d\d)?$/.test(m.id) && !/image|tts|audio|live|embedding/.test(m.id));
    return newest(pro.filter((m) => !/preview|exp/.test(m.id))) || newest(pro) || 'gemini-2.5-pro';
  } catch { return 'gemini-2.5-pro'; }
}

/** Modèle d'images (Nano Banana) : celui choisi, sinon le plus récent. */
export async function geminiImageModel(cfg) {
  if (cfg.GEMINI_IMAGE_MODEL) return cfg.GEMINI_IMAGE_MODEL;
  try {
    return newest((await geminiModels(cfg)).filter((m) => /image/.test(m.id) && !/imagen/.test(m.id))) || 'gemini-2.5-flash-image';
  } catch { return 'gemini-2.5-flash-image'; }
}

/**
 * Image par Gemini (API Google). `source` = { mime, b64 } pour retoucher une image existante.
 * Renvoie { id, url, model }.
 */
export async function geminiImage({ cfg, prompt, size = '1024x1024', source = null, signal }) {
  if (!cfg.GEMINI_API_KEY) throw new Error('Clé Gemini manquante (Réglages → Connexions → Gemini).');
  const model = await geminiImageModel(cfg);
  const ratio = size === '1536x1024' ? '3:2' : size === '1024x1536' ? '2:3' : '1:1';
  const parts = source
    ? [{ text: `Edit this image. Keep everything that is not mentioned unchanged.\n\n${prompt}` }, { inline_data: { mime_type: source.mime, data: source.b64 } }]
    : [{ text: prompt }];
  const res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(source ? {} : { imageConfig: { aspectRatio: ratio } }) },
    }),
    signal,
  });
  if (!res.ok) throw await failText(res, 'Gemini Images');
  const j = await res.json();
  const cand = j.candidates?.[0];
  const img = (cand?.content?.parts || []).find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!img) {
    const why = j.promptFeedback?.blockReason || cand?.finishReason;
    const said = (cand?.content?.parts || []).map((p) => p.text).filter(Boolean).join(' ').slice(0, 300);
    throw new Error(`Gemini n’a renvoyé aucune image${why && why !== 'STOP' ? ` (${why})` : ''}.${said ? ` Sa réponse : ${said}` : ''}`);
  }
  const data = img.inlineData || img.inline_data;
  const mime = data.mimeType || data.mime_type || 'image/png';
  return { ...saveImage(data.data, mime.includes('jpeg') ? 'jpg' : mime.split('/')[1] || 'png'), model };
}

/* ---------- Images ---------- */
function saveImage(b64, ext) {
  const id = crypto.randomBytes(8).toString('hex');
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(paths.images, file), Buffer.from(b64, 'base64'));
  return { id, url: `/images/${file}` };
}

async function fetchAsB64(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Téléchargement de l'image impossible (${r.status})`);
  return Buffer.from(await r.arrayBuffer()).toString('base64');
}

export async function generateImage({ cfg, engine = 'chatgpt', prompt, size = '1024x1024', signal }) {
  if (engine === 'grok') {
    if (!cfg.XAI_API_KEY) throw new Error('Clé Grok manquante (Réglages).');
    const res = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.XAI_API_KEY}` },
      body: JSON.stringify({ model: cfg.GROK_IMAGE_MODEL, prompt, n: 1, response_format: 'b64_json' }),
      signal,
    });
    if (!res.ok) throw await failText(res, 'Grok Images');
    const d = (await res.json()).data?.[0];
    const b64 = d?.b64_json || (d?.url && (await fetchAsB64(d.url, signal)));
    if (!b64) throw new Error('Grok n’a renvoyé aucune image.');
    return saveImage(b64, 'jpg');
  }

  if (!cfg.OPENAI_API_KEY) throw new Error('Clé OpenAI manquante (Réglages).');
  const model = cfg.OPENAI_IMAGE_MODEL;
  const body = { model, prompt, n: 1, size };
  if (model.startsWith('dall-e')) {
    body.response_format = 'b64_json';
    if (size !== '1024x1024') body.size = size === '1536x1024' ? '1792x1024' : '1024x1792';
  }
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await failText(res, 'OpenAI Images');
  const d = (await res.json()).data?.[0];
  const b64 = d?.b64_json || (d?.url && (await fetchAsB64(d.url, signal)));
  if (!b64) throw new Error('OpenAI n’a renvoyé aucune image.');
  return saveImage(b64, 'png');
}
