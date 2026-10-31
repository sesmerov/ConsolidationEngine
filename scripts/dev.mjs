import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(process.execPath, [path.join(root, 'apps/api/dist/server.js')], { cwd: root, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, [path.join(root, 'node_modules/@angular/cli/bin/ng.js'), 'serve', '--host', '127.0.0.1', '--port', '4200'], { cwd: path.join(root, 'apps/web'), stdio: 'inherit', windowsHide: true }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
for (const child of children) {
  child.once('error', (error) => { console.error(error.message); stop(1); });
  child.once('exit', (code) => { if (!stopping) stop(code ?? 1); });
}
