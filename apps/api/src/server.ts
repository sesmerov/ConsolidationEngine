import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT debe ser un entero entre 0 y 65535.');
}
const server = await createApp({ mode: process.env['NODE_ENV'] === 'production' ? 'production' : 'development', apiPort: port });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close(); });
}
await server.listen({ host: '127.0.0.1', port });
process.stdout.write('ConsolidationEngine API: ' + server.listeningOrigin + '\n');
