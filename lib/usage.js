/**
 * Utilisation des abonnements.
 *  - Limites (% sur 5 h et 7 jours) :
 *      Claude  → événements `rate_limit_event` envoyés par Claude Code
 *      ChatGPT → `rate_limits` écrits par Codex dans ses fichiers de session
 *      Grok    → non communiqué par Grok Build
 *      Gemini  → non communiqué par Gemini CLI (Relais compte les tokens)
 *  - Répartition par modèle : tokens comptés par Relais à chaque réponse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const STATE = path.join(paths.data, 'usage.json');
const LOG = path.join(paths.data, 'usage-log.jsonl');
const CODEX_SESSIONS = path.join(paths.accounts, 'codex', 'sessions');
const H5 = 5 * 3600 * 1000;
const D7 = 7 * 24 * 3600 * 1000;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { limits: {}, codexSeen: {} }; }
}
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch { /* lecture seule */ } }

/** Pourcentage déjà sur 100 (Codex, used_percentage). */
const pct = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};
/** Fraction 0–1 (Claude `utilization`). */
const frac = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n * 100)) : null;
};
const toMs = (t) => {
  if (!t) return null;
  const n = Number(t);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : null;
};

/* ---------- Tokens par modèle ---------- */
export function recordTokens(provider, model, input = 0, output = 0) {
  const entry = { t: Date.now(), p: provider, m: String(model || 'défaut'), i: Math.round(input) || 0, o: Math.round(output) || 0 };
  try { fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`); } catch { /* ignore */ }
}

/** Compte les tokens d'un événement `result` (Claude Code, Grok Build). */
export function recordResult(provider, ev, fallbackModel) {
  if (!ev) return;
  const mu = ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.entries(ev.modelUsage) : [];
  if (mu.length) {
    for (const [model, u] of mu) {
      recordTokens(provider, model, (u.inputTokens || u.input_tokens || 0) + (u.cacheCreationInputTokens || u.cache_creation_input_tokens || 0), u.outputTokens || u.output_tokens || 0);
    }
  } else {
    const u = ev.usage || {};
    recordTokens(provider, ev.model || fallbackModel, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), (u.output_tokens || 0) + (u.reasoning_tokens || 0));
  }
}

function readLog() {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').split('\n'); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (now - e.t < D7) out.push(e); } catch { /* ligne abîmée */ }
  }
  // Élague le journal (garde 7 jours)
  if (out.length < lines.length - 50) {
    try { fs.writeFileSync(LOG, out.map((e) => JSON.stringify(e)).join('\n') + (out.length ? '\n' : '')); } catch { /* ignore */ }
  }
  return out;
}

/* ---------- Claude : événements rate_limit_event ---------- */
export function recordClaudeRateLimit(info) {
  if (!info || typeof info !== 'object') return;
  const s = readState();
  const cur = s.limits.claude || { windows: {} };
  const windows = { ...cur.windows };
  const set = (key, w) => {
    const p = w?.utilization !== undefined ? frac(w.utilization) : pct(w?.used_percentage ?? w?.usedPercent);
    if (p === null && !w?.resetsAt) return;
    windows[key] = { pct: p ?? windows[key]?.pct ?? null, resetsAt: toMs(w?.resetsAt ?? w?.resets_at) ?? windows[key]?.resetsAt ?? null, status: w?.status || info.status || null };
  };
  if (info.unifiedWindows && typeof info.unifiedWindows === 'object') {
    for (const [k, w] of Object.entries(info.unifiedWindows)) set(k, w);
  }
  if (info.rateLimitType) set(info.rateLimitType, info);
  s.limits.claude = { windows, status: info.status || cur.status || null, updatedAt: Date.now() };
  writeState(s);
}

/* ---------- Codex : fichiers de session ---------- */
function newestJsonl(dir, max = 3) {
  const files = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.jsonl')) { try { files.push({ f, m: fs.statSync(f).mtimeMs }); } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return files.sort((a, b) => b.m - a.m).slice(0, max);
}

function tail(file, bytes = 400000) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** Relit les limites et les tokens que Codex a écrits dans ses sessions récentes. */
export function syncCodex() {
  const s = readState();
  s.codexSeen ||= {};
  let latest = null;
  for (const { f, m } of newestJsonl(CODEX_SESSIONS)) {
    let text;
    try { text = tail(f); } catch { continue; }
    let model = null;
    const lines = text.split('\n');
    const seen = s.codexSeen[f] || 0;
    let maxT = seen;
    for (const l of lines) {
      if (!l.includes('"model"') && !l.includes('token_count')) continue;
      let ev;
      try { ev = JSON.parse(l); } catch { continue; }
      const p = ev.payload || ev;
      if (p.model && (ev.type === 'turn_context' || p.type === 'turn_context' || ev.type === 'session_meta')) model = p.model;
      if (p.type !== 'token_count') continue;
      const t = toMs(ev.timestamp) || m;
      if (p.rate_limits && (!latest || t >= latest.t)) latest = { t, rl: p.rate_limits };
      const last = p.info?.last_token_usage;
      if (last && t > seen) {
        recordTokens('codex', model || 'défaut', (last.input_tokens || 0), (last.output_tokens || 0) + (last.reasoning_output_tokens || 0));
        if (t > maxT) maxT = t;
      }
    }
    s.codexSeen[f] = maxT;
  }
  // N'oublie pas les fichiers trop anciens
  for (const k of Object.keys(s.codexSeen)) if (!fs.existsSync(k)) delete s.codexSeen[k];
  if (latest) {
    const windows = {};
    for (const key of ['primary', 'secondary']) {
      const w = latest.rl[key];
      if (!w) continue;
      const name = w.window_minutes <= 360 ? 'five_hour' : w.window_minutes >= 10000 ? 'seven_day' : `${w.window_minutes}_min`;
      windows[name] = { pct: pct(w.used_percent), resetsAt: toMs(w.resets_at) || (w.resets_in_seconds ? latest.t + w.resets_in_seconds * 1000 : null) };
    }
    s.limits.codex = { windows, plan: latest.rl.plan_type || null, updatedAt: latest.t };
  }
  writeState(s);
}

/* ---------- Résumé pour l'interface ---------- */
export function usageSummary() {
  try { syncCodex(); } catch { /* sessions illisibles */ }
  const s = readState();
  const log = readLog();
  const now = Date.now();
  const providers = {};
  for (const p of ['claude', 'codex', 'grok', 'gemini']) {
    const models = {};
    let t5 = 0;
    let t7 = 0;
    let req5 = 0;
    let req7 = 0;
    for (const e of log) {
      if (e.p !== p) continue;
      const tok = e.i + e.o;
      const m = (models[e.m] ||= { tokens5h: 0, tokens7d: 0, req5h: 0, req7d: 0 });
      m.tokens7d += tok; m.req7d++; t7 += tok; req7++;
      if (now - e.t < H5) { m.tokens5h += tok; m.req5h++; t5 += tok; req5++; }
    }
    for (const m of Object.values(models)) {
      m.share5h = t5 ? Math.round((m.tokens5h / t5) * 100) : (req5 ? Math.round((m.req5h / req5) * 100) : 0);
      m.share7d = t7 ? Math.round((m.tokens7d / t7) * 100) : (req7 ? Math.round((m.req7d / req7) * 100) : 0);
    }
    const lim = s.limits[p] || null;
    // Une fenêtre déjà réinitialisée repart à 0 %
    if (lim?.windows) for (const w of Object.values(lim.windows)) if (w.resetsAt && w.resetsAt < now) { w.pct = 0; w.expired = true; }
    providers[p] = { limits: lim, tokens5h: t5, tokens7d: t7, req5h: req5, req7d: req7, models };
  }
  return { providers, at: now };
}
