#!/usr/bin/env node
/**
 * Lights On — alpha-omega-security/threat-model Integration
 *
 * Checks numbered section presence, not the truth of security claims.
 * Skill installation can populate a cache without changing the repository.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const THREAT_MODEL_REPO_URL = 'https://github.com/alpha-omega-security/threat-model';
export const SAFE_HTTPS_REPO_URL_REGEX = /^https:\/\/[A-Za-z0-9._/-]+$/;

export const THREAT_MODEL_SKILL_NAMES = [
  'threat-model',
  'threat-model-recon',
  'threat-model-surface',
  'threat-model-authoring',
  'threat-model-triage',
  'threat-model-interview',
  'threat-model-sidecar',
  'threat-model-backtest'
];

/**
 * Canonical §1.1 through §1.19 headings from alpha-omega-security/threat-model.
 */
export const THREAT_MODEL_REQUIRED_SECTIONS = [
  '## 1.1 Header',
  '## 1.2 Scope and intended use',
  '## 1.3 Out of scope',
  '## 1.4 Trust boundaries',
  '## 1.5 No-surprise side effects',
  '## 1.6 Adversary model',
  '## 1.7 Input assumptions',
  '## 1.8 Output guarantees',
  '## 1.9 Dependency assumptions',
  '## 1.10 Configuration and deployment assumptions',
  '## 1.11 Security properties',
  '## 1.12 Disclaimed properties',
  '## 1.13 Known misuses',
  '## 1.14 Design trade-offs',
  '## 1.15 Known non-findings',
  '## 1.16 Model-change conditions',
  '## 1.17 Triage dispositions',
  '## 1.18 Open questions',
  '## 1.19 Machine-readable sidecar'
];

const SECTION_KEY_BY_NUMBER = {
  '1.1': 'header',
  '1.2': 'scopeAndIntendedUse',
  '1.3': 'outOfScope',
  '1.4': 'trustBoundaries',
  '1.5': 'noSurpriseSideEffects',
  '1.6': 'adversaryModel',
  '1.7': 'inputAssumptions',
  '1.8': 'outputGuarantees',
  '1.9': 'dependencyAssumptions',
  '1.10': 'configurationAssumptions',
  '1.11': 'guaranteedSecurityProperties',
  '1.12': 'disclaimedProperties',
  '1.13': 'knownMisuses',
  '1.14': 'designTradeOffs',
  '1.15': 'knownNonFindings',
  '1.16': 'modelChangeConditions',
  '1.17': 'triageDispositions',
  '1.18': 'openQuestions',
  '1.19': 'machineReadableSidecar'
};

/**
 * Locate THREAT_MODEL.md (or threat-model.md) in the repository.
 */
function findThreatModelPath(repoRoot = process.cwd(), threatModelRelPath = 'THREAT_MODEL.md') {
  const absRoot = path.resolve(repoRoot);
  const candidates = [
    threatModelRelPath,
    'THREAT_MODEL.md',
    'threat-model.md',
    'docs/THREAT_MODEL.md',
    'docs/threat-model.md',
    '.github/THREAT_MODEL.md'
  ];

  for (const rel of candidates) {
    if (!rel) continue;
    const candidatePath = path.resolve(absRoot, rel);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  return path.resolve(absRoot, threatModelRelPath || 'THREAT_MODEL.md');
}

/**
 * Parse markdown headings for §1.1 through §1.19 and extract section bodies.
 */
function parseSectionsByNumber(markdown) {
  const byNumber = {};
  if (!markdown || typeof markdown !== 'string') {
    return byNumber;
  }

  const headingRegex = /^#{1,4}\s*(?:§\s*)?(1\.(?:1[0-9]|[1-9]))(?!\d)\b[^\r\n]*/gm;
  const matches = [];
  let match;
  while ((match = headingRegex.exec(markdown)) !== null) {
    matches.push({
      sectionNum: match[1],
      headingText: match[0].trim(),
      startIndex: match.index,
      bodyStartIndex: match.index + match[0].length
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].startIndex : markdown.length;
    const body = markdown.slice(current.bodyStartIndex, nextStart).trim();
    if (!(current.sectionNum in byNumber)) {
      byNumber[current.sectionNum] = body;
    }
  }

  return byNumber;
}

/**
 * Count open questions in §1.18 section content.
 */
function countOpenQuestions(openQuestionsText) {
  if (!openQuestionsText || typeof openQuestionsText !== 'string') {
    return 0;
  }
  const trimmed = openQuestionsText.trim();
  if (!trimmed) {
    return 0;
  }

  const normalized = trimmed.toLowerCase();
  if (
    /^(?:none\.?|n\/a\.?|no open questions.*|0 open questions.*)$/i.test(trimmed) ||
    (normalized.includes('no open questions') && !/oq-\d+/i.test(trimmed))
  ) {
    return 0;
  }

  const oqIds = trimmed.match(/\bOQ-\d+\b/gi);
  if (oqIds && oqIds.length > 0) {
    return new Set(oqIds.map((id) => id.toUpperCase())).size;
  }

  const lines = trimmed.split(/\r?\n/);
  let bulletCount = 0;
  let tableDataRows = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[-*+]\s+\[x\]/i.test(line)) continue;
    if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
      const itemBody = line.replace(/^(?:[-*+]|\d+\.)\s+/, '').trim();
      if (!/^(?:none|n\/a|no open questions)\b/i.test(itemBody)) {
        bulletCount++;
      }
    } else if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c));
      const isHeader = cells.some((c) => /^(?:id|question|claim|status|#)$/i.test(c));
      const isNoneRow = cells.every((c) => /^(?:none|n\/a|-|—|"")$/i.test(c));
      if (!isSeparator && !isHeader && !isNoneRow) {
        tableDataRows++;
      }
    }
  }

  return bulletCount > 0 ? bulletCount : tableDataRows;
}

/**
 * Inspect and validate the repository's THREAT_MODEL.md file.
 */
export function inspectThreatModel(repoRoot = process.cwd(), threatModelRelPath = 'THREAT_MODEL.md') {
  const resolvedPath = findThreatModelPath(repoRoot, threatModelRelPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      exists: false,
      path: resolvedPath,
      valid: false,
      missingSections: [...THREAT_MODEL_REQUIRED_SECTIONS],
      sections: {},
      openQuestionsCount: 0,
      raw: ''
    };
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const byNumber = parseSectionsByNumber(raw);

  const missingSections = [];
  for (const requiredHeading of THREAT_MODEL_REQUIRED_SECTIONS) {
    const numMatch = requiredHeading.match(/\b(1\.(?:1[0-9]|[1-9]))(?!\d)\b/);
    const sectionNum = numMatch ? numMatch[1] : null;
    if (!sectionNum || !(sectionNum in byNumber)) {
      missingSections.push(requiredHeading);
    }
  }

  const namedSections = {};
  for (const [secNum, keyName] of Object.entries(SECTION_KEY_BY_NUMBER)) {
    namedSections[keyName] = byNumber[secNum] || '';
  }

  const securityPropertiesParts = [];
  if (byNumber['1.11']) securityPropertiesParts.push(byNumber['1.11']);
  if (byNumber['1.12']) securityPropertiesParts.push(byNumber['1.12']);

  const sections = {
    header: namedSections.header,
    scopeAndIntendedUse: namedSections.scopeAndIntendedUse,
    outOfScope: namedSections.outOfScope,
    trustBoundaries: namedSections.trustBoundaries,
    noSurpriseSideEffects: namedSections.noSurpriseSideEffects,
    adversaryModel: namedSections.adversaryModel,
    inputAssumptions: namedSections.inputAssumptions,
    outputGuarantees: namedSections.outputGuarantees,
    dependencyAssumptions: namedSections.dependencyAssumptions,
    configurationAssumptions: namedSections.configurationAssumptions,
    securityProperties: securityPropertiesParts.join('\n\n'),
    disclaimedProperties: namedSections.disclaimedProperties,
    knownMisuses: namedSections.knownMisuses,
    designTradeOffs: namedSections.designTradeOffs,
    knownNonFindings: namedSections.knownNonFindings,
    modelChangeConditions: namedSections.modelChangeConditions,
    triageDispositions: namedSections.triageDispositions,
    openQuestions: namedSections.openQuestions,
    machineReadableSidecar: namedSections.machineReadableSidecar,
    byNumber
  };

  const openQuestionsCount = countOpenQuestions(sections.openQuestions);

  return {
    exists: true,
    path: resolvedPath,
    valid: missingSections.length === 0,
    missingSections,
    sections,
    openQuestionsCount,
    raw
  };
}

/**
 * Clone `alpha-omega-security/threat-model` (shallow `--depth 1`) into `cacheDir`
 * if not already present, and copy its `skills/threat-model*` directories into
 * `.claude/skills/` and `.github/skills/` in the workspace.
 */
export function ensureThreatModelSkills({
  cacheDir = '/tmp/lights-on-threat-model',
  repoUrl = THREAT_MODEL_REPO_URL,
  repoRoot = process.cwd(),
  installToWorkspace = true,
  execSyncImpl = execSync
} = {}) {
  const absRepoRoot = path.resolve(repoRoot);
  const resolvedCacheDir = path.resolve(cacheDir);
  let cloned = false;

  if (!repoUrl || typeof repoUrl !== 'string' || !SAFE_HTTPS_REPO_URL_REGEX.test(repoUrl.trim())) {
    throw new Error(`Invalid or unsafe threat model repository URL: "${repoUrl}"`);
  }
  if (/["`$;&|<>\\\r\n]/.test(repoUrl) || /["`$;&|<>\r\n]/.test(resolvedCacheDir)) {
    throw new Error('Unsafe characters detected in repoUrl or cacheDir');
  }

  const skillsSourceRoot = path.join(resolvedCacheDir, 'skills');
  if (!fs.existsSync(skillsSourceRoot)) {
    fs.mkdirSync(path.dirname(resolvedCacheDir), { recursive: true });
    if (execSyncImpl === execSync) {
      execFileSync('git', ['clone', '--depth', '1', '--', repoUrl.trim(), resolvedCacheDir], {
        stdio: 'pipe',
        encoding: 'utf8'
      });
    } else {
      execSyncImpl(`git clone --depth 1 "${repoUrl.trim()}" "${resolvedCacheDir}"`, {
        stdio: 'pipe',
        encoding: 'utf8'
      });
    }
    cloned = true;
  }

  const installedSkills = [];
  const claudeSkillsDir = path.join(absRepoRoot, '.claude', 'skills');
  const githubSkillsDir = path.join(absRepoRoot, '.github', 'skills');

  if (fs.existsSync(skillsSourceRoot)) {
    const entries = fs.readdirSync(skillsSourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('threat-model')) {
        continue;
      }
      const srcSkillDir = path.join(skillsSourceRoot, entry.name);
      if (installToWorkspace) {
        const destClaude = path.join(claudeSkillsDir, entry.name);
        const destGithub = path.join(githubSkillsDir, entry.name);
        fs.mkdirSync(claudeSkillsDir, { recursive: true });
        fs.mkdirSync(githubSkillsDir, { recursive: true });
        fs.cpSync(srcSkillDir, destClaude, { recursive: true, force: true });
        fs.cpSync(srcSkillDir, destGithub, { recursive: true, force: true });
      }
      installedSkills.push(entry.name);
    }
  }

  const scriptCandidates = [
    path.join(resolvedCacheDir, 'new_threat_model.py'),
    path.join(resolvedCacheDir, 'scripts', 'new_threat_model.py'),
    path.join(resolvedCacheDir, 'skills', 'threat-model', 'scripts', 'new_threat_model.py')
  ];
  const newThreatModelScript = scriptCandidates.find((p) => fs.existsSync(p)) || scriptCandidates[0];

  return {
    ok: true,
    cloned,
    cacheDir: resolvedCacheDir,
    repoUrl,
    installedSkills,
    claudeSkillsDir,
    githubSkillsDir,
    newThreatModelScript
  };
}

function parseCliArgs(argv) {
  const opts = {
    check: false,
    installSkills: false,
    repoRoot: process.cwd(),
    cacheDir: '/tmp/lights-on-threat-model',
    threatModelRelPath: 'THREAT_MODEL.md'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--install-skills') {
      opts.installSkills = true;
    } else if (arg === '--repo-root' && argv[i + 1]) {
      opts.repoRoot = argv[++i];
    } else if (arg === '--cache-dir' && argv[i + 1]) {
      opts.cacheDir = argv[++i];
    } else if (arg === '--file' && argv[i + 1]) {
      opts.threatModelRelPath = argv[++i];
    }
  }
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const cli = parseCliArgs(process.argv.slice(2));

  try {
    if (cli.installSkills) {
      const skillResult = ensureThreatModelSkills({
        cacheDir: cli.cacheDir,
        repoRoot: cli.repoRoot,
        installToWorkspace: true
      });
      console.log(JSON.stringify(skillResult, null, 2));
    }

    if (cli.check || !cli.installSkills) {
      const inspection = inspectThreatModel(cli.repoRoot, cli.threatModelRelPath);
      const summary = {
        exists: inspection.exists,
        path: inspection.path,
        valid: inspection.valid,
        missingSections: inspection.missingSections,
        openQuestionsCount: inspection.openQuestionsCount,
        sectionKeys: Object.keys(inspection.sections).filter((k) => k !== 'byNumber' && Boolean(inspection.sections[k]))
      };
      console.log(JSON.stringify(summary, null, 2));
      if (cli.check && !inspection.valid) {
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`ensure-threat-model error: ${err.message}`);
    process.exit(1);
  }
}
