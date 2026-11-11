/**
 * Command line entry point: `npm run server -- --port=8420 --name="My Sector" --peers=https://other.example`.
 */
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

// `node:sqlite` is stable enough for this use but still prints an experimental warning on Node 22.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await startServer(config);
  await server.peer();
  console.log('');
  console.log(`  PRIMACY2 sector "${server.config.name}"`);
  console.log(`  Play:       ${server.url}`);
  console.log(`  Server id:  ${server.id}`);
  console.log(`  Peers:      ${server.fed.links().map((k) => k.desc.name).join(', ') || 'none yet'}`);
  console.log('');

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('Saving and shutting down...');
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
