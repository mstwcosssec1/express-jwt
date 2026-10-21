import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PROTECTED_PATH_PATTERNS } from './verify-pr-safety.mjs';
import { resolveSafePath } from './workspace-path.mjs';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 10000;
const OMITTED = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const THREAT_MODEL = /^(docs\/|\.github\/)?threat[_-]model\.(md|ya?ml|json)$/i;
// Official node:24-bookworm image.
export const DEFAULT_SANDBOX_IMAGE = 'node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0';

function protectedPath(name, allowThreatModel) {
  if (/^\.git(?:\/|$)/i.test(name) || /^(?:\.gitattributes|\.gitmodules|\.lfsconfig)$/i.test(name)) return true;
  if (allowThreatModel && THREAT_MODEL.test(name)) return false;
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(name));
}

export function inventory(root, { omitLocal = false } = {}) {
  const files = new Map();
  let bytes = 0;
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      if (omitLocal && OMITTED.has(name.toLowerCase())) continue;
      if (/[\\\x00-\x1f\x7f]/.test(name) || name === '..' || name === '.') throw new Error('Unsafe candidate path.');
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`Candidate contains a symlink or special file: ${relative}`);
      }
      if (stat.isDirectory()) visit(full, relative);
      else {
        bytes += stat.size;
        if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new Error('Candidate workspace exceeds safety limits.');
        files.set(relative, {
          hash: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
          mode: stat.mode & 0o777
        });
      }
    }
  }
  visit(root);
  return files;
}

export function applyCandidate({ candidate, target, baseline, allowThreatModel = false }) {
  const after = inventory(candidate);
  const changes = [...new Set([...baseline.keys(), ...after.keys()])]
    .filter((name) => baseline.get(name)?.hash !== after.get(name)?.hash ||
      baseline.get(name)?.mode !== after.get(name)?.mode);
  // Validate the whole change set before touching the trusted checkout.
  for (const name of changes) {
    if (protectedPath(name, allowThreatModel)) throw new Error(`Protected candidate change rejected: ${name}`);
    resolveSafePath(name, target);
    const full = path.join(target, ...name.split('/'));
    const original = baseline.get(name);
    if (original && (!fs.existsSync(full) || !fs.lstatSync(full).isFile() ||
        crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') !== original.hash)) {
      throw new Error(`Trusted checkout changed during agent execution: ${name}`);
    }
    if (!original && fs.existsSync(full)) throw new Error(`Candidate would overwrite an existing path: ${name}`);
  }
  for (const name of changes) {
    const full = path.join(target, ...name.split('/'));
    if (!after.has(name)) fs.unlinkSync(full);
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.copyFileSync(path.join(candidate, ...name.split('/')), full);
      fs.chmodSync(full, after.get(name).mode & 0o755);
    }
  }
  return changes;
}

export function dockerCommandArgs({ name, image, workspace, command }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Sandbox image must resolve to an immutable image ID.');
  if (workspace.includes(',') || /[\r\n]/.test(workspace)) throw new Error('Unsupported sandbox mount path.');
  return ['run', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '128',
    '--memory', '2g', '--cpus', '2', '--ulimit', 'fsize=104857600:104857600',
    '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    '--mount', `type=bind,source=${workspace},target=/workspace`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--workdir', '/workspace',
    '--env', 'HOME=/tmp', '--env', 'CI=true', '--entrypoint', '/bin/sh',
    image, '-c', command];
}

export function createAgentSandbox({ repoRoot, image = DEFAULT_SANDBOX_IMAGE, spawnImpl = spawnSync } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-worker-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o755 });
  let baseline;
  try {
    baseline = inventory(repoRoot, { omitLocal: true });
    for (const name of baseline.keys()) {
      const dst = path.join(workspace, ...name.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, ...name.split('/')), dst);
    }
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
  let imageId;
  const docker = (args, options = {}) => spawnImpl('docker', args, {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120000,
    ...options
  });
  return {
    workspace,
    run(command) {
      if (!imageId) {
        let info = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
        if (info.status !== 0) {
          const pull = docker(['pull', image]);
          if (pull.status !== 0) throw new Error(`Docker sandbox unavailable: ${pull.error?.message || pull.stderr}`);
          info = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
        }
        if (info.status !== 0) throw new Error('Cannot resolve sandbox image.');
        imageId = info.stdout.trim();
      }
      const name = `lights-on-${crypto.randomUUID()}`;
      try {
        const proc = docker(dockerCommandArgs({ name, image: imageId, workspace, command }), { timeout: 60000 });
        return { exit_code: proc.error?.code === 'ETIMEDOUT' ? 124 : (proc.status ?? 1),
          stdout: (proc.stdout || '').slice(0, 50000),
          stderr: (proc.stderr || proc.error?.message || '').slice(0, 50000) };
      } finally {
        const removed = docker(['rm', '--force', name]);
        if (removed.status !== 0 && !/No such container/.test(removed.stderr || '')) {
          throw new Error(`Unable to stop sandbox container ${name}: ${removed.stderr || removed.error?.message}`);
        }
      }
    },
    apply({ allowThreatModel = false } = {}) {
      return applyCandidate({ candidate: workspace, target: path.resolve(repoRoot), baseline, allowThreatModel });
    },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
