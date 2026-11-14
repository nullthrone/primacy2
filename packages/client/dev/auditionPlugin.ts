import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

// Dev-only server side of the audition page: serves the rendered sounds and stores the owner's ratings.
// Registered with apply: 'serve' so that none of this reaches the built game.

const MAX_BODY = 1024 * 1024;

const TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  // A sound that was just rendered again must be heard at once.
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Past the limit the rest is read and dropped, so that the 413 can still be answered on this connection.
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(new Error('too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/** True when `child` is inside `dir` (or is `dir`), after both are resolved. */
function inside(dir: string, child: string): boolean {
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function auditionPlugin(): Plugin {
  return {
    name: 'primacy2-audition',
    apply: 'serve',
    configureServer(server) {
      const audioDir = path.resolve(server.config.root, '../../assets/audio');
      const renderDir = path.join(audioDir, 'render');
      const downloadsDir = path.join(audioDir, 'downloads');
      const ratingsFile = path.join(audioDir, 'ratings.json');

      server.middlewares.use('/audio-lib', (req, res, next) => {
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          let pathname: string;
          try {
            pathname = decodeURIComponent(url.pathname);
          } catch {
            send(res, 400, 'bad path');
            return;
          }
          if (pathname.includes('\0')) {
            send(res, 400, 'bad path');
            return;
          }

          if (req.method === 'PUT' && pathname === '/ratings') {
            let parsed: unknown;
            try {
              parsed = JSON.parse((await readBody(req)).toString('utf-8'));
            } catch (e) {
              const tooLarge = e instanceof Error && e.message === 'too large';
              send(res, tooLarge ? 413 : 400, tooLarge ? 'body larger than 1 MB' : 'body is not JSON');
              return;
            }
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              send(res, 400, 'body must be a JSON object');
              return;
            }
            await fs.mkdir(audioDir, { recursive: true });
            await fs.writeFile(ratingsFile, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
            send(res, 200, '{"ok":true}', TYPES['.json']);
            return;
          }

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
          }

          // Only render/, downloads/ and ratings.json are ever served; '..' is resolved before the check.
          const target = path.resolve(audioDir, '.' + path.posix.normalize('/' + pathname));
          const allowed = target === ratingsFile || inside(renderDir, target) || inside(downloadsDir, target);
          if (!allowed || target === renderDir || target === downloadsDir) {
            send(res, 403, 'not served');
            return;
          }
          try {
            // A link inside an allowed directory must not lead out of it.
            const real = await fs.realpath(target);
            const realAudio = await fs.realpath(audioDir);
            const okReal =
              real === path.join(realAudio, 'ratings.json') ||
              inside(path.join(realAudio, 'render'), real) ||
              inside(path.join(realAudio, 'downloads'), real);
            if (!okReal) {
              send(res, 403, 'not served');
              return;
            }
            const data = await fs.readFile(real);
            const type = TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
            send(res, 200, req.method === 'HEAD' ? '' : data, type);
          } catch {
            send(res, 404, 'not found');
          }
        })().catch((e: unknown) => send(res, 500, String(e)));
      });
    },
  };
}
