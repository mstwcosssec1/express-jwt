import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveSafePath(targetPath, workingDir = process.cwd(), { allowTmp = false } = {}) {
  if (!targetPath || typeof targetPath !== 'string') throw new Error('Path must be a non-empty string');
  const root = fs.realpathSync(path.resolve(workingDir));
  const target = path.resolve(root, targetPath);
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const contains = (parent) => {
    const relative = path.relative(normalize(parent), normalize(target));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  let boundary = root;
  if (!contains(root)) {
    boundary = allowTmp ? fs.realpathSync(os.tmpdir()) : null;
    if (!boundary || !contains(boundary)) throw new Error(`Path traversal blocked: "${targetPath}" resolves outside workingDir "${root}"`);
  }
  let current = boundary;
  const parts = path.relative(boundary, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Symlink path blocked: "${targetPath}"`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Path ancestor is not a directory.');
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Special files are not permitted.');
  }
  return target;
}
