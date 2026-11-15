import type { IncomingMessage, ServerResponse } from 'node:http';
import { getHostedApplication } from '../dist/hosted-entry.js';

/** Keep the original URL/body untouched: internal signatures bind both. Await completion before the function returns. */
export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const app = await getHostedApplication();
  await app.ready();
  await new Promise<void>((resolve, reject) => {
    response.once('finish', resolve); response.once('close', resolve); response.once('error', reject);
    app.server.emit('request', request, response);
  });
}
