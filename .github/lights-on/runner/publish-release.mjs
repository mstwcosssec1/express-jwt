#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sanitizeGitHubOutputValue } from './load-config.mjs';
import { readCurrentManifestVersion, tomlPackageSection } from './prepare-release.mjs';

const __filename = fileURLToPath(import.meta.url);

const SAFE_SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_PACKAGE_NAME_REGEX = /^(@[a-z0-9._-]+\/)?[a-z0-9._/-]+$/i;
const SAFE_MANIFEST_FILE_REGEX = /^[A-Za-z0-9._-]+$/;

export function partitionReleaseUploads(ecosystems, { hasNpmToken = false, hasPypiToken = false, provenance = true } = {}) {
  if (!Array.isArray(ecosystems) || ecosystems.some((name) => !['npm', 'pypi', 'crates', 'nuget', 'rubygems'].includes(name)) ||
      [hasNpmToken, hasPypiToken, provenance].some((value) => typeof value !== 'boolean')) {
    throw new Error('Invalid release upload authentication inputs.');
  }
  const result = { oidc: [], token: [] };
  for (const ecosystem of new Set(ecosystems)) {
    const needsOidc = ecosystem === 'npm' ? !hasNpmToken || provenance : ecosystem === 'pypi' && !hasPypiToken;
    result[needsOidc ? 'oidc' : 'token'].push(ecosystem);
  }
  return result;
}

/**
 * Extract release metadata from a Release PR's body (`<!-- lights-on-release: {...} -->`) or title (`chore(release): vX.Y.Z`).
 */
export function parseReleaseMetadataFromPr({ title = '', body = '' } = {}) {
  const bodyStr = String(body || '');
  const markerMatch = bodyStr.match(/<!--\s*lights-on-release:\s*(\{[\s\S]*?\})\s*-->/);
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1]);
      const version = String(parsed.version || '').replace(/^v/, '').trim();
      if (SAFE_SEMVER_REGEX.test(version)) {
        return {
          version,
          tag: `v${version}`,
          bump: parsed.bump || 'patch'
        };
      }
    } catch {}
  }

  const titleStr = String(title || '').trim();
  const titleMatch = titleStr.match(/^chore\(release\):\s*v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/i);
  if (titleMatch && SAFE_SEMVER_REGEX.test(titleMatch[1])) {
    const version = titleMatch[1];
    return {
      version,
      tag: `v${version}`,
      bump: 'patch'
    };
  }

  return null;
}

/**
 * Detect publishable package ecosystems in repoRoot.
 */
export function detectPublishTargets(repoRoot = process.cwd()) {
  const absRoot = path.resolve(repoRoot);
  const targets = [];

  // 1. npm (package.json with private !== true)
  const pkgPath = path.join(absRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.name && pkg.private !== true) {
      targets.push({
        ecosystem: 'npm',
        name: pkg.name,
        version: String(pkg.version || '').replace(/^v/, ''),
        manifest: 'package.json'
      });
    }
  }

  // 2. PyPI (pyproject.toml or setup.py)
  const pyprojectPath = path.join(absRoot, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const content = fs.readFileSync(pyprojectPath, 'utf8');
    const section = tomlPackageSection(content, ['project', 'tool.poetry']);
    if (section) {
      const nameMatch = section.text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      targets.push({
        ecosystem: 'pypi',
        name: nameMatch ? nameMatch[1] : path.basename(absRoot),
        manifest: 'pyproject.toml'
      });
    }
  } else if (fs.existsSync(path.join(absRoot, 'setup.py'))) {
    targets.push({
      ecosystem: 'pypi',
      name: path.basename(absRoot),
      manifest: 'setup.py'
    });
  }

  // 3. crates.io (Cargo.toml without publish = false)
  const cargoPath = path.join(absRoot, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    const content = fs.readFileSync(cargoPath, 'utf8');
    const section = tomlPackageSection(content, ['package']);
    if (section && !/^\s*publish\s*=\s*false/m.test(section.text)) {
      const nameMatch = section.text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      targets.push({
        ecosystem: 'crates',
        name: nameMatch ? nameMatch[1] : path.basename(absRoot),
        manifest: 'Cargo.toml'
      });
    }
  }

  // 4. NuGet (*.csproj without <IsPackable>false</IsPackable>)
  for (const entry of fs.readdirSync(absRoot)) {
    if (entry.endsWith('.csproj')) {
      const content = fs.readFileSync(path.join(absRoot, entry), 'utf8');
      if (!/<IsPackable>\s*false\s*<\/IsPackable>/i.test(content)) {
        targets.push({
          ecosystem: 'nuget',
          name: entry.replace(/\.csproj$/i, ''),
          manifest: entry
        });
      }
    } else if (entry.endsWith('.gemspec')) {
      targets.push({
        ecosystem: 'rubygems',
        name: entry.replace(/\.gemspec$/i, ''),
        manifest: entry
      });
    }
  }

  // 5. Go module (go.mod)
  const goModPath = path.join(absRoot, 'go.mod');
  if (fs.existsSync(goModPath)) {
    const content = fs.readFileSync(goModPath, 'utf8');
    const modMatch = content.match(/^\s*module\s+(\S+)/m);
    targets.push({
      ecosystem: 'go',
      name: modMatch ? modMatch[1] : path.basename(absRoot),
      manifest: 'go.mod'
    });
  }

  return targets;
}

/**
 * Build registry publish commands for each detected target.
 */
export function buildPublishCommands(
  targets = [],
  { version, tag, provenance = true, env = process.env } = {}
) {
  const cleanVersion = String(version || '').replace(/^v/, '');
  if (!SAFE_SEMVER_REGEX.test(cleanVersion)) {
    throw new Error(`Invalid SemVer version for publishing: "${version}"`);
  }
  const resolvedTag = tag || `v${cleanVersion}`;
  const hasOidc = Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

  const plan = [];

  for (const target of targets) {
    if (!SAFE_PACKAGE_NAME_REGEX.test(String(target.name || '')) || String(target.name || '').startsWith('-')) {
      continue;
    }
    if (target.manifest && (!SAFE_MANIFEST_FILE_REGEX.test(String(target.manifest)) || String(target.manifest).startsWith('-'))) {
      continue;
    }
    switch (target.ecosystem) {
      case 'npm': {
        const hasToken = Boolean(env.NODE_AUTH_TOKEN || env.NPM_TOKEN);
        const args = ['publish', '--ignore-scripts', '--access', 'public'];
        if (provenance && hasOidc) {
          args.splice(1, 0, '--provenance');
        }
        plan.push({
          ecosystem: 'npm',
          name: target.name,
          ready: hasToken || hasOidc,
          authMethod: hasOidc ? 'oidc-trusted-publisher' : (hasToken ? 'token' : 'missing'),
          buildCommands: [{ cmd: 'npm', args: ['pack', '--ignore-scripts'] }],
          commands: [{ cmd: 'npm', args: [...args, '<validated-package.tgz>'] }]
        });
        break;
      }

      case 'pypi': {
        const hasToken = Boolean(env.TWINE_PASSWORD || env.PYPI_API_TOKEN);
        plan.push({
          ecosystem: 'pypi',
          name: target.name,
          ready: hasToken || hasOidc,
          authMethod: hasOidc ? 'oidc-trusted-publisher' : (hasToken ? 'token' : 'missing'),
          buildCommands: [{ cmd: 'python', args: ['-m', 'build'] }],
          commands: [],
          uploadAction: 'pypa/gh-action-pypi-publish'
        });
        break;
      }

      case 'crates': {
        const hasToken = Boolean(env.CARGO_REGISTRY_TOKEN);
        plan.push({
          ecosystem: 'crates',
          name: target.name,
          ready: hasToken,
          authMethod: hasToken ? 'token' : 'missing',
          buildCommands: [{ cmd: 'cargo', args: ['package', '--no-verify'] }],
          commands: [],
          uploadEndpoint: 'https://crates.io/api/v1/crates/new'
        });
        break;
      }

      case 'nuget': {
        const hasToken = Boolean(env.NUGET_API_KEY);
        plan.push({
          ecosystem: 'nuget',
          name: target.name,
          ready: hasToken,
          authMethod: hasToken ? 'token' : 'missing',
          buildCommands: [{ cmd: 'dotnet', args: ['pack', target.manifest, '-c', 'Release', '-o', './nupkg'] }],
          commands: [
            {
              cmd: 'dotnet',
              args: [
                'nuget',
                'push',
                './nupkg/*.nupkg',
                '--source',
                'https://api.nuget.org/v3/index.json',
                '--skip-duplicate'
              ],
              secretArgEnv: 'NUGET_API_KEY',
              secretArgFlag: '--api-key'
            }
          ]
        });
        break;
      }

      case 'rubygems': {
        const hasToken = Boolean(env.GEM_HOST_API_KEY);
        plan.push({
          ecosystem: 'rubygems',
          name: target.name,
          ready: hasToken,
          authMethod: hasToken ? 'token' : 'missing',
          buildCommands: [{ cmd: 'gem', args: ['build', target.manifest] }],
          commands: [
            { cmd: 'gem', args: ['push', `${target.name}-${cleanVersion}.gem`] }
          ]
        });
        break;
      }

      case 'go': {
        plan.push({
          ecosystem: 'go',
          name: target.name,
          ready: true,
          authMethod: 'git-tag-proxy',
          commands: [],
          releaseTag: resolvedTag
        });
        break;
      }
    }
  }

  return plan;
}

/**
 * Build a release plan. Credentialed build-and-publish execution is disabled.
 */
export function publishRelease({
  repoRoot = process.cwd(),
  version,
  tag = null,
  config = null,
  dryRun = false,
  env = process.env
} = {}) {
  const resolvedConfig = config || loadConfig({ repoRoot, env });
  const releaseCfg = resolvedConfig?.release || {};

  const cleanVersion = String(version || readCurrentManifestVersion(repoRoot)).replace(/^v/, '').trim();
  if (!SAFE_SEMVER_REGEX.test(cleanVersion)) {
    throw new Error(`Invalid release version "${version}"`);
  }

  const manifestVersion = readCurrentManifestVersion(repoRoot);
  const targets = detectPublishTargets(repoRoot);

  // If the repo has a versioned manifest, verify it matches the requested release version
  if (targets.length > 0 && targets.some((t) => t.ecosystem !== 'go') && manifestVersion !== cleanVersion) {
    throw new Error(
      `Release version mismatch: PR/tag requested "${cleanVersion}" but manifest version is "${manifestVersion}".`
    );
  }

  const resolvedTag = tag || `v${cleanVersion}`;
  const publishPlan = buildPublishCommands(targets, {
    version: cleanVersion,
    tag: resolvedTag,
    provenance: releaseCfg.provenance !== false,
    env
  });

  const results = [];
  if (!dryRun && releaseCfg.auto_publish !== false) {
    throw new Error('Combined build/publish execution is disabled. Use lights-on-release.yml: credential-free build jobs and artifact-only registry upload jobs.');
  }

  return {
    version: cleanVersion,
    tag: resolvedTag,
    targets,
    publishPlan,
    results,
    dryRun
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const writeGithubOutput = args.includes('--github-output');
  const versionIdx = args.indexOf('--version');
  const versionArg = versionIdx !== -1 ? args[versionIdx + 1] : undefined;

  const res = publishRelease({
    repoRoot: process.cwd(),
    version: versionArg,
    dryRun
  });

  if (writeGithubOutput && process.env.GITHUB_OUTPUT) {
    const lines = [
      `version=${sanitizeGitHubOutputValue(res.version)}`,
      `tag=${sanitizeGitHubOutputValue(res.tag)}`,
      `targets_count=${res.targets.length}`
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
  }
  console.log(JSON.stringify(res, null, 2));
}
