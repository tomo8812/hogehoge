import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AGY_AGENT_MODES = ['auto', '', 'accept-edits', 'plan'] as const;
type AgentMode = (typeof AGY_AGENT_MODES)[number];

function withSettingsPath<T>(profileDir: string, operation: (file: string) => T): T {
  // Anchor writes to the opened directories on Linux, where the ACP worker
  // can access the profile while the server is editing its settings.
  const useDirectoryFd = process.platform === 'linux' && fs.existsSync('/proc/self/fd');
  let directory: number | undefined;
  let current = profileDir;
  try {
    for (const segment of ['', '.gemini', 'antigravity-cli']) {
      current = path.join(current, segment);
      fs.mkdirSync(current, { recursive: true, mode: 0o700 });
      if (useDirectoryFd) {
        const next = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        if (directory !== undefined) fs.closeSync(directory);
        directory = next;
        current = `/proc/self/fd/${directory}`;
      } else if (!fs.lstatSync(current).isDirectory()) {
        throw new Error('Antigravity の設定ディレクトリが不正です。');
      }
    }
    return operation(path.join(current, 'settings.json'));
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

function assertSettingsUnchanged(current: fs.BigIntStats | undefined, original: fs.BigIntStats): void {
  if (!current || current.dev !== original.dev || current.ino !== original.ino ||
      current.mtimeNs !== original.mtimeNs || current.ctimeNs !== original.ctimeNs ||
      current.size !== original.size) {
    throw Object.assign(new Error('settings.json が別の処理で更新されたため、そちらの変更を優先しました。'), {
      statusCode: 409,
      code: 'AGY_SETTINGS_CHANGED',
    });
  }
}

function createDefaultSettings(file: string): void {
  const temporary = path.join(path.dirname(file), `.settings-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, '{\n  "agentMode": "auto"\n}\n', 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function withSettingsFile<T>(file: string, access: number, operation: (fd: number) => T): T {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('Antigravity の設定ファイルが不正です。');
  const fd = fs.openSync(file, access | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const openedStat = fs.fstatSync(fd, { bigint: true });
    if (!openedStat.isFile() || openedStat.nlink !== 1n) {
      throw new Error('Antigravity の設定ファイルが不正です。');
    }
    return operation(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function parseSettings(content: Buffer): Record<string, unknown> {
  let settings: unknown;
  try {
    settings = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('Antigravity の settings.json を読み込めません。');
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Antigravity の settings.json は JSON オブジェクトである必要があります。');
  }
  return settings as Record<string, unknown>;
}

function ensureSettings(file: string): void {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
    createDefaultSettings(file);
  }
}

export function ensureAgyProfileSettings(profileDir: string): void {
  withSettingsPath(profileDir, ensureSettings);
}

export function getAgyAgentMode(profileDir: string, { createIfMissing = true } = {}): string | null {
  return withSettingsPath(profileDir, (file) => {
    if (createIfMissing) {
      ensureSettings(file);
    } else if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
      return null;
    }
    return withSettingsFile(file, fs.constants.O_RDONLY, (fd) => {
      const { agentMode } = parseSettings(fs.readFileSync(fd));
      return typeof agentMode === 'string' ? agentMode : null;
    });
  });
}

export function setAgyAgentMode(profileDir: string, agentMode: AgentMode): void {
  withSettingsPath(profileDir, (file) => {
    ensureSettings(file);
    withSettingsFile(file, fs.constants.O_RDWR, (fd) => {
      const original = fs.fstatSync(fd, { bigint: true });
      const previous = fs.readFileSync(fd);
      const settings = parseSettings(previous);
      if (settings.agentMode === agentMode) return;

      const json = Buffer.from(`${JSON.stringify({ ...settings, agentMode }, null, 2)}\n`, 'utf8');
      // Pad shorter JSON with whitespace so saving requires no separate truncate.
      const updated = Buffer.alloc(Math.max(json.length, previous.length), 0x20);
      json.copy(updated);
      assertSettingsUnchanged(fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }), original);

      // The CLI saves by replacing the path. Writing to the open descriptor
      // leaves any file installed by the CLI intact, even during this write.
      const written = fs.writeSync(fd, updated, 0, updated.length, 0);
      if (written !== updated.length) {
        fs.writeSync(fd, previous, 0, Math.min(previous.length, written), 0);
        fs.ftruncateSync(fd, previous.length);
        throw new Error('Antigravity の settings.json を保存できませんでした。');
      }
      assertSettingsUnchanged(fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }), fs.fstatSync(fd, { bigint: true }));
    });
  });
}

export interface AgyPermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

const VALID_PERMISSION_RULE_RE = /^(mcp|command|write_file|read_file|read_url|execute_url)\(([^)\r\n\0]+)\)$/;

export function isValidAgyPermissionRule(rule: string): boolean {
  const trimmed = rule.trim();
  return Boolean(trimmed && trimmed.length <= 2048 && VALID_PERMISSION_RULE_RE.test(trimmed));
}

export function formatMcpPermissionRule(serverName: string, toolName: string): string {
  return `mcp(${serverName.trim()}/${toolName.trim()})`;
}

function normalizeStringRuleList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || /[\r\n\0]/.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function extractPermissionRules(settings: Record<string, unknown>): AgyPermissionRules {
  const rawPerms =
    settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};
  return {
    allow: normalizeStringRuleList(rawPerms.allow),
    ask: normalizeStringRuleList(rawPerms.ask),
    deny: normalizeStringRuleList(rawPerms.deny),
  };
}

export function getAgyPermissionRules(
  profileDir: string,
  { createIfMissing = false } = {}
): AgyPermissionRules {
  return withSettingsPath(profileDir, (file) => {
    if (createIfMissing) {
      ensureSettings(file);
    } else if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
      return { allow: [], ask: [], deny: [] };
    }
    return withSettingsFile(file, fs.constants.O_RDONLY, (fd) => {
      const settings = parseSettings(fs.readFileSync(fd));
      return extractPermissionRules(settings);
    });
  });
}

export function updateAgyPermissionRules(
  profileDir: string,
  mutator: (current: AgyPermissionRules) => AgyPermissionRules
): AgyPermissionRules {
  return withSettingsPath(profileDir, (file) => {
    ensureSettings(file);
    return withSettingsFile(file, fs.constants.O_RDWR, (fd) => {
      const original = fs.fstatSync(fd, { bigint: true });
      const previous = fs.readFileSync(fd);
      const settings = parseSettings(previous);
      const current = extractPermissionRules(settings);
      const nextRaw = mutator(current);
      const next: AgyPermissionRules = {
        allow: normalizeStringRuleList(nextRaw.allow),
        ask: normalizeStringRuleList(nextRaw.ask),
        deny: normalizeStringRuleList(nextRaw.deny),
      };

      const unchanged =
        next.allow.length === current.allow.length &&
        next.allow.every((v, i) => v === current.allow[i]) &&
        next.ask.length === current.ask.length &&
        next.ask.every((v, i) => v === current.ask[i]) &&
        next.deny.length === current.deny.length &&
        next.deny.every((v, i) => v === current.deny[i]);
      if (unchanged) {
        return current;
      }

      const rawPermsObj =
        settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
          ? (settings.permissions as Record<string, unknown>)
          : {};
      const nextPermsObj: Record<string, unknown> = {
        ...rawPermsObj,
        allow: next.allow,
      };
      if (next.ask.length > 0 || Array.isArray(rawPermsObj.ask)) {
        nextPermsObj.ask = next.ask;
      }
      if (next.deny.length > 0 || Array.isArray(rawPermsObj.deny)) {
        nextPermsObj.deny = next.deny;
      }

      const json = Buffer.from(
        `${JSON.stringify({ ...settings, permissions: nextPermsObj }, null, 2)}\n`,
        'utf8'
      );
      const updated = Buffer.alloc(Math.max(json.length, previous.length), 0x20);
      json.copy(updated);
      assertSettingsUnchanged(fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }), original);

      const written = fs.writeSync(fd, updated, 0, updated.length, 0);
      if (written !== updated.length) {
        fs.writeSync(fd, previous, 0, Math.min(previous.length, written), 0);
        fs.ftruncateSync(fd, previous.length);
        throw new Error('Antigravity の settings.json を保存できませんでした。');
      }
      assertSettingsUnchanged(
        fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }),
        fs.fstatSync(fd, { bigint: true })
      );
      return next;
    });
  });
}

export function addAgyAllowPermissionRule(profileDir: string, rule: string): AgyPermissionRules {
  const trimmed = rule.trim();
  if (!isValidAgyPermissionRule(trimmed)) {
    throw new Error('無効なパーミッションルール形式です。');
  }
  return updateAgyPermissionRules(profileDir, (current) => ({
    allow: current.allow.includes(trimmed) ? current.allow : [...current.allow, trimmed],
    ask: current.ask.filter((item) => item !== trimmed),
    deny: current.deny,
  }));
}

export function syncMcpServerAlwaysAllowRules(params: {
  profileDirs: string[];
  serverName: string;
  previousServerName?: string | null;
  alwaysAllowTools: string[];
  revokeTools?: string[];
  removeAllForServer?: boolean;
}): void {
  const prefixCurrent = `mcp(${params.serverName.trim()}/`;
  const prefixPrev =
    params.previousServerName && params.previousServerName.trim() !== params.serverName.trim()
      ? `mcp(${params.previousServerName.trim()}/`
      : null;

  const desiredRules = params.removeAllForServer
    ? []
    : params.alwaysAllowTools
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0 && !/[\r\n\0)]/.test(tool))
        .map((tool) => formatMcpPermissionRule(params.serverName, tool));
  const desiredSet = new Set(desiredRules);

  const revokeSet = new Set(
    (params.revokeTools ?? [])
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0 && !/[\r\n\0)]/.test(tool))
      .map((tool) => formatMcpPermissionRule(params.serverName, tool))
      .filter((rule) => !desiredSet.has(rule))
  );

  for (const profileDir of params.profileDirs) {
    if (!profileDir) continue;
    updateAgyPermissionRules(profileDir, (current) => {
      const filteredAllow = current.allow.filter((rule) => {
        if (prefixPrev && rule.startsWith(prefixPrev) && rule.endsWith(')')) return false;
        if (params.removeAllForServer && rule.startsWith(prefixCurrent) && rule.endsWith(')')) return false;
        if (revokeSet.has(rule)) return false;
        if (desiredSet.has(rule)) return false;
        return true;
      });
      const filteredAsk = current.ask.filter((rule) => !desiredSet.has(rule));
      return {
        allow: [...filteredAllow, ...desiredRules],
        ask: filteredAsk,
        deny: current.deny,
      };
    });
  }
}

