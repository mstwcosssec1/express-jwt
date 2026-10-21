import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function installCopilotTools(directory, backend) {
  if (!['cli', 'sdk'].includes(backend)) throw new Error('Select the cli or sdk tooling backend.');
  if (!directory || !path.isAbsolute(directory)) throw new Error('Supply an absolute trusted tooling directory.');
  directory = path.resolve(directory);
  const relative = path.relative(process.cwd(), directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Prepare Copilot tools outside the maintained checkout.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let current = directory; path.dirname(current) !== current; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Copilot tooling directory cannot traverse symlinks.');
  }
  if (fs.readdirSync(directory).length) {
    const manifest = path.join(directory, 'package.json');
    const stat = fs.lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== `lights-on-copilot-${backend}-tools`) {
      throw new Error('Destination is not an existing Lights On installation of the selected tools.');
    }
  }
  const source = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['package.json', 'package-lock.json']) {
    const target = path.join(directory, name);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.copyFileSync(path.join(source, `copilot-${backend}.${name}`), target, fs.constants.COPYFILE_EXCL);
  }
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  // npm.cmd needs cmd.exe on Windows; neither the command nor its arguments contain user input.
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: directory, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: directory, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Pinned Copilot tools installation failed; no alternate registry or runtime fallback.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--backend' || process.argv[4] !== '--directory') {
      throw new Error('Usage: install-copilot-tools.mjs --backend cli|sdk --directory ABSOLUTE_PATH');
    }
    installCopilotTools(process.argv[5], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
