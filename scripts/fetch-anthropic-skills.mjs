#!/usr/bin/env node
/**
 * Dynamically fetches the latest Anthropic document skills (docx, pptx, xlsx, pdf)
 * from https://github.com/anthropics/skills at build time so they can be bundled
 * into AGY-ChatUI without checking upstream files into git or placing them manually on servers.
 *
 * Zero external dependencies — runs on Node.js >= 24.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ANTHROPIC_SKILLS_REPO = 'anthropics/skills';
export const DEFAULT_ANTHROPIC_SKILLS_REF = 'main';
export const DEFAULT_DOCUMENT_SKILLS = ['docx', 'pptx', 'xlsx', 'pdf'];
export const BUILTIN_SKILLS_MANIFEST_FILE = '.builtin-skills-manifest.json';

/**
 * Computes a deterministic SHA-256 digest over all regular files in `dirPath`.
 * @param {string} dirPath
 * @returns {{ sha256: string; fileCount: number; totalBytes: number }}
 */
export function computeDirectoryDigest(dirPath) {
  const root = fs.realpathSync(dirPath);
  /** @type {Array<{ rel: string; abs: string }>} */
  const files = [];

  const walk = (currentDir, relBase = '') => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(currentDir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(root + path.sep)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(real, rel);
      } else if (entry.isFile()) {
        files.push({ rel, abs: real });
      }
    }
  };

  walk(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const item of files) {
    const data = fs.readFileSync(item.abs);
    totalBytes += data.byteLength;
    hash.update(item.rel);
    hash.update('\0');
    hash.update(String(data.byteLength));
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }

  return {
    sha256: hash.digest('hex'),
    fileCount: files.length,
    totalBytes,
  };
}

/**
 * Validates that a relative path from an archive or directory is strictly contained.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isSafeRelativeArchivePath(relPath) {
  if (!relPath || relPath.includes('\0') || relPath.includes('\\')) return false;
  if (path.posix.isAbsolute(relPath)) return false;
  const parts = relPath.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return false;
  return true;
}

/**
 * Recursively copies regular files and directories safely without following symlinks.
 * @param {string} srcDir
 * @param {string} dstDir
 */
function copySafeTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o755 });
  const rootReal = fs.realpathSync(srcDir);

  const walk = (dir, relBase = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const target = path.join(dstDir, rel);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true, mode: 0o755 });
        walk(real, rel);
      } else if (entry.isFile()) {
        const st = fs.statSync(real);
        fs.copyFileSync(real, target);
        const mode = (st.mode & 0o111) !== 0 || rel.startsWith('scripts/') ? 0o755 : 0o644;
        try {
          fs.chmodSync(target, mode);
        } catch {
          // ignore chmod errors
        }
      }
    }
  };

  walk(rootReal);
}

/**
 * Builds the default GitHub codeload tarball URL for `repo` and `ref`.
 * @param {string} repo
 * @param {string} ref
 */
export function buildGitHubTarballUrl(repo, ref) {
  const cleanRepo = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(cleanRepo)) {
    throw new Error(`Invalid GitHub repository slug: ${repo}`);
  }
  const cleanRef = ref.trim();
  if (!cleanRef || /[\s\\]/.test(cleanRef)) {
    throw new Error(`Invalid Git ref: ${ref}`);
  }
  return `https://codeload.github.com/${cleanRepo}/tar.gz/${encodeURIComponent(cleanRef)}`;
}

/**
 * Extracts selected `skills/<slug>/` trees from a `.tar.gz` file into `stageExtractDir`.
 * Rejects path traversal and non-regular/non-dir archive entries.
 * @param {string} tarballPath
 * @param {string} stageExtractDir
 * @param {string[]} skillSlugs
 */
function extractSkillsFromTarball(tarballPath, stageExtractDir, skillSlugs) {
  const rawNames = execFileSync('tar', ['-tzf', tarballPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const wantedSet = new Set(skillSlugs);
  const selectedFiles = [];
  const selectedAll = new Set();

  for (const rawLine of rawNames.split('\n')) {
    const entryName = rawLine.replace(/\r$/, '');
    if (!entryName) continue;
    const isDir = entryName.endsWith('/');
    const cleanEntry = entryName.replace(/\/+$/, '');
    if (!isSafeRelativeArchivePath(cleanEntry)) {
      throw new Error(`Unsafe archive path rejected: ${entryName}`);
    }
    const slashIdx = cleanEntry.indexOf('/');
    if (slashIdx <= 0) continue;
    const rest = cleanEntry.slice(slashIdx + 1);
    const restParts = rest.split('/');
    if (restParts[0] !== 'skills' || restParts.length < 2 || !wantedSet.has(restParts[1])) {
      continue;
    }
    selectedAll.add(cleanEntry);
    if (!isDir && restParts.length >= 3) {
      selectedFiles.push(entryName);
    }
  }

  if (selectedFiles.length === 0) {
    throw new Error(`No matching skills (${skillSlugs.join(', ')}) found in archive ${tarballPath}`);
  }

  // Verify selected entries are strictly regular files or directories (no symlinks/hardlinks/devices)
  const verboseList = execFileSync('tar', ['-tvzf', tarballPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const rawLine of verboseList.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const typeChar = line[0];
    if (typeChar !== '-' && typeChar !== 'd') {
      // Check if this non-regular entry is inside any selected skill path
      const matchesSelected = skillSlugs.some((slug) => line.includes(`/skills/${slug}/`));
      if (matchesSelected) {
        throw new Error(`Unsupported non-regular entry in skills archive (${typeChar}): ${line}`);
      }
    }
  }

  fs.mkdirSync(stageExtractDir, { recursive: true, mode: 0o755 });
  const listFile = path.join(path.dirname(stageExtractDir), 'selected-entries.txt');
  fs.writeFileSync(listFile, selectedFiles.join('\n') + '\n', 'utf8');

  execFileSync(
    'tar',
    ['-xzf', tarballPath, '-C', stageExtractDir, '--strip-components=2', '--no-same-owner', '--files-from', listFile],
    { encoding: 'utf8' }
  );
}

/**
 * Checks if an existing `outDir` already contains a valid manifest and all requested skills.
 * @param {string} outDir
 * @param {string[]} skillSlugs
 * @returns {boolean}
 */
export function hasValidBuiltinSkillsCache(outDir, skillSlugs = DEFAULT_DOCUMENT_SKILLS) {
  const manifestPath = path.join(outDir, BUILTIN_SKILLS_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.skills) return false;
    return skillSlugs.every((slug) => fs.existsSync(path.join(outDir, slug, 'SKILL.md')));
  } catch {
    return false;
  }
}

/**
 * Downloads (or reads from local tarball/dir) the Anthropic document skills and
 * writes them atomically into `outDir` with `.builtin-skills-manifest.json`.
 *
 * @param {{
 *   outDir?: string;
 *   repo?: string;
 *   ref?: string;
 *   tarballUrl?: string;
 *   tarballPath?: string;
 *   fromDir?: string;
 *   skills?: string[];
 *   timeoutMs?: number;
 * }} [options]
 */
export async function fetchAnthropicSkills(options = {}) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const outDir = path.resolve(options.outDir ?? path.join(repoRoot, 'builtin-skills'));
  const repo = options.repo ?? process.env.ANTHROPIC_SKILLS_REPO ?? DEFAULT_ANTHROPIC_SKILLS_REPO;
  const ref = options.ref ?? process.env.ANTHROPIC_SKILLS_REF ?? DEFAULT_ANTHROPIC_SKILLS_REF;
  const skills = (options.skills && options.skills.length > 0 ? options.skills : DEFAULT_DOCUMENT_SKILLS).map((s) =>
    s.trim().toLowerCase()
  );
  const timeoutMs = options.timeoutMs ?? 45_000;

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fetch-skills-'));
  try {
    const extractDir = path.join(tmpRoot, 'extracted');
    const stageOutDir = path.join(tmpRoot, 'stage-out');
    fs.mkdirSync(stageOutDir, { recursive: true, mode: 0o755 });

    if (options.fromDir) {
      const srcBase = path.resolve(options.fromDir);
      const skillsBase = fs.existsSync(path.join(srcBase, 'skills'))
        ? path.join(srcBase, 'skills')
        : srcBase;
      for (const slug of skills) {
        const candidate = path.join(skillsBase, slug);
        if (!fs.existsSync(path.join(candidate, 'SKILL.md'))) {
          throw new Error(`Skill "${slug}" (with SKILL.md) not found under ${skillsBase}`);
        }
        copySafeTree(candidate, path.join(stageOutDir, slug));
      }
    } else {
      let tarballPath = options.tarballPath ? path.resolve(options.tarballPath) : '';
      if (!tarballPath) {
        const url = options.tarballUrl ?? process.env.ANTHROPIC_SKILLS_TARBALL_URL ?? buildGitHubTarballUrl(repo, ref);
        tarballPath = path.join(tmpRoot, 'skills.tar.gz');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'antigravity-chat-ui-build/1.0' },
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength < 1024) {
            throw new Error(`Downloaded skills archive unexpectedly small (${buf.byteLength} bytes)`);
          }
          fs.writeFileSync(tarballPath, buf);
        } finally {
          clearTimeout(timer);
        }
      }

      extractSkillsFromTarball(tarballPath, extractDir, skills);
      for (const slug of skills) {
        const extractedSkillDir = path.join(extractDir, slug);
        if (!fs.existsSync(path.join(extractedSkillDir, 'SKILL.md'))) {
          throw new Error(`Extracted skill "${slug}" is missing SKILL.md`);
        }
        copySafeTree(extractedSkillDir, path.join(stageOutDir, slug));
      }
    }

    /** @type {Record<string, { sha256: string; fileCount: number; totalBytes: number }>} */
    const skillDigests = {};
    const overallHash = crypto.createHash('sha256');
    for (const slug of [...skills].sort()) {
      const digest = computeDirectoryDigest(path.join(stageOutDir, slug));
      skillDigests[slug] = digest;
      overallHash.update(`${slug}:${digest.sha256}\n`);
    }

    const manifest = {
      source: options.fromDir ? 'local' : repo,
      ref: options.fromDir ? 'local' : ref,
      fetchedAt: new Date().toISOString(),
      manifestDigest: overallHash.digest('hex'),
      skills: skillDigests,
    };
    fs.writeFileSync(
      path.join(stageOutDir, BUILTIN_SKILLS_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8'
    );

    // Atomic swap into outDir
    fs.mkdirSync(path.dirname(outDir), { recursive: true, mode: 0o755 });
    const backupDir = `${outDir}.old.${process.pid}`;
    const tempSwap = `${outDir}.new.${process.pid}`;
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(tempSwap, { recursive: true, force: true });
    copySafeTree(stageOutDir, tempSwap);
    if (fs.existsSync(outDir)) {
      fs.renameSync(outDir, backupDir);
    }
    fs.renameSync(tempSwap, outDir);
    fs.rmSync(backupDir, { recursive: true, force: true });

    return { outDir, manifest };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  const opts = {
    outDir: undefined,
    repo: undefined,
    ref: undefined,
    tarballUrl: undefined,
    tarballPath: undefined,
    fromDir: undefined,
    skills: undefined,
    bestEffort: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      opts.outDir = argv[++i];
    } else if (arg === '--repo' && argv[i + 1]) {
      opts.repo = argv[++i];
    } else if (arg === '--ref' && argv[i + 1]) {
      opts.ref = argv[++i];
    } else if (arg === '--tarball-url' && argv[i + 1]) {
      opts.tarballUrl = argv[++i];
    } else if (arg === '--tarball' && argv[i + 1]) {
      opts.tarballPath = argv[++i];
    } else if (arg === '--from-dir' && argv[i + 1]) {
      opts.fromDir = argv[++i];
    } else if (arg === '--skills' && argv[i + 1]) {
      opts.skills = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--best-effort') {
      opts.bestEffort = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = parseCliArgs(process.argv.slice(2));
  try {
    const result = await fetchAnthropicSkills(opts);
    const summary = Object.entries(result.manifest.skills)
      .map(([k, v]) => `${k}(${v.fileCount} files, ${v.sha256.slice(0, 8)})`)
      .join(', ');
    console.log(`[fetch-anthropic-skills] Bundled latest skills into ${result.outDir}: ${summary}`);
  } catch (err) {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const outDir = path.resolve(opts.outDir ?? path.join(repoRoot, 'builtin-skills'));
    const skills = opts.skills ?? DEFAULT_DOCUMENT_SKILLS;
    if (opts.bestEffort && hasValidBuiltinSkillsCache(outDir, skills)) {
      console.warn(
        `[fetch-anthropic-skills] WARNING: Failed to refresh skills (${err instanceof Error ? err.message : String(err)}); keeping existing bundled cache in ${outDir}.`
      );
      process.exit(0);
    }
    console.error(`[fetch-anthropic-skills] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
