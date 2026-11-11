/**
 * HTTP endpoints: the federation API, a status endpoint and the static client files.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { GAME_VERSION, PROTOCOL_VERSION } from '@primacy2/shared';
import { FedError, type Federation } from './federation.ts';
import type { World } from './world.ts';

const MAX_BODY = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new FedError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new FedError(400, 'invalid JSON'));
      }
    });
    req.on('error', () => reject(new FedError(400, 'read error')));
  });
}

export function createHttpHandler(world: World, fed: Federation, clientDir: string) {
  const root = resolve(clientDir);
  const hasClient = existsSync(join(root, 'index.html'));

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (!hasClient) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>PRIMACY2</title><body style="font-family:sans-serif;background:#05080f;color:#cfe">` +
          `<h1>PRIMACY2 server "${world.config.name.replace(/[<>&"]/g, '')}" is running</h1>` +
          `<p>The game client has not been built yet. Run <code>npm run build</code> and restart the server.</p>`,
      );
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(root, rel));
    // Never serve anything outside the client directory.
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Unknown paths without an extension belong to the single-page app.
      if (extname(rel)) {
        res.writeHead(404).end();
        return;
      }
      file = join(root, 'index.html');
    }
    const ext = extname(file).toLowerCase();
    const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpg|webp|glb)$/.test(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': statSync(file).size,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      if (path === '/api/status' && req.method === 'GET') {
        const d = world.host.descriptor().body;
        return json(res, 200, {
          id: world.id, name: d.name, version: GAME_VERSION, proto: PROTOCOL_VERSION, players: world.players.size,
          maxPlayers: world.config.maxPlayers, systems: d.systems.length, links: d.links.length, url: d.url,
        });
      }

      if (path.startsWith('/fed/')) {
        if (req.method === 'GET' && path === '/fed/descriptor') return json(res, 200, world.host.descriptor());
        if (req.method === 'GET' && path === '/fed/known') return json(res, 200, fed.knownList());
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const body = await readBody(req);
        if (path === '/fed/hello') return json(res, 200, await fed.onGossip(body, true));
        if (path === '/fed/gossip') return json(res, 200, await fed.onGossip(body, false));
        if (path === '/fed/redeem') {
          const { from, payload } = fed.openFromKnown<{ nonce?: unknown; playerId?: unknown }>(body);
          return json(res, 200, { ok: world.redeemTicket(from.id, payload?.nonce, payload?.playerId) });
        }
        if (path.startsWith('/fed/x/')) {
          const topic = path.slice('/fed/x/'.length);
          if (!/^[a-z0-9_-]{1,32}$/.test(topic)) return json(res, 404, { error: 'unknown topic' });
          return json(res, 200, await fed.onTopic(topic, body));
        }
        return json(res, 404, { error: 'not found' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(req, res, path);
    } catch (err) {
      if (err instanceof FedError) return json(res, err.status, { error: err.message });
      world.host.log(`http ${req.method} ${path} failed: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  };
}
