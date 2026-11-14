import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

// Dev-only server side of the audition page: serves the rendered sounds and stores the owner's ratings.
// Registered with apply: 'serve' so that none of this reaches the built game.

const MAX_BODY = 1024 * 1024;
// The file written is indented, so a small body can grow a lot; this caps what lands on disk.
const MAX_WRITTEN = 2 * MAX_BODY;
// Past this many bytes a client is cut off: draining a stream that never ends would keep the server busy for ever.
const HARD_LIMIT = 8 * MAX_BODY;

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
      // Past the limit the rest is read and dropped, so that the 413 can still be answered on this connection;
      // past the hard limit the connection is cut instead.
      if (size <= MAX_BODY) chunks.push(c);
      else if (size > HARD_LIMIT) req.destroy();
    });
    req.on('end', () => (size > MAX_BODY ? reject(new Error('too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => reject(new Error('too large')));
  });
}

/** True when `child` is inside `dir` (or is `dir`), after both are resolved. */
function inside(dir: string, child: string): boolean {
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A page of another origin (any other local web app, any site the owner visits meanwhile) must neither read the
 * sounds nor overwrite the ratings. Browsers always name the origin or the fetch site; curl and the check's raw
 * probes send neither and are let through.
 */
function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return true;
  return typeof site === 'string' && site !== 'same-origin' && site !== 'none';
}

export function auditionPlugin(): Plugin {
  return {
    name: 'primacy2-audition',
    apply: 'serve',
    configureServer(server) {
      const audioDir = path.resolve(server.config.root, '../../assets/audio');
      const renderDir = path.join(audioDir, 'render');
      const downloadsDir = path.join(audioDir, 'downloads');
      // Hashes of the files as heard in earlier listening rounds; read-only, like everything but the ratings.
      const roundsDir = path.join(audioDir, 'rounds');
      // A test server can keep its ratings elsewhere, so that a check never touches the owner's file.
      const ratingsFile = process.env.AUDITION_RATINGS_FILE ? path.resolve(process.env.AUDITION_RATINGS_FILE) : path.join(audioDir, 'ratings.json');

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

          if (crossOrigin(req)) {
            send(res, 403, 'cross-origin request refused');
            return;
          }

          if (req.method === 'PUT' && pathname === '/ratings') {
            // A form post from another site cannot set this type without a preflight, which this server never answers.
            if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
              send(res, 415, 'content type must be application/json');
              return;
            }
            const declared = Number(req.headers['content-length']);
            if (Number.isFinite(declared) && declared > HARD_LIMIT) {
              res.setHeader('Connection', 'close');
              send(res, 413, 'body larger than 1 MB');
              return;
            }
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
            const text = JSON.stringify(parsed, null, 2) + '\n';
            if (Buffer.byteLength(text) > MAX_WRITTEN) {
              send(res, 413, 'ratings larger than 2 MB once written');
              return;
            }
            await fs.mkdir(path.dirname(ratingsFile), { recursive: true });
            // Written beside the file and renamed over it, so that a crash never leaves half a ratings file.
            const tmp = `${ratingsFile}.${process.pid}.tmp`;
            try {
              await fs.writeFile(tmp, text, 'utf-8');
              await fs.rename(tmp, ratingsFile);
            } catch (e) {
              await fs.rm(tmp, { force: true });
              throw e;
            }
            send(res, 200, '{"ok":true}', TYPES['.json']);
            return;
          }

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            next();
            return;
          }

          if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/ratings.json') {
            try {
              send(res, 200, req.method === 'HEAD' ? '' : await fs.readFile(ratingsFile), TYPES['.json']);
            } catch {
              send(res, 404, 'not found');
            }
            return;
          }

          // Only render/, downloads/, rounds/ and ratings.json are ever served; '..' is resolved before the check.
          const target = path.resolve(audioDir, '.' + path.posix.normalize('/' + pathname));
          const allowed = inside(renderDir, target) || inside(downloadsDir, target) || inside(roundsDir, target);
          if (!allowed || target === renderDir || target === downloadsDir || target === roundsDir) {
            send(res, 403, 'not served');
            return;
          }
          try {
            // A link inside an allowed directory must not lead out of it.
            const real = await fs.realpath(target);
            const realAudio = await fs.realpath(audioDir);
            const okReal =
              inside(path.join(realAudio, 'render'), real) ||
              inside(path.join(realAudio, 'downloads'), real) ||
              inside(path.join(realAudio, 'rounds'), real);
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
