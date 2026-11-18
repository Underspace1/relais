import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';

const ID_RE = /^[a-f0-9]{16}$/;
const fileOf = (id) => path.join(paths.convos, `${id}.json`);

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

export function listConversations() {
  return fs
    .readdirSync(paths.convos)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(paths.convos, f), 'utf8'));
        return { id: c.id, title: c.title, mode: c.mode, updatedAt: c.updatedAt, pinned: !!c.pinned, project: c.project || null };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversation(id) {
  if (!ID_RE.test(id || '')) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

export function saveConversation(conv) {
  conv.updatedAt = Date.now();
  fs.writeFileSync(fileOf(conv.id), JSON.stringify(conv, null, 2));
}

export function deleteConversation(id) {
  if (!ID_RE.test(id || '')) return false;
  try {
    fs.unlinkSync(fileOf(id));
    return true;
  } catch {
    return false;
  }
}
