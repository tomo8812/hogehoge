import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_STATE_FILENAME = '.builtin-skills-state.json';
export const LEGACY_BUILTIN_SYNC_MARKER = '.agy-builtin-skill';
const BUILTIN_MANIFEST_FILENAME = '.builtin-skills-manifest.json';

const VALID_SKILL_SLUG_RE = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,62}[a-z0-9])$/;

export interface BuiltinSkillEntry {
  slug: string;
  dir: string;
  sha256: string | null;
}

export function isValidSkillSlug(rawSlug: string): boolean {
  const normalized = rawSlug.trim().toLowerCase();
  return Boolean(normalized && normalized === rawSlug && VALID_SKILL_SLUG_RE.test(normalized));
}

export function getProfileCustomSkillScanDirs(profileDir: string): string[] {
  const profileAbs = path.resolve(profileDir);
  return [
    path.join(profileAbs, '.gemini', 'config', 'skills'),
    path.join(profileAbs, '.gemini', 'config', 'skills-disabled'),
    path.join(profileAbs, '.gemini', 'skills'),
    path.join(profileAbs, '.gemini', 'antigravity', 'skills'),
  ];
}

/**
 * Reads the read-only Built-in skills catalog from `builtinSkillsDir`.
 * Returns a deterministic map keyed by slug.
 */
export function readBuiltinSkillsCatalog(builtinSkillsDir?: string | null): Map<string, BuiltinSkillEntry> {
  const catalog = new Map<string, BuiltinSkillEntry>();
  if (!builtinSkillsDir || !builtinSkillsDir.trim()) return catalog;

  let baseReal: string;
  try {
    baseReal = fs.realpathSync(path.resolve(builtinSkillsDir));
    if (!fs.statSync(baseReal).isDirectory()) return catalog;
  } catch {
    return catalog;
  }

  const manifestShas = new Map<string, string>();
  const manifestPath = path.join(baseReal, BUILTIN_MANIFEST_FILENAME);
  try {
    if (fs.existsSync(manifestPath)) {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        skills?: Record<string, { sha256?: unknown }>;
      };
      if (parsed && parsed.skills && typeof parsed.skills === 'object') {
        for (const [slug, meta] of Object.entries(parsed.skills)) {
          if (meta && typeof meta.sha256 === 'string' && meta.sha256) {
            manifestShas.set(slug, meta.sha256);
          }
        }
      }
    }
  } catch {
    // ignore malformed manifest and fall back to scanning directories
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseReal, { withFileTypes: true });
  } catch {
    return catalog;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const slug = entry.name.trim().toLowerCase();
    if (!isValidSkillSlug(slug) || slug !== entry.name) continue;
    const skillDir = path.join(baseReal, entry.name);
    let skillDirReal: string;
    try {
      skillDirReal = fs.realpathSync(skillDir);
    } catch {
      continue;
    }
    if (!skillDirReal.startsWith(baseReal + path.sep)) continue;
    if (!fs.existsSync(path.join(skillDirReal, 'SKILL.md'))) continue;
    catalog.set(slug, {
      slug,
      dir: skillDirReal,
      sha256: manifestShas.get(slug) ?? null,
    });
  }

  return catalog;
}

/**
 * Reads per-profile Built-in disabled slugs from `.gemini/config/.builtin-skills-state.json`.
 */
export function readProfileDisabledBuiltins(profileDir: string): Set<string> {
  const disabled = new Set<string>();
  const statePath = path.join(path.resolve(profileDir), '.gemini', 'config', BUILTIN_STATE_FILENAME);
  if (!fs.existsSync(statePath)) return disabled;

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      disabled?: unknown;
      skills?: Record<string, { status?: unknown }>;
    };
    if (parsed && Array.isArray(parsed.disabled)) {
      for (const item of parsed.disabled) {
        if (typeof item === 'string' && isValidSkillSlug(item)) {
          disabled.add(item);
        }
      }
    }
    // Support reading legacy state shape if present before migration
    if (parsed && parsed.skills && typeof parsed.skills === 'object') {
      for (const [slug, meta] of Object.entries(parsed.skills)) {
        if (
          isValidSkillSlug(slug) &&
          meta &&
          (meta.status === 'disabled' || meta.status === 'deleted')
        ) {
          disabled.add(slug);
        }
      }
    }
  } catch {
    // ignore corrupt state file
  }
  return disabled;
}

export function writeProfileDisabledBuiltins(profileDir: string, disabledSet: ReadonlySet<string>): void {
  const configDir = path.join(path.resolve(profileDir), '.gemini', 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(configDir, BUILTIN_STATE_FILENAME);
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  const payload = {
    disabled: [...disabledSet].filter(isValidSkillSlug).sort(),
  };
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, statePath);
}

/**
 * Migrates any legacy `.agy-builtin-skill` mutable copies out of user skill directories
 * into `.builtin-skills-state.json` disabled state so Built-in skills live solely in
 * the read-only catalog.
 */
export function migrateLegacySyncedBuiltins(profileDir: string): void {
  const profileAbs = path.resolve(profileDir);
  const configDir = path.join(profileAbs, '.gemini', 'config');
  const enabledDir = path.join(configDir, 'skills');
  const disabledDir = path.join(configDir, 'skills-disabled');
  const disabledSet = readProfileDisabledBuiltins(profileAbs);
  let changed = false;

  for (const [dir, isDisabledDir] of [
    [enabledDir, false],
    [disabledDir, true],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const markerPath = path.join(skillDir, LEGACY_BUILTIN_SYNC_MARKER);
      if (!fs.existsSync(markerPath)) continue;
      if (isDisabledDir && isValidSkillSlug(entry.name)) {
        disabledSet.add(entry.name);
      }
      fs.rmSync(skillDir, { recursive: true, force: true });
      changed = true;
    }
  }

  const statePath = path.join(configDir, BUILTIN_STATE_FILENAME);
  if (changed || (fs.existsSync(statePath) && fs.readFileSync(statePath, 'utf8').includes('"manifestDigest"'))) {
    writeProfileDisabledBuiltins(profileAbs, disabledSet);
  }
}

/**
 * Lists all Custom global skill slugs across canonical, disabled, and legacy paths
 * so Built-in skills never overwrite or hide an existing user-authored skill.
 */
export function listCustomGlobalSkillSlugs(profileDir: string): Set<string> {
  const slugs = new Set<string>();
  for (const baseDir of getProfileCustomSkillScanDirs(profileDir)) {
    if (!fs.existsSync(baseDir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const slug = entry.name.trim().toLowerCase();
      if (!isValidSkillSlug(slug) || slug !== entry.name) continue;
      const skillDir = path.join(baseDir, entry.name);
      if (fs.existsSync(path.join(skillDir, LEGACY_BUILTIN_SYNC_MARKER))) continue;
      if (fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
        slugs.add(slug);
      }
    }
  }
  return slugs;
}

/**
 * Resolves the active Built-in skills to expose to Antigravity for a given profile:
 * excludes user-disabled Built-in skills and any Built-in skill colliding with a
 * Custom global skill (including legacy paths).
 */
export function resolveActiveBuiltinSkillsForProfile(
  profileDir: string,
  builtinSkillsDir?: string | null
): {
  active: BuiltinSkillEntry[];
  conflicts: string[];
} {
  const catalog = readBuiltinSkillsCatalog(builtinSkillsDir);
  if (catalog.size === 0) {
    return { active: [], conflicts: [] };
  }
  const disabledSet = readProfileDisabledBuiltins(profileDir);
  const customSlugs = listCustomGlobalSkillSlugs(profileDir);

  const active: BuiltinSkillEntry[] = [];
  const conflicts: string[] = [];

  for (const [slug, entry] of catalog.entries()) {
    if (customSlugs.has(slug)) {
      conflicts.push(slug);
      continue;
    }
    if (disabledSet.has(slug)) {
      continue;
    }
    active.push(entry);
  }

  return { active, conflicts };
}
