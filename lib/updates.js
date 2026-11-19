/**
 * Mises à jour, comme dans Claude Desktop : Relais regarde régulièrement la dernière release
 * GitHub, télécharge l'installateur en arrière-plan (empreinte SHA-256 vérifiée), puis
 * l'interface propose « Redémarrer pour mettre à jour ». L'installateur s'exécute en silence,
 * remplace les fichiers (tes données restent) et relance Relais.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { paths } from './config.js';

const REPO = process.env.RELAIS_UPDATE_REPO || 'Underspace1/relais';
const API = process.env.RELAIS_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = 'Relais-Setup.exe';
const DIR = path.join(paths.data, 'updates');
const EVERY = 6 * 60 * 60 * 1000;
const IS_WIN = process.platform === 'win32';

export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(paths.root, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
})();

/** Installé avec Relais-Setup.exe (et pas la version portable ou le code source) ? */
export const installed = () => (IS_WIN && fs.existsSync(path.join(paths.root, 'unins000.exe'))) || process.env.RELAIS_UPDATE_INSTALLED === '1'; // variable : tests

const state = { current: VERSION, latest: null, available: false, checking: false, checkedAt: 0, error: null, notes: '', url: `https://github.com/${REPO}/releases/latest`, publishedAt: null, download: null };

function newer(a, b) {
  const p = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export function updateState() {
  return { ...state, installable: installed(), download: state.download && { ...state.download, file: undefined } };
}

export async function checkUpdates({ force = false } = {}) {
  if (state.checking || (!force && Date.now() - state.checkedAt < 10 * 60 * 1000)) return updateState();
  state.checking = true;
  try {
    const r = await fetch(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Relais-updater' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}`);
    const rel = await r.json();
    const v = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find((a) => a.name === ASSET);
    state.latest = v;
    state.notes = String(rel.body || '').slice(0, 6000);
    state.url = rel.html_url || state.url;
    state.publishedAt = rel.published_at || null;
    state.available = !!v && newer(v, VERSION);
    state.error = null;
    state.checkedAt = Date.now();
    if (state.available && asset && installed()) prepare(v, asset);
  } catch (e) {
    state.error = e.message;
    state.checkedAt = Date.now();
  } finally { state.checking = false; }
  return updateState();
}

/** Télécharge l'installateur en arrière-plan et vérifie son empreinte. */
async function prepare(version, asset) {
  const d = state.download;
  if (d && d.version === version && (d.ready || d.running)) return;
  fs.mkdirSync(DIR, { recursive: true });
  // Anciennes versions téléchargées
  for (const f of fs.readdirSync(DIR)) if (!f.includes(version)) fs.rmSync(path.join(DIR, f), { force: true });
  const file = path.join(DIR, `Relais-Setup-${version}.exe`);
  const sha = String(asset.digest || '').startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null;
  const dl = (state.download = { version, running: true, ready: false, received: 0, size: asset.size || 0, error: null, file });
  try {
    if (fs.existsSync(file) && sha && await hashOf(file) === sha) { Object.assign(dl, { running: false, ready: true, received: dl.size }); return; }
    // Réseau bloqué plus d'une minute : on abandonne (nouvel essai à la prochaine vérification)
    const ctrl = new AbortController();
    let idle = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'Relais-updater' }, redirect: 'follow', signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error(`Téléchargement impossible (${r.status})`);
    const part = `${file}.part`;
    const out = fs.createWriteStream(part);
    const h = crypto.createHash('sha256');
    for await (const chunk of r.body) {
      h.update(chunk);
      dl.received += chunk.length;
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), 60000);
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    }
    clearTimeout(idle);
    await new Promise((ok, ko) => out.end((e) => (e ? ko(e) : ok())));
    if (asset.size && dl.received !== asset.size) { fs.rmSync(part, { force: true }); throw new Error('Téléchargement incomplet : nouvel essai plus tard.'); }
    if (sha && h.digest('hex') !== sha) { fs.rmSync(part, { force: true }); throw new Error('Fichier téléchargé corrompu (empreinte différente) : il sera retéléchargé.'); }
    fs.renameSync(part, file);
    Object.assign(dl, { running: false, ready: true });
  } catch (e) {
    Object.assign(dl, { running: false, ready: false, error: e.name === 'AbortError' ? 'Téléchargement interrompu (réseau) : nouvel essai plus tard.' : e.message });
  }
}

function hashOf(file) {
  return new Promise((ok, ko) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex'))).on('error', ko);
  });
}

/**
 * Lance l'installateur en silence, détaché de Relais (pour survivre à sa fermeture) :
 * il attend que Relais se ferme, remplace les fichiers et relance Relais.
 */
export function installUpdate() {
  const dl = state.download;
  if (!installed()) throw new Error('Cette copie de Relais n’a pas été installée avec Relais-Setup.exe : télécharge la nouvelle version sur la page des releases.');
  if (!dl?.ready || !fs.existsSync(dl.file)) throw new Error('La mise à jour n’est pas encore téléchargée.');
  const script = path.join(DIR, 'installer.cmd');
  fs.writeFileSync(script, [
    '@echo off',
    'rem Attend que Relais se ferme, puis installe la mise à jour et relance Relais',
    'timeout /t 3 /nobreak >nul',
    `"${dl.file}" /SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /RELAUNCH /DIR="${paths.root}"`,
    '',
  ].join('\r\n'));
  // « start » détache le script : il n'est pas arrêté avec l'arbre de processus de Relais
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" /min "${script}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.unref();
  return { ok: true, version: dl.version };
}

/** Vérifie au démarrage (après une minute) puis toutes les 6 heures. */
export function startUpdateChecks(cfg) {
  if (String(cfg?.UPDATE_CHECK ?? 'true') === 'false') return;
  setTimeout(() => checkUpdates(), 60 * 1000).unref();
  setInterval(() => checkUpdates(), EVERY).unref();
}
