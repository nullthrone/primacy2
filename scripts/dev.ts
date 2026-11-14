/**
 * Development helper: starts two peered servers on this machine so federation can be tried locally.
 *
 *   npm run dev            # Alpha on :8420, Beta on :8421 (data in .data/)
 *   npm run dev:client     # in a second terminal, for hot-reloading the client against Alpha
 *
 * PRIMACY2_DEV_PORT=<n> puts Alpha on port n and Beta on n + 1, and PRIMACY2_DEV_DATA=<dir> keeps
 * their data there: for a test run beside a stack that is already up on the usual ports.
 */
import { startServer } from '../packages/server/src/server.ts';
import { publicKeyOf, sha256Hex, type KeyPair } from '../packages/shared/src/index.ts';

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// A fixed universe for tests: with PRIMACY2_FIXED_UNIVERSE set to a label, both servers get
// identities derived from that label, so every start on an empty data directory generates the
// same two sectors and a test run says something about the code, not about the dice. Such keys
// are public by construction: never start a real server this way. Without the variable each
// server makes its own identity on first start, as any server does.
const universe = process.env.PRIMACY2_FIXED_UNIVERSE;
const identity = (name: string): { keys?: KeyPair } => {
  if (!universe) return {};
  const secretKey = sha256Hex(`primacy2-dev:${name}-${universe}`);
  return { keys: { secretKey, publicKey: publicKeyOf(secretKey) } };
};

const port = Number(process.env.PRIMACY2_DEV_PORT ?? 8420);
const data = process.env.PRIMACY2_DEV_DATA ?? '.data';

// The two servers rate each other partner (the default would be visitor, with all cargo sealed),
// so trade, tariffs and the trade balance can be tried between them.
const alpha = await startServer(
  { name: 'Alpha Reach', port, seed: 'alpha', dataDir: `${data}/alpha`, defaultTrust: 'partner' },
  identity('alpha'),
);
const beta = await startServer(
  { name: 'Beta Expanse', port: port + 1, seed: 'beta', dataDir: `${data}/beta`, peers: [alpha.url], defaultTrust: 'partner' },
  identity('beta'),
);
await beta.peer();

console.log('');
console.log(`  Alpha Reach:   ${alpha.url}`);
console.log(`  Beta Expanse:  ${beta.url}`);
console.log('  Both sectors are peered. Open either URL to play; fold jumps cross between them.');
console.log('');

const stop = (): void => {
  void Promise.all([alpha.stop(), beta.stop()]).then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
