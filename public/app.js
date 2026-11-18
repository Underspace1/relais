/* Relais v2 — client */
import { detectIntent } from './intent.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const AGENTS = {
  claude: { name: 'Claude', mono: 'Cl' },
  chatgpt: { name: 'ChatGPT', mono: 'Gp' },
  codex: { name: 'ChatGPT', mono: 'Gp' },
  grok: { name: 'Grok', mono: 'Gk' },
  cursor: { name: 'Cursor', mono: 'Cu' },
  skill: { name: 'Skill', mono: 'Sk' },
};

const I = {
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6M20 4v4.6h-4.6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  // onglets réglages
  general: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  plug: '<svg viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  code: '<svg viewBox="0 0 24 24"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/></svg>',
  data: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7" ry="2.5"/><path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></svg>',
  design: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9h17M9 9v10.5"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  github: '<svg viewBox="0 0 24 24"><path d="M9 19c-4 1.3-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 2.8 5.8 3.1 5.8 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>',
  monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>',
  tablet: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7.5" y="3" width="9" height="18" rx="2"/><path d="M11 18h2"/></svg>',
};

const DEFAULT_PREFS = { theme: 'auto', fontSize: 'm', sendKey: 'enter', stepsOpen: false, perm: 'ask' };

const PERM_INFO = {
  read: { label: 'Lecture seule', icon: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.5"/></svg>', desc: 'Les IA lisent et analysent, sans rien modifier.' },
  ask: { label: 'Demander', icon: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/></svg>', desc: 'Claude te demande avant chaque modification ou commande. Codex et Grok modifient les fichiers du projet, sans commandes risquées.' },
  full: { label: 'Accès complet', icon: '<svg viewBox="0 0 24 24"><path d="M13 3L5 13h6l-1 8 8-10h-6z"/></svg>', desc: 'Fichiers et commandes sans confirmation. Pour les projets que tu sauvegardes (Git).' },
};
const CODER_NAME = { claude: 'Claude Code', chatgpt: 'Codex', grok: 'Grok Build' };

const state = {
  convId: null,
  mode: 'claude',
  skill: null,
  relay: null,
  relayDirect: false,
  skills: [],
  status: null,
  connectors: null,
  convs: [],
  search: '',
  streaming: null,
  pop: null,
  popIndex: 0,
  prefs: loadPrefs(),
  project: null, // { path, name, type } du projet ouvert
  perm: null,
};
state.perm = state.prefs.perm || 'ask';

function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('relais-prefs') || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs() {
  try { localStorage.setItem('relais-prefs', JSON.stringify(state.prefs)); } catch { /* indisponible */ }
  const root = document.documentElement;
  if (state.prefs.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = state.prefs.theme;
  if (state.prefs.fontSize === 'm') delete root.dataset.size; else root.dataset.size = state.prefs.fontSize;
  setMode(state.mode);
  if (typeof syncHostBackground === 'function') syncHostBackground();
}

/* ==========================================================================
   API
   ========================================================================== */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadStatus() {
  try { state.status = await api('/api/status'); } catch { state.status = null; }
  renderConnCard();
  renderTopAgents();
}
async function loadConnectors(force) {
  try { state.connectors = await api(`/api/connectors${force ? '?force=1' : ''}`); } catch { state.connectors = null; }
  renderConnCard();
}
async function loadSkills() {
  try { state.skills = await api('/api/skills'); } catch { state.skills = []; }
  $('#skillCount').textContent = state.skills.length || '';
}
async function loadConvs() {
  try { state.convs = await api('/api/conversations'); } catch { state.convs = []; }
  renderConvList();
}

const relays = () => state.status?.relays || [];
const av = () => state.status?.available || {};
const settings = () => state.status?.settings || {};

/* ==========================================================================
   Markdown (sûr : tout est échappé avant mise en forme)
   ========================================================================== */
function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const LIST = /^\s*([-*+]|\d+[.)])\s+/;
  const BREAK = /^\s*```|^#{1,4}\s|^\s*([-*+]|\d+[.)])\s+|^>|^\|/;
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out += `<div class="code"><div class="code-head"><span>${esc(fence[1] || 'code')}</span><button type="button" data-copy-code>${I.copy}Copier</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
      continue;
    }
    const hd = l.match(/^(#{1,4})\s+(.*)$/);
    if (hd) { const n = hd[1].length + 1; out += `<h${n}>${inline(hd[2])}</h${n}>`; i++; continue; }
    if (LIST.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && (LIST.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (LIST.test(lines[i])) items.push(lines[i].replace(LIST, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out += `<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`;
      continue;
    }
    if (/^>\s?/.test(l)) {
      const b = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) b.push(lines[i++].replace(/^>\s?/, ''));
      out += `<blockquote>${inline(b.join(' '))}</blockquote>`;
      continue;
    }
    if (/^\|.*\|\s*$/.test(l) && /^\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out += '<hr>'; i++; continue; }
    if (!l.trim()) { i++; continue; }
    const p = [];
    while (i < lines.length && lines[i].trim() && !(p.length && BREAK.test(lines[i]))) p.push(lines[i++]);
    out += `<p>${inline(p.join('\n')).replace(/\n/g, '<br>')}</p>`;
  }
  return out;
}

/* ==========================================================================
   Barre latérale
   ========================================================================== */
function connState(id) {
  const s = settings();
  const authKey = { claude: 'CLAUDE_AUTH', codex: 'OPENAI_AUTH', grok: 'XAI_AUTH' }[id];
  const keyName = { claude: 'anthropic', codex: 'openai', grok: 'xai' }[id];
  if (!state.status) return { label: '—', ok: false };
  if (s[authKey] === 'api') return s.keys?.[keyName] ? { label: 'clé API', ok: true } : { label: 'pas de clé', ok: false };
  const c = state.connectors?.[id];
  if (!c) return { label: '…', ok: false };
  if (c.installing) return { label: 'installation', ok: false };
  if (!c.installed) return { label: 'à installer', ok: false };
  if (c.connected === true) return { label: 'compte', ok: true };
  if (c.connected === null) return { label: 'installé', ok: true };
  return { label: 'à connecter', ok: false };
}

function renderConnCard() {
  const rows = [['claude', 'claude'], ['codex', 'chatgpt'], ['grok', 'grok']];
  $('#connCard').innerHTML = rows.map(([id, a]) => {
    const st = connState(id);
    return `<div class="conn-row ${st.ok ? '' : 'off'}"><i class="dot" data-agent="${a}"></i>${AGENTS[a].name}<span class="st ${st.ok ? 'ok' : ''}">${st.label}</span></div>`;
  }).join('');
}

function renderTopAgents() {
  const a = av();
  $('#topAgents').innerHTML = ['claude', 'chatgpt', 'grok', ...(a.cursor ? ['cursor'] : [])]
    .map((k) => `<span class="avatar ${a[k] ? '' : 'off'}" data-agent="${k}" title="${AGENTS[k].name} : ${a[k] ? 'disponible' : 'non configuré'}">${AGENTS[k].mono}</span>`).join('');
}

function groupLabel(ts) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Aujourd’hui';
  if (ts >= start - 86400000) return 'Hier';
  if (ts >= start - 6 * 86400000) return '7 derniers jours';
  if (ts >= start - 29 * 86400000) return '30 derniers jours';
  return new Date(ts).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

function renderConvList() {
  const el = $('#convList');
  const q = state.search.trim().toLowerCase();
  const list = state.convs.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
  if (!list.length) {
    el.innerHTML = `<div class="conv-empty">${q ? 'Aucun résultat.' : 'Tes conversations apparaîtront ici.'}</div>`;
    return;
  }
  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned);
  const item = (c) => `<div class="conv-item ${c.id === state.convId ? 'active' : ''}" role="button" tabindex="0" data-conv="${c.id}" title="${c.project ? esc(c.project) : ''}">
      ${c.project ? `<span class="conv-proj">${FOLDER_ICON}</span>` : `<i class="dot" data-agent="${esc(c.mode || 'claude')}"></i>`}<span class="t">${esc(c.title || 'Sans titre')}</span>
      <span class="acts"><button type="button" data-pin="${c.id}" data-pinned="${c.pinned ? 1 : 0}" title="${c.pinned ? 'Désépingler' : 'Épingler'}">${I.pin}</button><button type="button" data-rename="${c.id}" title="Renommer">${I.edit}</button><button type="button" data-del="${c.id}" title="Supprimer">${I.trash}</button></span></div>`;
  let html = pinned.length ? `<div class="conv-group">Épinglées</div>${pinned.map(item).join('')}` : '';
  let last = '';
  for (const c of rest) {
    const g = groupLabel(c.updatedAt);
    if (g !== last) { html += `<div class="conv-group">${g}</div>`; last = g; }
    html += item(c);
  }
  el.innerHTML = html;
}

/* ==========================================================================
   Rendu des messages
   ========================================================================== */
const thread = $('#thread');
const inner = $('#threadInner');
const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
const scrollDown = (force) => { if (force || nearBottom()) thread.scrollTop = thread.scrollHeight; };

function chainHtml(chain) {
  return `<span class="chain">${chain.map((a) => `<i class="dot" data-agent="${a}"></i>`).join(I.arrow)}</span>`;
}

function relayAvailable(r) {
  const a = av();
  const need = { 'image-grok': a.imageGrok, 'image-chatgpt': a.imageChatgpt, 'roblox-icon': a.imageChatgpt, 'roblox-thumb': a.imageChatgpt, 'image-both': a.claude && a.imageChatgpt && a.imageGrok, 'ask-chatgpt': a.chatgpt, 'ask-grok': a.grok, debate: a.claude && (a.chatgpt || a.grok), 'code-review': a.claude && a.chatgpt, 'code-project': a.claude, 'roblox-script': a.claude };
  return need[r.id] === undefined ? true : !!need[r.id];
}

const CODE_STARTERS = [
  { t: 'Explique-moi ce projet', d: 'Structure, rôle des fichiers, points d’entrée', p: 'Explore ce projet et explique-moi sa structure : à quoi sert chaque dossier et fichier important, comment il se lance, et ce qui pourrait être amélioré.' },
  { t: 'Trouve et corrige les bugs', d: 'Analyse, puis corrections', p: 'Cherche les bugs et les erreurs probables dans ce projet, explique-les, puis corrige les plus importants.' },
  { t: 'Ajoute une fonctionnalité', d: 'Décris-la, l’IA s’en charge', p: 'Je veux ajouter cette fonctionnalité : ' },
  { t: 'Nettoie et organise', d: 'Code plus clair, sans changer le comportement', p: 'Rends le code de ce projet plus clair et mieux organisé, sans changer son comportement. Explique ce que tu as changé.' },
  { t: 'Système Roblox', d: 'Script Luau serveur + client', p: 'Crée dans ce projet un système Roblox complet (scripts serveur et client, RemoteEvents sécurisés) pour : ' },
  { t: 'Icône du jeu', d: 'Générée par ChatGPT, rangée dans le projet', p: 'Crée une icône pour ce jeu (demande l’image à ChatGPT) et range-la dans le projet.' },
];

function renderProjectEmpty() {
  const p = state.project;
  const a = av();
  inner.innerHTML = '';
  inner.append(h(`<div class="empty">
    <div class="proj-card">${FOLDER_ICON}<div><b>${esc(p.name)}</b><span>${esc(p.path)}</span></div><span class="pill">${esc(p.type || 'Dossier')}</span>
      <button type="button" class="btn sm" data-reveal="${esc(p.path)}">Ouvrir le dossier</button></div>
    <h2 class="hello">On construit quoi<br><span>dans ${esc(p.name)} ?</span></h2>
    <p class="lede">Choisis l’IA qui code en bas à droite — ${CODER_NAME.claude}, ${CODER_NAME.chatgpt} ou ${CODER_NAME.grok} — et le niveau d’autorisation à gauche. Elle lit, modifie et teste directement les fichiers de ce dossier.</p>
    ${!a[state.mode] ? `<div class="setup"><span class="avatar" data-agent="${state.mode}">${AGENTS[state.mode].mono}</span><div><b>${CODER_NAME[state.mode]} n’est pas connecté</b><span>Connecte ton compte pour coder dans ce projet.</span></div><button class="btn primary" type="button" data-open-settings="connexions">Connecter</button></div>` : ''}
    <div class="section-label"><span>Pour commencer</span></div>
    <div class="tiles">${CODE_STARTERS.map((s, i) => `<button type="button" class="tile" data-code-starter="${i}"><b>${esc(s.t)}</b><span>${esc(s.d)}</span></button>`).join('')}</div>
  </div>`));
}

function renderEmpty() {
  if (state.project) return renderProjectEmpty();
  const hour = new Date().getHours();
  const hi = hour < 6 ? 'Bonne nuit' : hour < 18 ? 'Bonjour' : 'Bonsoir';
  const a = av();
  const featured = ['image-chatgpt', 'design', 'design-roblox-ui', 'roblox-icon', 'debate', 'code-project'].map((id) => relays().find((r) => r.id === id)).filter(Boolean);
  inner.innerHTML = '';
  inner.append(h(`<div class="empty">
    <h2 class="hello">${hi}.<br><span>Qu’est-ce qu’on crée ?</span></h2>
    <p class="lede">Écris simplement : Claude comprend quand il faut une image, un autre avis ou du code, et fait travailler la bonne IA. Essaie « dessine un logo pour mon jeu » ou « demande à Grok… ».</p>
    ${state.status && !(a.claude && a.chatgpt && a.grok) ? `<div class="setup"><span class="avatar" data-agent="${!a.claude ? 'claude' : !a.chatgpt ? 'chatgpt' : 'grok'}">${!a.claude ? 'Cl' : !a.chatgpt ? 'Gp' : 'Gk'}</span><div><b>${!a.claude && !a.chatgpt && !a.grok ? 'Connecte tes comptes' : `Connecte ${!a.claude ? 'Claude' : !a.chatgpt ? 'ChatGPT' : 'Grok'}`}</b><span>Avec tes abonnements, sans clé API. Tout reste dans le dossier Relais.</span></div><button class="btn primary" type="button" data-open-settings="connexions">Connecter</button></div>` : ''}
    <div class="section-label"><span>Relais rapides</span></div>
    <div class="tiles">${featured.map((r) => `
      <button type="button" class="tile ${relayAvailable(r) ? '' : 'disabled'}" data-pick-relay="${r.id}">
        <span class="tile-top">${chainHtml(r.chain)}</span>
        <b>${esc(r.label)}</b><span>${esc(r.hint)}</span>
      </button>`).join('')}
    </div></div>`));
}

function fmtMs(ms) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`; }

function userEl(m) {
  const sk = m.skill && state.skills.find((s) => s.slug === m.skill);
  const rl = m.relay && relays().find((r) => r.id === m.relay);
  const tags = [
    rl ? `<span class="tag">${chainHtml(rl.chain)}${esc(rl.label)}${m.direct ? ' · direct' : ''}</span>` : '',
    sk ? `<span class="tag"><i class="dot" data-agent="skill"></i>${esc(sk.name)}</span>` : '',
  ].join('');
  return h(`<div class="msg user">${tags.trim() ? `<div class="tags">${tags}</div>` : ''}<div class="bubble">${esc(m.text)}</div></div>`);
}

function stepEl(step, wasOpen) {
  const a = AGENTS[step.agent] ? step.agent : 'claude';
  const flat = (s) => String(s || '').replace(/\s+/g, ' ');
  const preview = step.status === 'running' ? (flat(step.output).slice(-120) || flat(step.input).slice(0, 120)) : flat(step.input).slice(0, 140);
  const status = step.status === 'running' ? '<span class="spinner"></span>en cours' : step.status === 'error' ? 'erreur' : step.ms ? fmtMs(step.ms) : 'terminé';
  const isText = ['chatgpt', 'grok', 'skill'].includes(step.agent) && !step.kind;
  const open = wasOpen ?? (state.prefs.stepsOpen || step.status === 'error');
  const body = `
    ${step.diff ? diffHtml(step.diff) : ''}
    ${step.input && !step.diff ? `<div class="step-label">${step.agent === 'skill' ? 'Description' : step.kind === 'command' ? 'Commande' : step.kind ? 'Détail' : 'Consigne'}</div><div class="step-input">${esc(step.input)}</div>` : ''}
    ${step.output ? `<div class="step-label">${step.status === 'error' ? 'Erreur' : step.agent === 'skill' ? 'Instructions' : 'Réponse'}</div>
      ${isText && step.status !== 'error' ? `<div class="md">${md(step.output)}</div>` : `<div class="step-input">${esc(step.output)}</div>`}` : ''}`;
  return h(`<div class="step part-step ${open ? 'open' : ''}" data-id="${esc(step.id)}" data-status="${esc(step.status || 'done')}">
    <button type="button" class="step-head" aria-expanded="${open}">
      <span class="avatar" data-agent="${a}">${AGENTS[a].mono}</span>
      <span class="step-title">${esc(step.title || 'Étape')}</span>
      <span class="step-preview">${esc(preview)}</span>
      <span class="step-status">${status}</span>${I.chev}
    </button><div class="step-body">${body}</div></div>`);
}

function imageEl(img) {
  const a = AGENTS[img.engine] ? img.engine : 'chatgpt';
  return h(`<figure class="figure part-image">
    <div class="figure-frame" data-zoom="${esc(img.url)}" data-caption="${esc(img.prompt)}">
      <img src="${esc(img.url)}" alt="${esc(img.prompt)}" loading="lazy">
      <div class="figure-actions"><a href="${esc(img.url)}" download title="Télécharger">${I.download}</a></div>
    </div>
    <figcaption><b><i class="dot" data-agent="${a}"></i>${AGENTS[a].name}</b><span>${esc(img.prompt)}</span></figcaption></figure>`);
}

function partEl(part, wasOpen) {
  if (part.type === 'text') { const e = h('<div class="md part-text"></div>'); e.innerHTML = md(part.text); return e; }
  if (part.type === 'step') return stepEl(part, wasOpen);
  if (part.type === 'image') return imageEl(part);
  if (part.type === 'design') return designEl(part);
  return h('<div></div>');
}

function assistantShell(agent, skillSlug) {
  const a = AGENTS[agent] ? agent : 'claude';
  const sk = skillSlug && state.skills.find((s) => s.slug === skillSlug);
  const el = h(`<div class="msg assistant">
    <div class="msg-head"><span class="avatar" data-agent="${a}">${AGENTS[a].mono}</span><span class="msg-name">${state.project && CODER_NAME[a] ? CODER_NAME[a] : AGENTS[a].name}</span>
      ${sk ? `<span class="tag"><i class="dot" data-agent="skill"></i>${esc(sk.name)}</span>` : ''}<span class="msg-meta"></span></div>
    <div class="parts"></div>
    <div class="msg-actions"><button type="button" data-copy-msg>${I.copy}<span>Copier</span></button><button type="button" data-retry>${I.retry}<span>Relancer</span></button></div></div>`);
  return { el, partsEl: $('.parts', el), parts: [], els: [], agent: a };
}

function errorEl(message) {
  const settingsHint = /Réglages|clé|connect|install|key|401|403/i.test(message);
  return h(`<div class="msg-error">${I.alert}<div>${esc(message)}${settingsHint ? ' — <button type="button" data-open-settings="connexions">Ouvrir les connexions</button>' : ''}</div></div>`);
}

/* ---------- Diffs et autorisations ---------- */
function diffHtml(diff) {
  if (!diff) return '';
  const rows = [];
  const oldL = diff.old ? diff.old.split('\n') : [];
  const newL = diff.new ? diff.new.split('\n') : [];
  // Lignes communes en début et en fin, pour ne montrer que ce qui change
  let a = 0;
  while (a < oldL.length && a < newL.length && oldL[a] === newL[a]) a++;
  let b = 0;
  while (b < oldL.length - a && b < newL.length - a && oldL[oldL.length - 1 - b] === newL[newL.length - 1 - b]) b++;
  for (const l of oldL.slice(Math.max(0, a - 2), a)) rows.push(['ctx', l]);
  for (const l of oldL.slice(a, oldL.length - b)) rows.push(['del', l]);
  for (const l of newL.slice(a, newL.length - b)) rows.push(['add', l]);
  for (const l of oldL.slice(oldL.length - b, oldL.length - b + 2)) rows.push(['ctx', l]);
  const shown = rows.slice(0, 160);
  return `<div class="diff"><div class="diff-head">${esc(diff.path || '')}<span>${diff.old ? '' : 'nouveau fichier'}</span></div><pre>${shown.map(([k, l]) => `<span class="dl ${k}">${k === 'del' ? '−' : k === 'add' ? '+' : ' '} ${esc(l)}</span>`).join('')}${rows.length > shown.length ? `<span class="dl ctx">… ${rows.length - shown.length} lignes de plus</span>` : ''}</pre></div>`;
}

function permissionEl(d, agent) {
  const a = AGENTS[agent] ? agent : 'claude';
  return h(`<div class="perm-card" data-perm-id="${esc(d.id)}">
    <div class="perm-top"><span class="avatar" data-agent="${a}">${AGENTS[a].mono}</span><div><b>${d.kind === 'command' ? 'Lancer une commande ?' : d.kind === 'edit' ? 'Modifier un fichier ?' : 'Autoriser cette action ?'}</b><span>${esc(d.title)}</span></div></div>
    ${d.diff ? diffHtml(d.diff) : d.detail ? `<pre class="perm-detail">${esc(d.detail)}</pre>` : ''}
    <div class="perm-actions">
      <button type="button" class="btn sm primary" data-perm="allow">Autoriser</button>
      <button type="button" class="btn sm" data-perm="always">Toujours autoriser « ${esc(d.tool)} » ici</button>
      <button type="button" class="btn sm danger right" data-perm="deny">Refuser</button>
    </div></div>`);
}

function settlePermission(card, decision) {
  card.classList.add('settled');
  $('.perm-actions', card).innerHTML = `<span class="note">${decision === 'deny' ? 'Refusé' : decision === 'always' ? 'Autorisé pour cette conversation' : 'Autorisé'}</span>`;
}

function notifyAttention(msg) {
  if (document.hasFocus()) return;
  const t = document.title;
  document.title = `● ${msg}`;
  window.addEventListener('focus', () => { document.title = t; }, { once: true });
}

function finishView(view, { ms, error } = {}) {
  view.el.classList.remove('streaming');
  $('.thinking', view.el)?.remove();
  if (ms) $('.msg-meta', view.el).textContent = fmtMs(ms);
  if (error) view.partsEl.append(errorEl(error));
  if (!view.parts.length && !error) view.partsEl.append(h('<div class="md part-text"><p>(Réponse vide)</p></div>'));
  view.el._view = view;
}

function assistantEl(m) {
  const view = assistantShell(m.agent, m.skill);
  for (const p of m.parts || []) { view.parts.push(p); const e = partEl(p, state.prefs.stepsOpen); view.els.push(e); view.partsEl.append(e); }
  finishView(view, { ms: m.ms, error: m.error });
  return view.el;
}

/* ---------- Événements en direct ---------- */
let raf = null;
function renderTextSoon(view, idx) {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    const p = view.parts[idx];
    if (p && view.els[idx]) view.els[idx].innerHTML = md(p.text);
    scrollDown();
  });
}
function addPart(view, part) {
  $('.thinking', view.el)?.remove();
  view.parts.push(part);
  const e = partEl(part);
  view.els.push(e);
  view.partsEl.append(e);
  scrollDown();
}
function applyEvent(view, ev, d) {
  if (ev === 'text') {
    const i = view.parts.length - 1;
    if (view.parts[i]?.type === 'text') { view.parts[i].text += d.delta; renderTextSoon(view, i); }
    else addPart(view, { type: 'text', text: d.delta });
  } else if (ev === 'step') {
    const i = view.parts.findIndex((p) => p.type === 'step' && p.id === d.step.id);
    if (i < 0) return addPart(view, { type: 'step', ...d.step });
    view.parts[i] = { ...view.parts[i], ...d.step };
    const e = stepEl(view.parts[i], view.els[i].classList.contains('open'));
    view.els[i].replaceWith(e);
    view.els[i] = e;
    scrollDown();
  } else if (ev === 'image') addPart(view, { type: 'image', ...d.image });
  else if (ev === 'design') {
    const part = { type: 'design', ...d.design };
    const i = view.parts.findIndex((p) => p.type === 'design' && p.id === part.id);
    if (i >= 0) {
      view.parts[i] = part;
      const e = designEl(part);
      view.els[i].replaceWith(e);
      view.els[i] = e;
    } else addPart(view, part);
    // Une nouvelle version d'un design déjà affiché plus haut : on rafraîchit aussi ces cartes.
    $$(`[data-design-id="${part.id}"] iframe`).forEach((f) => { f.src = `${part.url}?v=${part.version}`; });
    $$(`[data-design-id="${part.id}"] .tag`).forEach((t) => { t.textContent = `${part.kind || 'prototype'} · v${part.version}`; });
  }
}

/* ==========================================================================
   Envoi (flux SSE)
   ========================================================================== */
let lastSent = null;

async function send(text, override) {
  text = String(text || '').trim();
  if (!text || state.streaming) return;
  const req = override || { mode: state.mode, skill: state.skill, relay: state.relay, direct: state.relayDirect };
  const r = req.relay && relays().find((x) => x.id === req.relay);
  const a = av();
  if (state.status && !a.claude && !a.chatgpt && !a.grok) {
    toast('Connecte d’abord au moins une IA.', true);
    openSettings('connexions');
    return;
  }
  if (state.status && state.project && !a[req.mode]) {
    toast(`${CODER_NAME[req.mode]} n’est pas encore connecté.`, true);
    openSettings('connexions');
    return;
  }
  if (state.status && !state.project && !r && req.mode !== 'claude' && !a[req.mode]) {
    toast(`${AGENTS[req.mode].name} n’est pas encore connecté.`, true);
    openSettings('connexions');
    return;
  }
  lastSent = { text, ...req };

  if ($('.empty', inner)) inner.innerHTML = '';
  inner.append(userEl({ text, skill: req.skill, relay: req.relay, direct: req.direct }));
  const agent = r && req.direct ? r.engine : r ? 'claude' : req.mode;
  const view = assistantShell(agent, req.skill);
  view.el.classList.add('streaming');
  const label = r ? (req.direct ? `${AGENTS[r.engine].name} travaille…` : 'Claude prépare le relais…') : `${AGENTS[agent].name} réfléchit…`;
  view.partsEl.append(h(`<div class="thinking"><span class="bars"><i></i><i></i><i></i></span>${label}</div>`));
  inner.append(view.el);
  scrollDown(true);

  if (!override) { input.value = ''; autoGrow(); state.intent = null; setSkill(null); setRelay(null); }

  const controller = new AbortController();
  state.streaming = { controller, view };
  updateSendBtn();
  const meta = {};

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: state.convId, text, mode: req.mode, skill: req.skill, relay: req.relay, direct: req.direct, project: state.project?.path || null, perm: state.perm }),
      signal: controller.signal,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        let d = {};
        try { d = JSON.parse(data || '{}'); } catch { continue; }
        if (ev === 'conversation') {
          const isNew = state.convId !== d.id;
          state.convId = d.id;
          $('#convTitle').textContent = d.title;
          if (isNew) loadConvs();
        } else if (ev === 'route') {
          const ag = AGENTS[d.agent] ? d.agent : 'claude';
          const av2 = $('.msg-head .avatar', view.el);
          av2.dataset.agent = ag;
          av2.textContent = AGENTS[ag].mono;
          $('.msg-name', view.el).textContent = d.project ? CODER_NAME[ag] : AGENTS[ag].name;
          if (d.relay) $('.msg-name', view.el).insertAdjacentHTML('afterend', `<span class="tag">${esc(d.relay)}${d.direct ? ' · direct' : ''}</span>`);
          const th = $('.thinking', view.el);
          if (th) th.lastChild.textContent = d.direct ? `${AGENTS[ag].name} travaille…` : `${AGENTS[ag].name} réfléchit…`;
          if (d.fallback) view.partsEl.insertAdjacentHTML('afterbegin', '<p class="note">Claude n’est pas connecté : la demande part directement à l’IA disponible.</p>');
        } else if (ev === 'permission') {
          $('.thinking', view.el)?.remove();
          view.partsEl.append(permissionEl(d, view.agent));
          scrollDown(true);
          notifyAttention(`${CODER_NAME.claude} demande une autorisation`);
        } else if (ev === 'permission_done') {
          const card = $(`[data-perm-id="${d.id}"]`);
          if (card) settlePermission(card, d.decision);
        } else if (ev === 'error') meta.error = d.message;
        else if (ev === 'done') meta.ms = d.ms;
        else if (ev === 'skills') loadSkills();
        else applyEvent(view, ev, d);
      }
    }
  } catch (e) {
    meta.error = e.name === 'AbortError' ? 'Arrêté.' : `Connexion impossible : ${e.message}`;
  } finally {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    view.parts.forEach((p, i) => { if (p.type === 'text') view.els[i].innerHTML = md(p.text); });
    finishView(view, meta);
    state.streaming = null;
    updateSendBtn();
    loadConvs();
    loadUsage();
    input.focus();
  }
}

/* ==========================================================================
   Conversations
   ========================================================================== */
function newChat() {
  if (state.streaming) state.streaming.controller.abort();
  state.convId = null;
  $('#convTitle').textContent = 'Nouvelle conversation';
  renderEmpty();
  renderConvList();
  closeNav();
  input.focus();
}

async function openConv(id) {
  if (state.streaming) state.streaming.controller.abort();
  try {
    const c = await api(`/api/conversations/${id}`);
    state.convId = c.id;
    $('#convTitle').textContent = c.title;
    state.project = c.project ? await api('/api/projects/info', { method: 'POST', body: { path: c.project } }).catch(() => ({ path: c.project, name: c.project.split(/[\\/]/).pop() })) : null;
    if (c.perm) state.perm = c.perm;
    setMode(c.mode || 'claude');
    inner.innerHTML = '';
    for (const m of c.messages) inner.append(m.role === 'user' ? userEl(m) : assistantEl(m));
    renderConvList();
    closeNav();
    requestAnimationFrame(() => scrollDown(true));
  } catch (e) { toast(e.message, true); }
}

/* ==========================================================================
   Composer : mode, relais, skills
   ========================================================================== */
const input = $('#input');
const pop = $('#popover');

function setMode(mode) {
  state.mode = mode;
  $$('#modeSwitch button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    $('span', b).textContent = state.project ? CODER_NAME[b.dataset.mode] : AGENTS[b.dataset.mode].name;
  });
  const r = state.relay && relays().find((x) => x.id === state.relay);
  const key = state.prefs.sendKey === 'ctrl' ? 'Ctrl+Entrée pour envoyer' : 'Entrée pour envoyer';
  if (state.project) {
    input.placeholder = `Que doit faire ${CODER_NAME[mode]} dans ${state.project.name} ?`;
    $('#hint').textContent = `${CODER_NAME[mode]} travaille dans ${state.project.name} · ${PERM_INFO[state.perm].label} · ${key}`;
  } else {
    input.placeholder = r ? (r.kind === 'image' ? 'Décris l’image voulue…' : 'Ta demande…') : mode === 'claude' ? 'Demande n’importe quoi : « dessine… », « demande à Grok… », @ChatGPT' : `Écris à ${AGENTS[mode].name}…`;
    $('#hint').textContent = mode === 'claude' ? `${key} · @ pour mentionner une IA · / pour un skill` : `Conversation directe avec ${AGENTS[mode].name} · ${key}`;
  }
  renderProjectUI();
  if (typeof renderModelBtn === 'function' && $('#modelBtn')) renderModelBtn();
}

const FOLDER_ICON = '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';

function renderProjectUI() {
  const b = $('#projectBtn');
  const p = state.project;
  b.classList.toggle('on', !!p);
  b.innerHTML = p
    ? `${FOLDER_ICON}<span class="pname">${esc(p.name)}</span><span class="ptype">${esc(p.type || '')}</span>`
    : `${FOLDER_ICON}<span class="pname">Discussion libre</span><span class="ptype">choisir un projet</span>`;
  const pb = $('#permBtn');
  pb.hidden = !p;
  pb.innerHTML = `${PERM_INFO[state.perm].icon}<span>${PERM_INFO[state.perm].label}</span>`;
  pb.dataset.level = state.perm;
  pb.title = PERM_INFO[state.perm].desc;
  $('#relayBtn').hidden = !!p;
}

async function setProject(p, { keepConv = false } = {}) {
  state.project = p;
  if (!keepConv) newChat();
  setMode(state.mode);
}

function renderChips() {
  const chips = $('#chips');
  const r = state.relay && relays().find((x) => x.id === state.relay);
  const sk = state.skill && state.skills.find((s) => s.slug === state.skill);
  let html = '';
  if (r) {
    const canDirect = ['image', 'ask'].includes(r.kind);
    html += `<span class="chip">${chainHtml(state.relayDirect ? [r.engine] : r.chain)}${esc(r.label)}
      ${canDirect ? `<label class="chip-toggle" title="Décoché : la demande part directement, sans passer par Claude"><input type="checkbox" data-relay-claude ${state.relayDirect ? '' : 'checked'}>Claude prépare</label>` : ''}
      <button type="button" class="x" data-clear-relay aria-label="Retirer">${I.x}</button></span>`;
  }
  if (sk) html += `<span class="chip"><i class="dot" data-agent="skill"></i>${esc(sk.name)}<button type="button" class="x" data-clear-skill aria-label="Retirer">${I.x}</button></span>`;
  const it = state.intent;
  if (!r && it?.relay) {
    const target = it.engines[0] ? AGENTS[it.engines[0]].name : 'Claude';
    let label;
    if (state.mode !== 'claude') label = it.kind === 'image' ? `${AGENTS[state.mode].name} va générer l’image` : '';
    else if (!av().claude && ['image', 'ask'].includes(it.kind)) label = it.kind === 'image' ? `Envoi direct à ${target} pour l’image` : `Envoi direct à ${target}`;
    else label = { image: `Claude va demander l’image à ${it.engines.map((e) => AGENTS[e].name).join(' et ')}`, ask: `Claude va consulter ${it.engines.map((e) => AGENTS[e].name).join(' et ')}`, code: 'Claude va écrire le code' }[it.kind];
    if (label) html += `<button type="button" class="chip suggest" data-pick-relay="${it.relay}" title="${it.explicit ? 'Demandé avec une @mention' : 'Détecté automatiquement — clique pour le forcer'}">${chainHtml(state.mode !== 'claude' ? [state.mode] : it.chain)}${esc(label)}</button>`;
  }
  chips.innerHTML = html;
  chips.hidden = !html;
  setMode(state.mode);
}

function setSkill(slug) { state.skill = slug; renderChips(); }
function setRelay(id) {
  state.relay = id;
  state.relayDirect = false;
  renderChips();
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 280)}px`;
  updateSendBtn();
}

function updateSendBtn() {
  const b = $('#sendBtn');
  const streaming = !!state.streaming;
  b.classList.toggle('stop', streaming);
  b.setAttribute('aria-label', streaming ? 'Arrêter' : 'Envoyer');
  b.disabled = !streaming && !input.value.trim();
}

/* ---------- Popover ---------- */
function closePop() { pop.hidden = true; state.pop = null; $$('.tool-btn').forEach((b) => b.setAttribute('aria-expanded', 'false')); }

function openRelayPop() {
  state.pop = 'relay';
  $('#relayBtn').setAttribute('aria-expanded', 'true');
  const groups = [...new Set(relays().map((r) => r.group))];
  pop.innerHTML = groups.map((g) => `<div class="pop-group">${esc(g)}</div><div class="pop-grid">${relays().filter((r) => r.group === g).map((r) => `
      <button type="button" class="pop-item ${relayAvailable(r) ? '' : 'disabled'}" data-pick-relay="${r.id}" title="${relayAvailable(r) ? '' : 'Connexion manquante'}">
        <b>${esc(r.label)}</b>${chainHtml(r.chain)}<span>${esc(r.hint)}</span></button>`).join('')}</div>`).join('')
    + '<div class="pop-foot">Un relais force la délégation : par exemple Claude rédige le prompt et ChatGPT génère l’image.</div>';
  pop.hidden = false;
}

function slashQuery() { const m = input.value.match(/^\/([\w-]*)$/); return m ? m[1].toLowerCase() : null; }

function openSkillPop(force) {
  const q = force ? '' : slashQuery();
  if (q === null) { if (state.pop === 'skill') closePop(); return; }
  state.pop = 'skill';
  $('#skillBtn').setAttribute('aria-expanded', 'true');
  const items = state.skills.filter((s) => !q || s.slug.includes(q) || s.name.toLowerCase().includes(q));
  state.popIndex = Math.min(state.popIndex, Math.max(items.length - 1, 0));
  pop.innerHTML = `<div class="pop-group">Skills</div>${items.length
    ? items.map((s, i) => `<button type="button" class="pop-item ${i === state.popIndex ? 'active' : ''}" data-pick-skill="${s.slug}"><b>${esc(s.name)}<code>/${s.slug}</code></b><i class="dot" data-agent="skill" style="grid-row:span 2"></i><span>${esc(s.description)}</span></button>`).join('')
    : '<div class="pop-empty">Aucun skill. Crée-en un depuis le panneau Skills.</div>'}`;
  pop.hidden = false;
}

function pickSkill(slug) {
  setSkill(slug);
  if (slashQuery() !== null) input.value = '';
  closePop();
  autoGrow();
  input.focus();
}

function pickRelay(id) {
  const r = relays().find((x) => x.id === id);
  if (!r) return;
  if (!relayAvailable(r)) { toast('Connexion manquante pour ce relais.', true); openSettings('connexions'); return; }
  setRelay(id);
  if (r.skill && state.skills.some((s) => s.slug === r.skill)) setSkill(null);
  closePop();
  input.focus();
}

let intentTimer = null;
input.addEventListener('input', () => {
  state.popIndex = 0;
  autoGrow();
  if (input.value.startsWith('/') || state.pop === 'skill') openSkillPop();
  else if (mentionQuery() !== null || state.pop === 'mention') openMentionPop();
  clearTimeout(intentTimer);
  intentTimer = setTimeout(() => {
    const next = detectIntent(input.value);
    if (next.relay !== state.intent?.relay) { state.intent = next; renderChips(); }
  }, 180);
});

/* ---------- @mentions ---------- */
const MENTIONS = [
  { tag: 'ChatGPT', agent: 'chatgpt', hint: 'Demander à ChatGPT (ou image s’il s’agit d’un visuel)' },
  { tag: 'Grok', agent: 'grok', hint: 'Demander à Grok (ou image Grok)' },
  { tag: 'Image', agent: 'chatgpt', hint: 'Générer une image' },
  { tag: 'Design', agent: 'claude', hint: 'Maquette ou prototype interactif (aperçu live)' },
];
function mentionQuery() {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = before.match(/(^|\s)@(\w*)$/);
  return m ? m[2].toLowerCase() : null;
}
function openMentionPop() {
  const q = mentionQuery();
  if (q === null) { if (state.pop === 'mention') closePop(); return; }
  const items = MENTIONS.filter((m) => m.tag.toLowerCase().startsWith(q));
  if (!items.length) { closePop(); return; }
  state.pop = 'mention';
  state.popIndex = Math.min(state.popIndex, items.length - 1);
  pop.innerHTML = `<div class="pop-group">Mentionner une IA</div>${items.map((m, i) => `<button type="button" class="pop-item ${i === state.popIndex ? 'active' : ''}" data-mention="${m.tag}"><b>@${m.tag}</b><i class="dot" data-agent="${m.agent}" style="grid-row:span 2"></i><span>${esc(m.hint)}</span></button>`).join('')}`;
  pop.hidden = false;
}
function pickMention(tag) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos).replace(/@\w*$/, `@${tag} `);
  input.value = before + input.value.slice(pos);
  input.setSelectionRange(before.length, before.length);
  closePop();
  input.dispatchEvent(new Event('input'));
  input.focus();
}
input.addEventListener('keydown', (e) => {
  if (state.pop === 'mention') {
    const items = $$('[data-mention]', pop);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.popIndex = (state.popIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
      items.forEach((it, i) => it.classList.toggle('active', i === state.popIndex));
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && items[state.popIndex]) { e.preventDefault(); pickMention(items[state.popIndex].dataset.mention); return; }
  }
  if (state.pop === 'skill') {
    const items = $$('[data-pick-skill]', pop);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.popIndex = (state.popIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
      items.forEach((it, i) => it.classList.toggle('active', i === state.popIndex));
      items[state.popIndex]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && items[state.popIndex]) { e.preventDefault(); pickSkill(items[state.popIndex].dataset.pickSkill); return; }
  }
  if (e.key === 'Escape' && state.pop) { closePop(); return; }
  if (e.key === 'Backspace' && !input.value && (state.skill || state.relay)) { if (state.skill) setSkill(null); else setRelay(null); return; }
  if (e.key === 'Enter' && !e.isComposing) {
    const ctrlMode = state.prefs.sendKey === 'ctrl';
    if ((ctrlMode && (e.ctrlKey || e.metaKey)) || (!ctrlMode && !e.shiftKey)) { e.preventDefault(); send(input.value); }
  }
});

$('#composer').addEventListener('submit', (e) => { e.preventDefault(); if (state.streaming) state.streaming.controller.abort(); else send(input.value); });
$('#modeSwitch').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) { setMode(b.dataset.mode); renderChips(); input.focus(); } });
$('#relayBtn').addEventListener('click', () => (state.pop === 'relay' ? closePop() : openRelayPop()));
$('#skillBtn').addEventListener('click', () => { if (state.pop === 'skill') return closePop(); state.popIndex = 0; openSkillPop(true); });

/* ==========================================================================
   Fenêtre : réglages, skills, galerie
   ========================================================================== */
const modal = $('#modal');
const scrim = $('#scrim');
const mBody = $('#modalBody');
const mFoot = $('#modalFoot');

function showModal(title, { nav = null } = {}) {
  $('#modalTitle').textContent = title;
  $('#modalCard').classList.toggle('no-nav', !nav);
  $('#modalNav').innerHTML = nav || '';
  mFoot.hidden = true;
  mFoot.innerHTML = '';
  modal.hidden = false;
  scrim.hidden = false;
}
function closeModal() {
  modal.hidden = true;
  if (!$('#app').classList.contains('nav-open')) scrim.hidden = true;
  stopPolling();
}

/* ---------- Réglages ---------- */
const TABS = [
  ['general', 'Général', I.general],
  ['connexions', 'Connexions', I.plug],
  ['claude', 'Claude', I.spark],
  ['images', 'Images', I.image],
  ['projet', 'Projet', I.folder],
  ['donnees', 'Données', I.data],
];
let settingsTab = 'general';
let saveTimer = null;

async function openSettings(tab = settingsTab) {
  closeNav();
  closePop();
  settingsTab = tab;
  await loadStatus();
  showModal(TABS.find((t) => t[0] === tab)[1], {
    nav: `<div class="nav-title">Réglages</div>${TABS.map(([id, label, icon]) => `<button type="button" data-tab="${id}" class="${id === tab ? 'active' : ''}">${icon}${label}</button>`).join('')}`,
  });
  renderTab();
  if (tab === 'connexions') loadConnectors(true).then(() => settingsTab === 'connexions' && !modal.hidden && renderTab());
  if (!state.models) loadModels().then(() => { if (!modal.hidden && ['connexions', 'claude', 'images'].includes(settingsTab)) renderTab(); });
}

function row(title, desc, control) {
  return `<div class="row"><div class="row-text"><b>${title}</b>${desc ? `<span>${desc}</span>` : ''}</div>${control}</div>`;
}
const sel = (k, opts, v) => `<select class="select" data-k="${k}">${opts.map(([val, label]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
const inp = (k, v, ph = '', mono = true) => `<input class="input ${mono ? 'mono' : ''}" data-k="${k}" value="${esc(v)}" placeholder="${esc(ph)}" spellcheck="false">`;
const sw = (k, v) => `<input type="checkbox" class="switch" data-k="${k}" ${String(v) === 'true' ? 'checked' : ''}>`;
const prefSeg = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button type="button" data-pref="${k}" data-v="${v}" class="${String(state.prefs[k]) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;

function renderTab() {
  const s = settings();
  const tab = settingsTab;
  $$('#modalNav [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#modalTitle').textContent = TABS.find((t) => t[0] === tab)[1];
  mFoot.hidden = false;
  mFoot.innerHTML = '<span class="note">Les modifications sont enregistrées automatiquement.</span>';

  if (tab === 'general') {
    mBody.innerHTML = `
      <div class="group-title">Apparence</div>
      <div class="group">
        ${row('Thème', '', prefSeg('theme', [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']]))}
        ${row('Taille du texte', '', prefSeg('fontSize', [['s', 'Petit'], ['m', 'Normal'], ['l', 'Grand']]))}
        ${row('Étapes dépliées', 'Afficher le détail de chaque délégation par défaut.', `<input type="checkbox" class="switch" data-pref-bool="stepsOpen" ${state.prefs.stepsOpen ? 'checked' : ''}>`)}
      </div>
      <div class="group-title">Discussion</div>
      <div class="group">
        ${row('Envoyer avec', '', prefSeg('sendKey', [['enter', 'Entrée'], ['ctrl', 'Ctrl + Entrée']]))}
        ${row('Langue des réponses', '', sel('RESPONSE_LANGUAGE', [['auto', 'Comme mon message'], ['fr', 'Français'], ['en', 'Anglais']], s.RESPONSE_LANGUAGE))}
      </div>
      <div class="group-title">Instructions personnalisées</div>
      <div class="group"><div class="row stack">
        <div class="row-text"><b>Ce que les IA doivent savoir sur toi</b><span>Ajouté à chaque conversation. Ex. « Je crée un jeu Roblox d’obby, je débute en Luau, réponds simplement. »</span></div>
        <textarea class="textarea" data-k="CUSTOM_INSTRUCTIONS" placeholder="Ton projet, ton niveau, ton style préféré…">${esc(s.CUSTOM_INSTRUCTIONS)}</textarea>
      </div></div>`;
  }

  if (tab === 'connexions') renderConnexions();

  if (tab === 'claude') {
    mBody.innerHTML = `
      <div class="group-title">Modèle</div>
      <div class="group">
        ${row('Modèle (compte)', 'Utilisé quand Claude est connecté par ton abonnement.', modelField('CLAUDE_ACCOUNT_MODEL', s.CLAUDE_ACCOUNT_MODEL))}
        ${row('Modèle (clé API)', 'Utilisé en mode clé API.', modelField('CLAUDE_MODEL', s.CLAUDE_MODEL))}
      </div>
      <div class="group-title">Orchestration</div>
      <div class="group">
        ${row('Étapes maximum par message', 'Nombre d’allers-retours avec les autres IA avant de s’arrêter.', `<div class="range"><input type="range" min="2" max="40" data-k="MAX_STEPS" value="${esc(s.MAX_STEPS)}" oninput="this.nextElementSibling.value=this.value"><output>${esc(s.MAX_STEPS)}</output></div>`)}
      </div>
      <p class="note">Les relais (bouton « Relais » sous le champ de message) obligent Claude à passer par une IA précise : par exemple « Image · ChatGPT ».</p>`;
  }

  if (tab === 'images') {
    mBody.innerHTML = `
      <div class="group-title">Génération</div>
      <div class="group">
        ${row('Moteur par défaut', 'Quand Claude génère une image sans consigne précise.', sel('IMAGE_ENGINE', [['chatgpt', 'ChatGPT'], ['grok', 'Grok']], s.IMAGE_ENGINE))}
        ${row('Format par défaut', '', sel('IMAGE_SIZE', [['1024x1024', 'Carré 1:1'], ['1536x1024', 'Paysage 3:2'], ['1024x1536', 'Portrait 2:3']], s.IMAGE_SIZE))}
      </div>
      <div class="group-title">Modèles (mode clé API)</div>
      <div class="group">
        ${row('Images OpenAI', 'Liste chargée depuis l’API quand une clé OpenAI est enregistrée.', modelField('OPENAI_IMAGE_MODEL', s.OPENAI_IMAGE_MODEL))}
        ${row('Images Grok', 'Toujours via la clé API xAI.', modelField('GROK_IMAGE_MODEL', s.GROK_IMAGE_MODEL))}
      </div>
      <div class="group-title">Export</div>
      <div class="group">
        ${row('Copier les images dans mon projet', s.PROJECT_DIR ? `Dans ${esc(s.PROJECT_DIR)}\\relais-assets` : 'Choisis d’abord un dossier projet (onglet Projet).', sw('IMAGE_EXPORT', s.IMAGE_EXPORT))}
      </div>`;
  }

  if (tab === 'projet') {
    mBody.innerHTML = `
      <div class="group-title">Coder dans un projet</div>
      <div class="group">
        ${row('Projets', 'Ouvre un dossier pour que Claude Code, Codex ou Grok y travaillent directement.', '<button type="button" class="btn sm" data-goto-projects>Gérer les projets</button>')}
        ${row('Autorisation par défaut', esc(PERM_INFO[state.prefs.perm || 'ask'].desc), prefSeg('perm', [['read', 'Lecture'], ['ask', 'Demander'], ['full', 'Complet']]))}
      </div>
      <p class="note warn">Relais refuse les dossiers trop larges (disque entier, dossier utilisateur, Bureau, Documents…). Avec « Accès complet », garde une sauvegarde de ton projet (Git).</p>
      <details ${String(s.CURSOR_ENABLED) === 'true' ? 'open' : ''}><summary class="group-title" style="cursor:pointer">Optionnel : Cursor</summary>
      <div class="group">
        ${row('Activer Cursor', 'Claude peut confier du code à l’agent Cursor (cursor-agent).', sw('CURSOR_ENABLED', s.CURSOR_ENABLED))}
        ${row('Dossier de travail', 'Vide = dossier projet.', inp('CURSOR_WORKSPACE', s.CURSOR_WORKSPACE, s.PROJECT_DIR || ''))}
        ${row('Commande', 'Installation : cursor.com/cli', inp('CURSOR_COMMAND', s.CURSOR_COMMAND))}
        ${row('Commandes sans confirmation', 'Cursor peut exécuter des commandes dans le dossier.', sw('CURSOR_ALLOW_WRITES', s.CURSOR_ALLOW_WRITES))}
      </div></details>`;
  }

  if (tab === 'donnees') {
    mBody.innerHTML = `
      <div class="group-title">Conversations</div>
      <div class="group">
        ${row('Exporter', 'Toutes les conversations au format JSON.', '<a class="btn sm" href="/api/export" download>Exporter</a>')}
        ${row('Effacer l’historique', 'Supprime toutes les conversations. Irréversible.', '<button type="button" class="btn sm danger" data-clear-history>Tout effacer</button>')}
      </div>
      <div class="group-title">Emplacements</div>
      <div class="group">
        ${row('Données', 'Conversations, images et réglages sont rangés dans <code>relais/data</code> sur ce PC.', '')}
        ${row('Outils installés', 'Claude Code, Codex et Grok Build sont dans <code>relais/tools</code>.', '')}
        ${row('Connexions aux comptes', 'Gardées dans <code>relais/data/accounts</code>. Supprimer ce dossier déconnecte tout.', '')}
      </div>`;
  }
}

/* ---------- Connexions ---------- */
const CONNECTORS = [
  {
    id: 'claude', agent: 'claude', name: 'Claude', authKey: 'CLAUDE_AUTH', keyK: 'ANTHROPIC_API_KEY', mask: 'anthropic', tool: 'Claude Code',
    account: 'Ton abonnement Claude Pro ou Max, via Claude Code (outil officiel d’Anthropic). Utilise le crédit « Agent SDK » inclus chaque mois.',
    api: 'Facturé à l’usage sur console.anthropic.com.',
  },
  {
    id: 'codex', agent: 'chatgpt', name: 'ChatGPT', authKey: 'OPENAI_AUTH', keyK: 'OPENAI_API_KEY', mask: 'openai', tool: 'Codex',
    account: 'Ton abonnement ChatGPT, via Codex (outil officiel d’OpenAI). Les images passent par l’outil de génération inclus, sans clé API.',
    api: 'Facturé à l’usage sur platform.openai.com.',
    accountModel: ['CODEX_MODEL', 'Modèle', 'par défaut'], apiModel: ['OPENAI_MODEL', 'Modèle'],
  },
  {
    id: 'grok', agent: 'grok', name: 'Grok', authKey: 'XAI_AUTH', keyK: 'XAI_API_KEY', mask: 'xai', tool: 'Grok Build',
    account: 'Ton abonnement SuperGrok ou X Premium+, via Grok Build (outil officiel de xAI, en bêta). Texte uniquement : les images Grok demandent une clé API.',
    api: 'Facturé à l’usage sur console.x.ai. Nécessaire pour les images Grok.',
    accountModel: ['GROK_ACCOUNT_MODEL', 'Modèle', 'par défaut'], apiModel: ['GROK_MODEL', 'Modèle'], keyAlways: true,
  },
];

function connPill(c) {
  const s = settings();
  if (s[c.authKey] === 'api') return s.keys?.[c.mask] ? '<span class="pill ok">Clé enregistrée</span>' : '<span class="pill">Pas de clé</span>';
  const st = state.connectors?.[c.id];
  if (!st) return '<span class="pill busy">Vérification…</span>';
  if (st.installing || st.job?.running) return '<span class="pill warn busy">Installation…</span>';
  if (!st.installed) return '<span class="pill">Non installé</span>';
  if (st.connected === true) return '<span class="pill ok">Connecté</span>';
  if (st.connected === null) return '<span class="pill warn">Installé</span>';
  return '<span class="pill warn">Non connecté</span>';
}

function loginBox(c, lg) {
  if (!lg) return '';
  if (!lg.running) return lg.error ? `<p class="note" style="color:var(--danger)">${esc(lg.error)}</p>` : '';
  const step1 = lg.url
    ? `<a class="btn sm primary" href="${esc(lg.url)}" target="_blank" rel="noopener noreferrer">${c.id === 'claude' ? '1. Ouvrir la page claude.com' : '1. Ouvrir la page de connexion'}</a>`
    : '<span class="note"><span class="spinner"></span> Préparation…</span>';
  const step2 = c.id === 'claude'
    ? `<div class="login-row"><input class="input mono" data-login-code="claude" placeholder="2. Colle ici le code donné par la page" autocomplete="off" spellcheck="false"><button type="button" class="btn sm primary" data-send-code="claude">Valider</button></div>`
    : lg.code ? `<div class="login-row"><span class="note">${c.id === 'codex' ? '2. Saisis ce code sur la page :' : '2. Vérifie que la page affiche ce code :'}</span><code class="login-code">${esc(lg.code)}</code><button type="button" class="btn sm" data-copy-text="${esc(lg.code)}">${I.copy}Copier</button></div>` : '';
  return `<div class="login-box">
    <div class="login-row"><b>Connexion à ton compte ${c.name}</b><button type="button" class="btn sm right" data-cancel-login="${c.id}">Annuler</button></div>
    <div class="login-row">${step1}</div>${step2}
    <span class="note"><span class="spinner"></span> En attente de ta confirmation dans le navigateur…</span></div>`;
}

function renderConnexions() {
  // Ne pas effacer ce que l'utilisateur est en train de taper
  const typing = mBody.querySelector('[data-login-code]:focus, [data-key]:focus');
  if (typing && typing.value) return;
  const s = settings();
  const missing = CONNECTORS.filter((c) => (s[c.authKey] || 'account') === 'account' && state.connectors && !state.connectors[c.id]?.installed);
  mBody.innerHTML = `<div class="setup" style="margin:0 0 16px"><div><b>Tout-en-un, 100 % portable</b><span>Les outils officiels de Claude, ChatGPT et Grok sont installés dans <code>relais/tools</code>, et tes connexions sont gardées dans <code>relais/data/accounts</code>. Aucune application à installer, rien dans ton dossier utilisateur.</span></div>
    ${missing.length ? `<button type="button" class="btn primary" data-install-all>Tout installer</button>` : ''}</div>${CONNECTORS.map((c) => {
    const mode = s[c.authKey] || 'account';
    const st = state.connectors?.[c.id] || {};
    const job = st.job;
    const keyField = `<div class="field"><label>Clé API ${c.name}${s.keys?.[c.mask] ? ` <span class="note">(${esc(s.keys[c.mask])})</span>` : ''}</label>
      <div style="display:flex;gap:6px"><input class="input mono" type="password" data-key="${c.keyK}" placeholder="${s.keys?.[c.mask] ? 'Nouvelle clé pour remplacer' : 'Colle ta clé ici'}" autocomplete="off" spellcheck="false">
      <button type="button" class="btn sm" data-save-key="${c.keyK}">Enregistrer</button>${s.keys?.[c.mask] ? `<button type="button" class="btn sm danger" data-clear-key="${c.keyK}">Retirer</button>` : ''}</div></div>`;
    const accountBlock = `
      <div class="conn-actions">
        ${!st.installed ? `<button type="button" class="btn sm primary" data-conn="install" data-id="${c.id}" ${job?.running ? 'disabled' : ''}>${job?.running ? 'Installation…' : `Installer ${c.tool}`}</button>` : ''}
        ${st.installed && !st.login?.running ? `<button type="button" class="btn sm ${st.connected === true ? '' : 'primary'}" data-conn="login" data-id="${c.id}">${st.connected === true ? 'Changer de compte' : 'Se connecter'}</button>` : ''}
        ${st.installed ? `
          <button type="button" class="btn sm" data-conn="test" data-id="${c.id}">Tester</button>
          ${st.connected === true ? `<button type="button" class="btn sm" data-conn="logout" data-id="${c.id}">Déconnecter</button>` : ''}
          <button type="button" class="btn sm right" data-conn="install" data-id="${c.id}" ${job?.running ? 'disabled' : ''} title="Mettre à jour ${c.tool}">${job?.running ? 'Mise à jour…' : 'Mettre à jour'}</button>` : ''}
      </div>
      ${loginBox(c, st.login)}
      ${st.detail ? `<p class="note">${esc(st.detail)}</p>` : ''}
      ${job && (job.running || job.ok === false) ? `<pre class="conn-log">${esc((job.log || 'Démarrage…').slice(-1500))}</pre>` : ''}
      <div class="conn-test" data-test-out="${c.id}"></div>
      ${c.accountModel ? `<div class="conn-fields"><div class="field"><label>${c.accountModel[1]}</label>${modelField(c.accountModel[0], s[c.accountModel[0]], c.accountModel[2])}</div></div>` : ''}
      ${c.keyAlways ? keyField : ''}`;
    const apiBlock = `${keyField}${c.apiModel ? `<div class="conn-fields"><div class="field"><label>${c.apiModel[1]}</label>${modelField(c.apiModel[0], s[c.apiModel[0]])}</div></div>` : ''}`;
    return `<div class="conn">
      <div class="conn-head"><span class="avatar" data-agent="${c.agent}">${AGENTS[c.agent].mono}</span><div><b>${c.name}</b><span>${mode === 'account' ? `via ${c.tool}${st.version ? ` ${esc(st.version)}` : ''}${st.account ? ` · ${esc(st.account)}` : ''}` : 'via clé API'}</span></div><span class="right">${connPill(c)}</span></div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div class="seg"><button type="button" data-auth="${c.authKey}" data-v="account" class="${mode === 'account' ? 'on' : ''}">Mon compte</button><button type="button" data-auth="${c.authKey}" data-v="api" class="${mode === 'api' ? 'on' : ''}">Clé API</button></div>
        <span class="note" style="flex:1;min-width:200px">${mode === 'account' ? c.account : c.api}</span></div>
      ${mode === 'account' ? accountBlock : apiBlock}
    </div>`;
  }).join('')}`;
  mFoot.hidden = false;
  mFoot.innerHTML = `<span class="note">La connexion se fait depuis Relais, avec une simple confirmation dans ton navigateur.</span><button type="button" class="btn sm right" data-refresh-conn>${I.retry}Actualiser</button>`;
  const running = CONNECTORS.some((c) => state.connectors?.[c.id]?.job?.running);
  if (running) startPolling(1500);
}

let pollTimer = null;
let pollUntil = 0;
function startPolling(ms, duration = 10 * 60 * 1000) {
  pollUntil = Math.max(pollUntil, Date.now() + duration);
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (modal.hidden || Date.now() > pollUntil) return stopPolling();
    const before = Object.fromEntries(CONNECTORS.map((c) => [c.id, state.connectors?.[c.id]?.login?.running]));
    await loadConnectors(true);
    await loadStatus();
    for (const c of CONNECTORS) {
      const lg = state.connectors?.[c.id]?.login;
      if (before[c.id] && lg && !lg.running) toast(lg.ok ? `Connecté à ${c.name}` : `Connexion ${c.name} interrompue`, !lg.ok);
    }
    if (settingsTab === 'connexions') renderConnexions();
    const busy = CONNECTORS.some((c) => state.connectors?.[c.id]?.job?.running || state.connectors?.[c.id]?.login?.running);
    if (!busy) stopPolling();
  }, ms);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; pollUntil = 0; }

async function saveSettings(patch, quiet) {
  try {
    const r = await api('/api/settings', { method: 'POST', body: patch });
    state.status = { ...state.status, settings: r.settings, available: r.available };
    renderConnCard();
    renderTopAgents();
    renderModelBtn();
    if (!quiet) toast('Enregistré');
  } catch (e) { toast(e.message, true); }
}

async function connAction(action, id, btn) {
  if (action === 'install') {
    await api(`/api/connectors/${id}/install`, { method: 'POST' });
    await loadConnectors(true);
    renderConnexions();
    startPolling(1500);
  } else if (action === 'login') {
    await api(`/api/connectors/${id}/login`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 1200));
    await loadConnectors(true);
    renderConnexions();
    startPolling(2000, 15 * 60 * 1000);
  } else if (action === 'logout') {
    await api(`/api/connectors/${id}/logout`, { method: 'POST' });
    await loadConnectors(true);
    renderConnexions();
  } else if (action === 'test') {
    const out = $(`[data-test-out="${id}"]`);
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Test…';
    const r = await api(`/api/connectors/${id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    btn.textContent = 'Tester';
    if (out) out.innerHTML = r.ok
      ? `<p class="note" style="color:var(--ok)">Ça marche (${fmtMs(r.ms)}) — réponse : « ${esc(r.reply)} »</p>`
      : `<p class="note" style="color:var(--danger)">${esc(r.error)}</p>`;
    loadConnectors(true).then(() => renderConnCard());
  }
}

/* ---------- Projets ---------- */
async function openProjects() {
  closeNav();
  closePop();
  showModal('Projets');
  mBody.innerHTML = '<p class="note">Chargement…</p>';
  let list = [];
  try { list = await api('/api/projects'); } catch { /* vide */ }
  mBody.innerHTML = `<p class="note" style="margin:0 0 16px">Ouvre un dossier : Claude Code, Codex ou Grok y travailleront directement (lire, modifier, lancer des commandes), selon le niveau d’autorisation choisi.</p>
    <div class="proj-open">
      <button type="button" class="btn primary" data-pick-folder>${FOLDER_ICON}Choisir un dossier…</button>
      <div class="login-row" style="flex:1"><input class="input mono" id="projPath" placeholder="ou colle un chemin : C:\\Users\\toi\\mon-jeu" spellcheck="false"><button type="button" class="btn" data-open-path>Ouvrir</button></div>
    </div>
    <div class="group-title">Récents</div>
    ${list.length ? `<div class="proj-list">${list.map((p) => `
      <div class="proj-item ${state.project?.path === p.path ? 'active' : ''}">
        <button type="button" class="proj-main" data-open-project="${esc(p.path)}">${FOLDER_ICON}<div><b>${esc(p.name)}</b><span>${esc(p.path)}</span></div><span class="pill">${esc(p.type)}</span></button>
        <button type="button" class="icon-btn" data-reveal="${esc(p.path)}" title="Ouvrir dans l’explorateur">${I.arrow}</button>
        <button type="button" class="icon-btn" data-forget-project="${esc(p.path)}" title="Retirer de la liste">${I.x}</button>
      </div>`).join('')}</div>` : '<p class="note">Aucun projet récent.</p>'}`;
  mFoot.hidden = false;
  mFoot.innerHTML = state.project
    ? `<span class="note">Projet ouvert : <b>${esc(state.project.name)}</b></span><button type="button" class="btn sm right" data-close-project>Revenir en discussion libre</button>`
    : '<span class="note">Sans projet, Relais reste un chat qui fait travailler les IA ensemble.</span>';
}

async function openProjectPath(dir) {
  try {
    const p = await api('/api/projects', { method: 'POST', body: { path: dir } });
    closeModal();
    await setProject(p);
    toast(`Projet ouvert : ${p.name}`);
  } catch (e) { toast(e.message, true); }
}

function openPermPop() {
  state.pop = 'perm';
  $('#permBtn').setAttribute('aria-expanded', 'true');
  pop.innerHTML = `<div class="pop-group">Niveau d’autorisation dans le projet</div>${Object.entries(PERM_INFO).map(([k, v]) => `
    <button type="button" class="pop-item perm-item ${state.perm === k ? 'active' : ''}" data-set-perm="${k}"><b>${v.icon}${v.label}</b><span style="white-space:normal">${esc(v.desc)}</span></button>`).join('')}`;
  pop.hidden = false;
}

/* ---------- Skills ---------- */
const SOURCE_LABEL = { relais: 'Relais', claude: 'Claude', github: 'GitHub' };
let skillsView = 'all';
let skillsData = { all: [], packs: [], catalog: [] };

async function loadSkillsData() {
  const [all, packs] = await Promise.all([api('/api/skills?all=1'), api('/api/skills/packs')]);
  skillsData = { all, packs: packs.packs, catalog: packs.catalog };
}

async function openSkills(view = skillsView) {
  closeNav();
  closePop();
  skillsView = view;
  try { await loadSkillsData(); } catch (e) { return toast(e.message, true); }
  const { all, packs } = skillsData;
  const mine = all.filter((s) => !s.pack);
  const on = (list) => list.filter((s) => s.enabled).length;
  const navBtn = (id, label, list, icon) => `<button type="button" data-skills-view="${esc(id)}" class="${id === view ? 'active' : ''}">${icon}<span class="nav-label">${esc(label)}</span><span class="count">${on(list)}/${list.length}</span></button>`;
  showModal('Skills', {
    nav: `<div class="nav-title">Skills</div>
      ${navBtn('all', 'Tous', all, I.spark)}
      ${navBtn('relais', 'Mes skills Relais', mine, I.edit)}
      ${packs.length ? '<div class="nav-title">Packs importés</div>' : ''}
      ${packs.map((p) => navBtn(p.id, p.name, all.filter((s) => s.pack === p.id), p.source === 'github' ? I.github : p.id === 'claude-design' ? I.design : I.spark)).join('')}
      <div class="nav-sep"></div>
      <button type="button" data-skills-view="add" class="${view === 'add' ? 'active' : ''}">${I.plus}<span class="nav-label">Ajouter des skills</span></button>`,
  });
  renderSkillsView();
}

function skillRow(s) {
  return `<div class="skill-row ${s.enabled ? '' : 'off'}" data-skill-row="${esc(s.slug)}" data-search="${esc(`${s.name} ${s.slug} ${s.description} ${s.packName || ''}`.toLowerCase())}">
    <button type="button" class="skill-main" data-edit-skill="${esc(s.slug)}">
      <b>${esc(s.name)} <code>/${esc(s.slug)}</code></b>
      <span>${esc(s.description || 'Pas de description.')}</span>
    </button>
    <span class="src-badge" data-src="${esc(s.source)}">${esc(s.packName || SOURCE_LABEL[s.source] || s.source)}</span>
    <input type="checkbox" class="switch" data-skill-toggle="${esc(s.slug)}" ${s.enabled ? 'checked' : ''} aria-label="Activer ${esc(s.name)}" title="${s.enabled ? 'Activé : proposé aux IA' : 'Désactivé'}">
  </div>`;
}

function renderSkillsView() {
  const view = skillsView;
  const { all, packs, catalog } = skillsData;
  if (view === 'add') return renderSkillsAdd();
  const pack = packs.find((p) => p.id === view);
  const list = view === 'all' ? all : view === 'relais' ? all.filter((s) => !s.pack) : all.filter((s) => s.pack === view);
  $('#modalTitle').textContent = pack ? pack.name : view === 'relais' ? 'Mes skills Relais' : 'Tous les skills';
  const head = pack
    ? `<div class="pack-head">
        <div><b>${esc(pack.name)}</b><span>${esc(pack.note || '')}</span>
          <span class="pack-meta">${pack.enabled}/${pack.total} activés${pack.license ? ` · Licence : ${esc(pack.license)}` : ''}${pack.url ? ` · <a href="${esc(pack.url)}" target="_blank" rel="noopener">${esc(pack.url.replace('https://github.com/', ''))}</a>` : ''}</span></div>
        <div class="pack-actions">
          <button type="button" class="btn sm" data-pack-toggle="${esc(pack.id)}" data-on="1">Tout activer</button>
          <button type="button" class="btn sm" data-pack-toggle="${esc(pack.id)}" data-on="0">Tout désactiver</button>
          ${catalog.some((c) => c.id === pack.id) || pack.source === 'github' ? `<button type="button" class="btn sm" data-import-gh="${esc(pack.id)}" data-repo="${esc((pack.url || '').replace('https://github.com/', ''))}">${I.retry}Mettre à jour</button>` : `<button type="button" class="btn sm" data-import-claude>${I.retry}Resynchroniser</button>`}
          <button type="button" class="btn sm danger" data-pack-remove="${esc(pack.id)}">${I.trash}Retirer</button>
        </div></div>`
    : `<p class="note" style="margin:0 0 14px">Un skill est un mode d’emploi réutilisable. Claude voit la liste des skills <b>activés</b> et charge celui qui correspond à ta demande ; tu peux aussi en forcer un avec <code>/</code>. Désactive ceux qui ne te servent pas : Claude reste plus précis.</p>`;
  mBody.innerHTML = `${head}
    <label class="search skill-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.5-3.5"/></svg><input type="search" data-skill-search placeholder="Filtrer ${list.length} skills" autocomplete="off"></label>
    <div class="skill-rows">${list.map(skillRow).join('') || '<p class="note">Aucun skill ici.</p>'}</div>`;
  mFoot.hidden = false;
  mFoot.innerHTML = `<button type="button" class="btn primary" data-edit-skill="">${I.plus}Nouveau skill</button>
    <button type="button" class="btn" data-skills-view="add">${I.download}Importer</button>
    <span class="note right">${all.filter((s) => s.enabled).length} activés sur ${all.length}</span>`;
}

function renderSkillsAdd() {
  const { packs, catalog } = skillsData;
  $('#modalTitle').textContent = 'Ajouter des skills';
  const has = (id) => packs.find((p) => p.id === id);
  const claudePacks = packs.filter((p) => p.source === 'claude');
  mBody.innerHTML = `
    <div class="section-label"><span>Depuis ton compte Claude</span></div>
    <div class="import-card">
      <span class="avatar" data-agent="claude">Cl</span>
      <div><b>Mes skills Claude + Claude Design</b>
        <span>Copie dans Relais les skills de ton compte (synchronisés par Claude Code) et ceux des plugins de l’app Claude, dont <b>Design</b> : critique, design system, UX writing, accessibilité, handoff…</span>
        ${claudePacks.length ? `<span class="pack-meta">Déjà importés : ${claudePacks.map((p) => `${esc(p.name)} (${p.total})`).join(', ')}</span>` : ''}</div>
      <button type="button" class="btn primary" data-import-claude>${claudePacks.length ? 'Resynchroniser' : 'Importer'}</button>
    </div>
    <div class="section-label"><span>Skills Roblox sur GitHub</span></div>
    ${catalog.map((c) => `<div class="import-card">
      <span class="avatar gh">${I.github}</span>
      <div><b>${esc(c.name)}</b><span>${esc(c.blurb)}</span>
        <span class="pack-meta"><a href="https://github.com/${esc(c.repo)}" target="_blank" rel="noopener">${esc(c.repo)}</a> · ${esc(c.license)}${has(c.id) ? ` · installé (${has(c.id).total})` : ''}</span></div>
      <button type="button" class="btn ${has(c.id) ? '' : 'primary'}" data-import-gh="${esc(c.id)}">${has(c.id) ? 'Mettre à jour' : 'Installer'}</button>
    </div>`).join('')}
    <div class="section-label"><span>Autre dépôt GitHub</span></div>
    <div class="import-repo">
      <input class="input mono" id="gh-repo" placeholder="propriétaire/dépôt ou https://github.com/…" spellcheck="false">
      <button type="button" class="btn" data-import-repo>${I.download}Importer</button>
    </div>
    <p class="note">Relais copie tous les dossiers qui contiennent un <code>SKILL.md</code> (format des skills Claude). Un skill, c’est des instructions que l’IA suit : n’importe que des dépôts de confiance.</p>`;
  mFoot.hidden = true;
}

async function runImport(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Import…';
  try {
    const msg = await fn();
    toast(msg);
    await loadSkills();
    await openSkills(skillsView);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

async function editSkill(slug) {
  let s = { slug: '', name: '', description: '', body: '' };
  if (slug) { try { s = await api(`/api/skills/${slug}`); } catch (e) { return toast(e.message, true); } }
  $('#modalTitle').textContent = slug ? s.name : 'Nouveau skill';
  const back = `<button type="button" class="back" data-skills-view="${esc(skillsView)}">${I.back}Retour</button>`;
  if (s.readonly) {
    mBody.innerHTML = `${back}
      <div class="pack-head"><div><b>${esc(s.name)} <code>/${esc(s.slug)}</code></b><span>${esc(s.description)}</span>
        <span class="pack-meta">${esc(s.packName || '')}${s.license ? ` · ${esc(s.license)}` : ''} · lecture seule</span></div>
        <input type="checkbox" class="switch" data-skill-toggle="${esc(s.slug)}" ${s.enabled ? 'checked' : ''} aria-label="Activer"></div>
      <div class="md skill-preview">${md(s.body)}</div>
      ${s.files?.length ? `<div class="section-label"><span>Fichiers de référence (${s.files.length})</span></div><div class="file-list">${s.files.map((f) => `<span><code>${esc(f.path)}</code><i>${Math.max(1, Math.round(f.size / 1024))} Ko</i></span>`).join('')}</div><p class="note">Claude charge ces fichiers seulement quand il en a besoin (outil read_skill_file).</p>` : ''}`;
    mFoot.hidden = false;
    mFoot.innerHTML = `<button type="button" class="btn primary" data-use-skill="${esc(slug)}">Utiliser maintenant</button>
      <button type="button" class="btn" data-copy-skill="${esc(slug)}">${I.copy}Copier dans mes skills</button>
      <button type="button" class="btn danger right" data-delete-skill="${esc(slug)}">${I.trash}Supprimer</button>`;
    return;
  }
  mBody.innerHTML = `${back}
    <div class="field" style="margin-bottom:12px"><label>Nom</label><input class="input" id="sk-name" maxlength="60" value="${esc(s.name)}" placeholder="Ex. Rédacteur de patch notes"></div>
    <div class="field" style="margin-bottom:12px"><label>Quand l’utiliser</label><input class="input" id="sk-desc" maxlength="240" value="${esc(s.description)}" placeholder="Une phrase : Claude s’en sert pour décider de charger le skill."></div>
    <div class="field"><label>Instructions</label><textarea class="textarea mono tall" id="sk-body" placeholder="Étapes, ton, format attendu, outils à utiliser (generate_image, show_design, ask_chatgpt, ask_grok)…">${esc(s.body)}</textarea></div>`;
  mFoot.hidden = false;
  mFoot.innerHTML = `<button type="button" class="btn primary" data-save-skill="${esc(slug || '')}">${I.check}Enregistrer</button>
    ${slug ? `<button type="button" class="btn" data-use-skill="${slug}">Utiliser maintenant</button><button type="button" class="btn danger right" data-delete-skill="${slug}">${I.trash}Supprimer</button>` : ''}`;
  $('#sk-name').focus();
}

/* ---------- Designs ---------- */
const CLAUDE_DESIGN_URL = 'https://claude.com/product/design';
const DESIGN_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals';

function designEl(d) {
  const src = `${d.url}?v=${d.version || 1}`;
  return h(`<div class="design-card part-design" data-design-id="${esc(d.id)}">
    <div class="design-head">
      <span class="design-ico">${I.design}</span>
      <b>${esc(d.title)}</b><span class="tag">${esc(d.kind || 'prototype')} · v${d.version || 1}</span>
      <span class="spacer"></span>
      <button type="button" class="icon-btn sm" data-design-full="${esc(d.id)}" title="Plein écran">${I.expand}</button>
      <a class="icon-btn sm" href="${esc(d.url)}?download=1" download title="Télécharger le HTML">${I.download}</a>
      <button type="button" class="icon-btn sm" data-design-critique="${esc(d.id)}" title="Critique de design">${I.spark}</button>
      ${state.project ? `<button type="button" class="btn sm" data-design-build="${esc(d.id)}">${I.code}Coder dans le projet</button>` : ''}
    </div>
    <div class="design-frame"><iframe src="${esc(src)}" sandbox="${DESIGN_SANDBOX}" loading="lazy" title="${esc(d.title)}"></iframe></div>
  </div>`);
}

function openDesignViewer(id) {
  const card = $(`[data-design-id="${id}"]`);
  const title = card ? $('b', card).textContent : 'Design';
  const v = $('#designViewer');
  $('.dv-title', v).textContent = title;
  $('iframe', v).src = `/designs/${id}.html?t=${Date.now()}`;
  $('[data-dv-download]', v).href = `/designs/${id}.html?download=1`;
  v.dataset.id = id;
  setDevice('desktop');
  v.hidden = false;
}
function setDevice(dev) {
  const v = $('#designViewer');
  v.dataset.device = dev;
  $$('[data-dv-device]', v).forEach((b) => b.classList.toggle('on', b.dataset.dvDevice === dev));
}

async function openDesigns() {
  closeNav();
  showModal('Designs');
  mBody.innerHTML = '<p class="note">Chargement…</p>';
  try {
    const list = await api('/api/designs');
    mBody.innerHTML = `<div class="import-card">
        <span class="design-ico big">${I.design}</span>
        <div><b>Designs créés dans Relais</b><span>Demande simplement « fais une maquette de… », « prototype de… » ou l’UI de ton jeu : Claude crée un HTML interactif affiché en direct, que tu peux faire évoluer, télécharger ou faire coder dans ton projet. L’app web Claude Design reste disponible sur claude.com.</span></div>
        <a class="btn" href="${CLAUDE_DESIGN_URL}" target="_blank" rel="noopener">${I.ext}Claude Design</a>
      </div>
      ${list.length ? `<div class="design-grid">${list.map((d) => `<div class="design-tile">
        <button type="button" class="dt-frame" data-design-open="${esc(d.id)}" data-title="${esc(d.title)}"><iframe src="${esc(d.url)}?v=${d.version}" sandbox="${DESIGN_SANDBOX}" loading="lazy" tabindex="-1" title=""></iframe></button>
        <div class="dt-meta"><b>${esc(d.title)}</b><span>${esc(d.kind)} · v${d.version} · ${new Date(d.updatedAt).toLocaleDateString('fr-FR')}</span>
          <button type="button" class="icon-btn sm right" data-design-delete="${esc(d.id)}" title="Supprimer">${I.trash}</button></div>
      </div>`).join('')}</div>` : '<p class="note">Aucun design pour l’instant. Essaie le relais « Maquette interactive » ou écris « fais-moi une maquette de l’écran d’accueil de mon jeu ».</p>'}`;
  } catch (e) { mBody.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

/* ---------- Galerie ---------- */
async function openGallery() {
  closeNav();
  showModal('Images');
  mBody.innerHTML = '<p class="note">Chargement…</p>';
  try {
    const imgs = await api('/api/images');
    mBody.innerHTML = imgs.length
      ? `<div class="gallery">${imgs.map((i) => `<button type="button" data-zoom="${esc(i.url)}" data-caption="${esc(new Date(i.at).toLocaleString('fr-FR'))}"><img src="${esc(i.url)}" alt="" loading="lazy"></button>`).join('')}</div>`
      : '<p class="note">Aucune image pour l’instant. Essaie le relais « Image · ChatGPT ».</p>';
  } catch (e) { mBody.innerHTML = `<p class="note">${esc(e.message)}</p>`; }
}

/* ==========================================================================
   Divers
   ========================================================================== */
function toast(msg, isError) {
  const t = h(`<div class="toast ${isError ? 'error' : ''}">${esc(msg)}</div>`);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3400);
}
const lightbox = $('#lightbox');
function openLightbox(src, caption) { $('img', lightbox).src = src; $('figcaption', lightbox).textContent = caption || ''; lightbox.hidden = false; }
lightbox.addEventListener('click', () => { lightbox.hidden = true; });

function closeNav() { $('#app').classList.remove('nav-open'); if (modal.hidden) scrim.hidden = true; }
$('#menuBtn').addEventListener('click', () => { $('#app').classList.add('nav-open'); scrim.hidden = false; });
scrim.addEventListener('click', () => { closeModal(); closeNav(); });
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
thread.addEventListener('scroll', () => $('.topbar').classList.toggle('scrolled', thread.scrollTop > 4));
$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderConvList(); });
async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { toast('Copie impossible', true); return false; } }

/* Réglages : enregistrement automatique */
mBody.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.k) {
    const v = t.type === 'checkbox' ? String(t.checked) : t.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSettings({ [t.dataset.k]: v }), 150);
  }
  if (t.dataset.prefBool) { state.prefs[t.dataset.prefBool] = t.checked; savePrefs(); }
});

/* ---------- Clics ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-del]'))) {
    e.stopPropagation();
    if (!confirm('Supprimer cette conversation ?')) return;
    await api(`/api/conversations/${el.dataset.del}`, { method: 'DELETE' });
    if (el.dataset.del === state.convId) newChat();
    return loadConvs();
  }
  if ((el = t.closest('[data-pin]'))) {
    e.stopPropagation();
    await api(`/api/conversations/${el.dataset.pin}`, { method: 'PATCH', body: { pinned: el.dataset.pinned !== '1' } });
    return loadConvs();
  }
  if ((el = t.closest('[data-rename]'))) {
    e.stopPropagation();
    const c = state.convs.find((x) => x.id === el.dataset.rename);
    const title = prompt('Nouveau titre', c?.title || '');
    if (!title) return;
    await api(`/api/conversations/${el.dataset.rename}`, { method: 'PATCH', body: { title } });
    if (el.dataset.rename === state.convId) $('#convTitle').textContent = title;
    return loadConvs();
  }
  if ((el = t.closest('[data-conv]'))) return openConv(el.dataset.conv);
  if ((el = t.closest('[data-open-settings]'))) return openSettings(el.dataset.openSettings || 'general');
  if ((el = t.closest('[data-tab]'))) { settingsTab = el.dataset.tab; renderTab(); if (settingsTab === 'connexions') loadConnectors(true).then(() => settingsTab === 'connexions' && renderConnexions()); return; }
  if ((el = t.closest('[data-pref]'))) { state.prefs[el.dataset.pref] = el.dataset.v; if (el.dataset.pref === 'perm') state.perm = el.dataset.v; savePrefs(); return renderTab(); }
  if ((el = t.closest('[data-goto-projects]'))) return openProjects();
  if ((el = t.closest('[data-auth]'))) { await saveSettings({ [el.dataset.auth]: el.dataset.v }, true); return renderConnexions(); }
  if ((el = t.closest('[data-save-key]'))) {
    const field = $(`[data-key="${el.dataset.saveKey}"]`);
    if (!field.value.trim()) return toast('Colle d’abord la clé.', true);
    await saveSettings({ [el.dataset.saveKey]: field.value.trim() });
    return renderConnexions();
  }
  if ((el = t.closest('[data-clear-key]'))) { await saveSettings({ [el.dataset.clearKey]: '__clear__' }); return renderConnexions(); }
  if ((el = t.closest('[data-conn]'))) {
    try { await connAction(el.dataset.conn, el.dataset.id, el); } catch (err) { toast(err.message, true); }
    return;
  }
  if ((el = t.closest('[data-perm]'))) {
    const card = el.closest('[data-perm-id]');
    try { await api(`/api/permission/${card.dataset.permId}`, { method: 'POST', body: { decision: el.dataset.perm } }); settlePermission(card, el.dataset.perm); }
    catch (err) { toast(err.message, true); settlePermission(card, 'deny'); }
    return;
  }
  if ((el = t.closest('[data-pick-folder]'))) {
    el.disabled = true;
    el.innerHTML = '<span class="spinner"></span>Choisis le dossier dans la fenêtre…';
    try {
      const p = await api('/api/projects/pick', { method: 'POST' });
      if (p.cancelled) return openProjects();
      closeModal();
      await setProject(p);
      toast(`Projet ouvert : ${p.name}`);
    } catch (err) { toast(err.message, true); openProjects(); }
    return;
  }
  if ((el = t.closest('[data-open-path]'))) { const v = $('#projPath').value.trim(); return v ? openProjectPath(v) : toast('Colle d’abord un chemin.', true); }
  if ((el = t.closest('[data-open-project]'))) return openProjectPath(el.dataset.openProject);
  if ((el = t.closest('[data-forget-project]'))) { await api('/api/projects/forget', { method: 'POST', body: { path: el.dataset.forgetProject } }); return openProjects(); }
  if ((el = t.closest('[data-reveal]'))) { await api('/api/projects/reveal', { method: 'POST', body: { path: el.dataset.reveal } }).catch((err) => toast(err.message, true)); return; }
  if ((el = t.closest('[data-close-project]'))) { closeModal(); return setProject(null); }
  if ((el = t.closest('[data-set-perm]'))) {
    state.perm = el.dataset.setPerm;
    state.prefs.perm = state.perm;
    savePrefs();
    closePop();
    if (state.perm === 'full') toast('Accès complet : les IA modifient et exécutent sans demander.');
    return;
  }
  if ((el = t.closest('[data-code-starter]'))) {
    const s = CODE_STARTERS[Number(el.dataset.codeStarter)];
    input.value = s.p;
    autoGrow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  if ((el = t.closest('[data-send-code]'))) {
    const field = $(`[data-login-code="${el.dataset.sendCode}"]`);
    if (!field?.value.trim()) return toast('Colle d’abord le code.', true);
    try { await api(`/api/connectors/${el.dataset.sendCode}/login/code`, { method: 'POST', body: { code: field.value.trim() } }); field.value = ''; toast('Code envoyé, vérification…'); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if ((el = t.closest('[data-cancel-login]'))) {
    await api(`/api/connectors/${el.dataset.cancelLogin}/login`, { method: 'DELETE' });
    await loadConnectors(true);
    return renderConnexions();
  }
  if ((el = t.closest('[data-copy-text]'))) { if (await copy(el.dataset.copyText)) toast('Copié'); return; }
  if ((el = t.closest('[data-install-all]'))) {
    el.disabled = true;
    const s = settings();
    for (const c of CONNECTORS) {
      if ((s[c.authKey] || 'account') === 'account' && !state.connectors?.[c.id]?.installed) await api(`/api/connectors/${c.id}/install`, { method: 'POST' });
    }
    await loadConnectors(true);
    renderConnexions();
    return startPolling(1500);
  }
  if ((el = t.closest('[data-refresh-conn]'))) { await loadConnectors(true); await loadStatus(); return renderConnexions(); }
  if ((el = t.closest('[data-clear-history]'))) {
    if (!confirm('Supprimer définitivement toutes les conversations ?')) return;
    await api('/api/conversations', { method: 'DELETE' });
    toast('Historique effacé');
    newChat();
    return loadConvs();
  }
  if ((el = t.closest('[data-pick-relay]'))) return pickRelay(el.dataset.pickRelay);
  if ((el = t.closest('[data-clear-relay]'))) { setRelay(null); return input.focus(); }
  if ((el = t.closest('[data-mention]'))) return pickMention(el.dataset.mention);
  if ((el = t.closest('[data-pick-skill]'))) return pickSkill(el.dataset.pickSkill);
  if ((el = t.closest('[data-clear-skill]'))) { setSkill(null); return input.focus(); }
  if ((el = t.closest('[data-edit-skill]'))) return editSkill(el.dataset.editSkill);
  if ((el = t.closest('[data-back-skills]'))) return openSkills();
  if ((el = t.closest('[data-skills-view]'))) {
    skillsView = el.dataset.skillsView;
    $$('#modalNav [data-skills-view]').forEach((b) => b.classList.toggle('active', b.dataset.skillsView === skillsView));
    return renderSkillsView();
  }
  if ((el = t.closest('[data-import-claude]'))) {
    return runImport(el, async () => {
      const { report } = await api('/api/skills/import/claude', { method: 'POST' });
      return `Importé : ${report.map((r) => `${r.count} skills (${r.pack === 'claude-design' ? 'Claude Design' : r.pack === 'claude-compte' ? 'compte Claude' : r.pack})`).join(', ')}`;
    });
  }
  if ((el = t.closest('[data-import-gh]'))) {
    const id = el.dataset.importGh;
    const preset = skillsData.catalog.some((c) => c.id === id);
    return runImport(el, async () => {
      const r = await api('/api/skills/import/github', { method: 'POST', body: preset ? { id } : { repo: el.dataset.repo } });
      return `${r.count} skills importés depuis GitHub`;
    });
  }
  if ((el = t.closest('[data-import-repo]'))) {
    const repo = $('#gh-repo').value.trim();
    if (!repo) return toast('Indique un dépôt GitHub.', true);
    return runImport(el, async () => {
      const r = await api('/api/skills/import/github', { method: 'POST', body: { repo } });
      skillsView = r.pack;
      return `${r.count} skills importés depuis ${repo}`;
    });
  }
  if ((el = t.closest('[data-pack-toggle]'))) {
    const on = el.dataset.on === '1';
    await api(`/api/skills/packs/${el.dataset.packToggle}`, { method: 'POST', body: { enabled: on } });
    toast(on ? 'Pack activé' : 'Pack désactivé');
    await loadSkills();
    return openSkills(skillsView);
  }
  if ((el = t.closest('[data-pack-remove]'))) {
    if (!confirm('Retirer ce pack de Relais ? Ses fichiers seront supprimés du dossier skills (tu pourras le réimporter).')) return;
    await api(`/api/skills/packs/${el.dataset.packRemove}`, { method: 'DELETE' });
    toast('Pack retiré');
    await loadSkills();
    return openSkills('all');
  }
  if ((el = t.closest('[data-copy-skill]'))) {
    try {
      const s = await api(`/api/skills/${el.dataset.copySkill}`);
      const saved = await api('/api/skills', { method: 'POST', body: { name: `${s.name} (perso)`, description: s.description, body: s.body } });
      toast('Copié dans tes skills : tu peux le modifier');
      await loadSkills();
      return editSkill(saved.slug);
    } catch (err) { return toast(err.message, true); }
  }
  if ((el = t.closest('[data-design-full]'))) return openDesignViewer(el.dataset.designFull);
  if ((el = t.closest('[data-design-open]'))) {
    closeModal();
    const v = $('#designViewer');
    openDesignViewer(el.dataset.designOpen);
    $('.dv-title', v).textContent = el.dataset.title || 'Design';
    return;
  }
  if ((el = t.closest('[data-dv-device]'))) return setDevice(el.dataset.dvDevice);
  if ((el = t.closest('[data-dv-close]'))) { $('#designViewer').hidden = true; $('#designViewer iframe').src = 'about:blank'; return; }
  if ((el = t.closest('[data-dv-reload]'))) { $('#designViewer iframe').src = `/designs/${$('#designViewer').dataset.id}.html?t=${Date.now()}`; return; }
  if ((el = t.closest('[data-design-critique]'))) {
    const title = $('b', el.closest('.design-card')).textContent;
    pickRelay('design-critique');
    input.value = `Critique le design « ${title} » (design_id ${el.dataset.designCritique}) et propose une version corrigée.`;
    autoGrow();
    return input.focus();
  }
  if ((el = t.closest('[data-design-build]'))) {
    try {
      const { file } = await api(`/api/designs/${el.dataset.designBuild}`, { method: 'POST', body: { dir: state.project?.path } });
      input.value = `Implémente ce design dans le projet. La maquette est ici : ${file}. Lis-la, reprends fidèlement la mise en page, les couleurs et les interactions, et adapte-la à la techno du projet${state.project?.type?.toLowerCase().includes('roblox') ? ' (ScreenGui + LocalScript Luau)' : ''}.`;
      autoGrow();
      input.focus();
      toast('Maquette copiée dans relais-designs/ du projet');
    } catch (err) { toast(err.message, true); }
    return;
  }
  if ((el = t.closest('[data-design-delete]'))) {
    if (!confirm('Supprimer ce design ?')) return;
    await api(`/api/designs/${el.dataset.designDelete}`, { method: 'DELETE' });
    return openDesigns();
  }
  if ((el = t.closest('[data-save-skill]'))) {
    const slug = el.dataset.saveSkill;
    const body = { name: $('#sk-name').value, description: $('#sk-desc').value, body: $('#sk-body').value };
    if (!body.name.trim()) return toast('Donne un nom au skill.', true);
    try {
      const saved = slug ? await api(`/api/skills/${slug}`, { method: 'PUT', body }) : await api('/api/skills', { method: 'POST', body });
      toast(`Skill « ${saved.name} » enregistré`);
      return openSkills();
    } catch (err) { return toast(err.message, true); }
  }
  if ((el = t.closest('[data-use-skill]'))) { setSkill(el.dataset.useSkill); closeModal(); return input.focus(); }
  if ((el = t.closest('[data-delete-skill]'))) {
    if (!confirm('Supprimer ce skill ?')) return;
    await api(`/api/skills/${el.dataset.deleteSkill}`, { method: 'DELETE' });
    toast('Skill supprimé');
    return openSkills();
  }
  if ((el = t.closest('.step-head'))) {
    const step = el.closest('.step');
    step.classList.toggle('open');
    return el.setAttribute('aria-expanded', String(step.classList.contains('open')));
  }
  if ((el = t.closest('[data-zoom]')) && !t.closest('a')) return openLightbox(el.dataset.zoom, el.dataset.caption);
  if ((el = t.closest('[data-copy-code]'))) {
    if (await copy($('code', el.closest('.code')).textContent)) { el.innerHTML = `${I.check}Copié`; setTimeout(() => { el.innerHTML = `${I.copy}Copier`; }, 1400); }
    return;
  }
  if ((el = t.closest('[data-copy-msg]'))) {
    const view = el.closest('.msg')._view;
    if (await copy((view?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n'))) toast('Réponse copiée');
    return;
  }
  if ((el = t.closest('[data-retry]'))) { if (lastSent) send(lastSent.text, lastSent); else toast('Rien à relancer dans cette session.'); return; }
  if ((el = t.closest('[data-pick-model]'))) {
    await saveSettings({ [el.dataset.key]: el.dataset.pickModel }, true);
    closePop();
    renderModelBtn();
    toast(`Modèle : ${modelLabel(el.dataset.key, el.dataset.pickModel)}`);
    return;
  }
  if (state.pop && !t.closest('#popover') && !t.closest('.tool-btn') && !t.closest('#usageBar')) closePop();
});

mBody.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.key) { e.preventDefault(); $(`[data-save-key="${e.target.dataset.key}"]`)?.click(); }
  if (e.key === 'Enter' && e.target.dataset.loginCode) { e.preventDefault(); $(`[data-send-code="${e.target.dataset.loginCode}"]`)?.click(); }
});
mBody.addEventListener('change', async (e) => {
  if (e.target.matches('[data-relay-claude]')) { state.relayDirect = !e.target.checked; renderChips(); }
  if (e.target.matches('[data-skill-toggle]')) {
    const slug = e.target.dataset.skillToggle;
    const enabled = e.target.checked;
    try {
      await api(`/api/skills/${slug}/toggle`, { method: 'POST', body: { enabled } });
      const s = skillsData.all.find((x) => x.slug === slug);
      if (s) s.enabled = enabled;
      e.target.closest('.skill-row')?.classList.toggle('off', !enabled);
      // compteurs de la barre latérale
      const { all } = skillsData;
      $$('#modalNav [data-skills-view]').forEach((b) => {
        const v = b.dataset.skillsView;
        const list = v === 'all' ? all : v === 'relais' ? all.filter((x) => !x.pack) : all.filter((x) => x.pack === v);
        const c = $('.count', b);
        if (c) c.textContent = `${list.filter((x) => x.enabled).length}/${list.length}`;
      });
      loadSkills();
    } catch (err) { e.target.checked = !enabled; toast(err.message, true); }
  }
});
mBody.addEventListener('input', (e) => {
  if (!e.target.matches('[data-skill-search]')) return;
  const q = e.target.value.trim().toLowerCase();
  $$('[data-skill-row]', mBody).forEach((r) => { r.hidden = !!q && !r.dataset.search.includes(q); });
});
$('#chips').addEventListener('change', (e) => {
  if (e.target.matches('[data-relay-claude]')) { state.relayDirect = !e.target.checked; renderChips(); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('[data-conv]') && e.key === 'Enter') openConv(e.target.closest('[data-conv]').dataset.conv);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); }
  if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  if (e.key === 'Escape') {
    if (!$('#designViewer').hidden) $('#designViewer [data-dv-close]').click();
    else if (!lightbox.hidden) lightbox.hidden = true;
    else if (!modal.hidden) closeModal();
    else if (state.pop) closePop();
    else if (state.streaming) state.streaming.controller.abort();
  }
});

$('#newChat').addEventListener('click', newChat);
$('#newChatIcon').addEventListener('click', newChat);
$('#openSkills').addEventListener('click', () => openSkills());
$('#openGallery').addEventListener('click', openGallery);
$('#openDesigns').addEventListener('click', openDesigns);
$('#openProjects').addEventListener('click', openProjects);
$('#projectBtn').addEventListener('click', openProjects);
$('#permBtn').addEventListener('click', () => (state.pop === 'perm' ? closePop() : openPermPop()));
$('#modalClose').addEventListener('click', closeModal);

/* ==========================================================================
   Modèles : menus déroulants + sélecteur rapide
   ========================================================================== */
state.models = null;
async function loadModels() {
  try { state.models = await api('/api/models'); } catch { state.models = {}; }
  renderModelBtn();
  return state.models;
}

function modelKey(mode = state.mode) {
  const s = settings();
  if (mode === 'chatgpt') return s.OPENAI_AUTH === 'api' ? 'OPENAI_MODEL' : 'CODEX_MODEL';
  if (mode === 'grok') return s.XAI_AUTH === 'api' ? 'GROK_MODEL' : 'GROK_ACCOUNT_MODEL';
  return s.CLAUDE_AUTH === 'api' ? 'CLAUDE_MODEL' : 'CLAUDE_ACCOUNT_MODEL';
}
const ALLOWS_DEFAULT = ['CODEX_MODEL', 'GROK_ACCOUNT_MODEL'];

function modelLabel(key, value) {
  const list = state.models?.[key] || [];
  if (!value) {
    const d = list.find((m) => m.isDefault);
    return d ? `${d.label} (défaut)` : 'Par défaut';
  }
  return list.find((m) => m.id === value)?.label || value;
}

/** Menu déroulant de modèles pour les réglages ; champ libre si aucune liste n'est disponible. */
function modelField(k, value, ph = '') {
  const list = state.models?.[k];
  if (!state.models) return `<select class="select" disabled><option>Chargement des modèles…</option></select>`;
  if (!list?.length) return inp(k, value, ph || 'Identifiant du modèle');
  const opts = [];
  if (ALLOWS_DEFAULT.includes(k)) opts.push(['', modelLabel(k, '')]);
  for (const m of list) opts.push([m.id, m.hint ? `${m.label} — ${m.hint}` : m.label]);
  if (value && !list.some((m) => m.id === value)) opts.push([value, `${value} (personnalisé)`]);
  return sel(k, opts, value || '');
}

function renderModelBtn() {
  const b = $('#modelBtn');
  if (!b) return;
  const k = modelKey();
  b.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg><span>${esc(modelLabel(k, settings()[k]))}</span>`;
}

function openModelPop() {
  const k = modelKey();
  const list = state.models?.[k] || [];
  state.pop = 'model';
  $('#modelBtn').setAttribute('aria-expanded', 'true');
  const cur = settings()[k] || '';
  const items = [...(ALLOWS_DEFAULT.includes(k) ? [{ id: '', label: modelLabel(k, ''), hint: 'Laisse l’outil choisir' }] : []), ...list];
  pop.innerHTML = `<div class="pop-group">Modèle · ${state.project ? CODER_NAME[state.mode] : AGENTS[state.mode].name}</div>
    ${items.length ? `<div class="pop-grid">${items.map((m) => `<button type="button" class="pop-item ${m.id === cur ? 'active' : ''}" data-pick-model="${esc(m.id)}" data-key="${k}"><b>${esc(m.label)}${m.id === cur ? ' ✓' : ''}</b><span>${esc(m.hint || m.id || '')}</span></button>`).join('')}</div>`
      : '<div class="pop-empty">Aucune liste disponible pour l’instant. Tu peux saisir le modèle dans Réglages.</div>'}`;
  pop.hidden = false;
}

/* ==========================================================================
   Utilisation des abonnements (5 h / semaine, par modèle)
   ========================================================================== */
state.usage = null;
const USAGE_AGENTS = [['claude', 'claude'], ['codex', 'chatgpt'], ['grok', 'grok']];
const WINDOW_LABEL = { five_hour: 'Session (5 h)', seven_day: 'Semaine (7 j)', seven_day_opus: 'Semaine · Opus', seven_day_sonnet: 'Semaine · Sonnet', seven_day_fable: 'Semaine · Fable', overage: 'Dépassement' };

async function loadUsage() {
  try { state.usage = await api('/api/usage'); } catch { state.usage = null; }
  renderUsageBar();
  if (state.pop === 'usage') openUsagePop();
}

const fmtPct = (p) => (p === null || p === undefined ? '—' : `${p < 10 && p > 0 && !Number.isInteger(p) ? p.toFixed(1).replace('.', ',') : Math.round(p)} %`);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));
function fmtReset(ts) {
  if (!ts) return '';
  const d = ts - Date.now();
  if (d <= 0) return 'réinitialisé';
  const total = Math.ceil(d / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 24) return `réinit. ${new Date(ts).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })} ${new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  return `réinit. dans ${h ? `${h} h ` : ''}${m} min`;
}
const level = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : '');

function renderUsageBar() {
  const el = $('#usageBar');
  const u = state.usage?.providers;
  const a = av();
  if (!u) { el.hidden = true; return; }
  const items = USAGE_AGENTS.filter(([, ag]) => a[ag] || u[USAGE_AGENTS.find((x) => x[1] === ag)[0]]?.req7d).map(([id, ag]) => {
    const p = u[id];
    const w5 = p.limits?.windows?.five_hour;
    const w7 = p.limits?.windows?.seven_day;
    let body;
    if (w5?.pct != null || w7?.pct != null) {
      const main = w5?.pct ?? w7?.pct;
      body = `<span class="u-meter ${level(main)}"><i style="width:${Math.max(2, main)}%"></i></span><span class="u-val">${fmtPct(w5?.pct)}<em> · ${fmtPct(w7?.pct)}</em></span>`;
    } else if (p.req7d) body = `<span class="u-val">${p.req7d} req.<em> · 7 j</em></span>`;
    else body = '<span class="u-val"><em>—</em></span>';
    return `<span class="u-item"><i class="dot" data-agent="${ag}"></i>${AGENTS[ag].name}${body}</span>`;
  });
  el.innerHTML = items.length ? `${items.join('')}` : '';
  el.hidden = !items.length;
}

function usageBars(p) {
  const wins = Object.entries(p.limits?.windows || {}).sort(([a], [b]) => (a === 'five_hour' ? -1 : b === 'five_hour' ? 1 : a.localeCompare(b)));
  return wins.map(([k, w]) => `<div class="u-row"><span class="u-name">${esc(WINDOW_LABEL[k] || k.replace(/_/g, ' '))}</span>
      <span class="u-meter wide ${level(w.pct || 0)}"><i style="width:${Math.max(1, w.pct || 0)}%"></i></span>
      <span class="u-pct">${fmtPct(w.pct)}</span><span class="u-reset">${esc(fmtReset(w.resetsAt))}</span></div>`).join('');
}

function openUsagePop() {
  const u = state.usage?.providers;
  if (!u) return;
  state.pop = 'usage';
  const ago = (t) => { if (!t) return ''; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`; };
  const sections = USAGE_AGENTS.map(([id, ag]) => {
    const p = u[id];
    const models = Object.entries(p.models).sort((a, b) => b[1].share7d - a[1].share7d)
      .map(([name, m]) => [name === 'défaut' ? modelLabel(id === 'grok' ? 'GROK_ACCOUNT_MODEL' : 'CODEX_MODEL', '') : name, m]);
    const noLimits = !p.limits?.windows || !Object.keys(p.limits.windows).length;
    return `<section class="u-sec">
      <div class="u-head"><span class="avatar" data-agent="${ag}">${AGENTS[ag].mono}</span><b>${AGENTS[ag].name}</b>
        ${p.limits?.plan ? `<span class="pill">${esc(p.limits.plan)}</span>` : ''}<span class="u-ago">${p.limits?.updatedAt ? `mesuré ${ago(p.limits.updatedAt)}` : ''}</span></div>
      ${noLimits
        ? `<p class="note">${id === 'grok' ? 'Grok ne communique pas son pourcentage d’utilisation : Relais compte tes requêtes.' : `Pas encore mesuré : le pourcentage apparaît après ton prochain message à ${AGENTS[ag].name}.`}</p>`
        : usageBars(p)}
      ${models.length ? `<div class="u-sub">Par modèle · 7 jours</div>${models.map(([name, m]) => `<div class="u-row"><span class="u-name mono">${esc(name)}</span>
          <span class="u-meter wide model"><i style="width:${Math.max(1, m.share7d)}%"></i></span><span class="u-pct">${m.share7d} %</span>
          <span class="u-reset">${m.tokens7d ? `${fmtTok(m.tokens7d)} tokens` : `${m.req7d} req.`}${m.req5h ? ` · ${m.share5h} % sur 5 h` : ''}</span></div>`).join('')}` : ''}
    </section>`;
  }).join('');
  pop.innerHTML = `<div class="pop-group">Utilisation de tes abonnements</div>${sections}
    <div class="pop-foot">Les pourcentages viennent de Claude Code et de Codex (limites de ton abonnement). La répartition par modèle est comptée par Relais à partir des tokens utilisés.</div>`;
  pop.hidden = false;
}

$('#modelBtn').addEventListener('click', async () => {
  if (state.pop === 'model') return closePop();
  if (!state.models) await loadModels();
  openModelPop();
});
$('#usageBar').addEventListener('click', () => (state.pop === 'usage' ? closePop() : (openUsagePop(), loadUsage())));
setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);

/* ---------- Fenêtre Relais.exe : barre de titre intégrée ---------- */
const host = window.chrome?.webview;
function setupNativeWindow() {
  if (!host) return;
  document.documentElement.classList.add('native');
  const bar = h(`<div class="win-controls" role="group" aria-label="Fenêtre">
    <button type="button" data-win="min" aria-label="Réduire" title="Réduire"><svg viewBox="0 0 12 12"><path d="M2 6.5h8"/></svg></button>
    <button type="button" data-win="max" aria-label="Agrandir" title="Agrandir"><svg viewBox="0 0 12 12" class="i-max"><rect x="2" y="2" width="8" height="8" rx="1.2"/></svg><svg viewBox="0 0 12 12" class="i-restore"><rect x="2" y="3.6" width="6.4" height="6.4" rx="1"/><path d="M4 3.6V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-.6"/></svg></button>
    <button type="button" data-win="close" class="win-close" aria-label="Fermer" title="Fermer"><svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg></button>
  </div>`);
  document.body.append(bar);
  bar.addEventListener('click', (e) => { const b = e.target.closest('[data-win]'); if (b) host.postMessage(b.dataset.win); });

  // Zones de déplacement : la barre du haut et le haut de la barre latérale, hors boutons et champs
  const DRAG = '.topbar, .side-top, .modal-head';
  const NO_DRAG = 'button, a, input, textarea, select, [role="button"], .top-agents, .win-controls';
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.target.closest(DRAG) || e.target.closest(NO_DRAG)) return;
    if (e.detail === 2) { host.postMessage('max'); return; }
    e.preventDefault();
    host.postMessage('drag');
  });
  host.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.window) document.documentElement.classList.toggle('win-max', d.window === 'max');
  });
  host.postMessage('ready');
  syncHostBackground();
}
function syncHostBackground() {
  if (!host) return;
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  if (m) host.postMessage(`bg:#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`);
}
setupNativeWindow();

/* ---------- Démarrage ---------- */
(async function init() {
  setMode('claude');
  updateSendBtn();
  await Promise.all([loadStatus(), loadSkills(), loadConvs()]);
  renderEmpty();
  loadUsage();
  loadModels();
  input.focus();
  loadConnectors().then(() => { if ($('.empty', inner)) renderEmpty(); });
})();
