#!/usr/bin/env node
/**
 * Petit serveur MCP (stdio) lancé par Claude Code.
 * Il expose les outils de Relais (ChatGPT, Grok, Gemini, Perplexity, images, Cursor, skills)
 * et transmet chaque appel au serveur Relais, qui l'exécute et l'affiche en direct.
 */
const URL_BASE = process.env.RELAIS_URL;
const TOKEN = process.env.RELAIS_TOKEN;

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function relais(pathname, body) {
  const res = await fetch(`${URL_BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Relais ${res.status}`);
  return data;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && write({ jsonrpc: '2.0', id, result });
  const fail = (message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code: -32000, message } });

  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'relais', version: '2.0.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list': {
        const { tools } = await relais('/internal/tools', {});
        return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
      }
      case 'tools/call': {
        const r = await relais('/internal/call', { name: params?.name, input: params?.arguments || {} });
        return reply({ content: [{ type: 'text', text: String(r.content ?? '') }], isError: !!r.is_error });
      }
      default:
        if (method?.startsWith('notifications/')) return undefined;
        return id !== undefined && write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Méthode inconnue : ${method}` } });
    }
  } catch (e) {
    return fail(e.message);
  }
}

let buf = '';
const inflight = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = handle(msg);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }
});
process.stdin.on('end', async () => {
  await Promise.allSettled([...inflight]);
  process.exit(0);
});
