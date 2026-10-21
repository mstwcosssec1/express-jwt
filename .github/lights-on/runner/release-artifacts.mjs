import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectPublishTargets, publishRelease } from './publish-release.mjs';
import { loadConfig } from './load-config.mjs';

const EXTENSIONS = {
  npm: /\.tgz$/, pypi: /(?:\.whl|\.tar\.gz)$/, crates: /\.crate$/,
  nuget: /\.nupkg$/, rubygems: /\.gem$/
};
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function buildReleaseArtifacts({ repoRoot, directory, version, ecosystem, env = process.env, execFileImpl = execFileSync }) {
  if (Object.keys(env).some((key) => /(?:TOKEN|PASSWORD|API_KEY|ACTIONS_ID_TOKEN)/i.test(key) && env[key])) {
    throw new Error('Refusing to build with credentials in the environment.');
  }
  const plan = publishRelease({ repoRoot, version, dryRun: true, env: {} });
  const targets = plan.targets.filter((t) => t.ecosystem === ecosystem);
  if (!EXTENSIONS[ecosystem] || !targets.length) throw new Error('No supported build target.');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.readdirSync(directory).length) throw new Error('Build artifact directory must be empty.');
  const run = (cmd, args) => execFileImpl(cmd, args, { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  for (const target of targets) {
    if (!/^[A-Za-z0-9_.-]+$/.test(target.manifest) || target.manifest.startsWith('-')) throw new Error('Invalid manifest.');
    if (ecosystem === 'npm') run('npm', ['pack', '--ignore-scripts', '--pack-destination', directory]);
    if (ecosystem === 'pypi') run('python', ['-m', 'build', '--outdir', directory]);
    if (ecosystem === 'nuget') run('dotnet', ['pack', target.manifest, '-c', 'Release', '-o', directory]);
    if (ecosystem === 'rubygems') run('gem', ['build', target.manifest, '--output', path.join(directory, `${target.name}-${version}.gem`)]);
    if (ecosystem === 'crates') {
      run('cargo', ['package', '--allow-dirty', '--no-verify', '--target-dir', path.join(directory, 'cargo')]);
      const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1']));
      const pkg = metadata.packages.find((p) => path.resolve(p.manifest_path) === path.join(repoRoot, 'Cargo.toml'));
      if (!pkg || pkg.version !== version) throw new Error('Invalid Cargo package metadata.');
      fs.copyFileSync(path.join(directory, 'cargo', 'package', `${pkg.name}-${version}.crate`),
        path.join(directory, `${pkg.name}-${version}.crate`));
      fs.writeFileSync(path.join(directory, 'crate-metadata.json'), JSON.stringify({
        name: pkg.name, vers: pkg.version, deps: pkg.dependencies.map((d) => ({
          name: d.name, explicit_name_in_toml: d.rename || null,
          version_req: d.req, features: d.features, optional: d.optional,
          default_features: d.uses_default_features, target: d.target, kind: d.kind || 'normal',
          registry: d.registry
        })),
        features: pkg.features, authors: pkg.authors, description: pkg.description,
        documentation: pkg.documentation, homepage: pkg.homepage, repository: pkg.repository,
        readme: pkg.readme ? fs.readFileSync(path.join(repoRoot, pkg.readme), 'utf8') : null,
        readme_file: pkg.readme, keywords: pkg.keywords, categories: pkg.categories,
        license: pkg.license, license_file: pkg.license_file, rust_version: pkg.rust_version, links: pkg.links
      }));
      fs.rmSync(path.join(directory, 'cargo'), { recursive: true, force: true });
    }
  }
  const files = fs.readdirSync(directory).filter((name) => EXTENSIONS[ecosystem].test(name) || name === 'crate-metadata.json');
  if (!files.some((name) => EXTENSIONS[ecosystem].test(name))) throw new Error('Build produced no packages.');
  for (const name of fs.readdirSync(directory)) {
    if (!files.includes(name) || !fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(`Unexpected build output: ${name}`);
  }
  const manifest = { version, ecosystem, files: files.map((name) => ({ name, sha256: hash(path.join(directory, name)) })) };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

export function validateReleaseArtifacts({ directory, version, ecosystem, repoRoot, env = process.env }) {
  if (!EXTENSIONS[ecosystem]) throw new Error('Unsupported registry.');
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Invalid artifact manifest.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version || manifest.ecosystem !== ecosystem || !Array.isArray(manifest.files) ||
      !manifest.files.length || manifest.files.length > 100) throw new Error('Artifact identity mismatch.');
  const names = new Set(['manifest.json']);
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!entry || !/^[A-Za-z0-9_.+-]+$/.test(entry.name) || entry.name.startsWith('-') ||
        names.has(entry.name) || !(EXTENSIONS[ecosystem].test(entry.name) ||
          (ecosystem === 'crates' && entry.name === 'crate-metadata.json'))) throw new Error('Invalid artifact filename.');
    names.add(entry.name);
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    totalBytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || totalBytes > 500 * 1024 * 1024 ||
        hash(file) !== entry.sha256) throw new Error('Artifact integrity check failed.');
  }
  if (fs.readdirSync(directory).some((name) => !names.has(name))) throw new Error('Unexpected file in release artifact.');
  if (!manifest.files.some((entry) => EXTENSIONS[ecosystem].test(entry.name))) throw new Error('No package artifact.');
  const files = manifest.files.map((entry) => path.join(directory, entry.name));
  if (!repoRoot) throw new Error('Artifact identity verification requires the trusted release checkout.');
  const targets = detectPublishTargets(repoRoot).filter((target) => target.ecosystem === ecosystem);
  if (!targets.length) throw new Error('No trusted release targets for the artifacts.');
  const script = fileURLToPath(new URL('./package-identity.py', import.meta.url));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-identity-'));
  try {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', script], {
      cwd: home, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: env.PATH || process.env.PATH, SystemRoot: env.SystemRoot || process.env.SystemRoot, HOME: home, USERPROFILE: home },
      input: JSON.stringify({ repo_root: path.resolve(repoRoot), version, ecosystem, files: files.map((file) => path.resolve(file)),
        targets, package_names: loadConfig({ repoRoot, env: {} }).release.package_names || {} })
    });
  } catch {
    throw new Error('Distribution identity verification failed; install Python 3.11+ (and Ruby with Psych for RubyGems) and ensure all package metadata matches the trusted release names/version.');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  return files;
}

export function registryEnvironment(ecosystem, env, home, { provenance = true } = {}) {
  const clean = { PATH: env.PATH, SystemRoot: env.SystemRoot, HOME: home, USERPROFILE: home,
    DOTNET_CLI_HOME: home, DOTNET_NOLOGO: 'true', CI: 'true' };
  if (ecosystem === 'npm') {
    if (env.REGISTRY_TOKEN) clean.NODE_AUTH_TOKEN = env.REGISTRY_TOKEN;
    if (!env.REGISTRY_TOKEN || provenance) {
      for (const key of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
        'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_RUN_ID',
        'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA',
        'ACTIONS_RESULTS_URL', 'RUNNER_ENVIRONMENT']) if (env[key]) clean[key] = env[key];
    }
  }
  if (ecosystem === 'rubygems') clean.GEM_HOST_API_KEY = env.REGISTRY_TOKEN;
  return clean;
}

export async function uploadReleaseArtifacts({ repoRoot, directory, version, ecosystem, env = process.env,
  execFileImpl = execFileSync, fetchImpl = globalThis.fetch }) {
  const files = validateReleaseArtifacts({ directory, version, ecosystem, repoRoot, env });
  const targets = detectPublishTargets(repoRoot).filter((t) => t.ecosystem === ecosystem);
  if (!targets.length) throw new Error('Artifact registry does not match trusted release sources.');
  if (ecosystem !== 'npm' && !env.REGISTRY_TOKEN) throw new Error(`Missing publishing token for ${ecosystem}.`);
  if (ecosystem === 'npm' && !env.REGISTRY_TOKEN && !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('Missing npm publishing identity.');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-on-publish-'));
  try {
    const provenance = ecosystem === 'npm' && loadConfig({ repoRoot, env: {} }).release.provenance !== false;
    const cleanEnv = registryEnvironment(ecosystem, env, home, { provenance });
    const run = (cmd, args) => execFileImpl(cmd, args, { cwd: home, env: cleanEnv, stdio: 'pipe' });
    if (ecosystem === 'npm') {
      fs.writeFileSync(path.join(home, '.npmrc'), env.REGISTRY_TOKEN ? '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' : '');
      for (const file of files) run('npm', ['publish', file, '--ignore-scripts', '--strict-ssl=true', '--access', 'public',
        '--registry', 'https://registry.npmjs.org', '--userconfig', path.join(home, '.npmrc'),
        ...(provenance && cleanEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN ? ['--provenance'] : [])]);
    } else if (ecosystem === 'nuget') {
      fs.writeFileSync(path.join(home, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
      for (const file of files) run('dotnet', ['nuget', 'push', file, '--source',
        'https://api.nuget.org/v3/index.json', '--api-key', env.REGISTRY_TOKEN, '--skip-duplicate']);
    } else if (ecosystem === 'rubygems') {
      for (const file of files) run('gem', ['push', file, '--host', 'https://rubygems.org']);
    } else if (ecosystem === 'crates') {
      const metadataFile = files.find((file) => path.basename(file) === 'crate-metadata.json');
      const crate = files.filter((file) => file.endsWith('.crate'));
      if (!metadataFile || crate.length !== 1) throw new Error('Invalid crate artifact set.');
      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
      if (metadata.vers !== version || !targets.some((t) => t.name === metadata.name)) throw new Error('Crate identity mismatch.');
      const json = Buffer.from(JSON.stringify(metadata));
      const data = fs.readFileSync(crate[0]);
      const jsonLength = Buffer.alloc(4);
      const dataLength = Buffer.alloc(4);
      jsonLength.writeUInt32LE(json.length);
      dataLength.writeUInt32LE(data.length);
      const response = await fetchImpl('https://crates.io/api/v1/crates/new', {
        method: 'PUT', headers: { Authorization: env.REGISTRY_TOKEN, 'Content-Type': 'application/octet-stream', Accept: 'application/json',
          'User-Agent': 'Lights-On-release' },
        body: Buffer.concat([jsonLength, json, dataLength, data]), redirect: 'error', signal: AbortSignal.timeout(120000)
      });
      if (!response.ok || (await response.json()).errors) throw new Error('crates.io rejected the upload.');
    } else throw new Error('PyPI uploads must use the dedicated trusted-publishing action.');
  } catch {
    // CLI failures may include their secret-valued arguments. Do not print them.
    throw new Error(`Artifact upload failed for ${ecosystem}; no build commands were executed.`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { repoRoot: process.cwd(), directory: path.resolve(process.env.ARTIFACT_DIR),
    version: process.env.RELEASE_VERSION, ecosystem: process.env.ECOSYSTEM };
  try {
    if (process.argv.includes('--build')) buildReleaseArtifacts(options);
    else if (process.argv.includes('--validate')) validateReleaseArtifacts(options);
    else if (process.argv.includes('--upload')) await uploadReleaseArtifacts(options);
    else throw new Error('Specify --build, --validate, or --upload.');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
