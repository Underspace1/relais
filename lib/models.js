/**
 * Listes de modèles pour les menus déroulants des réglages.
 * Mode compte : demandées aux outils officiels. Mode clé API : demandées à l'API.
 */
import { resolveCli, runCli } from './connectors.js';
import { orModels, localModels, localBase } from './llm.js';
import { geminiModels } from './providers.js';

const cache = new Map();
const TTL = 10 * 60 * 1000;

async function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.list;
  const list = await fn();
  if (list.length) cache.set(key, { at: Date.now(), list });
  return list;
}

const CLAUDE_ACCOUNT = [
  { id: 'sonnet', label: 'Sonnet 5.5', hint: 'Rapide et précis, recommandé' },
  { id: 'opus', label: 'Opus 5.5', hint: 'Le plus capable, consomme plus' },
  { id: 'haiku', label: 'Haiku 5.5', hint: 'Le plus rapide et économe' },
  { id: 'fable', label: 'Fable 5.2', hint: '' },
];
const CLAUDE_API = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
];

async function codexModels(cfg) {
  const c = resolveCli('codex', cfg);
  if (!c) return [];
  const r = await runCli(c, ['debug', 'models'], { timeoutMs: 30000 });
  let data;
  try { data = JSON.parse(r.stdout); } catch { return []; }
  return (data.models || data || [])
    .filter((m) => m.slug && m.visibility !== 'hide')
    .map((m) => ({ id: m.slug, label: m.display_name || m.slug, hint: m.description ? String(m.description).split('.')[0].slice(0, 80) : '', isDefault: !!m.is_default }));
}

async function grokModels(cfg) {
  const c = resolveCli('grok', cfg);
  if (!c) return [];
  const r = await runCli(c, ['models'], { timeoutMs: 30000 });
  const list = [];
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
    const m = line.match(/^\s*[*-]\s+([\w.:-]+)(\s+\(default\))?/);
    if (m) list.push({ id: m[1], label: m[1], isDefault: !!m[2] });
  }
  return list;
}

/** Gemini CLI : `gemini --list-models` affiche « id (nom) » puis une description. */
async function geminiCliModels(cfg) {
  const c = resolveCli('gemini', cfg);
  if (!c) return [];
  const r = await runCli(c, ['--list-models'], { timeoutMs: 30000 });
  const list = [];
  const lines = `${r.stdout}\n${r.stderr}`.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w.:-]+) \((.+)\)\s*$/);
    if (!m) continue;
    const desc = (lines[i + 1] || '').match(/Description:\s*(.+)/);
    list.push({ id: m[1], label: m[1] === 'auto' ? 'Auto (Gemini CLI choisit)' : m[2], hint: desc ? desc[1].slice(0, 90) : '', isDefault: m[1] === 'auto' });
  }
  return list;
}

// Perplexity : modèles Sonar (l'API n'a pas de liste publique des modèles)
const PERPLEXITY = [
  { id: 'sonar-pro', label: 'Sonar Pro', hint: 'Recherche approfondie, plus de sources. Recommandé' },
  { id: 'sonar', label: 'Sonar', hint: 'Rapide et économique' },
  { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', hint: 'Raisonne avant de répondre' },
  { id: 'sonar-deep-research', label: 'Sonar Deep Research', hint: 'Rapport complet, plusieurs minutes' },
];

async function apiModels(url, headers, filter) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.data || j.models || [])
    .map((m) => ({ id: m.id, label: m.display_name || m.id }))
    .filter((m) => filter(m.id))
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** Toutes les listes utiles aux réglages. Les erreurs donnent une liste vide (le champ reste modifiable). */
export async function listModels(cfg) {
  const safe = (p) => p.catch(() => []);
  // Liste publique d'OpenRouter : utile seulement si une IA passe par OpenRouter
  const usesOr = [cfg.CLAUDE_AUTH, cfg.OPENAI_AUTH, cfg.XAI_AUTH, cfg.GEMINI_AUTH, cfg.PERPLEXITY_AUTH].includes('openrouter') || !!cfg.OPENROUTER_API_KEY;
  const or = usesOr ? await safe(orModels()) : [];
  const price = (m) => (m.price && Number.isFinite(m.price.in) ? `${m.price.in.toFixed(2).replace('.', ',')} $ / ${m.price.out.toFixed(2).replace('.', ',')} $ par million de tokens` : '');
  const orList = (re, img = false, anyTools = false) => or.filter((m) => re.test(m.id) && (img ? m.image : anyTools || m.tools)).sort((a, b) => b.created - a.created)
    .map((m) => ({ id: m.id, label: m.name.replace(/^[^:]+:\s*/, ''), hint: price(m) }));
  const [codex, grok, anthropic, openai, xai, geminiCli, gemini] = await Promise.all([
    safe(cached('codex', () => codexModels(cfg))),
    safe(cached('grok', () => grokModels(cfg))),
    cfg.ANTHROPIC_API_KEY ? safe(cached('anthropic', () => apiModels('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': cfg.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, (id) => id.startsWith('claude')))) : [],
    cfg.OPENAI_API_KEY ? safe(cached('openai', () => apiModels('https://api.openai.com/v1/models', { authorization: `Bearer ${cfg.OPENAI_API_KEY}` }, (id) => /^(gpt|o\d|chatgpt)/.test(id) || id.includes('image')))) : [],
    cfg.XAI_API_KEY ? safe(cached('xai', () => apiModels('https://api.x.ai/v1/models', { authorization: `Bearer ${cfg.XAI_API_KEY}` }, (id) => id.startsWith('grok')))) : [],
    safe(cached('gemini-cli', () => geminiCliModels(cfg))),
    cfg.GEMINI_API_KEY ? safe(geminiModels(cfg)) : [],
  ]);
  const local = localBase(cfg) ? await safe(localModels(cfg)) : [];
  const byVersion = (a, b) => b.id.localeCompare(a.id, 'en', { numeric: true });
  return {
    CLAUDE_ACCOUNT_MODEL: CLAUDE_ACCOUNT,
    CLAUDE_MODEL: anthropic.length ? anthropic : CLAUDE_API,
    CODEX_MODEL: codex,
    OPENAI_MODEL: openai.filter((m) => !m.id.includes('image')),
    OPENAI_IMAGE_MODEL: openai.filter((m) => m.id.includes('image')),
    GROK_ACCOUNT_MODEL: grok,
    GROK_MODEL: xai.filter((m) => !m.id.includes('image')),
    GROK_IMAGE_MODEL: xai.filter((m) => m.id.includes('image')),
    OPENROUTER_CLAUDE_MODEL: orList(/^anthropic\//),
    OPENROUTER_GPT_MODEL: orList(/^openai\//),
    OPENROUTER_GROK_MODEL: orList(/^x-ai\//),
    OPENROUTER_IMAGE_MODEL: orList(/./, true),
    GEMINI_ACCOUNT_MODEL: geminiCli,
    GEMINI_MODEL: gemini.filter((m) => !/image|tts|audio|live|embedding|robotics|computer-use/.test(m.id)).sort(byVersion),
    GEMINI_IMAGE_MODEL: gemini.filter((m) => /image/.test(m.id)).sort(byVersion),
    PERPLEXITY_MODEL: PERPLEXITY,
    LOCAL_MODEL: local,
    OPENROUTER_GEMINI_MODEL: orList(/^google\/gemini/),
    OPENROUTER_PERPLEXITY_MODEL: orList(/^perplexity\//, false, true),
    OPENROUTER_GEMINI_IMAGE_MODEL: orList(/^google\//, true),
  };
}
