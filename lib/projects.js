/**
 * Projets : les dossiers dans lesquels les IA peuvent coder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from './config.js';

const FILE = path.join(paths.data, 'projects.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function write(list) { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }

/** Refuse les dossiers trop larges ou sensibles. */
export function validateProject(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('Choisis un dossier.');
  const p = path.resolve(dir.trim());
  let st;
  try { st = fs.statSync(p); } catch { throw new Error(`Dossier introuvable : ${p}`); }
  if (!st.isDirectory()) throw new Error('Ce chemin n’est pas un dossier.');
  const norm = (x) => path.resolve(x).toLowerCase().replace(/[\\/]+$/, '');
  const home = norm(os.homedir());
  const forbidden = [
    norm(path.parse(p).root), home,
    norm(path.join(home, 'Desktop')), norm(path.join(home, 'Documents')), norm(path.join(home, 'Downloads')),
    norm(process.env.SystemRoot || 'C:\\Windows'), norm(process.env.ProgramFiles || 'C:\\Program Files'),
    norm(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'),
  ];
  if (forbidden.includes(norm(p))) throw new Error('Ce dossier est trop large. Choisis le dossier précis de ton projet.');
  if (norm(p).startsWith(norm(paths.root))) throw new Error('Choisis un projet en dehors du dossier de Relais.');
  return p;
}

/** Devine le type de projet pour l'afficher et guider les IA. */
export function detectType(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* illisible */ }
  if (has('default.project.json') || entries.some((f) => f.endsWith('.project.json'))) return 'Roblox (Rojo)';
  if (entries.some((f) => /\.(rbxl|rbxlx|rbxm|rbxmx)$/i.test(f))) return 'Roblox';
  if (entries.some((f) => /\.luau?$/i.test(f))) return 'Lua / Luau';
  if (has('package.json')) return 'JavaScript / Node';
  if (has('pyproject.toml') || has('requirements.txt')) return 'Python';
  if (has('Cargo.toml')) return 'Rust';
  if (has('project.godot')) return 'Godot';
  if (entries.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) return 'C# / .NET';
  if (has('index.html')) return 'Site web';
  return entries.length ? 'Dossier' : 'Dossier vide';
}

export function listProjects() {
  return read()
    .filter((p) => fs.existsSync(p.path))
    .map((p) => ({ ...p, type: detectType(p.path) }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

export function touchProject(dir) {
  const p = validateProject(dir);
  const list = read().filter((x) => x.path.toLowerCase() !== p.toLowerCase());
  list.unshift({ path: p, name: path.basename(p), lastUsed: Date.now() });
  write(list.slice(0, 20));
  return { path: p, name: path.basename(p), type: detectType(p) };
}

export function forgetProject(dir) {
  write(read().filter((x) => x.path.toLowerCase() !== String(dir).toLowerCase()));
}

/** Ouvre la boîte de dialogue Windows « Choisir un dossier ». */
export function pickFolder() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Saisis le chemin à la main.'));
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
      $d = New-Object System.Windows.Forms.FolderBrowserDialog
      $d.Description = 'Choisis le dossier de ton projet'
      $d.ShowNewFolderButton = $true
      $d.UseDescriptionForTitle = $true
      if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
      $owner.Dispose()`;
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out.trim() || null));
  });
}

export function revealFolder(dir) {
  const p = validateProject(dir);
  if (process.platform === 'win32') spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
}
