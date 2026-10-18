#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, sanitizeGitHubOutputValue } from './load-config.mjs';

const __filename = fileURLToPath(import.meta.url);

const SEMVER_REGEX = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Compare two SemVer strings (a, b). Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a, b) {
  const ma = String(a || '').trim().match(SEMVER_REGEX);
  const mb = String(b || '').trim().match(SEMVER_REGEX);
  if (!ma && !mb) return 0;
  if (!ma) return -1;
  if (!mb) return 1;

  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na !== nb) return na > nb ? 1 : -1;
  }

  // Pre-release has lower precedence than normal version
  const preA = ma[4] || '';
  const preB = mb[4] || '';
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB);
}

/**
 * Find the highest stable SemVer tag from a list of git tags.
 */
export function parseLatestSemverTag(tags = []) {
  if (!Array.isArray(tags)) return null;
  const valid = [];
  for (const raw of tags) {
    const tag = String(raw || '').trim();
    const match = tag.match(SEMVER_REGEX);
    if (match && !match[4]) {
      valid.push({
        tag,
        version: `${match[1]}.${match[2]}.${match[3]}`
      });
    }
  }
  if (valid.length === 0) return null;
  valid.sort((a, b) => compareSemver(b.version, a.version));
  return valid[0];
}

/**
 * Increment a SemVer version string by patch or minor.
 * Blocks autonomous major bumps unless allowMajor is explicitly true.
 */
export function bumpVersionString(currentVersion, bumpType = 'patch', { allowMajor = false } = {}) {
  const match = String(currentVersion || '0.1.0').trim().match(SEMVER_REGEX);
  if (!match) {
    throw new Error(`Invalid SemVer string: "${currentVersion}"`);
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  const normalizedBump = String(bumpType || 'patch').toLowerCase();
  if (normalizedBump === 'major') {
    if (!allowMajor) {
      throw new Error('Autonomous major version bumps are blocked by safety policy; cap at minor or patch.');
    }
    major += 1;
    minor = 0;
    patch = 0;
  } else if (normalizedBump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (normalizedBump === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unsupported bump type: "${bumpType}"`);
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Analyze commit messages since the last release tag to determine if a release is warranted
 * and whether to bump patch or minor (capped at maxAutoBump).
 */
export function analyzeCommitsForRelease(
  commits = [],
  { maxAutoBump = 'minor', minCommits = 1, immediateOnSecurity = true } = {}
) {
  const normalizedCap = String(maxAutoBump || 'minor').toLowerCase() === 'patch' ? 'patch' : 'minor';
  const categorized = {
    security: [],
    features: [],
    fixes: [],
    dependencies: [],
    other: []
  };

  let hasBreakingChange = false;
  let hasFeature = false;
  let hasFixOrDep = false;
  let hasSecurityFix = false;
  const releasableCommits = [];

  for (const item of commits) {
    const rawSubject = typeof item === 'string' ? item : String(item?.subject || item?.message || '');
    const rawBody = typeof item === 'object' && item?.body ? String(item.body) : '';
    const fullText = `${rawSubject}\n${rawBody}`.trim();
    const firstLine = rawSubject.split(/\r?\n/)[0].trim();

    if (!firstLine) continue;

    // Ignore prior automated release commits or pure CI/test/doc commits
    if (/^chore\(release\):/i.test(firstLine) || /^release:/i.test(firstLine)) {
      continue;
    }

    if (
      /BREAKING[ -]CHANGE:/i.test(fullText) ||
      /^[a-z]+(\([^)]+\))?!:/i.test(firstLine)
    ) {
      hasBreakingChange = true;
    }

    if (
      /^(fix|chore|sec|security)\((security|sec|cve|vuln)\):/i.test(firstLine) ||
      /\b(CVE-\d{4}-\d+|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|security\s+vulnerability|security\s+fix)\b/i.test(fullText)
    ) {
      hasSecurityFix = true;
      hasFixOrDep = true;
      categorized.security.push(firstLine);
      releasableCommits.push(firstLine);
      continue;
    }

    if (/^feat(\([^)]+\))?!?:/i.test(firstLine) || /^feature(\([^)]+\))?!?:/i.test(firstLine)) {
      hasFeature = true;
      categorized.features.push(firstLine);
      releasableCommits.push(firstLine);
      continue;
    }

    if (/^(fix|perf|bugfix|hotfix)(\([^)]+\))?!?:/i.test(firstLine)) {
      hasFixOrDep = true;
      categorized.fixes.push(firstLine);
      releasableCommits.push(firstLine);
      continue;
    }

    if (
      /^(chore|build)\((deps|dependencies)\):/i.test(firstLine) ||
      /^deps(\([^)]+\))?:/i.test(firstLine)
    ) {
      hasFixOrDep = true;
      categorized.dependencies.push(firstLine);
      releasableCommits.push(firstLine);
      continue;
    }

    // Ignore non-releasable doc/ci/test/style chores
    if (/^(docs|ci|test|tests|style|chore)(\([^)]+\))?:/i.test(firstLine)) {
      continue;
    }

    // Default other code commits to releasable patch
    hasFixOrDep = true;
    categorized.other.push(firstLine);
    releasableCommits.push(firstLine);
  }

  let rawBump = null;
  if (hasFeature || hasBreakingChange) {
    rawBump = 'minor';
  } else if (hasFixOrDep || hasSecurityFix) {
    rawBump = 'patch';
  }

  const blockedMajor = hasBreakingChange;
  let bumpType = rawBump;
  if (bumpType === 'minor' && normalizedCap === 'patch') {
    bumpType = 'patch';
  }

  const meetsThreshold =
    releasableCommits.length >= Math.max(1, Number(minCommits) || 1) ||
    (immediateOnSecurity && hasSecurityFix);

  const shouldRelease = Boolean(bumpType) && meetsThreshold;

  return {
    shouldRelease,
    bumpType: shouldRelease ? bumpType : null,
    recommendedBump: rawBump,
    hasBreakingChange,
    blockedMajor,
    hasSecurityFix,
    releasableCommits,
    categorized
  };
}

/**
 * Read the current version from the primary project manifest in repoRoot.
 */
export function readCurrentManifestVersion(repoRoot = process.cwd()) {
  const absRoot = path.resolve(repoRoot);

  // 1. package.json
  const pkgPath = path.join(absRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version && SEMVER_REGEX.test(pkg.version)) {
        return String(pkg.version).replace(/^v/, '');
      }
    } catch {}
  }

  // 2. pyproject.toml
  const pyprojectPath = path.join(absRoot, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const content = fs.readFileSync(pyprojectPath, 'utf8');
    const sectionMatch = content.match(/\[(?:project|tool\.poetry)\][\s\S]*?(?=\r?\n\[|$)/);
    const targetBlock = sectionMatch ? sectionMatch[0] : content;
    const m = targetBlock.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
    if (m && SEMVER_REGEX.test(m[1])) return m[1].replace(/^v/, '');
  }

  // 3. Cargo.toml
  const cargoPath = path.join(absRoot, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    const content = fs.readFileSync(cargoPath, 'utf8');
    const sectionMatch = content.match(/\[package\][\s\S]*?(?=\r?\n\[|$)/);
    const targetBlock = sectionMatch ? sectionMatch[0] : content;
    const m = targetBlock.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
    if (m && SEMVER_REGEX.test(m[1])) return m[1].replace(/^v/, '');
  }

  // 4. *.csproj or *.gemspec in root
  try {
    const entries = fs.readdirSync(absRoot);
    for (const entry of entries) {
      if (entry.endsWith('.csproj')) {
        const content = fs.readFileSync(path.join(absRoot, entry), 'utf8');
        const m = content.match(/<Version>([^<]+)<\/Version>/i);
        if (m && SEMVER_REGEX.test(m[1].trim())) return m[1].trim().replace(/^v/, '');
      }
      if (entry.endsWith('.gemspec')) {
        const content = fs.readFileSync(path.join(absRoot, entry), 'utf8');
        const m = content.match(/\.version\s*=\s*["']([^"']+)["']/);
        if (m && SEMVER_REGEX.test(m[1].trim())) return m[1].trim().replace(/^v/, '');
      }
    }
  } catch {}

  return '0.1.0';
}

/**
 * Update version fields across detected ecosystem manifests in repoRoot.
 */
export function updateManifestVersions(repoRoot = process.cwd(), newVersion) {
  const absRoot = path.resolve(repoRoot);
  const cleanVersion = String(newVersion || '').trim().replace(/^v/, '');
  if (!SEMVER_REGEX.test(cleanVersion)) {
    throw new Error(`Refusing to write invalid SemVer version "${newVersion}" to manifests`);
  }

  const updatedFiles = [];

  // 1. package.json & package-lock.json
  const pkgPath = path.join(absRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.version = cleanVersion;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      updatedFiles.push('package.json');
    } catch {}
  }

  const pkgLockPath = path.join(absRoot, 'package-lock.json');
  if (fs.existsSync(pkgLockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(pkgLockPath, 'utf8'));
      lock.version = cleanVersion;
      if (lock.packages && lock.packages[''] && typeof lock.packages[''] === 'object') {
        lock.packages[''].version = cleanVersion;
      }
      fs.writeFileSync(pkgLockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
      updatedFiles.push('package-lock.json');
    } catch {}
  }

  // 2. pyproject.toml
  const pyprojectPath = path.join(absRoot, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const content = fs.readFileSync(pyprojectPath, 'utf8');
    let updated = content.replace(
      /(\[(?:project|tool\.poetry)\][\s\S]*?^\s*version\s*=\s*["'])([^"']+)(["'])/m,
      `$1${cleanVersion}$3`
    );
    if (updated === content) {
      updated = content.replace(
        /(^\s*version\s*=\s*["'])([^"']+)(["'])/m,
        `$1${cleanVersion}$3`
      );
    }
    if (updated !== content) {
      fs.writeFileSync(pyprojectPath, updated, 'utf8');
      updatedFiles.push('pyproject.toml');
    }
  }

  // 3. Cargo.toml
  const cargoPath = path.join(absRoot, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    const content = fs.readFileSync(cargoPath, 'utf8');
    let updated = content.replace(
      /(\[package\][\s\S]*?^\s*version\s*=\s*["'])([^"']+)(["'])/m,
      `$1${cleanVersion}$3`
    );
    if (updated === content) {
      updated = content.replace(
        /(^\s*version\s*=\s*["'])([^"']+)(["'])/m,
        `$1${cleanVersion}$3`
      );
    }
    if (updated !== content) {
      fs.writeFileSync(cargoPath, updated, 'utf8');
      updatedFiles.push('Cargo.toml');
    }
  }

  // 4. *.csproj and *.gemspec
  try {
    const entries = fs.readdirSync(absRoot);
    for (const entry of entries) {
      if (entry.endsWith('.csproj')) {
        const fullPath = path.join(absRoot, entry);
        const content = fs.readFileSync(fullPath, 'utf8');
        const updated = content.replace(
          /(<Version>)([^<]+)(<\/Version>)/i,
          `$1${cleanVersion}$3`
        );
        if (updated !== content) {
          fs.writeFileSync(fullPath, updated, 'utf8');
          updatedFiles.push(entry);
        }
      } else if (entry.endsWith('.gemspec')) {
        const fullPath = path.join(absRoot, entry);
        const content = fs.readFileSync(fullPath, 'utf8');
        const updated = content.replace(
          /(\.version\s*=\s*["'])([^"']+)(["'])/,
          `$1${cleanVersion}$3`
        );
        if (updated !== content) {
          fs.writeFileSync(fullPath, updated, 'utf8');
          updatedFiles.push(entry);
        }
      }
    }
  } catch {}

  return updatedFiles;
}

/**
 * Format a Markdown changelog section for a new version.
 */
export function generateChangelogEntry(
  newVersion,
  categorized,
  dateStr = new Date().toISOString().slice(0, 10)
) {
  const cleanVersion = String(newVersion || '').replace(/^v/, '');
  const lines = [`## [${cleanVersion}] - ${dateStr}`, ''];

  const addSection = (heading, items) => {
    if (Array.isArray(items) && items.length > 0) {
      lines.push(`### ${heading}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  };

  addSection('Security', categorized?.security);
  addSection('Added', categorized?.features);
  addSection('Fixed', categorized?.fixes);
  addSection('Dependencies', categorized?.dependencies);
  addSection('Maintenance', categorized?.other);

  return lines.join('\n').trim() + '\n';
}

/**
 * Prepend or create CHANGELOG.md in repoRoot with the new version section.
 */
export function updateChangelog(
  repoRoot = process.cwd(),
  newVersion,
  categorized,
  dateStr = new Date().toISOString().slice(0, 10)
) {
  const absRoot = path.resolve(repoRoot);
  const changelogPath = path.join(absRoot, 'CHANGELOG.md');
  const entry = generateChangelogEntry(newVersion, categorized, dateStr);

  if (!fs.existsSync(changelogPath)) {
    const content = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n${entry}`;
    fs.writeFileSync(changelogPath, content, 'utf8');
    return { path: 'CHANGELOG.md', entry };
  }

  const existing = fs.readFileSync(changelogPath, 'utf8');
  if (existing.includes(`## [${String(newVersion).replace(/^v/, '')}]`)) {
    return { path: 'CHANGELOG.md', entry };
  }

  const firstReleaseHeaderIdx = existing.search(/^##\s+\[?/m);
  let updated;
  if (firstReleaseHeaderIdx !== -1) {
    updated =
      existing.slice(0, firstReleaseHeaderIdx) +
      entry +
      '\n' +
      existing.slice(firstReleaseHeaderIdx);
  } else {
    updated = `${existing.trimEnd()}\n\n${entry}`;
  }

  fs.writeFileSync(changelogPath, updated, 'utf8');
  return { path: 'CHANGELOG.md', entry };
}

/**
 * High-level release preparation helper: inspects git tags & commits (or provided arrays),
 * computes next version, and optionally updates manifests + CHANGELOG.md.
 */
export function prepareRelease({
  repoRoot = process.cwd(),
  config = null,
  commits = null,
  tags = null,
  dryRun = false,
  dateStr = new Date().toISOString().slice(0, 10)
} = {}) {
  const resolvedConfig = config || loadConfig({ repoRoot });
  const releaseCfg = resolvedConfig?.release || {};

  if (releaseCfg.enabled === false) {
    return { shouldRelease: false, reason: 'release-disabled' };
  }

  // Discover tags from git if not supplied
  let tagList = tags;
  if (!Array.isArray(tagList)) {
    try {
      const rawTags = execFileSync('git', ['tag', '--list'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      tagList = rawTags.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      tagList = [];
    }
  }

  const latestTagObj = parseLatestSemverTag(tagList);
  const manifestVersion = readCurrentManifestVersion(repoRoot);
  const currentVersion =
    latestTagObj && compareSemver(latestTagObj.version, manifestVersion) > 0
      ? latestTagObj.version
      : manifestVersion;

  // Discover commits since latestTag if not supplied
  let commitList = commits;
  if (!Array.isArray(commitList)) {
    try {
      const range = latestTagObj ? `${latestTagObj.tag}..HEAD` : 'HEAD';
      const rawLog = execFileSync('git', ['log', range, '--no-merges', '--pretty=format:%s'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      commitList = rawLog.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      commitList = [];
    }
  }

  const analysis = analyzeCommitsForRelease(commitList, {
    maxAutoBump: releaseCfg.max_auto_bump || 'minor',
    minCommits: releaseCfg.min_commits_for_release ?? 1,
    immediateOnSecurity: releaseCfg.immediate_on_security !== false
  });

  if (!analysis.shouldRelease || !analysis.bumpType) {
    return {
      shouldRelease: false,
      reason: 'no-releasable-commits',
      currentVersion,
      latestTag: latestTagObj?.tag || null,
      analysis
    };
  }

  const newVersion = bumpVersionString(currentVersion, analysis.bumpType, { allowMajor: false });
  const newTag = `v${newVersion}`;
  const branchName = `lights-on/release-${newTag}`;
  const prTitle = `chore(release): ${newTag}`;
  const changelogEntry = generateChangelogEntry(newVersion, analysis.categorized, dateStr);

  const releaseMeta = {
    version: newVersion,
    previous_version: currentVersion,
    tag: newTag,
    bump: analysis.bumpType,
    has_security_fix: analysis.hasSecurityFix,
    blocked_major: analysis.blockedMajor
  };

  const prBodyLines = [
    `## Automated Release ${newTag}`,
    '',
    `This automated release PR bumps the package version from \`${currentVersion}\` to \`${newVersion}\` (\`${analysis.bumpType}\` bump) based on ${analysis.releasableCommits.length} merged commit(s).`,
    ''
  ];

  if (analysis.blockedMajor) {
    prBodyLines.push(
      '> **Note**: One or more commits contained breaking-change markers, which were capped at a `' +
        analysis.bumpType +
        '` bump per `release.max_auto_bump` safety policy. Review carefully before merging.',
      ''
    );
  }

  prBodyLines.push(
    '### Release Notes',
    '',
    changelogEntry.trim(),
    '',
    `<!-- lights-on-release: ${JSON.stringify(releaseMeta)} -->`,
    `<!-- lights-on-state: ${JSON.stringify({ action_taken: 'release_pr', version: newVersion, automated: true })} -->`
  );

  const updatedFiles = [];
  if (!dryRun) {
    const manifestFiles = updateManifestVersions(repoRoot, newVersion);
    updatedFiles.push(...manifestFiles);
    const cl = updateChangelog(repoRoot, newVersion, analysis.categorized, dateStr);
    updatedFiles.push(cl.path);
  }

  return {
    shouldRelease: true,
    currentVersion,
    newVersion,
    newTag,
    bumpType: analysis.bumpType,
    branchName,
    prTitle,
    prBody: prBodyLines.join('\n'),
    changelogEntry,
    updatedFiles,
    analysis
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const writeGithubOutput = args.includes('--github-output');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;

  const res = prepareRelease({ repoRoot: process.cwd(), dryRun });
  if (outputPath) {
    fs.writeFileSync(path.resolve(outputPath), JSON.stringify(res, null, 2) + '\n', 'utf8');
  }
  if (writeGithubOutput && process.env.GITHUB_OUTPUT) {
    const lines = [
      `should_release=${res.shouldRelease ? 'true' : 'false'}`,
      `new_version=${sanitizeGitHubOutputValue(res.newVersion || '')}`,
      `new_tag=${sanitizeGitHubOutputValue(res.newTag || '')}`,
      `bump_type=${sanitizeGitHubOutputValue(res.bumpType || '')}`,
      `branch_name=${sanitizeGitHubOutputValue(res.branchName || '')}`,
      `pr_title=${sanitizeGitHubOutputValue(res.prTitle || '')}`
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
  }
  console.log(JSON.stringify(res, null, 2));
}
