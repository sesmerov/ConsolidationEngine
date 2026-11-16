import { spawn } from 'node:child_process';

export const PACKAGE_NPM_VERSION = '11.19.1';

export function packageBuildEnvironment(environment) {
  const allowed = /^(path|home|userprofile|systemroot|comspec|pathext|tmp|temp|tmpdir|localappdata|appdata|ci|no_color|force_color|term|npm_config_cache|npm_execpath|npm_node_execpath|ng_build_max_workers|java_home)$/i;
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.test(name)));
}

export async function executePackageNpm(args, { root, environment }) {
  const npmCli = environment.npm_execpath;
  if (!npmCli) throw new Error(`Run packaging through npm run with npm ${PACKAGE_NPM_VERSION}.`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: root, env: packageBuildEnvironment(environment), windowsHide: true,
      stdio: args[0] === '--version' ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`npm ${args.join(' ')} exited with ${code}.`)));
  });
}

export async function assertPackageToolchain(runNpm, options) {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('The Vercel package requires Node 24.x.');
  if ((await runNpm(['--version'], options)).trim() !== PACKAGE_NPM_VERSION) throw new Error(`The Vercel package requires npm ${PACKAGE_NPM_VERSION}.`);
}
