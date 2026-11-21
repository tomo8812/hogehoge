import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import {
  copyFileWithCowFallback,
  PathContainmentError,
  resolveContainedExistingPath,
  resolveContainedWriteTarget,
} from '../files/workspace.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  AvailableCommandItem,
  SkillDetail,
  SkillOrigin,
  SkillResourceFile,
  SkillScope,
  SkillSummary,
  SkillTemplate,
} from '../types.js';
import {
  LEGACY_BUILTIN_SYNC_MARKER,
  migrateLegacySyncedBuiltins,
  readBuiltinSkillsCatalog,
  readProfileDisabledBuiltins,
  writeProfileDisabledBuiltins,
} from './builtin-skills.js';

const PROJECT_SYNC_MARKER = '.agy-project-skill';
const BUILTIN_SYNC_MARKER = LEGACY_BUILTIN_SYNC_MARKER;

export class SkillValidationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'SkillValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const BUILTIN_SKILL_TEMPLATES: SkillTemplate[] = [
  {
    slug: 'code-review',
    name: 'コードレビュー',
    description: '変更されたコードやファイルをバグ・セキュリティ・保守性・性能の観点でレビューするときに使う。',
    instructions: [
      '# Code Review Skill',
      '',
      '指定されたコード・差分・ファイルをレビューしてください。',
      '',
      '## 観点',
      '1. **正確性・エッジケース**: バグ、境界値、エラーハンドリング漏れがないか',
      '2. **セキュリティ**: 入力検証、インジェクション、機密情報の露出、権限境界の漏れがないか',
      '3. **可読性・保守性**: 責務の分離、命名、不要な複雑さがないか',
      '4. **パフォーマンス**: 不要なループ、N+1、重いI/Oがないか',
      '',
      '## 出力形式',
      '- 重要度（High / Medium / Low）ごとに整理',
      '- 問題箇所と具体的な改善案（コード例つき）を簡潔に提示',
    ].join('\n'),
  },
  {
    slug: 'summarize-doc',
    name: '資料・長文の構造化要約',
    description: '添付資料や長文の仕様書・議事録を要点・決定事項・課題・次のアクションに構造化して整理する。',
    instructions: [
      '# Structured Document Summary Skill',
      '',
      '対象ドキュメントや会話内容を以下の形式で簡潔に構造化してください。',
      '',
      '## 出力構成',
      '1. **一言サマリー**（3行以内）',
      '2. **主要なポイント**（箇条書き）',
      '3. **課題・リスク・未決事項**',
      '4. **次のアクション**（担当・優先度があれば明記）',
    ].join('\n'),
  },
  {
    slug: 'bug-investigation',
    name: '不具合・エラー原因調査',
    description: 'エラーメッセージ、ログ、再現手順から原因仮説を立てて調査・修正方針を特定する。',
    instructions: [
      '# Bug Investigation Skill',
      '',
      'エラーログ・スタックトレース・症状から根本原因を切り分けてください。',
      '',
      '## 手順',
      '1. 観測された事実とエラーメッセージを整理する',
      '2. あり得る原因仮説を優先度順に挙げる',
      '3. ワークスペース内の関連コードやテストを確認して仮説を検証する',
      '4. 根本原因と最小限で安全な修正方針・再発防止策を報告する',
    ].join('\n'),
  },
  {
    slug: 'release-notes',
    name: 'リリースノート作成',
    description: '変更点やコミット・ファイル差分からユーザー向けの分かりやすい日本語リリースノートを作成する。',
    instructions: [
      '# Release Notes Skill',
      '',
      '変更内容をもとにユーザーへ案内しやすい日本語のリリースノートを作成してください。',
      '',
      '## カテゴリ',
      '- **新機能**',
      '- **改善・最適化**',
      '- **不具合修正**',
      '- **注意点・破壊的変更**（該当する場合のみ）',
    ].join('\n'),
  },
];

export function validateSkillSlug(rawSlug: string): string {
  const normalized = rawSlug.trim().toLowerCase();
  if (!normalized || !/^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,62}[a-z0-9])$/.test(normalized)) {
    throw new SkillValidationError(
      'INVALID_SKILL_SLUG',
      'スキルID（スラッグ）は半角英小文字・数字・ハイフン（1〜64文字、先頭と末尾は英数字）で指定してください。'
    );
  }
  return normalized;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function formatYamlScalar(value: string): string {
  const cleaned = value.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return '""';
  if (
    cleaned.includes('\n') ||
    cleaned.includes(':') ||
    cleaned.includes('#') ||
    cleaned.includes('"') ||
    cleaned.includes("'") ||
    /^[-?[\]{}&*!|>%@`]/.test(cleaned) ||
    /^(?:true|false|null|yes|no|on|off)$/i.test(cleaned)
  ) {
    return JSON.stringify(cleaned);
  }
  return cleaned;
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  instructions: string;
}

export function parseSkillMarkdown(rawSkillMd: string, fallbackSlug: string): ParsedSkillMarkdown {
  const normalized = rawSkillMd.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (!fmMatch) {
    const firstHeading = /^#\s+(.+)$/m.exec(normalized)?.[1]?.trim() || fallbackSlug;
    return {
      name: firstHeading,
      description: '',
      disableModelInvocation: false,
      instructions: normalized.trim(),
    };
  }

  const frontmatter = fmMatch[1];
  const body = (fmMatch[2] ?? '').replace(/^\n+/, '').trim();
  const lines = frontmatter.split('\n');

  let name = '';
  let description = '';
  let disableModelInvocation = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const valRaw = kv[2].trim();

    if ((valRaw === '|' || valRaw === '|-' || valRaw === '>' || valRaw === '>-') && i + 1 < lines.length) {
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j].trim() === '')) {
        collected.push(lines[j].replace(/^\s{2}/, ''));
        j += 1;
      }
      i = j - 1;
      const joined = collected.join(valRaw.startsWith('>') ? ' ' : '\n').trim();
      if (key === 'name') name = joined;
      else if (key === 'description') description = joined;
      continue;
    }

    if (key === 'name') {
      name = unquoteYamlScalar(valRaw);
    } else if (key === 'description') {
      description = unquoteYamlScalar(valRaw);
    } else if (key === 'disable-model-invocation') {
      const low = unquoteYamlScalar(valRaw).toLowerCase();
      disableModelInvocation = low === 'true' || low === '1' || low === 'yes';
    }
  }

  return {
    name: name || fallbackSlug,
    description,
    disableModelInvocation,
    instructions: body,
  };
}

export function buildSkillMarkdown(params: {
  slug: string;
  name?: string;
  description: string;
  instructions: string;
  disableModelInvocation?: boolean;
}): string {
  const effectiveName = (params.name?.trim() || params.slug).replace(/\r?\n/g, ' ');
  const desc = params.description.trim();
  const body = params.instructions.replace(/\r\n/g, '\n').trim();

  const lines = [
    '---',
    `name: ${formatYamlScalar(effectiveName)}`,
    `description: ${formatYamlScalar(desc)}`,
  ];
  if (params.disableModelInvocation) {
    lines.push('disable-model-invocation: true');
  }
  lines.push('---', '');
  if (body) {
    lines.push(body, '');
  }
  return lines.join('\n');
}

function listSkillResourceFiles(skillDir: string): SkillResourceFile[] {
  const out: SkillResourceFile[] = [];
  if (!fs.existsSync(skillDir)) return out;
  const rootReal = fs.realpathSync(skillDir);

  const walk = (dir: string, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '__pycache__' ||
        entry.name === PROJECT_SYNC_MARKER ||
        entry.name === BUILTIN_SYNC_MARKER
      ) {
        continue;
      }
      if (prefix === '' && entry.name === 'SKILL.md') continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(real, rel);
      } else if (entry.isFile()) {
        const stat = fs.statSync(real);
        out.push({
          relPath: rel,
          name: entry.name,
          sizeBytes: stat.size,
          updatedAt: Math.floor(stat.mtimeMs),
        });
      }
    }
  };
  walk(rootReal);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function copyDirectoryRecursive(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  const rootReal = fs.realpathSync(srcDir);
  const walk = (dir: string, relBase = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === PROJECT_SYNC_MARKER ||
        entry.name === BUILTIN_SYNC_MARKER ||
        entry.name === '.git' ||
        entry.name === '__pycache__' ||
        entry.name === 'node_modules'
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const real = fs.realpathSync(full);
      if (!real.startsWith(rootReal + path.sep)) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const target = path.join(dstDir, rel);
      if (entry.isDirectory()) {
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        walk(real, rel);
      } else if (entry.isFile()) {
        copyFileWithCowFallback(real, target);
        try {
          const st = fs.statSync(real);
          if ((st.mode & 0o111) !== 0 || rel.startsWith('scripts/')) {
            fs.chmodSync(target, 0o700);
          }
        } catch {
          // ignore chmod errors
        }
      }
    }
  };
  walk(rootReal);
}

interface ResolvedScopeRoots {
  enabledDir: string;
  disabledDir: string;
  legacyEnabledDirs: string[];
  profileDir: string | null;
  projectId: string | null;
  chatId: string | null;
}

export class SkillService {
  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub
  ) {}

  private resolveScopeRoots(
    userId: string,
    scope: SkillScope,
    projectId?: string | null,
    chatId?: string | null
  ): ResolvedScopeRoots {
    if (scope === 'global') {
      const profile = this.db.getAgyProfile(userId);
      if (!profile) {
        throw new SkillValidationError('PROFILE_NOT_FOUND', 'Antigravityプロファイルが見つかりません。', 404);
      }
      return {
        enabledDir: path.join(profile.profileDir, '.gemini', 'config', 'skills'),
        disabledDir: path.join(profile.profileDir, '.gemini', 'config', 'skills-disabled'),
        legacyEnabledDirs: [
          path.join(profile.profileDir, '.gemini', 'skills'),
          path.join(profile.profileDir, '.gemini', 'antigravity', 'skills'),
        ],
        profileDir: profile.profileDir,
        projectId: null,
        chatId: null,
      };
    }

    if (scope === 'project') {
      if (!projectId) {
        throw new SkillValidationError('PROJECT_REQUIRED', 'プロジェクトスキルには projectId が必要です。');
      }
      const project = this.db.getProject(userId, projectId);
      if (!project) {
        throw new SkillValidationError('PROJECT_NOT_FOUND', '指定されたプロジェクトが見つかりません。', 404);
      }
      const projectRoot = path.dirname(project.storageDir);
      return {
        enabledDir: path.join(projectRoot, 'skills'),
        disabledDir: path.join(projectRoot, 'skills-disabled'),
        legacyEnabledDirs: [],
        profileDir: null,
        projectId: project.id,
        chatId: null,
      };
    }

    if (!chatId) {
      throw new SkillValidationError('CHAT_REQUIRED', 'ワークスペーススキルには chatId が必要です。');
    }
    const chat = this.db.getChat(userId, chatId);
    if (!chat) {
      throw new SkillValidationError('CHAT_NOT_FOUND', '指定されたチャットが見つかりません。', 404);
    }
    return {
      enabledDir: path.join(chat.workspaceDir, '.agents', 'skills'),
      disabledDir: path.join(chat.workspaceDir, '.agents', 'skills-disabled'),
      legacyEnabledDirs: [path.join(chat.workspaceDir, '.agent', 'skills')],
      profileDir: null,
      projectId: chat.projectId,
      chatId: chat.id,
    };
  }

  private readSkillsFromRoots(scope: SkillScope, roots: ResolvedScopeRoots): Array<{
    summary: SkillSummary;
    dir: string;
  }> {
    const items: Array<{ summary: SkillSummary; dir: string }> = [];
    const seen = new Set<string>();
    const builtinCatalog =
      scope === 'global' ? readBuiltinSkillsCatalog(this.config.builtinSkillsDir) : new Map();
    const disabledBuiltins =
      scope === 'global' && roots.profileDir
        ? readProfileDisabledBuiltins(roots.profileDir)
        : new Set<string>();

    const scanDir = (
      baseDir: string,
      enabled: boolean,
      storageKind: 'canonical' | 'legacy'
    ) => {
      if (!fs.existsSync(baseDir)) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        let slug: string;
        try {
          slug = validateSkillSlug(entry.name);
        } catch {
          continue;
        }
        if (seen.has(slug)) continue;

        const skillDir = path.join(baseDir, entry.name);
        // For workspace scope, skip project-synced skills (they belong to scope='project')
        if (scope === 'workspace' && fs.existsSync(path.join(skillDir, PROJECT_SYNC_MARKER))) {
          continue;
        }
        // Ignore legacy built-in synced copies if any remain before migration
        if (scope === 'global' && fs.existsSync(path.join(skillDir, BUILTIN_SYNC_MARKER))) {
          continue;
        }

        const skillMdPath = path.join(skillDir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const stat = fs.statSync(skillMdPath);
          const raw = fs.readFileSync(skillMdPath, 'utf8');
          const parsed = parseSkillMarkdown(raw, slug);
          const resources = listSkillResourceFiles(skillDir);
          seen.add(slug);
          items.push({
            dir: skillDir,
            summary: {
              slug,
              name: parsed.name || slug,
              description: parsed.description,
              scope,
              origin: 'custom',
              ...(scope === 'global' && builtinCatalog.has(slug) ? { hasBuiltinConflict: true } : {}),
              projectId: roots.projectId,
              chatId: roots.chatId,
              enabled,
              disableModelInvocation: parsed.disableModelInvocation,
              resourceCount: resources.length,
              updatedAt: Math.floor(stat.mtimeMs),
              storageKind,
            },
          });
        } catch {
          // ignore unreadable entry
        }
      }
    };

    scanDir(roots.enabledDir, true, 'canonical');
    for (const legacyDir of roots.legacyEnabledDirs) {
      scanDir(legacyDir, true, 'legacy');
    }
    scanDir(roots.disabledDir, false, 'canonical');

    // Add Built-in skills that do not collide with any existing Custom skill (canonical or legacy)
    if (scope === 'global' && builtinCatalog.size > 0) {
      for (const [slug, builtin] of builtinCatalog.entries()) {
        if (seen.has(slug)) continue;
        const skillMdPath = path.join(builtin.dir, 'SKILL.md');
        if (!fs.existsSync(skillMdPath)) continue;
        try {
          const stat = fs.statSync(skillMdPath);
          const raw = fs.readFileSync(skillMdPath, 'utf8');
          const parsed = parseSkillMarkdown(raw, slug);
          const resources = listSkillResourceFiles(builtin.dir);
          seen.add(slug);
          items.push({
            dir: builtin.dir,
            summary: {
              slug,
              name: parsed.name || slug,
              description: parsed.description,
              scope: 'global',
              origin: 'builtin',
              projectId: null,
              chatId: null,
              enabled: !disabledBuiltins.has(slug),
              disableModelInvocation: parsed.disableModelInvocation,
              resourceCount: resources.length,
              updatedAt: Math.floor(stat.mtimeMs),
              storageKind: 'builtin',
            },
          });
        } catch {
          // ignore unreadable entry
        }
      }
    }

    items.sort((a, b) => a.summary.slug.localeCompare(b.summary.slug));
    return items;
  }

  private findSkillDir(
    userId: string,
    params: { scope: SkillScope; slug: string; projectId?: string | null; chatId?: string | null }
  ): {
    scope: SkillScope;
    slug: string;
    roots: ResolvedScopeRoots;
    skillDir: string;
    enabled: boolean;
    storageKind: 'canonical' | 'legacy' | 'builtin';
    origin: SkillOrigin;
    hasBuiltinConflict?: boolean;
  } {
    const slug = validateSkillSlug(params.slug);
    const roots = this.resolveScopeRoots(userId, params.scope, params.projectId, params.chatId);
    const builtinCatalog =
      params.scope === 'global' ? readBuiltinSkillsCatalog(this.config.builtinSkillsDir) : new Map();
    const conflictFlag = params.scope === 'global' && builtinCatalog.has(slug) ? true : undefined;

    const canonicalEnabled = path.join(roots.enabledDir, slug);
    if (
      fs.existsSync(path.join(canonicalEnabled, 'SKILL.md')) &&
      !(params.scope === 'global' && fs.existsSync(path.join(canonicalEnabled, BUILTIN_SYNC_MARKER)))
    ) {
      return {
        scope: params.scope,
        slug,
        roots,
        skillDir: canonicalEnabled,
        enabled: true,
        storageKind: 'canonical',
        origin: 'custom',
        ...(conflictFlag ? { hasBuiltinConflict: true } : {}),
      };
    }

    for (const legacyDir of roots.legacyEnabledDirs) {
      const candidate = path.join(legacyDir, slug);
      if (
        fs.existsSync(path.join(candidate, 'SKILL.md')) &&
        !(params.scope === 'global' && fs.existsSync(path.join(candidate, BUILTIN_SYNC_MARKER)))
      ) {
        return {
          scope: params.scope,
          slug,
          roots,
          skillDir: candidate,
          enabled: true,
          storageKind: 'legacy',
          origin: 'custom',
          ...(conflictFlag ? { hasBuiltinConflict: true } : {}),
        };
      }
    }

    const canonicalDisabled = path.join(roots.disabledDir, slug);
    if (
      fs.existsSync(path.join(canonicalDisabled, 'SKILL.md')) &&
      !(params.scope === 'global' && fs.existsSync(path.join(canonicalDisabled, BUILTIN_SYNC_MARKER)))
    ) {
      return {
        scope: params.scope,
        slug,
        roots,
        skillDir: canonicalDisabled,
        enabled: false,
        storageKind: 'canonical',
        origin: 'custom',
        ...(conflictFlag ? { hasBuiltinConflict: true } : {}),
      };
    }

    if (params.scope === 'global' && builtinCatalog.has(slug)) {
      const builtin = builtinCatalog.get(slug)!;
      const disabledBuiltins = roots.profileDir
        ? readProfileDisabledBuiltins(roots.profileDir)
        : new Set<string>();
      return {
        scope: 'global',
        slug,
        roots,
        skillDir: builtin.dir,
        enabled: !disabledBuiltins.has(slug),
        storageKind: 'builtin',
        origin: 'builtin',
      };
    }

    throw new SkillValidationError('SKILL_NOT_FOUND', `スキル "/${slug}" が見つかりません。`, 404);
  }

  private buildDetailFromDir(params: {
    scope: SkillScope;
    slug: string;
    roots: ResolvedScopeRoots;
    skillDir: string;
    enabled: boolean;
    storageKind: 'canonical' | 'legacy' | 'builtin';
    origin: SkillOrigin;
    hasBuiltinConflict?: boolean;
  }): SkillDetail {
    const skillMdPath = path.join(params.skillDir, 'SKILL.md');
    const stat = fs.statSync(skillMdPath);
    const rawSkillMd = fs.readFileSync(skillMdPath, 'utf8');
    const parsed = parseSkillMarkdown(rawSkillMd, params.slug);
    const resources = listSkillResourceFiles(params.skillDir);

    return {
      slug: params.slug,
      name: parsed.name || params.slug,
      description: parsed.description,
      scope: params.scope,
      origin: params.origin,
      ...(params.hasBuiltinConflict ? { hasBuiltinConflict: true } : {}),
      projectId: params.roots.projectId,
      chatId: params.roots.chatId,
      enabled: params.enabled,
      disableModelInvocation: parsed.disableModelInvocation,
      resourceCount: resources.length,
      updatedAt: Math.floor(stat.mtimeMs),
      storageKind: params.storageKind,
      instructions: parsed.instructions,
      rawSkillMd,
      resources,
    };
  }

  listSkills(
    userId: string,
    opts: { projectId?: string | null; chatId?: string | null } = {}
  ): {
    global: SkillSummary[];
    project: SkillSummary[];
    workspace: SkillSummary[];
    projectId: string | null;
    chatId: string | null;
    templates: SkillTemplate[];
  } {
    const globalRoots = this.resolveScopeRoots(userId, 'global');
    const global = this.readSkillsFromRoots('global', globalRoots).map((x) => x.summary);

    let effectiveProjectId = opts.projectId ?? null;
    const effectiveChatId = opts.chatId ?? null;
    let workspace: SkillSummary[] = [];

    if (effectiveChatId) {
      const chat = this.db.getChat(userId, effectiveChatId);
      if (chat) {
        if (!effectiveProjectId && chat.projectId) {
          effectiveProjectId = chat.projectId;
        }
        const wsRoots = this.resolveScopeRoots(userId, 'workspace', chat.projectId, chat.id);
        workspace = this.readSkillsFromRoots('workspace', wsRoots).map((x) => x.summary);
      }
    }

    let project: SkillSummary[] = [];
    if (effectiveProjectId) {
      const proj = this.db.getProject(userId, effectiveProjectId);
      if (proj) {
        const projRoots = this.resolveScopeRoots(userId, 'project', proj.id);
        project = this.readSkillsFromRoots('project', projRoots).map((x) => x.summary);
      } else {
        effectiveProjectId = null;
      }
    }

    return {
      global,
      project,
      workspace,
      projectId: effectiveProjectId,
      chatId: effectiveChatId,
      templates: BUILTIN_SKILL_TEMPLATES,
    };
  }

  listAvailableSkillCommands(
    userId: string,
    opts: { projectId?: string | null; chatId?: string | null } = {}
  ): AvailableCommandItem[] {
    const { global, project, workspace } = this.listSkills(userId, opts);
    const byName = new Map<string, AvailableCommandItem>();

    // Higher-precedence scopes override lower scopes (global < project < workspace)
    for (const s of global) {
      if (!s.enabled) continue;
      byName.set(s.slug, {
        name: s.slug,
        description: s.description || s.name,
        source: 'skill',
        scope: 'global',
      });
    }
    for (const s of project) {
      if (!s.enabled) continue;
      byName.set(s.slug, {
        name: s.slug,
        description: s.description || s.name,
        source: 'skill',
        scope: 'project',
      });
    }
    for (const s of workspace) {
      if (!s.enabled) continue;
      byName.set(s.slug, {
        name: s.slug,
        description: s.description || s.name,
        source: 'skill',
        scope: 'workspace',
      });
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getSkillDetail(
    userId: string,
    params: { scope: SkillScope; slug: string; projectId?: string | null; chatId?: string | null }
  ): SkillDetail {
    const found = this.findSkillDir(userId, params);
    return this.buildDetailFromDir(found);
  }

  syncProjectSkillsToChat(userId: string, projectId: string, workspaceDir: string): string[] {
    const proj = this.db.getProject(userId, projectId);
    if (!proj) return [];
    const roots = this.resolveScopeRoots(userId, 'project', projectId);
    const enabledSkills = this.readSkillsFromRoots('project', roots).filter((s) => s.summary.enabled);

    const targetBase = path.join(workspaceDir, '.agents', 'skills');
    const enabledSlugs = new Set(enabledSkills.map((s) => s.summary.slug));

    // Remove previously synced project skills that were disabled/deleted without deleting unrelated workspace skills
    if (fs.existsSync(targetBase)) {
      for (const entry of fs.readdirSync(targetBase, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(targetBase, entry.name);
        if (fs.existsSync(path.join(dirPath, PROJECT_SYNC_MARKER)) && !enabledSlugs.has(entry.name)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
      }
    }

    if (enabledSkills.length === 0) {
      return [];
    }

    fs.mkdirSync(targetBase, { recursive: true, mode: 0o700 });
    const syncedPaths: string[] = [];
    for (const item of enabledSkills) {
      const dstSkillDir = path.join(targetBase, item.summary.slug);
      // Clean existing files inside synced folder so deleted resource files don't linger
      if (fs.existsSync(dstSkillDir)) {
        fs.rmSync(dstSkillDir, { recursive: true, force: true });
      }
      copyDirectoryRecursive(item.dir, dstSkillDir);
      fs.writeFileSync(path.join(dstSkillDir, PROJECT_SYNC_MARKER), `${projectId}\n`, 'utf8');
      syncedPaths.push(`.agents/skills/${item.summary.slug}/SKILL.md`);
    }
    return syncedPaths;
  }

  syncProjectSkillsToAllProjectChats(userId: string, projectId: string): string[] {
    const chats = this.db.listChats(userId, { projectId });
    const affectedChatIds: string[] = [];
    for (const chat of chats) {
      if (fs.existsSync(chat.workspaceDir)) {
        this.syncProjectSkillsToChat(userId, projectId, chat.workspaceDir);
        affectedChatIds.push(chat.id);
      }
    }
    return affectedChatIds;
  }

  syncBuiltinSkillsToProfile(profileDir: string): void {
    migrateLegacySyncedBuiltins(profileDir);
  }

  saveSkill(
    userId: string,
    input: {
      scope: SkillScope;
      projectId?: string | null;
      chatId?: string | null;
      slug: string;
      name?: string;
      description?: string;
      instructions?: string;
      rawSkillMd?: string;
      disableModelInvocation?: boolean;
      enabled?: boolean;
      createOnly?: boolean;
    }
  ): { detail: SkillDetail; affectedProjectChatIds: string[] } {
    const slug = validateSkillSlug(input.slug);
    const roots = this.resolveScopeRoots(userId, input.scope, input.projectId, input.chatId);
    const builtinCatalog =
      input.scope === 'global' ? readBuiltinSkillsCatalog(this.config.builtinSkillsDir) : new Map();

    const isCustomDir = (dirPath: string): boolean =>
      fs.existsSync(path.join(dirPath, 'SKILL.md')) &&
      !(input.scope === 'global' && fs.existsSync(path.join(dirPath, BUILTIN_SYNC_MARKER)));

    const enabledDir = path.join(roots.enabledDir, slug);
    const disabledDir = path.join(roots.disabledDir, slug);
    const existsEnabled = isCustomDir(enabledDir);
    const existsDisabled = isCustomDir(disabledDir);
    const existingLegacyDir =
      roots.legacyEnabledDirs
        .map((d) => path.join(d, slug))
        .find((d) => isCustomDir(d)) ?? null;
    const hasExistingCustom = existsEnabled || existsDisabled || Boolean(existingLegacyDir);

    if (input.scope === 'global' && !hasExistingCustom && builtinCatalog.has(slug)) {
      if (input.createOnly) {
        throw new SkillValidationError(
          'BUILTIN_SKILL_CONFLICT',
          `Built-in スキル "/${slug}" と同名のグローバルスキルは作成・差し替えできません。`,
          409
        );
      }
      throw new SkillValidationError(
        'BUILTIN_SKILL_READONLY',
        `Built-in スキル "/${slug}" は編集・差し替えできません。`,
        403
      );
    }

    if (input.createOnly && hasExistingCustom) {
      throw new SkillValidationError('SKILL_EXISTS', `スキル "/${slug}" は既に存在します。`, 409);
    }

    const wantEnabled =
      input.enabled !== undefined
        ? input.enabled
        : !existsDisabled || existsEnabled || Boolean(existingLegacyDir);
    const targetDir = wantEnabled ? enabledDir : disabledDir;
    const oldDir = existsEnabled
      ? enabledDir
      : existsDisabled
        ? disabledDir
        : existingLegacyDir;

    if (oldDir && oldDir !== targetDir && fs.existsSync(oldDir)) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(oldDir, targetDir);
    } else {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    let finalSkillMd: string;
    if (typeof input.rawSkillMd === 'string' && input.rawSkillMd.trim()) {
      const parsed = parseSkillMarkdown(input.rawSkillMd, slug);
      if (!parsed.description.trim()) {
        throw new SkillValidationError(
          'DESCRIPTION_REQUIRED',
          'SKILL.md のフロントマターに description を記述してください。'
        );
      }
      finalSkillMd = input.rawSkillMd.replace(/\r\n/g, '\n');
      if (!finalSkillMd.endsWith('\n')) finalSkillMd += '\n';
    } else {
      const desc = (input.description ?? '').trim();
      if (!desc) {
        throw new SkillValidationError(
          'DESCRIPTION_REQUIRED',
          'スキルの説明（いつ・何に使うか）を入力してください。'
        );
      }
      finalSkillMd = buildSkillMarkdown({
        slug,
        name: input.name,
        description: desc,
        instructions: input.instructions ?? '',
        disableModelInvocation: input.disableModelInvocation,
      });
    }

    const skillMdTarget = resolveContainedWriteTarget(targetDir, 'SKILL.md');
    fs.writeFileSync(skillMdTarget.absPath, finalSkillMd, 'utf8');

    const affectedProjectChatIds =
      input.scope === 'project' && roots.projectId
        ? this.syncProjectSkillsToAllProjectChats(userId, roots.projectId)
        : [];

    const detail = this.buildDetailFromDir({
      scope: input.scope,
      slug,
      roots,
      skillDir: targetDir,
      enabled: wantEnabled,
      storageKind: 'canonical',
      origin: 'custom',
      hasBuiltinConflict: input.scope === 'global' && builtinCatalog.has(slug),
    });

    this.hub.emitDurable({
      userId,
      type: 'skills.updated',
      projectId: roots.projectId,
      chatId: roots.chatId,
      payload: { scope: input.scope, slug, projectId: roots.projectId, chatId: roots.chatId },
    });

    return { detail, affectedProjectChatIds };
  }

  setSkillEnabled(
    userId: string,
    params: { scope: SkillScope; slug: string; projectId?: string | null; chatId?: string | null; enabled: boolean }
  ): { detail: SkillDetail; affectedProjectChatIds: string[] } {
    const found = this.findSkillDir(userId, params);

    if (found.origin === 'builtin') {
      if (!found.roots.profileDir) {
        throw new SkillValidationError('PROFILE_NOT_FOUND', 'Antigravityプロファイルが見つかりません。', 404);
      }
      const disabledSet = readProfileDisabledBuiltins(found.roots.profileDir);
      if (params.enabled) {
        disabledSet.delete(found.slug);
      } else {
        disabledSet.add(found.slug);
      }
      writeProfileDisabledBuiltins(found.roots.profileDir, disabledSet);

      const detail = this.buildDetailFromDir({
        scope: params.scope,
        slug: found.slug,
        roots: found.roots,
        skillDir: found.skillDir,
        enabled: params.enabled,
        storageKind: 'builtin',
        origin: 'builtin',
      });

      this.hub.emitDurable({
        userId,
        type: 'skills.updated',
        projectId: null,
        chatId: null,
        payload: {
          scope: params.scope,
          slug: found.slug,
          enabled: params.enabled,
          projectId: null,
          chatId: null,
        },
      });

      return { detail, affectedProjectChatIds: [] };
    }

    const dstDir = params.enabled
      ? path.join(found.roots.enabledDir, found.slug)
      : path.join(found.roots.disabledDir, found.slug);

    if (found.skillDir !== dstDir) {
      fs.mkdirSync(path.dirname(dstDir), { recursive: true, mode: 0o700 });
      if (fs.existsSync(dstDir)) {
        fs.rmSync(dstDir, { recursive: true, force: true });
      }
      fs.renameSync(found.skillDir, dstDir);
    }

    const affectedProjectChatIds =
      params.scope === 'project' && found.roots.projectId
        ? this.syncProjectSkillsToAllProjectChats(userId, found.roots.projectId)
        : [];

    const detail = this.buildDetailFromDir({
      scope: params.scope,
      slug: found.slug,
      roots: found.roots,
      skillDir: dstDir,
      enabled: params.enabled,
      storageKind: 'canonical',
      origin: 'custom',
      hasBuiltinConflict: found.hasBuiltinConflict,
    });

    this.hub.emitDurable({
      userId,
      type: 'skills.updated',
      projectId: found.roots.projectId,
      chatId: found.roots.chatId,
      payload: {
        scope: params.scope,
        slug: found.slug,
        enabled: params.enabled,
        projectId: found.roots.projectId,
        chatId: found.roots.chatId,
      },
    });

    return { detail, affectedProjectChatIds };
  }

  deleteSkill(
    userId: string,
    params: { scope: SkillScope; slug: string; projectId?: string | null; chatId?: string | null }
  ): { affectedProjectChatIds: string[] } {
    const found = this.findSkillDir(userId, params);
    if (found.origin === 'builtin') {
      throw new SkillValidationError(
        'BUILTIN_SKILL_READONLY',
        `Built-in スキル "/${found.slug}" は削除できません。無効化をご利用ください。`,
        403
      );
    }
    fs.rmSync(found.skillDir, { recursive: true, force: true });

    const affectedProjectChatIds =
      params.scope === 'project' && found.roots.projectId
        ? this.syncProjectSkillsToAllProjectChats(userId, found.roots.projectId)
        : [];

    this.hub.emitDurable({
      userId,
      type: 'skills.updated',
      projectId: found.roots.projectId,
      chatId: found.roots.chatId,
      payload: {
        scope: params.scope,
        slug: found.slug,
        deleted: true,
        projectId: found.roots.projectId,
        chatId: found.roots.chatId,
      },
    });

    return { affectedProjectChatIds };
  }

  upsertResourceFile(
    userId: string,
    params: {
      scope: SkillScope;
      slug: string;
      projectId?: string | null;
      chatId?: string | null;
      relPath: string;
      content: Buffer;
    }
  ): { detail: SkillDetail; affectedProjectChatIds: string[] } {
    const found = this.findSkillDir(userId, params);
    if (found.origin === 'builtin') {
      throw new SkillValidationError(
        'BUILTIN_SKILL_READONLY',
        `Built-in スキル "/${found.slug}" の付属ファイルは編集・差し替えできません。`,
        403
      );
    }
    let target: { absPath: string; relPath: string };
    try {
      target = resolveContainedWriteTarget(found.skillDir, params.relPath);
    } catch (err) {
      if (err instanceof PathContainmentError) {
        throw new SkillValidationError('INVALID_RESOURCE_PATH', err.message, 403);
      }
      throw err;
    }

    if (target.relPath === PROJECT_SYNC_MARKER || target.relPath === BUILTIN_SYNC_MARKER) {
      throw new SkillValidationError('INVALID_RESOURCE_PATH', '予約済みのファイル名です。');
    }

    fs.mkdirSync(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target.absPath, params.content);
    if (target.relPath.startsWith('scripts/') && /\.(sh|bash|py|js|ts)$/.test(target.relPath)) {
      try {
        fs.chmodSync(target.absPath, 0o755);
      } catch {
        // ignore chmod errors
      }
    }

    const affectedProjectChatIds =
      params.scope === 'project' && found.roots.projectId
        ? this.syncProjectSkillsToAllProjectChats(userId, found.roots.projectId)
        : [];

    const detail = this.buildDetailFromDir(found);
    this.hub.emitDurable({
      userId,
      type: 'skills.updated',
      projectId: found.roots.projectId,
      chatId: found.roots.chatId,
      payload: { scope: params.scope, slug: found.slug, projectId: found.roots.projectId, chatId: found.roots.chatId },
    });

    return { detail, affectedProjectChatIds };
  }

  readResourceFile(
    userId: string,
    params: { scope: SkillScope; slug: string; projectId?: string | null; chatId?: string | null; relPath: string }
  ): { absPath: string; relPath: string } {
    const found = this.findSkillDir(userId, params);
    return resolveContainedExistingPath(found.skillDir, params.relPath);
  }

  deleteResourceFile(
    userId: string,
    params: { scope: SkillScope; slug: string; projectId?: string | null; chatId?: string | null; relPath: string }
  ): { detail: SkillDetail; affectedProjectChatIds: string[] } {
    const found = this.findSkillDir(userId, params);
    if (found.origin === 'builtin') {
      throw new SkillValidationError(
        'BUILTIN_SKILL_READONLY',
        `Built-in スキル "/${found.slug}" の付属ファイルは削除できません。`,
        403
      );
    }
    const resolved = resolveContainedExistingPath(found.skillDir, params.relPath);
    if (
      resolved.relPath === 'SKILL.md' ||
      resolved.relPath === PROJECT_SYNC_MARKER ||
      resolved.relPath === BUILTIN_SYNC_MARKER
    ) {
      throw new SkillValidationError('CANNOT_DELETE_SKILL_MD', 'SKILL.md 自体はスキル削除から削除してください。');
    }
    fs.rmSync(resolved.absPath, { force: true });

    const affectedProjectChatIds =
      params.scope === 'project' && found.roots.projectId
        ? this.syncProjectSkillsToAllProjectChats(userId, found.roots.projectId)
        : [];

    const detail = this.buildDetailFromDir(found);
    this.hub.emitDurable({
      userId,
      type: 'skills.updated',
      projectId: found.roots.projectId,
      chatId: found.roots.chatId,
      payload: { scope: params.scope, slug: found.slug, projectId: found.roots.projectId, chatId: found.roots.chatId },
    });

    return { detail, affectedProjectChatIds };
  }
}
