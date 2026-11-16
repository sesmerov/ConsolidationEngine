import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'apps/api/src/hosted/migrations'), target = path.join(root, 'apps/api/dist/hosted/migrations');
const names = (await readdir(source)).filter(name => /^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort();
if (!names.length || names.some((name, index) => Number(name.slice(0, 3)) !== index + 1)) throw new Error('Hosted SQL migrations must be consecutive.');
await mkdir(target, { recursive: true });
if ((await readdir(target)).some(name => !names.includes(name))) throw new Error('The API output has an unknown migration; rebuild it from a clean controlled output directory.');
for (const name of names) await writeFile(path.join(target, name), await readFile(path.join(source, name)));
console.log(`Hosted API assets: ${names.length} SQL migrations copied without changing their bytes.`);
