/**
 * Agent de code intégré à Relais : travaille dans le dossier du projet sans
 * Claude Code, Codex ni Grok Build. Il passe par OpenRouter ou une clé API.
 *
 * Mêmes modes d'autorisation que les outils officiels :
 *   read : lecture seule · plan : exploration puis plan · ask : chaque modification et commande demandée
 *   auto : modifications acceptées, commandes demandées · full : tout sans confirmation
 */
import fs from 'node:fs';
import path from 'node:path';
import { chatTurn } from './llm.js';
import { shellCommand } from './workspace.js';
import { describeTool } from './coders.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vs', 'bin', 'obj']);
const MAX_READ = 400_000;
const short = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}\n… (${String(s).length - n} caractères de plus)` : String(s));

/* ---------- Chemins : toujours à l'intérieur du projet ---------- */
function inside(root, p) {
  const full = path.resolve(root, String(p || '.'));
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Chemin en dehors du projet refusé : ${p}`);
  return full;
}

function walk(root, start = root, limit = 8000) {
  const out = [];
  const stack = [start];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(f); }
      else out.push(f);
    }
  }
  return out;
}

function globToRegex(g) {
  const s = String(g).replace(/\\/g, '/').replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(.*/)?');
  return new RegExp(`^${s}$`, 'i');
}

/* ---------- Définition des outils ---------- */
const T = (name, description, properties, required = []) => ({ name, description, input_schema: { type: 'object', properties, required } });
const READ_TOOLS = [
  T('list_dir', 'Liste le contenu d’un dossier du projet.', { path: { type: 'string', description: 'Dossier relatif au projet (défaut : racine).' } }),
  T('read_file', 'Lit un fichier texte du projet, avec numéros de ligne.', { file_path: { type: 'string' }, offset: { type: 'number', description: 'Première ligne (1 = début).' }, limit: { type: 'number', description: 'Nombre de lignes.' } }, ['file_path']),
  T('glob', 'Cherche des fichiers par motif (ex. src/**/*.lua).', { pattern: { type: 'string' } }, ['pattern']),
  T('grep', 'Cherche une expression régulière dans les fichiers du projet.', { pattern: { type: 'string' }, path: { type: 'string', description: 'Dossier ou fichier (défaut : tout le projet).' }, glob: { type: 'string', description: 'Filtre de fichiers, ex. *.ts' } }, ['pattern']),
];
const WRITE_TOOLS = [
  T('write_file', 'Crée ou remplace entièrement un fichier.', { file_path: { type: 'string' }, content: { type: 'string' } }, ['file_path', 'content']),
  T('edit_file', 'Remplace un passage exact d’un fichier. old_string doit apparaître une seule fois (sinon ajoute du contexte, ou replace_all).', { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string']),
  T('bash', `Lance une commande dans le dossier du projet (${process.platform === 'win32' ? 'PowerShell' : 'sh'}). Pour tester, compiler, lancer git…`, { command: { type: 'string' } }, ['command']),
];
const TODO_TOOL = T('todo_write', 'Tient la liste de tâches visible par l’utilisateur pour un travail en plusieurs étapes. Renvoie la liste complète à chaque mise à jour.', {
  todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string' } }, required: ['content', 'status'] } },
}, ['todos']);
const PLAN_TOOL = T('present_plan', 'Mode plan : présente ton plan final à l’utilisateur (Markdown, étapes numérotées, fichiers concernés). Termine ton travail après.', { plan: { type: 'string' } }, ['plan']);

// Noms présentés à l'interface (mêmes cartes et autorisations que Claude Code)
const UI_NAME = { list_dir: 'list_dir', read_file: 'Read', glob: 'Glob', grep: 'Grep', write_file: 'Write', edit_file: 'Edit', bash: 'Bash' };

/* ---------- Exécution d'un outil de fichiers ---------- */
function runFileTool(root, name, input) {
  switch (name) {
    case 'list_dir': {
      const d = inside(root, input.path || '.');
      const entries = fs.readdirSync(d, { withFileTypes: true }).filter((e) => !SKIP_DIRS.has(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      return entries.slice(0, 500).map((e) => `${e.isDirectory() ? '[dossier] ' : ''}${e.name}`).join('\n') || '(dossier vide)';
    }
    case 'read_file': {
      const f = inside(root, input.file_path);
      const st = fs.statSync(f);
      if (st.isDirectory()) throw new Error('C’est un dossier : utilise list_dir.');
      if (st.size > MAX_READ * 4) throw new Error(`Fichier trop gros (${Math.round(st.size / 1024)} Ko) : lis-le par morceaux avec offset et limit.`);
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      const from = Math.max(1, Number(input.offset) || 1);
      const to = Math.min(lines.length, from - 1 + (Number(input.limit) || 2000));
      return short(lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join('\n'), MAX_READ) + (to < lines.length ? `\n(… ${lines.length - to} lignes de plus)` : '');
    }
    case 'glob': {
      const re = globToRegex(input.pattern);
      const hits = walk(root).map((f) => path.relative(root, f).replace(/\\/g, '/')).filter((r) => re.test(r) || re.test(r.split('/').pop()));
      return hits.slice(0, 300).join('\n') || 'Aucun fichier.';
    }
    case 'grep': {
      let re;
      try { re = new RegExp(input.pattern, 'i'); } catch (e) { throw new Error(`Expression invalide : ${e.message}`); }
      const base = inside(root, input.path || '.');
      const files = fs.statSync(base).isFile() ? [base] : walk(root, base);
      const filter = input.glob ? globToRegex(input.glob) : null;
      const out = [];
      for (const f of files) {
        const rel = path.relative(root, f).replace(/\\/g, '/');
        if (filter && !filter.test(rel.split('/').pop()) && !filter.test(rel)) continue;
        let text;
        try { if (fs.statSync(f).size > 2_000_000) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (text.includes('\u0000')) continue;
        text.split('\n').forEach((l, i) => { if (out.length < 250 && re.test(l)) out.push(`${rel}:${i + 1}: ${l.trim().slice(0, 240)}`); });
        if (out.length >= 250) break;
      }
      return out.join('\n') || 'Aucun résultat.';
    }
    case 'write_file': {
      const f = inside(root, input.file_path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(input.content ?? ''));
      return `Fichier écrit : ${path.relative(root, f)} (${String(input.content ?? '').split('\n').length} lignes)`;
    }
    case 'edit_file': {
      const f = inside(root, input.file_path);
      const text = fs.readFileSync(f, 'utf8');
      const oldS = String(input.old_string ?? '');
      if (!oldS) throw new Error('old_string est vide : utilise write_file pour créer un fichier.');
      const n = text.split(oldS).length - 1;
      if (!n) throw new Error('old_string introuvable dans le fichier : relis-le et copie le passage exact.');
      if (n > 1 && !input.replace_all) throw new Error(`old_string apparaît ${n} fois : ajoute du contexte ou utilise replace_all.`);
      fs.writeFileSync(f, input.replace_all ? text.split(oldS).join(String(input.new_string ?? '')) : text.replace(oldS, () => String(input.new_string ?? '')));
      return `Modifié : ${path.relative(root, f)}${n > 1 ? ` (${n} remplacements)` : ''}`;
    }
    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

/**
 * Lance l'agent intégré.
 * @param {object} o
 * @param {(name: string, input: object, id: string) => Promise<{content: string, is_error?: boolean}>} o.relaisTool  outils Relais (images, autres IA, designs, skills)
 * @param {object[]} o.relaisTools  définitions de ces outils
 */
export async function runBuiltinAgent({ cfg, backend, dir, perm, system, messages, relaisTools = [], relaisTool, askPermission, turn, signal, effort, maxTurns = 60 }) {
  const root = path.resolve(dir);
  const agent = backend.agent;
  const canWrite = !['read', 'plan'].includes(perm);
  const tools = [...READ_TOOLS, TODO_TOOL, ...(canWrite ? WRITE_TOOLS : []), ...(perm === 'plan' ? [PLAN_TOOL] : []), ...relaisTools];
  const relaisNames = new Set(relaisTools.map((t) => t.name));
  const history = messages.slice();
  const stats = { turns: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
  let thinkN = 0;

  const allowed = async (name, input) => {
    if (perm === 'full' || READ_TOOLS.some((t) => t.name === name)) return { ok: true };
    if (perm === 'auto' && name !== 'bash') return { ok: true };
    if (!askPermission) return { ok: false, why: 'Aucune autorisation possible ici.' };
    const r = await askPermission({ tool_name: UI_NAME[name] || name, input });
    return r.behavior === 'allow' ? { ok: true } : { ok: false, why: r.message || 'L’utilisateur a refusé cette action.' };
  };

  for (let i = 0; i < maxTurns; i++) {
    if (signal?.aborted) throw new Error('Arrêté.');
    let reasoning = '';
    const thinkId = `think-${Date.now()}-${thinkN++}`;
    const r = await chatTurn({
      cfg, backend, system, messages: history, tools, signal, effort,
      onText: (d) => turn.text(d),
      onReasoning: (d) => { reasoning += d; },
    });
    stats.turns++;
    stats.tokensIn += r.usage.tokensIn || 0;
    stats.tokensOut += r.usage.tokensOut || 0;
    stats.cost += Number(r.usage.cost) || 0;
    turn.meta?.({ ...stats, cost: stats.cost || undefined, model: r.model });
    if ((reasoning || r.reasoning)?.trim()) turn.step({ id: thinkId, agent, kind: 'thinking', title: 'Réflexion', output: reasoning || r.reasoning, status: 'done' });
    history.push({ role: 'assistant', text: r.text, toolCalls: r.toolCalls });
    if (!r.toolCalls.length) return stats;
    if (r.text && !/\n$/.test(r.text)) turn.text('\n\n');

    let stop = false;
    for (const call of r.toolCalls) {
      const { id, name, input } = call;
      if (name === 'todo_write') {
        turn.todos?.((input.todos || []).map((t) => ({ text: t.content || '', status: t.status || 'pending', active: t.activeForm || '' })), agent);
        history.push({ role: 'tool', id, name, content: 'Liste mise à jour.' });
        continue;
      }
      if (name === 'present_plan') {
        turn.plan?.({ id, agent, text: String(input.plan || '') });
        history.push({ role: 'tool', id, name, content: 'Plan présenté. Attends la décision de l’utilisateur.' });
        stop = true;
        continue;
      }
      if (relaisNames.has(name)) {
        const res = await relaisTool(name, input, id);
        history.push({ role: 'tool', id, name, content: String(res.content ?? '').slice(0, 30000), isError: !!res.is_error });
        continue;
      }
      const d = describeTool(UI_NAME[name] || name, input);
      turn.step({ id, agent, title: d.title, status: 'running', input: d.detail, diff: d.diff, kind: d.kind });
      try {
        if (!tools.some((t) => t.name === name)) throw new Error(`Outil « ${name} » indisponible dans ce mode (${perm}).`);
        const ok = await allowed(name, input);
        if (!ok.ok) {
          turn.step({ id, status: 'error', output: ok.why });
          history.push({ role: 'tool', id, name, content: ok.why, isError: true });
          continue;
        }
        let out;
        if (name === 'bash') {
          let acc = '';
          let last = 0;
          const res = await shellCommand(root, String(input.command || ''), {
            signal,
            onData: (x) => { acc += x; if (Date.now() - last > 300) { last = Date.now(); turn.step({ id, output: acc.slice(-4000) }); } },
          });
          out = `${res.output.slice(-20000) || '(aucune sortie)'}\n[code de sortie : ${res.code}]`;
          turn.step({ id, status: res.code === 0 ? 'done' : 'error', output: out.slice(-4000) });
        } else {
          out = runFileTool(root, name, input);
          turn.step({ id, status: 'done', output: short(out, 3000) });
        }
        history.push({ role: 'tool', id, name, content: out });
      } catch (e) {
        if (signal?.aborted) throw e;
        turn.step({ id, status: 'error', output: e.message });
        history.push({ role: 'tool', id, name, content: `Erreur : ${e.message}`, isError: true });
      }
    }
    if (stop) return stats;
  }
  turn.text('\n\n_Limite d’étapes atteinte : dis « continue » pour poursuivre._');
  return stats;
}
