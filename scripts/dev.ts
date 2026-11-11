/**
 * Development helper: starts two peered servers on this machine so federation can be tried locally.
 *
 *   npm run dev            # Alpha on :8420, Beta on :8421 (data in .data/)
 *   npm run dev:client     # in a second terminal, for hot-reloading the client against Alpha
 */
import { startServer } from '../packages/server/src/server.ts';

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const alpha = await startServer({ name: 'Alpha Reach', port: 8420, seed: 'alpha', dataDir: '.data/alpha' });
const beta = await startServer({ name: 'Beta Expanse', port: 8421, seed: 'beta', dataDir: '.data/beta', peers: [alpha.url] });
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
