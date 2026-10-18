import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './load-config.mjs';
import { loadState, saveState } from './state-store.mjs';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.tox',
  'bin',
  'obj'
]);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Extracts a clean semver-like version string from a dependency specifier.
 */
export function extractResolvedVersion(versionSpec) {
  if (!versionSpec || typeof versionSpec !== 'string') return null;
  const trimmed = versionSpec.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'latest') return null;
  const match = trimmed.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

/**
 * Parses a version string into numeric [major, minor, patch] and optional prerelease.
 */
function parseSemver(version) {
  if (!version || typeof version !== 'string') return null;
  const cleaned = version.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
    prerelease: match[4] || null
  };
}

/**
 * Classifies the semver bump between currentVersion and latestVersion.
 * Returns 'major', 'minor', 'patch', or null if not outdated.
 */
export function classifyVersionBump(currentVersion, latestVersion) {
  if (!currentVersion || !latestVersion) return null;
  if (String(currentVersion).trim() === String(latestVersion).trim()) return null;

  const cur = parseSemver(currentVersion);
  const lat = parseSemver(latestVersion);

  if (cur && lat) {
    if (lat.major < cur.major) return null;
    if (lat.major > cur.major) return 'major';
    if (lat.minor < cur.minor) return null;
    if (lat.minor > cur.minor) return 'minor';
    if (lat.patch < cur.patch) return null;
    if (lat.patch > cur.patch) return 'patch';
    if (cur.prerelease && !lat.prerelease) return 'patch';
    if (cur.prerelease && lat.prerelease && cur.prerelease !== lat.prerelease) return 'patch';
    return null;
  }

  return 'patch';
}

function toPosixRelative(repoRoot, filePath) {
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, '/');
  return rel || path.basename(filePath);
}

function findFiles(dir, predicate, maxDepth = 3, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth || !fs.existsSync(dir)) return results;

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      results.push(...findFiles(fullPath, predicate, maxDepth, currentDepth + 1));
    } else if (entry.isFile() && predicate(entry.name, fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function parseNpmManifest(filePath, repoRoot) {
  const packageInfo = [];
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { packageInfo, dependencies };
  }

  let lockPackages = null;
  const lockPath = path.join(path.dirname(filePath), 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    try {
      const lockJson = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      lockPackages = lockJson.packages || lockJson.dependencies || null;
    } catch {
      lockPackages = null;
    }
  }

  if (pkg.name) {
    packageInfo.push({
      ecosystem: 'npm',
      registry: 'npmjs.org',
      osvEcosystem: 'npm',
      name: pkg.name,
      version: pkg.version || '0.0.0',
      manifest: relManifest,
      ...(pkg.engines ? { engines: pkg.engines } : {})
    });
  }

  const resolveFromLockOrSpec = (depName, spec) => {
    if (lockPackages) {
      const nodeModEntry = lockPackages[`node_modules/${depName}`] || lockPackages[depName];
      if (nodeModEntry?.version) return nodeModEntry.version;
    }
    return extractResolvedVersion(spec);
  };

  const addDepMap = (depObj, isDev) => {
    if (!depObj || typeof depObj !== 'object') return;
    for (const [name, versionSpec] of Object.entries(depObj)) {
      const specStr = String(versionSpec);
      dependencies.push({
        ecosystem: 'npm',
        registry: 'npmjs.org',
        osvEcosystem: 'npm',
        name,
        versionSpec: specStr,
        resolvedVersion: resolveFromLockOrSpec(name, specStr),
        dev: isDev,
        manifest: relManifest
      });
    }
  };

  addDepMap(pkg.dependencies, false);
  addDepMap(pkg.devDependencies, true);
  addDepMap(pkg.peerDependencies, false);

  return { packageInfo, dependencies };
}

function parsePythonReqSpec(rawLine) {
  const line = rawLine.replace(/#.*$/, '').trim();
  if (!line || line.startsWith('-') || line.startsWith('git+') || line.startsWith('http')) {
    return null;
  }
  const withoutMarkers = line.split(';')[0].trim();
  const match = withoutMarkers.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  const name = match[1];
  const versionSpec = (match[2] || '').trim() || '*';
  return {
    name,
    versionSpec,
    resolvedVersion: extractResolvedVersion(versionSpec)
  };
}

function parseRequirementsTxt(filePath, repoRoot) {
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);
  const isDev = /dev|test/i.test(path.basename(filePath));

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { packageInfo: [], dependencies };
  }

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const parsed = parsePythonReqSpec(rawLine);
    if (parsed) {
      dependencies.push({
        ecosystem: 'pypi',
        registry: 'pypi.org',
        osvEcosystem: 'PyPI',
        name: parsed.name,
        versionSpec: parsed.versionSpec,
        resolvedVersion: parsed.resolvedVersion,
        dev: isDev,
        manifest: relManifest
      });
    }
  }

  return { packageInfo: [], dependencies };
}

function parsePyprojectToml(filePath, repoRoot) {
  const packageInfo = [];
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { packageInfo, dependencies };
  }

  const nameMatch = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  const versionMatch = content.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  const reqPythonMatch = content.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);

  if (nameMatch) {
    packageInfo.push({
      ecosystem: 'pypi',
      registry: 'pypi.org',
      osvEcosystem: 'PyPI',
      name: nameMatch[1],
      version: versionMatch ? versionMatch[1] : '0.0.0',
      manifest: relManifest,
      ...(reqPythonMatch ? { requiresPython: reqPythonMatch[1] } : {})
    });
  }

  const depsBlockMatch = content.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (depsBlockMatch) {
    const block = depsBlockMatch[1];
    const itemRegex = /["']([^"']+)["']/g;
    let m;
    while ((m = itemRegex.exec(block)) !== null) {
      const parsed = parsePythonReqSpec(m[1]);
      if (parsed) {
        dependencies.push({
          ecosystem: 'pypi',
          registry: 'pypi.org',
          osvEcosystem: 'PyPI',
          name: parsed.name,
          versionSpec: parsed.versionSpec,
          resolvedVersion: parsed.resolvedVersion,
          dev: false,
          manifest: relManifest
        });
      }
    }
  }

  return { packageInfo, dependencies };
}

function parseCargoToml(filePath, repoRoot) {
  const packageInfo = [];
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { packageInfo, dependencies };
  }

  let currentSection = '';
  let pkgName = null;
  let pkgVersion = '0.0.0';

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (currentSection === 'package') {
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/);
      if (kv) {
        if (kv[1] === 'name') pkgName = kv[2];
        if (kv[1] === 'version') pkgVersion = kv[2];
      }
    } else if (currentSection === 'dependencies' || currentSection === 'dev-dependencies') {
      const isDev = currentSection === 'dev-dependencies';
      const simpleKv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/);
      if (simpleKv) {
        const [, name, versionSpec] = simpleKv;
        dependencies.push({
          ecosystem: 'cargo',
          registry: 'crates.io',
          osvEcosystem: 'crates.io',
          name,
          versionSpec,
          resolvedVersion: extractResolvedVersion(versionSpec),
          dev: isDev,
          manifest: relManifest
        });
        continue;
      }

      const tableKv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}/);
      if (tableKv) {
        const name = tableKv[1];
        const verMatch = tableKv[2].match(/version\s*=\s*["']([^"']+)["']/);
        const versionSpec = verMatch ? verMatch[1] : '*';
        dependencies.push({
          ecosystem: 'cargo',
          registry: 'crates.io',
          osvEcosystem: 'crates.io',
          name,
          versionSpec,
          resolvedVersion: extractResolvedVersion(versionSpec),
          dev: isDev,
          manifest: relManifest
        });
      }
    }
  }

  if (pkgName) {
    packageInfo.push({
      ecosystem: 'cargo',
      registry: 'crates.io',
      osvEcosystem: 'crates.io',
      name: pkgName,
      version: pkgVersion,
      manifest: relManifest
    });
  }

  return { packageInfo, dependencies };
}

function parseGoMod(filePath, repoRoot) {
  const packageInfo = [];
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { packageInfo, dependencies };
  }

  let moduleName = null;
  let goVersion = null;
  let inRequireBlock = false;

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const isIndirect = /\/\/\s*indirect\b/.test(rawLine);
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (line.startsWith('module ')) {
      moduleName = line.slice('module '.length).trim().replace(/^["']|["']$/g, '');
      continue;
    }

    if (line.startsWith('go ')) {
      goVersion = line.slice('go '.length).trim();
      continue;
    }

    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }

    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }

    if (line.startsWith('require ')) {
      const rest = line.slice('require '.length).trim();
      const parts = rest.split(/\s+/);
      if (parts.length >= 2) {
        dependencies.push({
          ecosystem: 'go',
          registry: 'proxy.golang.org',
          osvEcosystem: 'Go',
          name: parts[0],
          versionSpec: parts[1],
          resolvedVersion: extractResolvedVersion(parts[1]),
          dev: isIndirect,
          manifest: relManifest
        });
      }
      continue;
    }

    if (inRequireBlock) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        dependencies.push({
          ecosystem: 'go',
          registry: 'proxy.golang.org',
          osvEcosystem: 'Go',
          name: parts[0],
          versionSpec: parts[1],
          resolvedVersion: extractResolvedVersion(parts[1]),
          dev: isIndirect,
          manifest: relManifest
        });
      }
    }
  }

  if (moduleName) {
    packageInfo.push({
      ecosystem: 'go',
      registry: 'proxy.golang.org',
      osvEcosystem: 'Go',
      name: moduleName,
      version: goVersion || '0.0.0',
      manifest: relManifest
    });
  }

  return { packageInfo, dependencies };
}

function parseCsproj(filePath, repoRoot) {
  const packageInfo = [];
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { packageInfo, dependencies };
  }

  const pkgIdMatch =
    content.match(/<PackageId>\s*([^<\s]+)\s*<\/PackageId>/i) ||
    content.match(/<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/i);
  const versionMatch = content.match(/<Version>\s*([^<\s]+)\s*<\/Version>/i);
  const pkgName = pkgIdMatch ? pkgIdMatch[1] : path.basename(filePath, '.csproj');

  packageInfo.push({
    ecosystem: 'nuget',
    registry: 'nuget.org',
    osvEcosystem: 'NuGet',
    name: pkgName,
    version: versionMatch ? versionMatch[1] : '0.0.0',
    manifest: relManifest
  });

  const pkgRefRegex = /<PackageReference\b([^>]*)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let match;
  while ((match = pkgRefRegex.exec(content)) !== null) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const includeMatch = attrs.match(/\bInclude\s*=\s*["']([^"']+)["']/i);
    if (!includeMatch) continue;
    const verAttrMatch =
      attrs.match(/\bVersion\s*=\s*["']([^"']+)["']/i) ||
      inner.match(/<Version>\s*([^<\s]+)\s*<\/Version>/i);
    const versionSpec = verAttrMatch ? verAttrMatch[1] : '*';
    const isPrivateAssetsAll = /\bPrivateAssets\s*=\s*["']all["']/i.test(attrs) || /<PrivateAssets>\s*all\s*<\/PrivateAssets>/i.test(inner);

    dependencies.push({
      ecosystem: 'nuget',
      registry: 'nuget.org',
      osvEcosystem: 'NuGet',
      name: includeMatch[1],
      versionSpec,
      resolvedVersion: extractResolvedVersion(versionSpec),
      dev: isPrivateAssetsAll,
      manifest: relManifest
    });
  }

  return { packageInfo, dependencies };
}

function parseGemfile(filePath, repoRoot) {
  const packageInfo = [];
  const dependencies = [];
  const relManifest = toPosixRelative(repoRoot, filePath);

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { packageInfo, dependencies };
  }

  let inDevGroup = false;
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    if (/^group\s+.*(:development|:test)/.test(line)) {
      inDevGroup = true;
      continue;
    }
    if (inDevGroup && line === 'end') {
      inDevGroup = false;
      continue;
    }

    const gemMatch = line.match(/^gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/);
    if (gemMatch) {
      const name = gemMatch[1];
      const versionSpec = gemMatch[2] || '*';
      dependencies.push({
        ecosystem: 'rubygems',
        registry: 'rubygems.org',
        osvEcosystem: 'RubyGems',
        name,
        versionSpec,
        resolvedVersion: extractResolvedVersion(versionSpec),
        dev: inDevGroup,
        manifest: relManifest
      });
    }
  }

  return { packageInfo, dependencies };
}

function parseWorkflowActions(filePath, repoRoot) {
  const githubActions = [];
  const relWorkflow = toPosixRelative(repoRoot, filePath);

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return githubActions;
  }

  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(?:-\s*)?uses\s*:\s*([^\s#]+)/);
    if (!match) continue;

    const rawUses = match[1].replace(/^['"]|['"]$/g, '');
    if (rawUses.startsWith('./') || rawUses.startsWith('.\\') || rawUses.startsWith('docker://')) {
      continue;
    }

    const atIdx = rawUses.lastIndexOf('@');
    if (atIdx <= 0) continue;

    const action = rawUses.slice(0, atIdx);
    const ref = rawUses.slice(atIdx + 1);
    const isPinnedSha = /^[0-9a-f]{40}$/i.test(ref);

    githubActions.push({
      workflow: relWorkflow,
      action,
      ref,
      isPinnedSha
    });
  }

  return githubActions;
}

/**
 * Scans repoRoot for ecosystem manifests and GitHub Actions workflows.
 */
export function detectManifestsAndDeps(repoRoot = process.cwd()) {
  const packageInfo = [];
  const dependencies = [];
  const githubActions = [];

  const manifestFiles = findFiles(repoRoot, (name) => {
    return (
      name === 'package.json' ||
      name === 'requirements.txt' ||
      name === 'pyproject.toml' ||
      name === 'Cargo.toml' ||
      name === 'go.mod' ||
      name === 'Gemfile' ||
      name.endsWith('.csproj')
    );
  });

  for (const filePath of manifestFiles) {
    const base = path.basename(filePath);
    let parsed = { packageInfo: [], dependencies: [] };

    if (base === 'package.json') {
      parsed = parseNpmManifest(filePath, repoRoot);
    } else if (base === 'requirements.txt') {
      parsed = parseRequirementsTxt(filePath, repoRoot);
    } else if (base === 'pyproject.toml') {
      parsed = parsePyprojectToml(filePath, repoRoot);
    } else if (base === 'Cargo.toml') {
      parsed = parseCargoToml(filePath, repoRoot);
    } else if (base === 'go.mod') {
      parsed = parseGoMod(filePath, repoRoot);
    } else if (base.endsWith('.csproj')) {
      parsed = parseCsproj(filePath, repoRoot);
    } else if (base === 'Gemfile') {
      parsed = parseGemfile(filePath, repoRoot);
    }

    packageInfo.push(...parsed.packageInfo);
    dependencies.push(...parsed.dependencies);
  }

  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  if (fs.existsSync(workflowsDir)) {
    const workflowFiles = findFiles(
      workflowsDir,
      (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
      1
    );
    for (const wfPath of workflowFiles) {
      githubActions.push(...parseWorkflowActions(wfPath, repoRoot));
    }
  }

  const actionsDir = path.join(repoRoot, '.github', 'actions');
  if (fs.existsSync(actionsDir)) {
    const actionFiles = findFiles(
      actionsDir,
      (name) => name === 'action.yml' || name === 'action.yaml',
      3
    );
    for (const actPath of actionFiles) {
      githubActions.push(...parseWorkflowActions(actPath, repoRoot));
    }
  }

  return {
    packageInfo,
    dependencies,
    githubActions
  };
}

function extractFixedVersionFromVuln(vuln) {
  if (!vuln || typeof vuln !== 'object') return { explicit: false, fixedVersion: null };

  if (
    vuln.fixed === null ||
    vuln.fixed === false ||
    vuln.fixedVersion === null ||
    vuln.fixed_version === null ||
    vuln.unfixed === true ||
    vuln.patched === false ||
    vuln.has_patch === false
  ) {
    return { explicit: true, fixedVersion: null };
  }

  const direct =
    vuln.fixedVersion ||
    vuln.fixed_version ||
    vuln.fixed ||
    (Array.isArray(vuln.patched_versions) ? vuln.patched_versions[0] : vuln.patched_versions);

  if (typeof direct === 'string' && direct.trim() !== '') {
    return { explicit: true, fixedVersion: direct.trim() };
  }

  if (Array.isArray(vuln.affected)) {
    for (const aff of vuln.affected) {
      if (Array.isArray(aff?.ranges)) {
        for (const range of aff.ranges) {
          if (Array.isArray(range?.events)) {
            for (const ev of range.events) {
              if (typeof ev?.fixed === 'string' && ev.fixed.trim() !== '') {
                return { explicit: true, fixedVersion: ev.fixed.trim() };
              }
            }
          }
        }
      }
      const dbFixed =
        aff?.database_specific?.fixed_versions?.[0] ||
        aff?.ecosystem_specific?.fixed_versions?.[0];
      if (typeof dbFixed === 'string' && dbFixed.trim() !== '') {
        return { explicit: true, fixedVersion: dbFixed.trim() };
      }
    }
    return { explicit: true, fixedVersion: null };
  }

  return { explicit: false, fixedVersion: null };
}

/**
 * Evaluates maintenance and security health of a dependency against ecosyste.ms and OSV.dev data.
 */
export function evaluateDependencyHealth(
  dep,
  ecosysteMsData = {},
  osvVulns = [],
  policy = {},
  now = Date.now()
) {
  const eco = ecosysteMsData && typeof ecosysteMsData === 'object' ? ecosysteMsData : {};
  const vulns = Array.isArray(osvVulns) ? osvVulns : [];

  const staleReleaseMonths = Number(policy?.stale_release_months ?? 24);
  const minMaintainers = Number(policy?.min_maintainers ?? 1);
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();

  const latestVersion = eco.latest_release_number || dep?.resolvedVersion || null;
  const lastReleaseAt = eco.latest_release_published_at || null;
  const maintainersCount =
    typeof eco.maintainers_count === 'number'
      ? eco.maintainers_count
      : Array.isArray(eco.maintainers)
        ? eco.maintainers.length
        : null;

  const deprecated = Boolean(
    eco.status === 'deprecated' || eco.deprecated === true
  );
  const archived = Boolean(
    eco.repository_metadata?.archived === true ||
      eco.status === 'archived' ||
      eco.archived === true
  );

  let stale = false;
  if (lastReleaseAt) {
    const releaseMs = new Date(lastReleaseAt).getTime();
    if (!Number.isNaN(releaseMs) && !Number.isNaN(nowMs)) {
      const ageMonths = (nowMs - releaseMs) / (1000 * 60 * 60 * 24 * 30.4375);
      stale = ageMonths > staleReleaseMonths;
    }
  }

  const bus_factor_risk =
    maintainersCount !== null && maintainersCount <= minMaintainers;

  let unresponsive = false;
  const issueMeta = eco.issue_metadata || eco.repository_metadata?.issue_metadata || null;
  if (issueMeta && typeof issueMeta === 'object') {
    const openIssues = Number(
      issueMeta.open_issues_count ?? issueMeta.open_issues ?? issueMeta.open ?? 0
    );
    if (openIssues > 100) {
      if (typeof issueMeta.response_rate === 'number') {
        const rate = issueMeta.response_rate > 1 ? issueMeta.response_rate / 100 : issueMeta.response_rate;
        unresponsive = rate < 0.25;
      } else if (typeof issueMeta.closed_issues_count === 'number') {
        const total = openIssues + issueMeta.closed_issues_count;
        unresponsive = total > 0 && issueMeta.closed_issues_count / total < 0.25;
      } else {
        unresponsive = true;
      }
    }
  }

  const vulnerable = vulns.length > 0;
  const bumpType = classifyVersionBump(dep?.resolvedVersion, eco.latest_release_number);
  const outdated = Boolean(bumpType !== null);

  const cves = vulns.map((v) => {
    if (typeof v === 'string') {
      return { id: v, fixedVersion: outdated ? latestVersion : null };
    }
    const { explicit, fixedVersion } = extractFixedVersionFromVuln(v);
    const resolvedFixed = explicit ? fixedVersion : outdated ? latestVersion : null;
    return {
      ...v,
      id: v.id || v.cve || (Array.isArray(v.aliases) ? v.aliases[0] : 'UNKNOWN'),
      fixedVersion: resolvedFixed
    };
  });

  const hasPatchedVersion =
    vulnerable && cves.every((c) => Boolean(c.fixedVersion));

  const flags = {
    deprecated,
    archived,
    stale,
    bus_factor_risk,
    unresponsive,
    vulnerable,
    outdated
  };

  let recommendedAction = 'healthy';
  if (deprecated || archived || (vulnerable && (!hasPatchedVersion || stale))) {
    recommendedAction = 'migrate';
  } else if (vulnerable && hasPatchedVersion) {
    recommendedAction = 'security-bump';
  } else if (outdated && (bumpType === 'patch' || bumpType === 'minor')) {
    recommendedAction = 'bump-minor-or-patch';
  } else if (outdated && bumpType === 'major') {
    recommendedAction = 'evaluate-major-bump';
  }

  const status = eco.status || (archived ? 'archived' : deprecated ? 'deprecated' : 'active');

  return {
    ...dep,
    latestVersion,
    lastReleaseAt,
    maintainersCount,
    status,
    flags,
    cves,
    bumpType,
    recommendedAction
  };
}

function getCachedEntry(state, key, nowMs = Date.now()) {
  const entry = state?.ecosystem_cache?.[key];
  if (!entry || !entry.fetchedAt || !entry.data) return null;
  const age = nowMs - new Date(entry.fetchedAt).getTime();
  if (Number.isNaN(age) || age > CACHE_TTL_MS) return null;
  return entry.data;
}

function setCachedEntry(state, key, data, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') return;
  if (!state.ecosystem_cache || typeof state.ecosystem_cache !== 'object') {
    state.ecosystem_cache = {};
  }
  state.ecosystem_cache[key] = {
    fetchedAt: new Date(nowMs).toISOString(),
    data
  };
}

async function safeFetchJson(fetchImpl, url, options = {}) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
      ...options
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchSinglePackageDependents(pkg, { fetchImpl = globalThis.fetch, state } = {}) {
  const fallback = { dependentPackagesCount: 0, downloads: 0, topDependents: [] };
  if (!pkg || !pkg.registry || !pkg.name) return fallback;

  const cacheKey = `dependents:${pkg.registry}:${pkg.name}`;
  const cached = getCachedEntry(state, cacheKey);
  if (cached) return cached;

  if (typeof fetchImpl !== 'function') {
    return state?.ecosystem_cache?.[cacheKey]?.data || fallback;
  }

  const baseUrl = `https://packages.ecosyste.ms/api/v1/registries/${pkg.registry}/packages/${encodeURIComponent(pkg.name)}`;
  const pkgData = await safeFetchJson(fetchImpl, baseUrl);
  const depListData = await safeFetchJson(fetchImpl, `${baseUrl}/dependent_packages?per_page=20`);

  if (!pkgData && !depListData) {
    return state?.ecosystem_cache?.[cacheKey]?.data || fallback;
  }

  const topDependents = Array.isArray(depListData)
    ? depListData.slice(0, 20).map((d) => ({
        name: d.name || '',
        downloads: Number(d.downloads ?? 0),
        latest_release_number: d.latest_release_number || null
      }))
    : [];

  const dependentPackagesCount = Number(
    pkgData?.dependent_packages_count ??
      pkgData?.dependents_count ??
      topDependents.length
  );
  const downloads = Number(pkgData?.downloads ?? 0);

  const result = {
    dependentPackagesCount,
    downloads,
    topDependents
  };

  setCachedEntry(state, cacheKey, result);
  return result;
}

/**
 * Queries packages.ecosyste.ms for downstream dependent packages and download counts.
 * Supports either a single packageInfo object or an array of packageInfo objects.
 */
export async function fetchDownstreamDependents(
  packageInfo,
  { fetchImpl = globalThis.fetch, state } = {}
) {
  const fallback = { dependentPackagesCount: 0, downloads: 0, topDependents: [] };
  if (!packageInfo) return fallback;

  if (Array.isArray(packageInfo)) {
    if (packageInfo.length === 0) return fallback;
    if (packageInfo.length === 1) {
      return fetchSinglePackageDependents(packageInfo[0], { fetchImpl, state });
    }

    let totalDependents = 0;
    let totalDownloads = 0;
    const allTop = [];

    for (const pkg of packageInfo) {
      const res = await fetchSinglePackageDependents(pkg, { fetchImpl, state });
      totalDependents += res.dependentPackagesCount;
      totalDownloads += res.downloads;
      allTop.push(...res.topDependents);
    }

    allTop.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    return {
      dependentPackagesCount: totalDependents,
      downloads: totalDownloads,
      topDependents: allTop.slice(0, 20)
    };
  }

  return fetchSinglePackageDependents(packageInfo, { fetchImpl, state });
}

async function fetchUpstreamPackageMetadata(dep, { fetchImpl, state, offline }) {
  if (!dep?.registry || !dep?.name) return {};
  const cacheKey = `pkg:${dep.registry}:${dep.name}`;
  const cached = getCachedEntry(state, cacheKey);
  if (cached) return cached;
  if (offline || typeof fetchImpl !== 'function') {
    return state?.ecosystem_cache?.[cacheKey]?.data || {};
  }

  const url = `https://packages.ecosyste.ms/api/v1/registries/${dep.registry}/packages/${encodeURIComponent(dep.name)}`;
  const data = await safeFetchJson(fetchImpl, url);
  if (data && typeof data === 'object') {
    setCachedEntry(state, cacheKey, data);
    return data;
  }
  return state?.ecosystem_cache?.[cacheKey]?.data || {};
}

async function fetchOsvVulnerabilities(dependencies, { fetchImpl, offline }) {
  const vulnsByIndex = dependencies.map(() => []);
  if (offline || typeof fetchImpl !== 'function' || dependencies.length === 0) {
    return vulnsByIndex;
  }

  const queryableIndices = [];
  const queries = [];

  dependencies.forEach((dep, idx) => {
    if (dep.name && dep.osvEcosystem && dep.resolvedVersion) {
      queryableIndices.push(idx);
      queries.push({
        package: {
          name: dep.name,
          ecosystem: dep.osvEcosystem
        },
        version: dep.resolvedVersion
      });
    }
  });

  if (queries.length === 0) return vulnsByIndex;

  const batchData = await safeFetchJson(fetchImpl, 'https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries })
  });

  if (batchData && Array.isArray(batchData.results)) {
    batchData.results.forEach((res, qIdx) => {
      const depIdx = queryableIndices[qIdx];
      if (depIdx !== undefined && Array.isArray(res?.vulns)) {
        vulnsByIndex[depIdx] = res.vulns;
      }
    });
    return vulnsByIndex;
  }

  for (let i = 0; i < queries.length; i++) {
    const depIdx = queryableIndices[i];
    const singleData = await safeFetchJson(fetchImpl, 'https://api.osv.dev/v1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queries[i])
    });
    if (singleData && Array.isArray(singleData.vulns)) {
      vulnsByIndex[depIdx] = singleData.vulns;
    }
  }

  return vulnsByIndex;
}

/**
 * Performs complete on-demand discovery of repository manifests, downstream dependents,
 * upstream dependency health, and OSV vulnerabilities.
 */
export async function scanRepositoryDependencies({
  repoRoot = process.cwd(),
  config,
  state,
  fetchImpl = globalThis.fetch,
  offline = false
} = {}) {
  const resolvedConfig = config || loadConfig({ repoRoot });
  const policy =
    resolvedConfig?.policies?.dependency_health ||
    resolvedConfig?.dependencies ||
    resolvedConfig?.dependency_policy ||
    {};

  const { packageInfo, dependencies: rawDeps, githubActions } = detectManifestsAndDeps(repoRoot);

  const downstreamDependents = offline
    ? { dependentPackagesCount: 0, downloads: 0, topDependents: [] }
    : await fetchDownstreamDependents(packageInfo, { fetchImpl, state });

  const osvResults = await fetchOsvVulnerabilities(rawDeps, { fetchImpl, offline });

  const evaluatedDeps = [];
  for (let i = 0; i < rawDeps.length; i++) {
    const dep = rawDeps[i];
    const ecoData = await fetchUpstreamPackageMetadata(dep, { fetchImpl, state, offline });
    const vulns = osvResults[i] || [];
    evaluatedDeps.push(evaluateDependencyHealth(dep, ecoData, vulns, policy));
  }

  const summary = {
    total: evaluatedDeps.length,
    vulnerable: evaluatedDeps.filter((d) => d.flags.vulnerable).length,
    needsMigration: evaluatedDeps.filter((d) => d.recommendedAction === 'migrate').length,
    outdatedPatchMinor: evaluatedDeps.filter(
      (d) => d.flags.outdated && (d.bumpType === 'patch' || d.bumpType === 'minor')
    ).length,
    outdatedMajor: evaluatedDeps.filter((d) => d.flags.outdated && d.bumpType === 'major').length,
    unpinnedActions: githubActions.filter((a) => !a.isPinnedSha).length
  };

  return {
    scannedAt: new Date().toISOString(),
    packages: packageInfo,
    downstreamDependents,
    dependencies: evaluatedDeps,
    githubActions,
    summary
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let offline = false;
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo-root' && args[i + 1]) {
      repoRoot = path.resolve(args[++i]);
    } else if (args[i] === '--offline') {
      offline = true;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = path.resolve(args[++i]);
    }
  }

  const config = loadConfig({ repoRoot });
  const state = loadState();
  const report = await scanRepositoryDependencies({ repoRoot, config, state, offline });

  try {
    saveState(state);
  } catch {
    // Ignore state persistence failure in read-only environments
  }

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json + '\n', 'utf8');
  }

  console.log(json);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
