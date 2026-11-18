import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Délègue une tâche à l'agent Cursor en ligne de commande (`cursor-agent -p`).
 * Installation : https://cursor.com/cli
 */
export function runCursorAgent({ cfg, prompt, signal, onOutput }) {
  return new Promise((resolve, reject) => {
    if (!cfg.cursorEnabled) return reject(new Error('Cursor est désactivé (Réglages).'));
    const cwd = cfg.CURSOR_WORKSPACE;
    if (!cwd || !fs.existsSync(cwd)) return reject(new Error(`Dossier de travail Cursor introuvable : "${cwd}"`));

    // Le shell est nécessaire sous Windows pour lancer un .cmd ; on neutralise donc
    // les caractères spéciaux du shell dans le prompt.
    const safePrompt = prompt.replace(/["%^&|<>!`$\r\n]/g, ' ').slice(0, 6000);
    const args = ['-p', `"${safePrompt}"`, '--output-format', 'text'];
    if (String(cfg.CURSOR_ALLOW_WRITES) === 'true') args.push('--force');

    const child = spawn(cfg.CURSOR_COMMAND || 'cursor-agent', args, { cwd, shell: true, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (d) => { out += d; onOutput?.(String(d)); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Impossible de lancer Cursor : ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve(out.trim() || '(Cursor a terminé sans rien afficher)');
      else reject(new Error(`Cursor s’est arrêté (code ${code}). ${(err || out).trim().slice(0, 800)}`));
    });
  });
}
