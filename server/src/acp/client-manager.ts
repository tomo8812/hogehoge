import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import mime from 'mime-types';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { diffLines } from 'diff';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AvailableCommand,
  type ClientConnection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
} from '@agentclientprotocol/sdk';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { decryptSmallSecret } from '../auth/password.js';
import {
  captureWorkspaceSnapshot,
  syncWorkspaceChangesAsArtifacts,
  type WorkspaceSnapshot,
} from '../files/artifacts.js';
import {
  detectContentFileType,
  formatFileLink,
  normalizeLinkCandidatePath,
  resolveArtifactFile,
  resolveAuthorizedChatFileReference,
} from '../files/link-resolver.js';
import {
  detectMimeAndPreviewKind,
  normalizeRelPath,
  PathContainmentError,
  resolveContainedExistingPath,
  resolveContainedWriteTarget,
  sanitizeFileName,
  sha256File,
  supportsWorkspaceTextWrites,
  writeWorkspaceTextFile,
} from '../files/workspace.js';
import type { PushNotificationService } from '../notifications/web-push.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  AcpConfigOption,
  AcpSelectOption,
  AttachmentRef,
  AvailableCommandItem,
  ChatRecord,
  ElicitationContentValue,
  ElicitationFormSchema,
  MessageActivity,
  PendingElicitationRecord,
  PendingPermissionRecord,
  SessionMessageItem,
  SubagentActivityItem,
  ToolCallItem,
} from '../types.js';
import type { SkillService } from '../skills/skill-service.js';
import type { McpService } from '../mcp/mcp-service.js';
import {
  buildAgyCommandSpec,
  probeBwrapSandbox,
  SANDBOX_HOME_MOUNT,
  SANDBOX_WORKSPACE_MOUNT,
} from './env-isolation.js';
import {
  addAgyAllowPermissionRule,
  AGY_AGENT_MODES,
  formatMcpPermissionRule,
  getAgyAgentMode,
  isValidAgyPermissionRule,
} from './profile-settings.js';

function normalizeTargetPathForRule(
  rawPath: string,
  workspaceDir: string,
  sandboxWorkspaceRoot: string
): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || /[\r\n\0)]/.test(trimmed)) return null;
  const hostPath = toHostWorkspacePath(workspaceDir, sandboxWorkspaceRoot, trimmed);
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedHost = path.resolve(hostPath);
  if (
    resolvedHost === resolvedWorkspace ||
    resolvedHost.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    const rel = path.relative(resolvedWorkspace, resolvedHost);
    return rel ? rel.replace(/\\/g, '/') : '.';
  }
  return hostPath;
}

export function deriveAgyPermissionRule(params: {
  toolCall: ToolCallItem;
  workspaceDir: string;
  sandboxWorkspaceRoot: string;
  knownMcpServerNames?: string[];
}): string | null {
  const { toolCall, workspaceDir, sandboxWorkspaceRoot, knownMcpServerNames = [] } = params;
  if (!toolCall || toolCall.toolCallId.startsWith('interaction_')) {
    return null;
  }

  const name = (toolCall.name ?? '').trim();
  const title = (toolCall.title ?? '').trim();
  const kind = (toolCall.kind ?? '').trim().toLowerCase();
  const rawObj =
    toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)
      ? (toolCall.rawInput as Record<string, unknown>)
      : null;

  const firstStr = (...candidates: unknown[]): string | null => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  };

  // 1) Explicit mcp(server/tool) in title/name
  const explicitMcp = /\bmcp\(([^/\r\n\0)]+)\/([^)\r\n\0]+)\)/.exec(`${name} ${title}`);
  if (explicitMcp) {
    const rule = formatMcpPermissionRule(explicitMcp[1], explicitMcp[2]);
    return isValidAgyPermissionRule(rule) ? rule : null;
  }

  // 2) MCP tool calls via call_mcp_tool or rawInput { ServerName, ToolName }
  const mcpServerFromInput = firstStr(
    rawObj?.ServerName,
    rawObj?.serverName,
    rawObj?.server,
    rawObj?.mcpServer
  );
  const mcpToolFromInput = firstStr(
    rawObj?.ToolName,
    rawObj?.toolName,
    rawObj?.tool,
    rawObj?.mcpTool
  );
  if (mcpServerFromInput && mcpToolFromInput) {
    const rule = formatMcpPermissionRule(mcpServerFromInput, mcpToolFromInput);
    return isValidAgyPermissionRule(rule) ? rule : null;
  }

  // 3) Eager-loaded MCP tools: mcp__<server>__<tool> or mcp_<server>_<tool>
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const sepIdx = rest.indexOf('__');
    if (sepIdx > 0 && sepIdx + 2 < rest.length) {
      const rule = formatMcpPermissionRule(rest.slice(0, sepIdx), rest.slice(sepIdx + 2));
      if (isValidAgyPermissionRule(rule)) return rule;
    }
  }
  if (name.startsWith('mcp_')) {
    const rest = name.slice('mcp_'.length);
    const sortedKnown = [...knownMcpServerNames].sort((a, b) => b.length - a.length);
    for (const srv of sortedKnown) {
      if (rest.startsWith(`${srv}_`) && rest.length > srv.length + 1) {
        const rule = formatMcpPermissionRule(srv, rest.slice(srv.length + 1));
        if (isValidAgyPermissionRule(rule)) return rule;
      }
    }
    const firstUnderscore = rest.indexOf('_');
    if (firstUnderscore > 0 && firstUnderscore + 1 < rest.length) {
      const rule = formatMcpPermissionRule(rest.slice(0, firstUnderscore), rest.slice(firstUnderscore + 1));
      if (isValidAgyPermissionRule(rule)) return rule;
    }
  }

  // 4) Terminal commands
  if (
    kind === 'execute' ||
    name === 'run_command' ||
    name === 'bash' ||
    name === 'execute_command'
  ) {
    const rawCmd = firstStr(rawObj?.CommandLine, rawObj?.command, rawObj?.cmd);
    if (rawCmd) {
      const cleanLine = rawCmd.split(/[\r\n\0]/)[0]?.trim() ?? '';
      const safeTarget = cleanLine.includes(')')
        ? cleanLine.slice(0, cleanLine.indexOf(')')).trim().split(/\s+/)[0] ?? ''
        : cleanLine;
      if (safeTarget) {
        const rule = `command(${safeTarget})`;
        if (isValidAgyPermissionRule(rule)) return rule;
      }
    }
    return null;
  }

  // 5) File write / edit
  if (
    kind === 'edit' ||
    kind === 'delete' ||
    kind === 'move' ||
    [
      'write_to_file',
      'replace_file_content',
      'multi_replace_file_content',
      'write_file',
      'edit_file',
      'writeTextFile',
    ].includes(name)
  ) {
    const rawPath = firstStr(
      toolCall.locations?.[0]?.path,
      rawObj?.TargetFile,
      rawObj?.targetFile,
      rawObj?.file_path,
      rawObj?.path
    );
    if (rawPath) {
      const target = normalizeTargetPathForRule(rawPath, workspaceDir, sandboxWorkspaceRoot);
      if (target) {
        const rule = `write_file(${target})`;
        if (isValidAgyPermissionRule(rule)) return rule;
      }
    }
    return null;
  }

  // 6) File read / search
  if (
    kind === 'read' ||
    kind === 'search' ||
    [
      'view_file',
      'read_file',
      'readTextFile',
      'grep_search',
      'find_by_name',
      'list_dir',
    ].includes(name)
  ) {
    const rawPath = firstStr(
      toolCall.locations?.[0]?.path,
      rawObj?.AbsolutePath,
      rawObj?.SearchPath,
      rawObj?.DirectoryPath,
      rawObj?.file_path,
      rawObj?.path
    );
    if (rawPath) {
      const target = normalizeTargetPathForRule(rawPath, workspaceDir, sandboxWorkspaceRoot);
      if (target) {
        const rule = `read_file(${target})`;
        if (isValidAgyPermissionRule(rule)) return rule;
      }
    }
    return null;
  }

  // 7) URL fetch / browser
  if (
    kind === 'fetch' ||
    ['read_url_content', 'read_url', 'fetch_url', 'browse', 'execute_url'].includes(name)
  ) {
    const firstUrl = Array.isArray(rawObj?.urls) ? rawObj.urls[0] : undefined;
    const rawUrl = firstStr(rawObj?.Url, rawObj?.url, firstUrl);
    if (rawUrl) {
      try {
        const host = new URL(rawUrl).hostname.trim();
        if (host) {
          const action = name.includes('execute') || name.includes('browse') ? 'execute_url' : 'read_url';
          const rule = `${action}(${host})`;
          if (isValidAgyPermissionRule(rule)) return rule;
        }
      } catch {
        // ignore invalid URL
      }
    }
    return null;
  }

  return null;
}

export function classifySubagentToolCall(params: {
  name?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawContent?: unknown;
}): { isSubagent: boolean; isAsyncSubagentLaunch?: boolean; subagentLabel?: string } {
  const nameStr = (params.name ?? '').trim();
  const titleStr = (params.title ?? '').trim();
  const combined = `${nameStr} ${titleStr}`;

  const rawObj =
    params.rawInput && typeof params.rawInput === 'object' && !Array.isArray(params.rawInput)
      ? (params.rawInput as Record<string, unknown>)
      : null;

  const isImageGen =
    /generate_image|image_gen|画像生成/i.test(combined) ||
    Boolean(
      rawObj &&
        ('ImageName' in rawObj || 'image_name' in rawObj) &&
        ('Prompt' in rawObj || 'prompt' in rawObj)
    );

  if (isImageGen) {
    const imgName =
      (rawObj && typeof rawObj.ImageName === 'string' && rawObj.ImageName.trim()) ||
      (rawObj && typeof rawObj.image_name === 'string' && rawObj.image_name.trim()) ||
      titleStr ||
      'generate_image';
    return {
      isSubagent: true,
      isAsyncSubagentLaunch: false,
      subagentLabel: `画像生成サブエージェント (${imgName})`,
    };
  }

  const hasSubagentsArray = Boolean(
    rawObj && Array.isArray(rawObj.Subagents) && rawObj.Subagents.length > 0
  );
  const hasSessionRefContent =
    Array.isArray(params.rawContent) &&
    params.rawContent.some(
      (c) =>
        c &&
        typeof c === 'object' &&
        ((c as { type?: string }).type === 'session' || (c as { type?: string }).type === 'subagent')
    );
  const isAsyncLaunch =
    hasSubagentsArray ||
    hasSessionRefContent ||
    /\binvoke_subagent\b|\bspawn_agent\b|\bdelegate_agent\b/i.test(combined);

  const isSubagentTool =
    isAsyncLaunch ||
    /define_subagent|manage_subagents|subagent|teamwork|サブエージェント/i.test(combined);

  if (isSubagentTool) {
    if (hasSubagentsArray && rawObj && Array.isArray(rawObj.Subagents)) {
      const roles = rawObj.Subagents.map((s) => {
        if (s && typeof s === 'object') {
          const item = s as Record<string, unknown>;
          return (
            (typeof item.Role === 'string' && item.Role.trim()) ||
            (typeof item.TypeName === 'string' && item.TypeName.trim()) ||
            ''
          );
        }
        return '';
      }).filter(Boolean);
      if (roles.length > 0) {
        return {
          isSubagent: true,
          isAsyncSubagentLaunch: isAsyncLaunch,
          subagentLabel: `サブエージェント (${roles.join(', ')})`,
        };
      }
    }
    return {
      isSubagent: true,
      isAsyncSubagentLaunch: isAsyncLaunch,
      subagentLabel: `サブエージェント (${titleStr || nameStr || '実行'})`,
    };
  }

  return { isSubagent: false };
}

function captureWorkspaceSkillsSignature(workspaceDir: string): string {
  const roots = [
    path.join(workspaceDir, '.agents', 'skills'),
    path.join(workspaceDir, '.agent', 'skills'),
  ];
  const parts: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillMd = path.join(root, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const st = fs.statSync(skillMd);
          parts.push(`${root}:${entry.name}:${st.size}:${Math.floor(st.mtimeMs)}`);
        }
      }
    } catch {
      // ignore
    }
  }
  return parts.join('|');
}

export function mapAcpAvailableCommands(raw: unknown): AvailableCommandItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AvailableCommandItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as AvailableCommand;
    const name = typeof item.name === 'string' ? item.name.trim().replace(/^\//, '') : '';
    if (!name) continue;
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const inputHint =
      item.input && typeof item.input === 'object' && typeof item.input.hint === 'string'
        ? item.input.hint
        : null;
    out.push({
      name,
      description: description || name,
      ...(inputHint ? { inputHint } : {}),
      source: 'acp',
    });
  }
  return out;
}

export function toHostWorkspacePath(
  workerWorkspaceDir: string,
  sandboxWorkspaceRoot: string,
  acpPath: string
): string {
  let cleaned = acpPath.trim();
  if (cleaned.startsWith('file://')) {
    try {
      cleaned = fileURLToPath(cleaned, { windows: sandboxWorkspaceRoot === workerWorkspaceDir ? undefined : false });
    } catch {
      // Keep raw string so path containment check rejects malformed URIs
    }
  }
  if (!cleaned) return '';
  if (sandboxWorkspaceRoot !== workerWorkspaceDir) {
    if (cleaned === sandboxWorkspaceRoot) {
      return workerWorkspaceDir;
    }
    if (cleaned.startsWith(`${sandboxWorkspaceRoot}/`)) {
      return cleaned.slice(sandboxWorkspaceRoot.length + 1);
    }
  }
  return cleaned;
}

function workspaceFilePath(worker: WorkerInstance, acpPath: string): string {
  const candidate = acpPath.startsWith('file://') ? fileURLToPath(acpPath) : acpPath;
  const isWindows = path.sep === '\\';
  const segments = isWindows ? candidate.split(/[\\/]/) : candidate.split('/');
  if (segments.includes('..') || (!isWindows && candidate.includes('\\'))) {
    throw new PathContainmentError('無効な作業ファイルのパスです。');
  }
  if (!path.isAbsolute(candidate)) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) || (isWindows && /^[a-z]:/i.test(candidate))) {
      throw new PathContainmentError('ローカルファイルのパスを指定してください。');
    }
    return normalizeRelPath(candidate);
  }

  // Resolve absolute paths in the agent's namespace before using the host workspace.
  const relative = path.relative(worker.sandboxWorkspaceRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathContainmentError('許可された作業領域外のファイルにはアクセスできません。');
  }
  return normalizeRelPath(relative);
}

function summarizeToolDiff(content: ToolCall['content'] | null): ToolCallItem['diffStats'] {
  const diffs = content?.filter((item) => item.type === 'diff');
  if (!diffs?.length) return undefined;

  const stats = { added: 0, removed: 0 };
  for (const diff of diffs) {
    const lines = diffLines(diff.oldText ?? '', diff.newText, { timeout: 25 });
    if (!lines) return undefined;
    for (const line of lines) {
      if (line.added) stats.added += line.count;
      if (line.removed) stats.removed += line.count;
    }
  }
  return stats;
}

export interface ParsedSessionOptions {
  configOptions: AcpConfigOption[];
  modelOptionId: string | null;
  effortOptionId: string | null;
  currentModelId: string | null;
  currentEffortValue: string | null;
  availableCommands?: AvailableCommandItem[];
}

export function normalizeConfigOptions(
  rawList: SessionConfigOption[] | null | undefined,
  availableCommands?: AvailableCommandItem[]
): ParsedSessionOptions {
  const normalized: AcpConfigOption[] = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (item.type !== 'select') continue;
      const flatOptions: AcpSelectOption[] = [];
      for (const entry of item.options) {
        if ('group' in entry && Array.isArray(entry.options)) {
          for (const sub of entry.options) {
            flatOptions.push({
              value: sub.value,
              name: `${entry.name}: ${sub.name}`,
              description: sub.description ?? null,
            });
          }
        } else if ('value' in entry) {
          flatOptions.push({
            value: entry.value,
            name: entry.name,
            description: entry.description ?? null,
          });
        }
      }
      normalized.push({
        id: item.id,
        name: item.name,
        category: item.category ?? null,
        currentValue: item.currentValue,
        options: flatOptions,
      });
    }
  }

  const modelOpt =
    normalized.find((c) => c.category === 'model') ??
    normalized.find((c) => c.id.toLowerCase().includes('model')) ??
    null;
  const effortOpt =
    normalized.find((c) => c.category === 'thought_level') ??
    normalized.find((c) => c.category === 'model_config' && /effort|thought|reason/i.test(c.id)) ??
    normalized.find((c) => /effort|thought|reasoning/i.test(c.id)) ??
    null;

  return {
    configOptions: normalized,
    modelOptionId: modelOpt?.id ?? null,
    effortOptionId: effortOpt?.id ?? null,
    currentModelId: modelOpt?.currentValue ?? null,
    currentEffortValue: effortOpt?.currentValue ?? null,
    ...(availableCommands ? { availableCommands } : {}),
  };
}

interface TrackedSubagentState {
  sessionId: string;
  toolCallId: string;
  title: string;
  description?: string;
  state: 'running' | 'idle' | 'requires_action' | 'unknown';
  stopReason?: string | null;
  thoughtsText: string;
  contentText: string;
  toolCalls: SubagentActivityItem[];
  lastActivityAt: number;
}

interface ActiveTurnBridge {
  runId: string;
  userId: string;
  chatId: string;
  assistantMessageId: string;
  contentText: string;
  thoughtsText: string;
  toolCalls: ToolCallItem[];
  activity: MessageActivity[];
  sessionMessages: SessionMessageItem[];
  lastDbFlushAt: number;
  pendingResolvers: Map<string, (outcome: RequestPermissionResponse) => void>;
  pendingElicitationResolvers: Map<string, (resp: CreateElicitationResponse) => void>;
  beforeWorkspaceSnap: WorkspaceSnapshot;
  emittedArtifactIds: Set<string>;
  lastActivityAt: number;
  subagents: Map<string, TrackedSubagentState>;
  asyncSubagentToolIds: Set<string>;
  initialPromptDone: boolean;
  parentState: 'running' | 'idle' | 'requires_action' | 'unknown';
  backgroundWorkCount: number;
  parentWakeupStarted: boolean;
  receivedWakeupText: boolean;
  wakeupCount: number;
  wakeupContentOffset: number;
  lastParentActivityAt: number;
}

interface WorkerInstance {
  key: string; // `${userId}:${chatId}`
  userId: string;
  chatId: string;
  profileDir: string;
  workspaceDir: string;
  sandboxed: boolean;
  sandboxWorkspaceRoot: string;
  process: ChildProcessWithoutNullStreams;
  conn: ClientConnection;
  init: InitializeResponse;
  acpSessionId: string | null;
  parsedOptions: ParsedSessionOptions;
  supportsSystemPrompt: boolean;
  inFlight: boolean;
  lastUsedAt: number;
  activeTurn: ActiveTurnBridge | null;
  backgroundBridge: ActiveTurnBridge | null;
  turnBridges: Map<string, ActiveTurnBridge>;
  lastBackgroundActivityAt: number;
  stderrTail: string[];
}

export class AcpClientManager {
  private readonly workers = new Map<string, WorkerInstance>();
  private readonly connecting = new Map<string, Promise<WorkerInstance>>();
  private readonly userOptionsCache = new Map<string, { options: ParsedSessionOptions; cachedAt: number }>();
  private readonly userOptionProbes = new Map<string, Promise<ParsedSessionOptions | null>>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub,
    private readonly skillService?: SkillService,
    private readonly pushService?: PushNotificationService,
    private readonly mcpService?: McpService
  ) {
    this.cleanupTimer = setInterval(() => this.evictIdleWorkers(), 30_000);
    this.cleanupTimer.unref();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.workers.keys()].map((k) => this.stopWorkerByKey(k)));
  }

  invalidateUserOptionsCache(userId: string): void {
    for (const key of [...this.userOptionsCache.keys()]) {
      if (key.startsWith(`${userId}:`)) {
        this.userOptionsCache.delete(key);
      }
    }
  }

  async stopAllForUser(userId: string): Promise<void> {
    this.invalidateUserOptionsCache(userId);
    const keys = [...this.workers.values()].filter((w) => w.userId === userId).map((w) => w.key);
    await Promise.allSettled(keys.map((k) => this.stopWorkerByKey(k)));
  }

  async stopIdleWorkersForUser(userId: string): Promise<void> {
    this.invalidateUserOptionsCache(userId);
    const keys = [...this.workers.values()]
      .filter((w) => w.userId === userId && !this.isWorkerBusy(w))
      .map((w) => w.key);
    await Promise.allSettled(keys.map((k) => this.stopWorkerByKey(k)));
  }

  async stopIdleWorkersForAllUsers(): Promise<void> {
    this.userOptionsCache.clear();
    const keys = [...this.workers.values()]
      .filter((w) => !this.isWorkerBusy(w))
      .map((w) => w.key);
    await Promise.allSettled(keys.map((k) => this.stopWorkerByKey(k)));
  }

  async stopChatWorker(userId: string, chatId: string): Promise<void> {
    await this.stopWorkerByKey(`${userId}:${chatId}`);
  }

  async stopChatWorkerIfIdle(userId: string, chatId: string): Promise<boolean> {
    const key = `${userId}:${chatId}`;
    const w = this.workers.get(key);
    if (!w) return true;
    if (this.isWorkerBusy(w)) return false;
    await this.stopWorkerByKey(key);
    return true;
  }

  private mergeAvailableCommands(
    userId: string,
    acpCommands: AvailableCommandItem[] | undefined,
    ctx: { projectId?: string | null; chatId?: string | null }
  ): AvailableCommandItem[] {
    const skillCommands = this.skillService
      ? this.skillService.listAvailableSkillCommands(userId, ctx)
      : [];
    const byName = new Map<string, AvailableCommandItem>();

    for (const cmd of acpCommands ?? []) {
      byName.set(cmd.name.toLowerCase(), cmd);
    }
    for (const sk of skillCommands) {
      byName.set(sk.name.toLowerCase(), sk);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private enrichParsedOptions(
    userId: string,
    parsed: ParsedSessionOptions,
    ctx: { projectId?: string | null; chatId?: string | null },
    acpCommandsOverride?: AvailableCommandItem[]
  ): ParsedSessionOptions {
    const baseCommands =
      acpCommandsOverride ??
      (parsed.availableCommands ?? []).filter((c) => c.source !== 'skill');
    const merged = this.mergeAvailableCommands(userId, baseCommands, ctx);
    return {
      ...parsed,
      availableCommands: merged,
    };
  }

  async getOrProbeUserOptions(
    userId: string,
    desiredModelId: string | null = null,
    ctx: { projectId?: string | null; chatId?: string | null } = {}
  ): Promise<ParsedSessionOptions | null> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile || profile.authStatus !== 'authenticated') {
      return null;
    }

    // Reuse an already-running worker for this user if model matches (or no preference specified)
    for (const worker of this.workers.values()) {
      if (
        worker.userId === userId &&
        worker.parsedOptions.configOptions.length > 0 &&
        (!desiredModelId || worker.parsedOptions.currentModelId === desiredModelId)
      ) {
        this.cacheUserOptions(userId, worker.parsedOptions);
        return this.enrichParsedOptions(userId, worker.parsedOptions, ctx);
      }
    }

    const cacheKey = `${userId}:${desiredModelId ?? ''}`;
    const cached = this.userOptionsCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < 15 * 60 * 1000) {
      return this.enrichParsedOptions(userId, cached.options, ctx);
    }

    const inFlight = this.userOptionProbes.get(cacheKey);
    if (inFlight) {
      const res = await inFlight;
      return res ? this.enrichParsedOptions(userId, res, ctx) : null;
    }

    const promise = this.probeUserOptionsOnce(userId, profile.profileDir, desiredModelId).finally(() => {
      this.userOptionProbes.delete(cacheKey);
    });
    this.userOptionProbes.set(cacheKey, promise);
    const res = await promise;
    return res ? this.enrichParsedOptions(userId, res, ctx) : null;
  }

  private cacheUserOptions(userId: string, options: ParsedSessionOptions): void {
    const now = Date.now();
    const acpOnly = (options.availableCommands ?? []).filter((c) => c.source !== 'skill');
    const baseOptions: ParsedSessionOptions = { ...options, availableCommands: acpOnly };
    this.userOptionsCache.set(`${userId}:`, { options: baseOptions, cachedAt: now });
    if (options.currentModelId) {
      this.userOptionsCache.set(`${userId}:${options.currentModelId}`, { options: baseOptions, cachedAt: now });
    }
  }

  private async probeUserOptionsOnce(
    userId: string,
    profileDir: string,
    desiredModelId: string | null
  ): Promise<ParsedSessionOptions | null> {
    const tempProbeCwd = path.join(profileDir, '.tmp', 'options-probe');
    fs.mkdirSync(tempProbeCwd, { recursive: true, mode: 0o700 });
    const apiKey = this.loadApiKeyForUser(userId);
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir,
      workspaceDir: tempProbeCwd,
      geminiApiKey: apiKey,
      enableSandboxBwrap: false,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: tempProbeCwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      let capturedCommands: AvailableCommandItem[] = [];
      const app = client({ name: 'antigravity-chat-options-probe' }).onNotification(
        methods.client.session.update,
        async ({ params }) => {
          if (params.update.sessionUpdate === 'available_commands_update') {
            capturedCommands = mapAcpAvailableCommands(params.update.availableCommands);
          }
        }
      );
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      );
      const conn = app.connect(stream);
      const init = await Promise.race([
        conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'antigravity-chat-ui', title: 'Antigravity Chat UI', version: this.config.appVersion },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ACP options initialize timeout')), 15_000)),
      ]);

      const created = (await conn.agent.request(methods.agent.session.new, {
        cwd: tempProbeCwd,
        mcpServers: [],
      })) as NewSessionResponse;
      let parsed = normalizeConfigOptions(created.configOptions, capturedCommands);

      if (desiredModelId && parsed.modelOptionId && parsed.currentModelId !== desiredModelId) {
        const updated = await conn.agent
          .request(methods.agent.session.setConfigOption, {
            sessionId: created.sessionId,
            configId: parsed.modelOptionId,
            value: desiredModelId,
          })
          .catch(() => null);
        if (updated) {
          parsed = normalizeConfigOptions(updated.configOptions, capturedCommands);
        }
      }

      if (init.agentCapabilities?.sessionCapabilities?.close && created.sessionId) {
        await conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId }).catch(() => {});
      }
      conn.close();

      if (parsed.configOptions.length > 0) {
        this.userOptionsCache.set(`${userId}:${desiredModelId ?? ''}`, { options: parsed, cachedAt: Date.now() });
        this.cacheUserOptions(userId, parsed);
      }
      return this.enrichParsedOptions(userId, parsed, {}, capturedCommands);
    } catch {
      return null;
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  /**
   * Probes official ACP `initialize` + optionally `session/new` to verify that
   * an isolated profile is genuinely authenticated without inspecting token files.
   */
  async verifyProfileViaOfficialAcp(userId: string, tempProbeCwd: string): Promise<{
    authenticated: boolean;
    authMethods: Array<{ id: string; name: string }>;
    error?: string;
  }> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile) {
      return { authenticated: false, authMethods: [], error: 'Profile not found' };
    }
    const apiKey = this.loadApiKeyForUser(userId);
    fs.mkdirSync(tempProbeCwd, { recursive: true, mode: 0o700 });
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir: profile.profileDir,
      workspaceDir: tempProbeCwd,
      geminiApiKey: apiKey,
      enableSandboxBwrap: false,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: tempProbeCwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const app = client({ name: 'antigravity-chat-probe' });
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
      );
      const conn = app.connect(stream);
      const init = await Promise.race([
        conn.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'antigravity-chat-ui', title: 'Antigravity Chat UI', version: this.config.appVersion },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ACP initialize timeout')), 15_000)),
      ]);

      const authMethods = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name }));
      // Probe session/new cleanly and close immediately
      const created = await conn.agent.request(methods.agent.session.new, {
        cwd: tempProbeCwd,
        mcpServers: [],
      });
      if (init.agentCapabilities?.sessionCapabilities?.close && created.sessionId) {
        await conn.agent.request(methods.agent.session.close, { sessionId: created.sessionId }).catch(() => {});
      }
      conn.close();
      return { authenticated: true, authMethods };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { authenticated: false, authMethods: [], error: msg };
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  async attemptOfficialLogoutViaAcp(userId: string, tempCwd: string): Promise<void> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile) return;
    fs.mkdirSync(tempCwd, { recursive: true, mode: 0o700 });
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir: profile.profileDir,
      workspaceDir: tempCwd,
      enableSandboxBwrap: false,
    });
    const child = spawn(spec.command, spec.args, { cwd: tempCwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const app = client({ name: 'antigravity-chat-logout' });
      const conn = app.connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );
      const init = await conn.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
      });
      if (init.agentCapabilities?.auth?.logout) {
        await conn.agent.request(methods.agent.logout, {});
      }
      conn.close();
    } catch {
      // Fall through to CLI auth logout
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  async ensureSessionOptions(userId: string, chatId: string): Promise<ParsedSessionOptions> {
    const chat = this.db.getChat(userId, chatId);
    const worker = await this.getOrStartWorker(userId, chatId);
    if (worker.parsedOptions.configOptions.length > 0) {
      this.cacheUserOptions(userId, worker.parsedOptions);
    }
    const enriched = this.enrichParsedOptions(userId, worker.parsedOptions, {
      projectId: chat?.projectId ?? null,
      chatId,
    });
    worker.parsedOptions = enriched;
    return enriched;
  }

  async setChatConfig(
    userId: string,
    chatId: string,
    patch: { modelId?: string | null; effortValue?: string | null }
  ): Promise<{ chat: ChatRecord; configOptions: ParsedSessionOptions }> {
    const chat = this.db.getChat(userId, chatId);
    if (!chat) throw new Error('Chat not found');

    const worker = await this.getOrStartWorker(userId, chatId);
    if (!worker.acpSessionId) throw new Error('ACP session not initialized');

    if (patch.modelId && worker.parsedOptions.modelOptionId) {
      const prevAcpCommands = (worker.parsedOptions.availableCommands ?? []).filter(
        (c) => c.source !== 'skill'
      );
      const res = await worker.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: worker.acpSessionId,
        configId: worker.parsedOptions.modelOptionId,
        value: patch.modelId,
      });
      worker.parsedOptions = this.enrichParsedOptions(
        userId,
        normalizeConfigOptions(res.configOptions),
        { projectId: chat.projectId, chatId },
        prevAcpCommands
      );
    }

    if (patch.effortValue && worker.parsedOptions.effortOptionId) {
      const prevAcpCommands = (worker.parsedOptions.availableCommands ?? []).filter(
        (c) => c.source !== 'skill'
      );
      const res = await worker.conn.agent.request(methods.agent.session.setConfigOption, {
        sessionId: worker.acpSessionId,
        configId: worker.parsedOptions.effortOptionId,
        value: patch.effortValue,
      });
      worker.parsedOptions = this.enrichParsedOptions(
        userId,
        normalizeConfigOptions(res.configOptions),
        { projectId: chat.projectId, chatId },
        prevAcpCommands
      );
    }

    if (worker.parsedOptions.configOptions.length > 0) {
      this.cacheUserOptions(userId, worker.parsedOptions);
    }

    const updatedChat = this.db.updateChat(userId, chatId, {
      modelId: worker.parsedOptions.currentModelId ?? patch.modelId ?? chat.modelId,
      effortValue: worker.parsedOptions.currentEffortValue ?? patch.effortValue ?? chat.effortValue,
    })!;

    this.hub.emitDurable({
      userId,
      type: 'chat.updated',
      chatId,
      payload: { chat: updatedChat, sessionOptions: worker.parsedOptions },
    });

    return { chat: updatedChat, configOptions: worker.parsedOptions };
  }

  resolvePendingPermission(params: {
    userId: string;
    chatId: string;
    permissionId: string;
    selectedOptionId: string | null;
    alwaysAllow?: boolean;
    cancel?: boolean;
    clientId?: string | null;
  }): PendingPermissionRecord | null {
    const existing = this.db.getPermission(params.userId, params.permissionId);
    if (!existing || existing.chatId !== params.chatId || existing.status !== 'pending') {
      return null;
    }

    let effectiveOptionId = params.cancel ? null : params.selectedOptionId;
    if (!params.cancel && params.alwaysAllow) {
      const nativeAlwaysOpt = existing.options.find((o) => o.kind === 'allow_always');
      const allowOnceOpt = existing.options.find((o) => o.kind.startsWith('allow'));
      if (nativeAlwaysOpt) {
        effectiveOptionId = nativeAlwaysOpt.optionId;
      } else if (!effectiveOptionId && allowOnceOpt) {
        effectiveOptionId = allowOnceOpt.optionId;
      }
    }

    const chosenOption = effectiveOptionId
      ? existing.options.find((o) => o.optionId === effectiveOptionId) ?? null
      : null;
    const isAlwaysAllow =
      !params.cancel &&
      Boolean(params.alwaysAllow || chosenOption?.kind === 'allow_always');

    const status = params.cancel ? 'cancelled' : 'resolved';
    const updated = this.db.resolvePermissionAtomically({
      userId: params.userId,
      permissionId: params.permissionId,
      selectedOptionId: effectiveOptionId,
      status,
      clientId: params.clientId,
    });
    if (!updated) {
      return null;
    }

    if (isAlwaysAllow && existing.alwaysAllowRule) {
      const profile = this.db.getAgyProfile(params.userId);
      if (profile) {
        try {
          this.db.withAgyProfileSettingsWrite(() => {
            addAgyAllowPermissionRule(profile.profileDir, existing.alwaysAllowRule!);
          });
        } catch (err) {
          console.warn('[acp] Failed to persist always-allow permission rule:', err);
        }
      }
      const mcpMatch = /^mcp\(([^/]+)\/(.+)\)$/.exec(existing.alwaysAllowRule);
      if (mcpMatch) {
        this.mcpService?.recordToolAlwaysAllowFromChat(params.userId, mcpMatch[1], mcpMatch[2]);
      }
    }

    const worker = this.workers.get(`${params.userId}:${params.chatId}`);
    let targetBridge: ActiveTurnBridge | null = null;
    if (worker) {
      if (worker.activeTurn?.pendingResolvers.has(params.permissionId)) {
        targetBridge = worker.activeTurn;
      } else {
        for (const b of worker.turnBridges.values()) {
          if (b.pendingResolvers.has(params.permissionId)) {
            targetBridge = b;
            break;
          }
        }
        if (!targetBridge && worker.backgroundBridge?.pendingResolvers.has(params.permissionId)) {
          targetBridge = worker.backgroundBridge;
        }
      }
    }
    const resolver = targetBridge?.pendingResolvers.get(params.permissionId);
    if (resolver && targetBridge) {
      targetBridge.pendingResolvers.delete(params.permissionId);
      if (params.cancel || !effectiveOptionId) {
        resolver({ outcome: { outcome: 'cancelled' } });
      } else {
        resolver({ outcome: { outcome: 'selected', optionId: effectiveOptionId } });
      }
    }

    const run = this.db.getRun(params.userId, updated.runId);
    if (run && run.status === 'awaiting_permission') {
      this.db.updateRun(params.userId, run.id, { status: 'running' });
    }

    this.hub.emitDurable({
      userId: params.userId,
      type: 'permission.resolved',
      chatId: params.chatId,
      runId: updated.runId,
      payload: { permission: updated },
    });
    return updated;
  }

  resolvePendingElicitation(params: {
    userId: string;
    chatId: string;
    elicitationId: string;
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, ElicitationContentValue> | null;
    clientId?: string | null;
  }): PendingElicitationRecord | null {
    const existing = this.db.getElicitation(params.userId, params.elicitationId);
    if (!existing || existing.chatId !== params.chatId || existing.status !== 'pending') {
      return null;
    }

    const status: PendingElicitationRecord['status'] =
      params.action === 'cancel' ? 'cancelled' : 'resolved';
    const responseContent =
      params.action === 'accept' ? (params.content ?? null) : null;

    const updated = this.db.resolveElicitationAtomically({
      userId: params.userId,
      elicitationId: params.elicitationId,
      selectedAction: params.action,
      responseContent,
      status,
      clientId: params.clientId,
    });
    if (!updated) {
      return null;
    }

    const worker = this.workers.get(`${params.userId}:${params.chatId}`);
    let targetBridge: ActiveTurnBridge | null = null;
    if (worker) {
      if (worker.activeTurn?.pendingElicitationResolvers.has(params.elicitationId)) {
        targetBridge = worker.activeTurn;
      } else {
        for (const b of worker.turnBridges.values()) {
          if (b.pendingElicitationResolvers.has(params.elicitationId)) {
            targetBridge = b;
            break;
          }
        }
        if (!targetBridge && worker.backgroundBridge?.pendingElicitationResolvers.has(params.elicitationId)) {
          targetBridge = worker.backgroundBridge;
        }
      }
    }
    const resolver = targetBridge?.pendingElicitationResolvers.get(params.elicitationId);
    if (resolver && targetBridge) {
      targetBridge.pendingElicitationResolvers.delete(params.elicitationId);
      if (params.action === 'accept') {
        resolver({
          action: 'accept',
          ...(responseContent !== null ? { content: responseContent } : {}),
        });
      } else {
        resolver({ action: params.action });
      }
    }

    const run = this.db.getRun(params.userId, updated.runId);
    if (
      run &&
      run.status === 'awaiting_permission' &&
      (!targetBridge ||
        (targetBridge.pendingResolvers.size === 0 &&
          targetBridge.pendingElicitationResolvers.size === 0))
    ) {
      this.db.updateRun(params.userId, run.id, { status: 'running' });
    }

    this.hub.emitDurable({
      userId: params.userId,
      type: 'elicitation.resolved',
      chatId: params.chatId,
      runId: updated.runId,
      payload: { elicitation: updated },
    });
    return updated;
  }

  async cancelTurn(userId: string, chatId: string, runId: string): Promise<void> {
    const worker = this.workers.get(`${userId}:${chatId}`);
    if (!worker || !worker.activeTurn || worker.activeTurn.runId !== runId) {
      return;
    }
    // Reject any awaiting permissions and elicitations for this run first so prompt returns immediately
    for (const [permId, resolver] of worker.activeTurn.pendingResolvers.entries()) {
      this.db.resolvePermissionAtomically({
        userId,
        permissionId: permId,
        selectedOptionId: null,
        status: 'cancelled',
      });
      resolver({ outcome: { outcome: 'cancelled' } });
    }
    worker.activeTurn.pendingResolvers.clear();

    for (const [elicitId, resolver] of worker.activeTurn.pendingElicitationResolvers.entries()) {
      const updated = this.db.resolveElicitationAtomically({
        userId,
        elicitationId: elicitId,
        selectedAction: 'cancel',
        status: 'cancelled',
      });
      if (updated) {
        this.hub.emitDurable({
          userId,
          type: 'elicitation.resolved',
          chatId,
          runId,
          payload: { elicitation: updated },
        });
      }
      resolver({ action: 'cancel' });
    }
    worker.activeTurn.pendingElicitationResolvers.clear();

    if (worker.acpSessionId) {
      await worker.conn.agent
        .notify(methods.agent.session.cancel, { sessionId: worker.acpSessionId })
        .catch(() => {});
    }
  }

  async executeTurn(params: {
    userId: string;
    chatId: string;
    runId: string;
    userText: string;
    attachments: AttachmentRef[];
    assistantMessageId: string;
    abortSignal: AbortSignal;
  }): Promise<{ stopReason: PromptResponse['stopReason'] }> {
    const chat = this.db.getChat(params.userId, params.chatId);
    if (!chat) throw new Error('Chat not found');

    if (chat.projectId && this.skillService) {
      this.skillService.syncProjectSkillsToChat(params.userId, chat.projectId, chat.workspaceDir);
    }

    const worker = await this.getOrStartWorker(params.userId, params.chatId);
    if (worker.userId !== params.userId || !worker.acpSessionId) {
      throw new Error('ACP session mismatch or unavailable');
    }

    // Apply chat-scoped model/effort before prompting if out of sync
    if (
      (chat.modelId && worker.parsedOptions.currentModelId !== chat.modelId && worker.parsedOptions.modelOptionId) ||
      (chat.effortValue && worker.parsedOptions.currentEffortValue !== chat.effortValue && worker.parsedOptions.effortOptionId)
    ) {
      await this.setChatConfig(params.userId, params.chatId, {
        modelId: chat.modelId ?? undefined,
        effortValue: chat.effortValue ?? undefined,
      }).catch(() => {});
    }

    const beforeSkillsSig = captureWorkspaceSkillsSignature(chat.workspaceDir);
    const beforeSnap = captureWorkspaceSnapshot(chat.workspaceDir);
    const nowInit = Date.now();
    const bridge: ActiveTurnBridge = {
      runId: params.runId,
      userId: params.userId,
      chatId: params.chatId,
      assistantMessageId: params.assistantMessageId,
      contentText: '',
      thoughtsText: '',
      toolCalls: [],
      activity: [],
      sessionMessages: [],
      lastDbFlushAt: nowInit,
      pendingResolvers: new Map(),
      pendingElicitationResolvers: new Map(),
      beforeWorkspaceSnap: beforeSnap,
      emittedArtifactIds: new Set(),
      lastActivityAt: nowInit,
      subagents: new Map(),
      asyncSubagentToolIds: new Set(),
      initialPromptDone: false,
      parentWakeupStarted: false,
      receivedWakeupText: false,
      wakeupCount: 0,
      wakeupContentOffset: 0,
      lastParentActivityAt: nowInit,
      parentState: 'running',
      backgroundWorkCount: 0,
    };
    worker.inFlight = true;
    worker.lastUsedAt = Date.now();
    worker.activeTurn = bridge;
    worker.turnBridges.set(bridge.runId, bridge);
    this.pruneOldTurnBridges(worker);

    const onAbort = () => {
      this.cancelTurn(params.userId, params.chatId, params.runId).catch(() => {});
    };
    params.abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      const promptBlocks: ContentBlock[] = [];

      if (params.userText.trim()) {
        promptBlocks.push({ type: 'text', text: params.userText });
      }

      for (const att of params.attachments) {
        try {
          const file = resolveArtifactFile(this.db, chat, att);
          if (!file) continue;
          const { absPath, relPath } = file;
          const acpFilePath = worker.sandboxed
            ? path.posix.resolve(worker.sandboxWorkspaceRoot, relPath)
            : absPath;
          if (att.previewKind === 'image' && worker.init.agentCapabilities?.promptCapabilities?.image) {
            const b64 = fs.readFileSync(absPath).toString('base64');
            promptBlocks.push({
              type: 'image',
              mimeType: att.mimeType,
              data: b64,
              uri: `file://${acpFilePath}`,
            });
          } else {
            promptBlocks.push({
              type: 'resource_link',
              name: att.filename,
              mimeType: att.mimeType,
              size: att.sizeBytes,
              uri: `file://${acpFilePath}`,
            });
          }
        } catch {
          // ignore inaccessible attachment
        }
      }

      if (promptBlocks.length === 0) {
        promptBlocks.push({ type: 'text', text: '' });
      }

      const response = await worker.conn.agent.request(methods.agent.session.prompt, {
        sessionId: worker.acpSessionId,
        prompt: promptBlocks,
      });

      bridge.initialPromptDone = true;
      bridge.parentState = 'idle';
      bridge.wakeupContentOffset = bridge.contentText.length;
      // Yield to macrotask queue so any notifications queued in the same stdio frame are processed
      await new Promise((r) => setImmediate(r));

      const hintPaths = bridge.toolCalls.flatMap(tool => (tool.locations ?? [])
        .map(location => toHostWorkspacePath(worker.workspaceDir, worker.sandboxWorkspaceRoot, location.path)));

      const newArtifacts = syncWorkspaceChangesAsArtifacts({
        db: this.db,
        userId: params.userId,
        chatId: params.chatId,
        workspaceDir: chat.workspaceDir,
        messageId: params.assistantMessageId,
        runId: params.runId,
        before: beforeSnap,
        hintPaths,
      });

      if (bridge.activity.at(-1)?.kind === 'content') bridge.activity.push({ kind: 'answer_end' });

      const finalStatus = response.stopReason === 'cancelled' ? 'cancelled' : 'completed';
      const updatedMsg = this.db.updateMessage(params.userId, params.assistantMessageId, {
        contentText: bridge.contentText,
        thoughtsText: bridge.thoughtsText,
        toolCalls: bridge.toolCalls,
        activity: bridge.activity,
        sessionMessages: bridge.sessionMessages,
        artifactIds: [...new Set([...bridge.emittedArtifactIds, ...newArtifacts.map(a => a.id)])],
        status: finalStatus,
      })!;

      for (const art of newArtifacts) {
        if (bridge.emittedArtifactIds.has(art.id)) continue;
        bridge.emittedArtifactIds.add(art.id);
        this.hub.emitDurable({
          userId: params.userId,
          type: 'artifact.created',
          chatId: params.chatId,
          runId: params.runId,
          payload: { artifact: art },
        });
      }

      this.hub.emitDurable({
        userId: params.userId,
        type: 'message.updated',
        chatId: params.chatId,
        runId: params.runId,
        payload: { message: updatedMsg },
      });

      const afterSkillsSig = captureWorkspaceSkillsSignature(chat.workspaceDir);
      if (afterSkillsSig !== beforeSkillsSig && this.skillService) {
        const refreshed = this.enrichParsedOptions(params.userId, worker.parsedOptions, {
          projectId: chat.projectId,
          chatId: params.chatId,
        });
        worker.parsedOptions = refreshed;
        this.hub.emitDurable({
          userId: params.userId,
          type: 'skills.updated',
          projectId: chat.projectId,
          chatId: params.chatId,
          payload: {
            scope: 'workspace',
            projectId: chat.projectId,
            chatId: params.chatId,
          },
        });
        this.hub.emitDurable({
          userId: params.userId,
          type: 'chat.commands_updated',
          chatId: params.chatId,
          payload: {
            availableCommands: refreshed.availableCommands ?? [],
            sessionOptions: refreshed,
          },
        });
      }

      return { stopReason: response.stopReason };
    } catch (err) {
      bridge.initialPromptDone = true;
      bridge.parentState = 'idle';
      // Flush partial work even on error so nothing streamed so far is lost
      this.db.updateMessage(params.userId, params.assistantMessageId, {
        contentText: bridge.contentText,
        thoughtsText: bridge.thoughtsText,
        toolCalls: bridge.toolCalls,
        activity: bridge.activity,
        sessionMessages: bridge.sessionMessages,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      params.abortSignal.removeEventListener('abort', onAbort);
      worker.backgroundBridge = bridge;
      worker.activeTurn = null;
      worker.inFlight = false;
      worker.lastUsedAt = Date.now();
    }
  }

  private async getOrStartWorker(userId: string, chatId: string): Promise<WorkerInstance> {
    const key = `${userId}:${chatId}`;
    const existing = this.workers.get(key);
    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const pendingConnect = this.connecting.get(key);
    if (pendingConnect) return pendingConnect;

    const promise = this.startWorker(userId, chatId).finally(() => {
      this.connecting.delete(key);
    });
    this.connecting.set(key, promise);
    return promise;
  }

  private async startWorker(userId: string, chatId: string): Promise<WorkerInstance> {
    const profile = this.db.getAgyProfile(userId);
    if (!profile || profile.authStatus !== 'authenticated') {
      throw new Error('Antigravity認証が完了していません。設定から公式認証を完了してください。');
    }

    const chat = this.db.getChat(userId, chatId);
    if (!chat || chat.userId !== userId) {
      throw new Error('Chat not found or unauthorized');
    }

    // Evict oldest idle worker if we are at worker pool ceiling (crucial on 1GB E2 Micro)
    this.evictOneIdleIfFull();

    fs.mkdirSync(chat.workspaceDir, { recursive: true, mode: 0o700 });
    if (chat.projectId && this.skillService) {
      this.skillService.syncProjectSkillsToChat(userId, chat.projectId, chat.workspaceDir);
    }
    const sandboxStatus = probeBwrapSandbox(this.config);
    if (this.config.agyMode === 'real' && this.config.sandboxMode === 'strict' && !sandboxStatus.active) {
      throw new Error(
        `${sandboxStatus.reason ?? 'サンドボックス環境を初期化できません。'}${
          sandboxStatus.remediation ? ` (${sandboxStatus.remediation})` : ''
        }`
      );
    }

    const apiKey = this.loadApiKeyForUser(userId);
    const spec = buildAgyCommandSpec({
      config: this.config,
      subcommandArgs: ['acp'],
      profileDir: profile.profileDir,
      workspaceDir: chat.workspaceDir,
      geminiApiKey: apiKey,
      enableSandboxBwrap: sandboxStatus.active,
    });

    const child = spawn(spec.command, spec.args, {
      cwd: chat.workspaceDir,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const workerKey = `${userId}:${chatId}`;
    const stderrTail: string[] = [];
    const stderrRl = readline.createInterface({ input: child.stderr });
    stderrRl.on('line', (line) => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    });

    let workerRef: WorkerInstance | null = null;
    let isRestoringSession = false;
    let earlyAvailableCommands: AvailableCommandItem[] | undefined;
    let earlyConfigOptions: SessionConfigOption[] | undefined;
    const earlyNotifications: SessionNotification[] = [];

    const acpClientApp = client({ name: 'antigravity-chat-ui' });
    const internalBuilder = (
      acpClientApp as unknown as {
        builder?: { handlers?: Array<{ describe?: () => string }> };
      }
    ).builder;
    if (Array.isArray(internalBuilder?.handlers)) {
      internalBuilder.handlers = internalBuilder.handlers.filter(
        (h) => h.describe?.() !== 'client-session-update-router'
      );
    }

    acpClientApp
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        if (!workerRef) throw new RequestError(-32603, 'Worker uninitialized');
        try {
          const hostCandidate = toHostWorkspacePath(
            workerRef.workspaceDir,
            workerRef.sandboxWorkspaceRoot,
            params.path
          );
          const { absPath } = resolveContainedExistingPath(workerRef.workspaceDir, hostCandidate);
          const raw = fs.readFileSync(absPath, 'utf8');
          const lines = raw.split(/\r?\n/);
          const start = params.line && params.line > 0 ? params.line - 1 : 0;
          const end = params.limit && params.limit > 0 ? start + params.limit : lines.length;
          return { content: lines.slice(start, end).join('\n') };
        } catch (err) {
          throw new RequestError(-32602, err instanceof Error ? err.message : 'File read denied');
        }
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        if (!workerRef) throw new RequestError(-32603, 'Worker uninitialized');
        try {
          writeWorkspaceTextFile(workerRef.workspaceDir, workspaceFilePath(workerRef, params.path), params.content);
          return {};
        } catch (err) {
          throw new RequestError(-32602, err instanceof Error ? err.message : 'File write denied');
        }
      })
      .onRequest(methods.client.session.requestPermission, async ({ params, signal }) => {
        const turn = workerRef
          ? this.resolveBridgeForPermission(workerRef, params.toolCall.toolCallId, (params as { sessionId?: string }).sessionId)
          : null;
        if (!workerRef || !turn) {
          return { outcome: { outcome: 'cancelled' as const } };
        }
        workerRef.lastUsedAt = Date.now();
        workerRef.lastBackgroundActivityAt = Date.now();


        // Antigravity evaluates permissions using its native settings. Relay requests to the user.
        const permId = crypto.randomUUID();
        const subagentMeta = classifySubagentToolCall({
          name: (params.toolCall as { name?: string }).name,
          title: params.toolCall.title ?? undefined,
          kind: params.toolCall.kind ?? undefined,
          rawInput: params.toolCall.rawInput,
        });
        const toolCall: ToolCallItem = {
          toolCallId: params.toolCall.toolCallId,
          title:
            params.toolCall.title ??
            (params.toolCall.toolCallId.startsWith('interaction_')
              ? 'エージェントからの質問'
              : 'ツール実行の許可'),
          ...((params.toolCall as { name?: string }).name
            ? { name: (params.toolCall as { name?: string }).name }
            : {}),
          kind: params.toolCall.kind ?? undefined,
          status: params.toolCall.status ?? 'pending',
          ...(subagentMeta.isSubagent
            ? { isSubagent: true, subagentLabel: subagentMeta.subagentLabel }
            : {}),
          rawInput: params.toolCall.rawInput,
          locations: (params.toolCall.locations ?? []).map((l) => ({ path: l.path, line: l.line })),
        };
        const options = params.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        }));
        const isQuestion = toolCall.toolCallId.startsWith('interaction_');
        const isToolApproval =
          !isQuestion &&
          options.some((o) => o.kind.startsWith('allow')) &&
          options.some((o) => o.kind.startsWith('reject'));
        const knownMcpServerNames = isToolApproval
          ? this.db.listEffectiveMcpServersForUser(turn.userId).map((s) => s.name)
          : [];
        const alwaysAllowRule = isToolApproval
          ? deriveAgyPermissionRule({
              toolCall,
              workspaceDir: workerRef.workspaceDir,
              sandboxWorkspaceRoot: workerRef.sandboxWorkspaceRoot,
              knownMcpServerNames,
            })
          : null;

        const record = this.db.createPendingPermission({
          id: permId,
          runId: turn.runId,
          chatId: turn.chatId,
          userId: turn.userId,
          toolCall,
          options,
          alwaysAllowRule,
        });

        const existingRun = turn.runId ? this.db.getRun(turn.userId, turn.runId) : null;
        if (
          existingRun &&
          (existingRun.status === 'running' || existingRun.status === 'queued')
        ) {
          this.db.updateRun(turn.userId, turn.runId, { status: 'awaiting_permission' });
        }
        this.hub.emitDurable({
          userId: turn.userId,
          type: 'permission.requested',
          chatId: turn.chatId,
          runId: turn.runId,
          payload: { permission: record },
        });
        void this.pushService
          ?.notifyPermissionRequested({
            userId: turn.userId,
            chatId: turn.chatId,
            runId: turn.runId,
            permissionId: record.id,
            toolTitle: toolCall.title,
            isQuestion,
          })
          .catch((err) => {
            console.warn('[acp] Push permission notification failed:', err);
          });

        return new Promise<RequestPermissionResponse>((resolve) => {
          turn.pendingResolvers.set(permId, resolve);
          const onCancelSignal = () => {
            if (turn.pendingResolvers.delete(permId)) {
              this.db.resolvePermissionAtomically({
                userId: turn.userId,
                permissionId: permId,
                selectedOptionId: null,
                status: 'cancelled',
              });
              resolve({ outcome: { outcome: 'cancelled' } });
            }
          };
          signal.addEventListener('abort', onCancelSignal, { once: true });
        });
      })
      .onRequest(
        methods.client.elicitation.create,
        async ({ params, signal }): Promise<CreateElicitationResponse> => {
          const req = params as CreateElicitationRequest;
          const sessionId =
            'sessionId' in req && typeof req.sessionId === 'string' ? req.sessionId : undefined;
          const toolCallId =
            'toolCallId' in req && typeof req.toolCallId === 'string' ? req.toolCallId : undefined;
          const turn = workerRef
            ? this.resolveBridgeForPermission(workerRef, toolCallId, sessionId)
            : null;
          if (!workerRef || !turn) {
            return { action: 'cancel' };
          }
          workerRef.lastUsedAt = Date.now();
          workerRef.lastBackgroundActivityAt = Date.now();

          const elicitId = crypto.randomUUID();
          const mode: 'form' | 'url' = req.mode === 'url' ? 'url' : 'form';
          const requestedSchema: ElicitationFormSchema | null =
            mode === 'form' && 'requestedSchema' in req && req.requestedSchema
              ? (req.requestedSchema as unknown as ElicitationFormSchema)
              : null;
          const externalElicitationId =
            mode === 'url' && 'elicitationId' in req && typeof req.elicitationId === 'string'
              ? req.elicitationId
              : null;
          const url =
            mode === 'url' && 'url' in req && typeof req.url === 'string' ? req.url : null;

          const record = this.db.createPendingElicitation({
            id: elicitId,
            runId: turn.runId,
            chatId: turn.chatId,
            userId: turn.userId,
            toolCallId: toolCallId ?? null,
            externalElicitationId,
            mode,
            message: req.message,
            requestedSchema,
            url,
          });

          const existingRun = turn.runId ? this.db.getRun(turn.userId, turn.runId) : null;
          if (
            existingRun &&
            (existingRun.status === 'running' || existingRun.status === 'queued')
          ) {
            this.db.updateRun(turn.userId, turn.runId, { status: 'awaiting_permission' });
          }

          this.hub.emitDurable({
            userId: turn.userId,
            type: 'elicitation.requested',
            chatId: turn.chatId,
            runId: turn.runId,
            payload: { elicitation: record },
          });

          void this.pushService
            ?.notifyElicitationRequested({
              userId: turn.userId,
              chatId: turn.chatId,
              runId: turn.runId,
              elicitationId: record.id,
              message: record.message,
            })
            .catch((err) => {
              console.warn('[acp] Push elicitation notification failed:', err);
            });

          return new Promise<CreateElicitationResponse>((resolve) => {
            turn.pendingElicitationResolvers.set(elicitId, resolve);
            const onCancelSignal = () => {
              if (turn.pendingElicitationResolvers.delete(elicitId)) {
                const updated = this.db.resolveElicitationAtomically({
                  userId: turn.userId,
                  elicitationId: elicitId,
                  selectedAction: 'cancel',
                  status: 'cancelled',
                });
                if (updated) {
                  this.hub.emitDurable({
                    userId: turn.userId,
                    type: 'elicitation.resolved',
                    chatId: turn.chatId,
                    runId: turn.runId,
                    payload: { elicitation: updated },
                  });
                }
                resolve({ action: 'cancel' });
              }
            };
            signal.addEventListener('abort', onCancelSignal, { once: true });
          });
        }
      )
      .onNotification(methods.client.elicitation.complete, async ({ params }) => {
        if (!workerRef || !params?.elicitationId) return;
        const pending = this.db.getPendingElicitationByExternalId(
          workerRef.userId,
          workerRef.chatId,
          params.elicitationId
        );
        if (pending) {
          this.resolvePendingElicitation({
            userId: workerRef.userId,
            chatId: workerRef.chatId,
            elicitationId: pending.id,
            action: 'accept',
            content: null,
          });
        }
      })
      .onNotification(
        methods.client.session.update as unknown as `_${string}`,
        (rawParams: unknown) => rawParams as SessionNotification,
        async ({ params }) => {
          if (!workerRef) {
            if (params.update?.sessionUpdate === 'available_commands_update') {
              earlyAvailableCommands = mapAcpAvailableCommands(params.update.availableCommands);
            } else if (params.update?.sessionUpdate === 'config_option_update') {
              earlyConfigOptions = params.update.configOptions;
            } else if (!isRestoringSession) {
              earlyNotifications.push(params);
            }
            return;
          }
          this.handleSessionNotification(workerRef, params);
        }
      );

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );
    const conn = acpClientApp.connect(stream);

    child.once('exit', () => {
      if (this.workers.get(workerKey) === workerRef) {
        this.workers.delete(workerKey);
      }
    });

    const init = (await (conn.agent.request as (method: string, params: unknown) => Promise<unknown>)(
      methods.agent.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: supportsWorkspaceTextWrites },
          terminal: false,
          session: { configOptions: { boolean: {} } },
          elicitation: { form: {}, url: {} },
          subagents: {},
          plan: {},
          auth: { terminal: true },
        },
        clientInfo: {
          name: 'antigravity-chat-ui',
          title: 'Antigravity Chat UI',
          version: this.config.appVersion,
        },
      }
    )) as InitializeResponse;

    const supportsSystemPrompt = Boolean(init.agentCapabilities?.sessionCapabilities?.systemPrompt);
    let systemPromptPayload:
      | { mode: 'append'; content: Array<{ type: 'text'; text: string }> }
      | undefined;

    if (supportsSystemPrompt && chat.projectId) {
      const proj = this.db.getProject(userId, chat.projectId);
      if (proj?.instructions.trim()) {
        systemPromptPayload = {
          mode: 'append',
          content: [{ type: 'text', text: proj.instructions.trim() }],
        };
      }
    }

    let acpSessionId: string | null = null;
    let restoredExistingSession = false;
    let parsedOptions: ParsedSessionOptions = {
      configOptions: [],
      modelOptionId: null,
      effortOptionId: null,
      currentModelId: null,
      currentEffortValue: null,
    };

    const mcpServers = this.mcpService
      ? await this.mcpService.resolveAcpMcpServersForUser(
          userId,
          init.agentCapabilities?.mcpCapabilities
        )
      : [];

    // Try load / resume existing ACP session seamlessly
    if (chat.acpSessionId) {
      isRestoringSession = true;
      try {
        if (init.agentCapabilities?.loadSession) {
          const loadRes = (await conn.agent.request(methods.agent.session.load, {
            sessionId: chat.acpSessionId,
            cwd: spec.sandboxWorkspaceRoot,
            mcpServers,
            ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
          })) as LoadSessionResponse | undefined;
          acpSessionId = chat.acpSessionId;
          restoredExistingSession = true;
          parsedOptions = normalizeConfigOptions(
            loadRes?.configOptions ?? earlyConfigOptions,
            earlyAvailableCommands
          );
        } else if (init.agentCapabilities?.sessionCapabilities?.resume) {
          const resumeRes = (await conn.agent.request(methods.agent.session.resume, {
            sessionId: chat.acpSessionId,
            cwd: spec.sandboxWorkspaceRoot,
            mcpServers,
            ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
          })) as ResumeSessionResponse | undefined;
          acpSessionId = chat.acpSessionId;
          restoredExistingSession = true;
          parsedOptions = normalizeConfigOptions(
            resumeRes?.configOptions ?? earlyConfigOptions,
            earlyAvailableCommands
          );
        }
      } catch {
        acpSessionId = null;
      } finally {
        isRestoringSession = false;
      }
    }

    if (!acpSessionId) {
      try {
        const newRes = (await conn.agent.request(methods.agent.session.new, {
          cwd: spec.sandboxWorkspaceRoot,
          mcpServers,
          ...(systemPromptPayload ? { systemPrompt: systemPromptPayload } : {}),
        })) as NewSessionResponse;
        acpSessionId = newRes.sessionId;
        parsedOptions = normalizeConfigOptions(
          newRes.configOptions ?? earlyConfigOptions,
          earlyAvailableCommands
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('-32000') || /authentication required/i.test(msg)) {
          this.db.updateAgyProfile(userId, { authStatus: 'unauthenticated', lastError: msg });
          this.hub.emitDurable({
            userId,
            type: 'agy.auth_changed',
            payload: { profile: this.db.getAgyProfile(userId) },
          });
        }
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        throw err;
      }
    }

    if (chat.modelId && parsedOptions.modelOptionId && parsedOptions.currentModelId !== chat.modelId) {
      const res = await conn.agent
        .request(methods.agent.session.setConfigOption, {
          sessionId: acpSessionId,
          configId: parsedOptions.modelOptionId,
          value: chat.modelId,
        })
        .catch(() => null);
      if (res) {
        parsedOptions = normalizeConfigOptions(res.configOptions, earlyAvailableCommands);
      }
    }

    if (
      chat.effortValue &&
      parsedOptions.effortOptionId &&
      parsedOptions.currentEffortValue !== chat.effortValue
    ) {
      const res = await conn.agent
        .request(methods.agent.session.setConfigOption, {
          sessionId: acpSessionId,
          configId: parsedOptions.effortOptionId,
          value: chat.effortValue,
        })
        .catch(() => null);
      if (res) {
        parsedOptions = normalizeConfigOptions(res.configOptions, earlyAvailableCommands);
      }
    }

    // Agy ACP can report Default on session/new even when the profile specifies another mode.
    if (!restoredExistingSession) {
      let savedMode: string | null = null;
      try {
        savedMode = getAgyAgentMode(profile.profileDir, { createIfMissing: false });
      } catch {
        // Keep the mode selected by Antigravity if the profile settings cannot be read.
      }
      const supportedMode = AGY_AGENT_MODES.find((value) => value === savedMode);
      const requestedMode = supportedMode === '' ? 'default' : supportedMode;
      const modeOption = parsedOptions.configOptions.find((item) => item.category === 'mode' || item.id === 'mode');
      if (
        requestedMode &&
        modeOption &&
        modeOption.currentValue !== requestedMode &&
        modeOption.options.some((item) => item.value === requestedMode)
      ) {
        const res = await conn.agent
          .request(methods.agent.session.setConfigOption, {
            sessionId: acpSessionId,
            configId: modeOption.id,
            value: requestedMode,
          })
          .catch(() => null);
        if (res) {
          parsedOptions = normalizeConfigOptions(res.configOptions, earlyAvailableCommands);
        }
      }
    }

    parsedOptions = this.enrichParsedOptions(
      userId,
      parsedOptions,
      { projectId: chat.projectId, chatId: chat.id },
      earlyAvailableCommands
    );

    this.db.updateChat(userId, chatId, {
      acpSessionId,
      modelId: parsedOptions.currentModelId ?? chat.modelId,
      effortValue: parsedOptions.currentEffortValue ?? chat.effortValue,
    });

    workerRef = {
      key: workerKey,
      userId,
      chatId,
      profileDir: profile.profileDir,
      workspaceDir: chat.workspaceDir,
      sandboxed: spec.sandboxed,
      sandboxWorkspaceRoot: spec.sandboxWorkspaceRoot,
      process: child,
      conn,
      init,
      acpSessionId,
      parsedOptions,
      supportsSystemPrompt,
      inFlight: false,
      lastUsedAt: Date.now(),
      activeTurn: null,
      backgroundBridge: null,
      turnBridges: new Map(),
      lastBackgroundActivityAt: 0,
      stderrTail,
    };

    this.workers.set(workerKey, workerRef);
    for (const early of earlyNotifications) {
      this.handleSessionNotification(workerRef, early);
    }
    return workerRef;
  }

  private appendTurnThoughtChunk(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    chunk: string
  ): void {
    if (!chunk) return;
    const offset = turn.thoughtsText.length;
    const activityIndex = this.recordTextActivity(turn, 'thoughts', offset);
    turn.thoughtsText += chunk;
    this.hub.emitEphemeral({
      userId: worker.userId,
      type: 'run.delta',
      chatId: worker.chatId,
      runId: turn.runId,
      payload: { messageId: turn.assistantMessageId, field: 'thoughts', activityIndex, offset, chunk },
    });
    this.maybeFlushTurnProgress(turn);
  }

  private appendTurnContentChunk(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    chunk: string
  ): void {
    if (!chunk) return;
    const offset = turn.contentText.length;
    const activityIndex = this.recordTextActivity(turn, 'content', offset);
    turn.contentText += chunk;
    turn.lastActivityAt = Date.now();
    this.hub.emitEphemeral({
      userId: worker.userId,
      type: 'run.delta',
      chatId: worker.chatId,
      runId: turn.runId,
      payload: {
        messageId: turn.assistantMessageId,
        field: 'content',
        activityIndex,
        offset,
        chunk,
      },
    });
    this.maybeFlushTurnProgress(turn);
  }

  private saveInlineAssetToWorkspace(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    data: Buffer,
    mimeType: string,
    suggestedName?: string
  ): string | null {
    try {
      const ext = mime.extension(mimeType) || 'bin';
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      const filename = sanitizeFileName(suggestedName || `generated-${hash.slice(0, 12)}.${ext}`);
      const originalExt = path.extname(filename);
      const suffix = /^\.[a-z\d]{1,16}$/i.test(originalExt) ? originalExt : `.${ext}`;
      const stem = originalExt ? filename.slice(0, -originalExt.length) : filename;
      const identity = crypto.createHash('sha256').update(JSON.stringify([filename, mimeType, hash])).digest('hex');
      const storageStem = [...stem].slice(0, 32).join('');
      const target = resolveContainedWriteTarget(worker.workspaceDir, `generated/${storageStem}-${identity}${suffix}`);
      fs.mkdirSync(path.dirname(target.absPath), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(target.absPath) || sha256File(target.absPath) !== hash) {
        fs.writeFileSync(target.absPath, data);
      }
      this.publishArtifactReference(turn, target.relPath, filename, mimeType);
      return target.relPath;
    } catch {
      return null;
    }
  }

  /** Use the supplied file reference when present and persist inline-only bytes. */
  private renderContentBlock(worker: WorkerInstance, turn: ActiveTurnBridge, block: ContentBlock): string {
    if (block.type === 'text') return block.text;
    if (block.type === 'resource_link') {
      const reference = block.uri;
      const filename = block.name || path.basename(normalizeLinkCandidatePath(reference) ?? reference);
      const { previewKind } = detectContentFileType(filename, block.mimeType);
      this.publishArtifactReference(turn, reference, filename, block.mimeType);
      return `\n${formatFileLink(filename, reference, previewKind === 'image' || previewKind === 'svg')}\n`;
    }
    let data: Buffer;
    let mimeType: string;
    let filename: string | undefined;
    if (block.type === 'resource') {
      const resource = block.resource;
      if (!resource || (!('text' in resource) && !('blob' in resource))) return '';
      mimeType = resource.mimeType || ('text' in resource ? 'text/plain' : 'application/octet-stream');
      try { filename = decodeURIComponent(path.posix.basename(new URL(resource.uri).pathname)); } catch { /* Use a MIME-derived name. */ }
      if (this.publishArtifactReference(turn, resource.uri, filename, mimeType)) {
        const { previewKind } = detectContentFileType(filename || resource.uri, mimeType);
        return `\n${formatFileLink(filename || resource.uri, resource.uri, previewKind === 'image' || previewKind === 'svg')}\n`;
      }
      data = 'text' in resource ? Buffer.from(resource.text, 'utf8') : Buffer.from(resource.blob, 'base64');
    } else if (block.type === 'image' || block.type === 'audio') {
      if (block.type === 'image' && block.uri && this.publishArtifactReference(turn, block.uri, undefined, block.mimeType)) {
        return `\n${formatFileLink('生成画像', block.uri, true)}\n`;
      }
      if (typeof block.data !== 'string') return '';
      data = Buffer.from(block.data, 'base64');
      mimeType = block.mimeType;
    } else {
      return '';
    }
    const relPath = this.saveInlineAssetToWorkspace(worker, turn, data, mimeType, filename);
    if (!relPath) return '';
    const label = filename || (block.type === 'image' ? '生成画像' : path.basename(relPath));
    const { previewKind } = detectContentFileType(filename || relPath, mimeType);
    return `\n${formatFileLink(label, relPath, previewKind === 'image' || previewKind === 'svg')}\n`;
  }

  private publishArtifactReference(turn: ActiveTurnBridge, reference: string, label?: string, mimeType?: string | null): boolean {
    const resolved = resolveAuthorizedChatFileReference({
      db: this.db,
      userId: turn.userId,
      chatId: turn.chatId,
      messageId: turn.assistantMessageId,
      runId: turn.runId,
      reference,
      label,
      mimeType,
    });
    if (!resolved) return false;
    const { artifact } = resolved;
    if (!turn.emittedArtifactIds.has(artifact.id)) {
      turn.emittedArtifactIds.add(artifact.id);
      this.hub.emitDurable({
        userId: turn.userId,
        chatId: turn.chatId,
        runId: turn.runId,
        type: 'artifact.created',
        payload: { artifact },
      });
    }
    return true;
  }

  private extractToolCallContentAndSaveAssets(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    rawContent: unknown
  ): string | undefined {
    if (!Array.isArray(rawContent) || rawContent.length === 0) return undefined;
    const textParts: string[] = [];
    for (const item of rawContent) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (entry.type === 'content' && entry.content && typeof entry.content === 'object') {
        textParts.push(this.renderContentBlock(worker, turn, entry.content as ContentBlock));
      } else if (entry.type === 'diff' && typeof entry.path === 'string') {
        textParts.push(`Diff: ${entry.path}`);
      }
    }
    return textParts.length > 0
      ? textParts.join('\n').trim()
      : undefined;
  }

  private pruneOldTurnBridges(worker: WorkerInstance): void {
    if (worker.turnBridges.size <= 20) return;
    for (const [runId, b] of worker.turnBridges.entries()) {
      if (worker.turnBridges.size <= 20) break;
      if (b === worker.activeTurn || b === worker.backgroundBridge) continue;
      if (this.isBridgeBusy(b)) continue;
      worker.turnBridges.delete(runId);
    }
  }

  private isBridgeBusy(b: ActiveTurnBridge): boolean {
    if (b.pendingResolvers.size > 0 || b.pendingElicitationResolvers.size > 0) return true;
    if (
      b.parentState === 'running' ||
      b.parentState === 'requires_action' ||
      b.parentState === 'unknown'
    ) {
      return true;
    }
    if (b.backgroundWorkCount > 0) return true;
    if (
      [...b.subagents.values()].some(
        (s) => s.state === 'running' || s.state === 'requires_action' || s.state === 'unknown'
      )
    ) {
      return true;
    }
    if (b.toolCalls.some((tc) => tc.status === 'in_progress' || tc.status === 'pending')) {
      return true;
    }
    return false;
  }

  private getBridgesNewestFirst(worker: WorkerInstance): ActiveTurnBridge[] {
    const list: ActiveTurnBridge[] = [];
    if (worker.activeTurn) list.push(worker.activeTurn);
    const reversed = [...worker.turnBridges.values()].reverse();
    for (const b of reversed) {
      if (b !== worker.activeTurn) list.push(b);
    }
    if (worker.backgroundBridge && !list.includes(worker.backgroundBridge)) {
      list.push(worker.backgroundBridge);
    }
    return list;
  }

  private resolveBridgeForPermission(
    worker: WorkerInstance,
    toolCallId?: string,
    sessionId?: string
  ): ActiveTurnBridge | null {
    const bridges = this.getBridgesNewestFirst(worker);
    if (sessionId && worker.acpSessionId && sessionId !== worker.acpSessionId) {
      const bySub = bridges.find((b) => b.subagents.has(sessionId));
      if (bySub) return bySub;
    }
    if (toolCallId) {
      const byTool = bridges.find(
        (b) =>
          b.asyncSubagentToolIds.has(toolCallId) ||
          b.toolCalls.some((tc) => tc.toolCallId === toolCallId)
      );
      if (byTool) return byTool;
    }
    return worker.activeTurn ?? this.ensureBackgroundBridge(worker);
  }

  private resolveBridgeForNotification(
    worker: WorkerInstance,
    params: SessionNotification
  ): ActiveTurnBridge | null {
    const update = params.update;
    const rawUpdate = update as unknown as Record<string, unknown>;
    const rawUpdateType = String(rawUpdate.sessionUpdate || '');
    const bridges = this.getBridgesNewestFirst(worker);

    if (params.sessionId && worker.acpSessionId && params.sessionId !== worker.acpSessionId) {
      const byChild = bridges.find((b) => b.subagents.has(params.sessionId));
      if (byChild) return byChild;
      return worker.activeTurn ?? this.ensureBackgroundBridge(worker);
    }

    if (rawUpdateType === 'subagent_update') {
      const subId = typeof rawUpdate.sessionId === 'string' ? rawUpdate.sessionId : null;
      const tcId = typeof rawUpdate.toolCallId === 'string' ? rawUpdate.toolCallId : null;
      const bySub = bridges.find(
        (b) =>
          (subId && b.subagents.has(subId)) ||
          (tcId &&
            (b.asyncSubagentToolIds.has(tcId) || b.toolCalls.some((t) => t.toolCallId === tcId)))
      );
      if (bySub) return bySub;
    }

    if (update.sessionUpdate === 'tool_call_update') {
      const byTool = bridges.find((b) =>
        b.toolCalls.some((t) => t.toolCallId === update.toolCallId)
      );
      if (byTool) return byTool;
    }

    if (rawUpdateType === 'session_message' || rawUpdateType === 'session_message_chunk') {
      const msgId = typeof rawUpdate.messageId === 'string' ? rawUpdate.messageId : null;
      const senderId =
        typeof rawUpdate.senderSessionId === 'string' ? rawUpdate.senderSessionId : null;
      const byMsg = bridges.find(
        (b) =>
          (msgId && b.sessionMessages.some((m) => m.messageId === msgId)) ||
          (senderId && b.subagents.has(senderId))
      );
      if (byMsg) return byMsg;
    }

    return worker.activeTurn ?? this.ensureBackgroundBridge(worker);
  }

  private upsertSubagentToolCall(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    params: {
      subSessionId: string;
      toolCallId?: string | null;
      title?: string | null;
      description?: string | null;
      state?: 'running' | 'idle' | 'requires_action' | 'unknown';
      stopReason?: string | null;
      thoughtsDelta?: string;
      contentDelta?: string;
      childToolCall?: SubagentActivityItem;
    }
  ): void {
    const existingTrack = turn.subagents.get(params.subSessionId);
    const fallbackId = `subagent:${params.subSessionId}`;
    let targetToolCallId =
      (params.toolCallId && params.toolCallId.trim()) || existingTrack?.toolCallId;

    if (!targetToolCallId || targetToolCallId === fallbackId) {
      const boundToolIds = new Set(
        [...turn.subagents.values()]
          .filter((s) => s.sessionId !== params.subSessionId)
          .map((s) => s.toolCallId)
      );
      const unboundAsyncId = [...turn.asyncSubagentToolIds].find((id) => !boundToolIds.has(id));
      if (unboundAsyncId) {
        if (existingTrack?.toolCallId === fallbackId && unboundAsyncId !== fallbackId) {
          turn.toolCalls = turn.toolCalls.filter((t) => t.toolCallId !== fallbackId);
        }
        targetToolCallId = unboundAsyncId;
      } else if (!targetToolCallId) {
        targetToolCallId = fallbackId;
      }
    } else if (existingTrack?.toolCallId && existingTrack.toolCallId !== targetToolCallId) {
      turn.toolCalls = turn.toolCalls.filter((t) => t.toolCallId !== existingTrack.toolCallId);
    }

    const nextState = params.state ?? existingTrack?.state ?? 'unknown';
    const nextTitle =
      (params.title && params.title.trim()) ||
      existingTrack?.title ||
      (params.description && params.description.trim()) ||
      'サブエージェント';
    const nextDesc =
      params.description !== undefined
        ? params.description ?? undefined
        : existingTrack?.description;

    const nextThoughts = (existingTrack?.thoughtsText ?? '') + (params.thoughtsDelta ?? '');
    const nextContent = (existingTrack?.contentText ?? '') + (params.contentDelta ?? '');
    const nextChildTools = existingTrack ? [...existingTrack.toolCalls] : [];
    if (params.childToolCall) {
      const cIdx = nextChildTools.findIndex(
        (c) => c.toolCallId === params.childToolCall!.toolCallId
      );
      if (cIdx >= 0) {
        nextChildTools[cIdx] = { ...nextChildTools[cIdx], ...params.childToolCall };
      } else {
        nextChildTools.push(params.childToolCall);
      }
    }

    const tracked: TrackedSubagentState = {
      sessionId: params.subSessionId,
      toolCallId: targetToolCallId,
      title: nextTitle,
      description: nextDesc,
      state: nextState,
      stopReason: params.stopReason !== undefined ? params.stopReason : existingTrack?.stopReason,
      thoughtsText: nextThoughts,
      contentText: nextContent,
      toolCalls: nextChildTools,
      lastActivityAt: Date.now(),
    };
    turn.subagents.set(params.subSessionId, tracked);

    const label = nextDesc
      ? `サブエージェント (${nextTitle}: ${nextDesc})`
      : `サブエージェント (${nextTitle})`;

    const syntheticStatus: ToolCallItem['status'] =
      nextState === 'running' || nextState === 'requires_action'
        ? 'in_progress'
        : nextState === 'idle'
          ? tracked.stopReason === 'error' || tracked.stopReason === 'refusal'
            ? 'failed'
            : 'completed'
          : 'pending';

    const idx = turn.toolCalls.findIndex((t) => t.toolCallId === targetToolCallId);
    if (idx >= 0) {
      const prev = turn.toolCalls[idx];
      const isSynthetic = prev.toolCallId.startsWith('subagent:');
      // Preserve native ACP tool_call status; synthetic subagent fallback items follow child lifecycle
      turn.toolCalls[idx] = {
        ...prev,
        ...(isSynthetic ? { status: syntheticStatus } : {}),
        isSubagent: true,
        subagentLabel: prev.subagentLabel || label,
        subagentSessionId: params.subSessionId,
        subagentState: nextState,
        ...(tracked.stopReason !== undefined ? { subagentStopReason: tracked.stopReason } : {}),
        ...(nextThoughts ? { subagentThoughtsText: nextThoughts } : {}),
        ...(nextContent ? { subagentContentText: nextContent } : {}),
        ...(nextChildTools.length > 0 ? { subagentToolCalls: nextChildTools } : {}),
      };
    } else {
      turn.toolCalls.push({
        toolCallId: targetToolCallId,
        title: nextTitle,
        isSubagent: true,
        subagentLabel: label,
        status: syntheticStatus,
        subagentSessionId: params.subSessionId,
        subagentState: nextState,
        ...(tracked.stopReason !== undefined ? { subagentStopReason: tracked.stopReason } : {}),
        ...(nextThoughts ? { subagentThoughtsText: nextThoughts } : {}),
        ...(nextContent ? { subagentContentText: nextContent } : {}),
        ...(nextChildTools.length > 0 ? { subagentToolCalls: nextChildTools } : {}),
      });
    }

    this.publishToolActivity(worker, turn, targetToolCallId);
  }

  private handleChildSessionNotification(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    childSessionId: string,
    update: SessionUpdate
  ): void {
    const rawUpdate = update as unknown as Record<string, unknown>;
    const rawUpdateType = String(rawUpdate.sessionUpdate || '');
    if (rawUpdateType === 'state_update') {
      const hasExplicitNullState = 'state' in rawUpdate && rawUpdate.state === null;
      const stateObj = rawUpdate as {
        state?: 'running' | 'idle' | 'requires_action' | 'unknown' | null;
        stopReason?: string | null;
      };
      const resolvedState = hasExplicitNullState
        ? 'idle'
        : stateObj.state ?? (stateObj.stopReason ? 'idle' : 'unknown');
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: childSessionId,
        state: resolvedState,
        stopReason: stateObj.stopReason,
      });
      return;
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const contentNote = this.extractToolCallContentAndSaveAssets(
        worker,
        turn,
        (update as { content?: unknown }).content
      );
      const existingTrack = turn.subagents.get(childSessionId);
      const prevChildTool = existingTrack?.toolCalls.find(
        (c) => c.toolCallId === update.toolCallId
      );
      const rawName = (update as { name?: string }).name ?? prevChildTool?.name;
      const childTool: SubagentActivityItem = {
        toolCallId: update.toolCallId,
        title:
          update.title !== undefined && update.title !== null
            ? update.title
            : prevChildTool?.title ?? 'ツール実行',
        ...(rawName ? { name: rawName } : {}),
        ...(update.kind !== undefined && update.kind !== null
          ? { kind: update.kind }
          : prevChildTool?.kind
            ? { kind: prevChildTool.kind }
            : {}),
        status:
          update.status !== undefined && update.status !== null
            ? update.status
            : prevChildTool?.status ?? 'in_progress',
        ...(contentNote !== undefined
          ? { contentText: contentNote }
          : prevChildTool?.contentText
            ? { contentText: prevChildTool.contentText }
            : {}),
        ...(update.rawInput !== undefined
          ? { rawInput: update.rawInput }
          : prevChildTool?.rawInput !== undefined
            ? { rawInput: prevChildTool.rawInput }
            : {}),
        ...(update.rawOutput !== undefined
          ? { rawOutput: update.rawOutput }
          : prevChildTool?.rawOutput !== undefined
            ? { rawOutput: prevChildTool.rawOutput }
            : {}),
        ...(update.locations !== undefined && update.locations !== null
          ? { locations: update.locations.map((l) => ({ path: l.path, line: l.line })) }
          : prevChildTool?.locations
            ? { locations: prevChildTool.locations }
            : {}),
      };
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: childSessionId,
        childToolCall: childTool,
      });
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: childSessionId,
        thoughtsDelta: this.renderContentBlock(worker, turn, update.content),
      });
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: childSessionId,
        contentDelta: this.renderContentBlock(worker, turn, update.content),
      });
    }
  }

  private extractContentBlocksText(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    blocks: ContentBlock[]
  ): string {
    return blocks.map(block => this.renderContentBlock(worker, turn, block)).join('');
  }

  private handleInterSessionMessageNotification(
    worker: WorkerInstance,
    turn: ActiveTurnBridge,
    rawUpdateType: string,
    rawUpdate: Record<string, unknown>
  ): void {
    const messageId =
      typeof rawUpdate.messageId === 'string' && rawUpdate.messageId.trim()
        ? rawUpdate.messageId.trim()
        : null;
    if (!messageId) return;

    const existingIdx = turn.sessionMessages.findIndex((m) => m.messageId === messageId);
    const existing = existingIdx >= 0 ? turn.sessionMessages[existingIdx] : null;
    const now = Date.now();

    if (rawUpdateType === 'session_message') {
      let nextContent = existing?.contentText ?? '';
      if ('content' in rawUpdate) {
        if (rawUpdate.content === null || (Array.isArray(rawUpdate.content) && rawUpdate.content.length === 0)) {
          nextContent = '';
        } else if (Array.isArray(rawUpdate.content)) {
          nextContent = this.extractContentBlocksText(
            worker,
            turn,
            rawUpdate.content as ContentBlock[]
          );
        }
      }
      const item: SessionMessageItem = {
        messageId,
        senderSessionId:
          rawUpdate.senderSessionId !== undefined
            ? (rawUpdate.senderSessionId as string | null)
            : existing?.senderSessionId,
        recipientSessionId:
          rawUpdate.recipientSessionId !== undefined
            ? (rawUpdate.recipientSessionId as string | null)
            : existing?.recipientSessionId,
        senderMessageId:
          rawUpdate.senderMessageId !== undefined
            ? (rawUpdate.senderMessageId as string | null)
            : existing?.senderMessageId,
        recipientMessageId:
          rawUpdate.recipientMessageId !== undefined
            ? (rawUpdate.recipientMessageId as string | null)
            : existing?.recipientMessageId,
        contentText: nextContent,
        done: rawUpdate.done !== undefined ? Boolean(rawUpdate.done) : existing?.done ?? true,
        updatedAt: now,
      };
      if (existingIdx >= 0) turn.sessionMessages[existingIdx] = item;
      else turn.sessionMessages.push(item);
    } else {
      // session_message_chunk
      const chunkBlock = rawUpdate.content as ContentBlock | undefined;
      const rawChunk = chunkBlock?.type === 'text'
        ? chunkBlock.text
        : chunkBlock ? this.extractContentBlocksText(worker, turn, [chunkBlock]) : '';
      const item: SessionMessageItem = {
        messageId,
        senderSessionId: existing?.senderSessionId ?? (typeof rawUpdate.senderSessionId === 'string' ? rawUpdate.senderSessionId : undefined),
        recipientSessionId: existing?.recipientSessionId,
        senderMessageId: existing?.senderMessageId,
        recipientMessageId: existing?.recipientMessageId,
        contentText: (existing?.contentText ?? '') + rawChunk,
        done: rawUpdate.done === true ? true : existing?.done ?? false,
        updatedAt: now,
      };
      if (existingIdx >= 0) turn.sessionMessages[existingIdx] = item;
      else turn.sessionMessages.push(item);
    }

    const updatedMsg = this.db.updateMessage(turn.userId, turn.assistantMessageId, {
      sessionMessages: turn.sessionMessages,
    });
    if (updatedMsg) {
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'message.updated',
        chatId: worker.chatId,
        runId: turn.runId || null,
        payload: { message: updatedMsg },
      });
    }
  }

  private ensureBackgroundBridge(worker: WorkerInstance): ActiveTurnBridge | null {
    if (worker.backgroundBridge) {
      return worker.backgroundBridge;
    }
    const messages = this.db.listMessages(worker.userId, worker.chatId);
    const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!latestAssistant) return null;

    const beforeWorkspaceSnap = captureWorkspaceSnapshot(worker.workspaceDir);
    const bridge: ActiveTurnBridge = {
      runId: latestAssistant.runId ?? '',
      userId: worker.userId,
      chatId: worker.chatId,
      assistantMessageId: latestAssistant.id,
      contentText: latestAssistant.contentText,
      thoughtsText: latestAssistant.thoughtsText,
      toolCalls: [...latestAssistant.toolCalls],
      activity: latestAssistant.activity?.length ? [...latestAssistant.activity] : [
        ...(latestAssistant.thoughtsText ? [{ kind: 'thoughts', offset: 0 } as const] : []),
        ...latestAssistant.toolCalls.map(({ toolCallId }) => ({ kind: 'tool' as const, toolCallId })),
        ...(latestAssistant.contentText ? [{ kind: 'content', offset: 0 } as const, { kind: 'answer_end' } as const] : []),
      ],
      sessionMessages: [...(latestAssistant.sessionMessages ?? [])],
      lastDbFlushAt: 0,
      pendingResolvers: new Map(),
      pendingElicitationResolvers: new Map(),
      beforeWorkspaceSnap,
      emittedArtifactIds: new Set(latestAssistant.artifactIds),
      lastActivityAt: Date.now(),
      subagents: new Map(),
      asyncSubagentToolIds: new Set(),
      initialPromptDone: true,
      parentWakeupStarted: false,
      receivedWakeupText: false,
      wakeupCount: 0,
      wakeupContentOffset: latestAssistant.contentText.length,
      lastParentActivityAt: Date.now(),
      parentState: 'idle',
      backgroundWorkCount: 0,
    };
    worker.backgroundBridge = bridge;
    if (bridge.runId) {
      worker.turnBridges.set(bridge.runId, bridge);
    }
    return bridge;
  }

  private syncBackgroundWorkspaceArtifacts(
    worker: WorkerInstance,
    bridge: ActiveTurnBridge
  ): void {
    if (worker.activeTurn && worker.activeTurn !== bridge) {
      return;
    }
    const newArtifacts = syncWorkspaceChangesAsArtifacts({
      db: this.db,
      userId: worker.userId,
      chatId: worker.chatId,
      workspaceDir: worker.workspaceDir,
      messageId: bridge.assistantMessageId,
      runId: bridge.runId || null,
      before: bridge.beforeWorkspaceSnap,
      skipIfAlreadyOwnedByOtherMessage: true,
    });
    for (const art of newArtifacts) {
      if (bridge.emittedArtifactIds.has(art.id)) continue;
      bridge.emittedArtifactIds.add(art.id);
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'artifact.created',
        chatId: worker.chatId,
        runId: bridge.runId || null,
        payload: { artifact: art },
      });
    }
  }

  private flushBackgroundBridgeToMessage(
    worker: WorkerInstance,
    bridge: ActiveTurnBridge,
    syncArtifacts = false
  ): void {
    if (syncArtifacts) {
      this.syncBackgroundWorkspaceArtifacts(worker, bridge);
    }
    const updated = this.db.updateMessage(worker.userId, bridge.assistantMessageId, {
      contentText: bridge.contentText,
      thoughtsText: bridge.thoughtsText,
      toolCalls: bridge.toolCalls,
      activity: bridge.activity,
      sessionMessages: bridge.sessionMessages,
      artifactIds: [...bridge.emittedArtifactIds],
    });
    if (updated) {
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'message.updated',
        chatId: worker.chatId,
        runId: bridge.runId || null,
        payload: { message: updated },
      });
    }
  }

  private handleSessionNotification(worker: WorkerInstance, params: SessionNotification): void {
    const update: SessionUpdate = params.update;

    if (update.sessionUpdate === 'config_option_update') {
      const chat = this.db.getChat(worker.userId, worker.chatId);
      const prevAcpCommands = (worker.parsedOptions.availableCommands ?? []).filter(
        (c) => c.source !== 'skill'
      );
      worker.parsedOptions = this.enrichParsedOptions(
        worker.userId,
        normalizeConfigOptions(update.configOptions),
        { projectId: chat?.projectId ?? null, chatId: worker.chatId },
        prevAcpCommands
      );
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'chat.config_updated',
        chatId: worker.chatId,
        payload: { sessionOptions: worker.parsedOptions },
      });
      return;
    }

    if (update.sessionUpdate === 'available_commands_update') {
      const chat = this.db.getChat(worker.userId, worker.chatId);
      const acpCmds = mapAcpAvailableCommands(update.availableCommands);
      worker.parsedOptions = this.enrichParsedOptions(
        worker.userId,
        worker.parsedOptions,
        { projectId: chat?.projectId ?? null, chatId: worker.chatId },
        acpCmds
      );
      this.hub.emitDurable({
        userId: worker.userId,
        type: 'chat.commands_updated',
        chatId: worker.chatId,
        payload: {
          availableCommands: worker.parsedOptions.availableCommands ?? [],
          sessionOptions: worker.parsedOptions,
        },
      });
      return;
    }

    const turn = this.resolveBridgeForNotification(worker, params);
    const isBackgroundTurn = !worker.activeTurn || turn !== worker.activeTurn;

    if (update.sessionUpdate === 'usage_update') {
      if (turn) {
        turn.lastActivityAt = Date.now();
        turn.lastParentActivityAt = Date.now();
      }
      const used = Number(update.used);
      const size = Number(update.size);
      if (Number.isFinite(used) && Number.isFinite(size) && used >= 0 && size >= 0) {
        const curChat = this.db.getChat(worker.userId, worker.chatId);
        if (curChat && (curChat.contextUsed !== used || curChat.contextSize !== size)) {
          const updatedChat = this.db.updateChat(worker.userId, worker.chatId, {
            contextUsed: used,
            contextSize: size,
          });
          if (updatedChat) {
            this.hub.emitDurable({
              userId: worker.userId,
              type: 'chat.updated',
              chatId: worker.chatId,
              payload: { chat: updatedChat },
            });
          }
        }
      }
      this.hub.emitEphemeral({
        userId: worker.userId,
        type: 'chat.context_usage',
        chatId: worker.chatId,
        runId: turn?.runId ?? null,
        payload: { used: update.used, size: update.size, cost: update.cost ?? null },
      });
      return;
    }

    if (!turn) {
      return;
    }

    const now = Date.now();
    turn.lastActivityAt = now;
    worker.lastUsedAt = now;
    if (isBackgroundTurn) {
      worker.lastBackgroundActivityAt = now;
    }

    const finalizeIfBackground = (syncArtifacts = false) => {
      if (isBackgroundTurn) {
        this.flushBackgroundBridgeToMessage(worker, turn, syncArtifacts);
      }
    };

    // Route child subagent session notifications cleanly without mixing child scratch output into parent text
    if (params.sessionId && worker.acpSessionId && params.sessionId !== worker.acpSessionId) {
      this.handleChildSessionNotification(worker, turn, params.sessionId, update);
      const childRawType = String((update as unknown as Record<string, unknown>).sessionUpdate || '');
      const shouldSyncChildArtifacts =
        childRawType === 'state_update' ||
        (update.sessionUpdate === 'tool_call_update' &&
          (update.status === 'completed' || update.status === 'failed')) ||
        (update.sessionUpdate === 'agent_message_chunk' && update.content.type !== 'text');
      finalizeIfBackground(shouldSyncChildArtifacts);
      return;
    }

    const rawUpdate = update as unknown as Record<string, unknown>;
    const rawUpdateType = String(rawUpdate.sessionUpdate || '');

    if (rawUpdateType === 'subagent_update') {
      // In ACP v1/v2 (`SubagentUpdate.state`), `state: null` clears the current activity of the subagent.
      const hasExplicitNullState = 'state' in rawUpdate && rawUpdate.state === null;
      const subStateObj = rawUpdate.state as
        | { state?: 'running' | 'idle' | 'requires_action' | 'unknown'; stopReason?: string | null }
        | null
        | undefined;
      const resolvedSubState = hasExplicitNullState
        ? 'idle'
        : subStateObj?.state ?? (subStateObj?.stopReason ? 'idle' : undefined);
      this.upsertSubagentToolCall(worker, turn, {
        subSessionId: typeof rawUpdate.sessionId === 'string' ? rawUpdate.sessionId : 'subagent',
        toolCallId: typeof rawUpdate.toolCallId === 'string' ? rawUpdate.toolCallId : null,
        title: typeof rawUpdate.title === 'string' ? rawUpdate.title : null,
        description: typeof rawUpdate.description === 'string' ? rawUpdate.description : null,
        state: resolvedSubState,
        stopReason: subStateObj?.stopReason,
      });
      finalizeIfBackground(resolvedSubState === 'idle');
      return;
    }

    if (rawUpdateType === 'state_update') {
      const stateObj = rawUpdate as {
        state?: 'running' | 'idle' | 'requires_action' | 'unknown';
        stopReason?: string | null;
        background?: Array<{ type?: string; sessionId?: string; toolCallId?: string }> | null;
      };
      turn.lastParentActivityAt = now;
      if (Array.isArray(stateObj.background)) {
        const activeBg = stateObj.background;
        turn.backgroundWorkCount = activeBg.length;
        const allBridges: ActiveTurnBridge[] = [...worker.turnBridges.values()];
        if (worker.backgroundBridge && !allBridges.includes(worker.backgroundBridge)) {
          allBridges.push(worker.backgroundBridge);
        }
        for (const b of allBridges) {
          if (b === turn || !b.initialPromptDone || b.backgroundWorkCount === 0) continue;
          if (activeBg.length === 0) {
            b.backgroundWorkCount = 0;
          } else {
            const stillHasWorkForB = activeBg.some(
              (item) =>
                item &&
                ((typeof item.sessionId === 'string' && b.subagents.has(item.sessionId)) ||
                  (typeof item.toolCallId === 'string' &&
                    (b.asyncSubagentToolIds.has(item.toolCallId) ||
                      b.toolCalls.some((t) => t.toolCallId === item.toolCallId))))
            );
            if (!stillHasWorkForB) {
              b.backgroundWorkCount = 0;
            }
          }
        }
        for (const item of activeBg) {
          if (item && item.type === 'subagent' && typeof item.sessionId === 'string') {
            const subId = item.sessionId;
            if (!allBridges.some((b) => b.subagents.has(subId))) {
              this.upsertSubagentToolCall(worker, turn, {
                subSessionId: subId,
                toolCallId: typeof item.toolCallId === 'string' ? item.toolCallId : null,
                state: 'running',
              });
            }
          }
        }
      } else if (stateObj.background === null) {
        turn.backgroundWorkCount = 0;
        for (const b of worker.turnBridges.values()) {
          if (b.initialPromptDone) b.backgroundWorkCount = 0;
        }
        if (worker.backgroundBridge && worker.backgroundBridge.initialPromptDone) {
          worker.backgroundBridge.backgroundWorkCount = 0;
        }
      }
      if (stateObj.state) {
        turn.parentState = stateObj.state;
        if (stateObj.state === 'idle') {
          for (const b of worker.turnBridges.values()) {
            if (b.initialPromptDone) b.parentState = 'idle';
          }
          if (worker.backgroundBridge && worker.backgroundBridge.initialPromptDone) {
            worker.backgroundBridge.parentState = 'idle';
          }
        }
      }
      let completedWakeup: { wakeupSeq: number; previewText: string; isError: boolean } | null = null;
      if (
        (stateObj.state === 'running' || stateObj.state === 'requires_action') &&
        turn.initialPromptDone
      ) {
        turn.parentWakeupStarted = true;
      } else if (stateObj.state === 'idle' && turn.initialPromptDone) {
        if (turn.activity.at(-1)?.kind === 'content') turn.activity.push({ kind: 'answer_end' });
        if (turn.parentWakeupStarted || turn.receivedWakeupText) {
          turn.parentWakeupStarted = false;
          turn.receivedWakeupText = false;
          turn.wakeupCount += 1;
          const wakeupSlice = turn.contentText.slice(turn.wakeupContentOffset).trim();
          turn.wakeupContentOffset = turn.contentText.length;
          completedWakeup = {
            wakeupSeq: turn.wakeupCount,
            previewText: wakeupSlice,
            isError: stateObj.stopReason === 'error' || stateObj.stopReason === 'refusal',
          };
        }
      }
      finalizeIfBackground(stateObj.state === 'idle');
      if (completedWakeup) {
        const tag = `run-${turn.runId}-wakeup-${completedWakeup.wakeupSeq}`;
        const status = completedWakeup.isError ? 'error' : 'completed';
        const finalMsg = this.db.getMessage(worker.userId, turn.assistantMessageId);
        this.hub.emitDurable({
          userId: worker.userId,
          type: 'run.wakeup_finished',
          chatId: worker.chatId,
          runId: turn.runId,
          payload: {
            runId: turn.runId,
            chatId: worker.chatId,
            message: finalMsg,
            status,
            previewText: completedWakeup.previewText,
            notificationTag: tag,
          },
        });
        void this.pushService
          ?.notifyRunFinished({
            userId: worker.userId,
            chatId: worker.chatId,
            runId: turn.runId,
            status,
            previewText: completedWakeup.previewText,
            errorMessage: status === 'error' ? completedWakeup.previewText || undefined : undefined,
            tagOverride: tag,
          })
          .catch((err) => {
            console.warn('[acp] Push wakeup notification failed:', err);
          });
      }
      return;
    }

    if (rawUpdateType === 'session_message' || rawUpdateType === 'session_message_chunk') {
      this.handleInterSessionMessageNotification(worker, turn, rawUpdateType, rawUpdate);
      finalizeIfBackground(rawUpdateType === 'session_message' || Boolean(rawUpdate.done));
      return;
    }

    // Parent session activity arriving after the initial session/prompt resolved means
    // Antigravity's native Reactive Wakeup has resumed the parent session.
    const isTerminalToolUpdate =
      update.sessionUpdate === 'tool_call_update' &&
      (update.status === 'completed' || update.status === 'failed');
    const anotherForegroundTurnActive = Boolean(worker.activeTurn && turn !== worker.activeTurn);
    if (
      turn.initialPromptDone &&
      !isTerminalToolUpdate &&
      !anotherForegroundTurnActive &&
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk' ||
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update')
    ) {
      turn.lastParentActivityAt = now;
      turn.parentState = 'running';
      if (!turn.parentWakeupStarted) {
        turn.parentWakeupStarted = true;
      }
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      if (turn.initialPromptDone && !turn.receivedWakeupText) {
        turn.receivedWakeupText = true;
        if (turn.contentText.trim().length > 0 && !turn.contentText.endsWith('\n\n')) {
          this.appendTurnContentChunk(
            worker,
            turn,
            turn.contentText.endsWith('\n') ? '\n' : '\n\n'
          );
        }
      }
      this.appendTurnContentChunk(worker, turn, this.renderContentBlock(worker, turn, update.content));
      finalizeIfBackground(update.content.type !== 'text');
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      this.appendTurnThoughtChunk(worker, turn, this.renderContentBlock(worker, turn, update.content));
      finalizeIfBackground();
      return;
    }

    if (update.sessionUpdate === 'tool_call') {
      const rawName = (update as { name?: string }).name;
      const rawContent = (update as { content?: unknown }).content;
      const subagentMeta = classifySubagentToolCall({
        name: rawName,
        title: update.title,
        kind: update.kind,
        rawInput: update.rawInput,
        rawContent,
      });
      if (subagentMeta.isAsyncSubagentLaunch) this.bindAsyncSubagentTool(turn, update.toolCallId);
      const contentText = this.extractToolCallContentAndSaveAssets(worker, turn, rawContent);
      const diffStats = summarizeToolDiff(update.content);
      const boundSubagent = [...turn.subagents.values()].find(
        (s) => s.toolCallId === update.toolCallId
      );

      const nextTool: ToolCallItem = {
        toolCallId: update.toolCallId,
        title: update.title,
        ...(rawName ? { name: rawName } : {}),
        kind: update.kind,
        status: update.status ?? 'in_progress',
        ...(subagentMeta.isSubagent
          ? { isSubagent: true, subagentLabel: subagentMeta.subagentLabel }
          : {}),
        ...(boundSubagent
          ? {
              subagentSessionId: boundSubagent.sessionId,
              subagentState: boundSubagent.state,
              ...(boundSubagent.stopReason !== undefined
                ? { subagentStopReason: boundSubagent.stopReason }
                : {}),
            }
          : {}),
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        locations: update.locations?.map((l) => ({ path: l.path, line: l.line })),
        ...(contentText ? { contentText } : {}),
        ...(diffStats ? { diffStats } : {}),
      };
      const idx = turn.toolCalls.findIndex((t) => t.toolCallId === nextTool.toolCallId);
      if (idx >= 0) turn.toolCalls[idx] = nextTool;
      else turn.toolCalls.push(nextTool);


      this.publishToolActivity(worker, turn, nextTool.toolCallId);
      finalizeIfBackground();
      return;
    }

    if (update.sessionUpdate === 'tool_call_update') {
      const idx = turn.toolCalls.findIndex((t) => t.toolCallId === update.toolCallId);
      const existing: ToolCallItem =
        idx >= 0
          ? turn.toolCalls[idx]
          : { toolCallId: update.toolCallId, title: update.title ?? 'ツール実行', status: 'in_progress' };

      const rawName = (update as { name?: string }).name ?? existing.name;
      const mergedTitle =
        update.title !== undefined && update.title !== null ? update.title : existing.title;
      const mergedKind =
        update.kind !== undefined && update.kind !== null ? update.kind : existing.kind;
      const mergedRawInput = update.rawInput !== undefined ? update.rawInput : existing.rawInput;
      const rawContent = (update as { content?: unknown }).content;
      const subagentMeta = classifySubagentToolCall({
        name: rawName,
        title: mergedTitle,
        kind: mergedKind,
        rawInput: mergedRawInput,
        rawContent,
      });
      if (subagentMeta.isAsyncSubagentLaunch) this.bindAsyncSubagentTool(turn, update.toolCallId);
      const contentText = this.extractToolCallContentAndSaveAssets(worker, turn, rawContent);
      const diffStats = summarizeToolDiff(update.content);

      const effectiveStatus =
        update.status !== undefined && update.status !== null ? update.status : existing.status;

      const mergedRaw: ToolCallItem = {
        ...existing,
        title: mergedTitle,
        ...(rawName ? { name: rawName } : {}),
        ...(mergedKind !== undefined ? { kind: mergedKind } : {}),
        status: effectiveStatus,
        ...(subagentMeta.isSubagent
          ? { isSubagent: true, subagentLabel: subagentMeta.subagentLabel }
          : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(update.locations !== undefined && update.locations !== null
          ? { locations: update.locations.map((l) => ({ path: l.path, line: l.line })) }
          : {}),
        ...(contentText ? { contentText } : {}),
        ...(diffStats ? { diffStats } : {}),
      };
      const merged = mergedRaw;
      const nextIdx = turn.toolCalls.findIndex((t) => t.toolCallId === update.toolCallId);
      if (nextIdx >= 0) turn.toolCalls[nextIdx] = merged;
      else turn.toolCalls.push(merged);


      this.publishToolActivity(worker, turn, merged.toolCallId);
      finalizeIfBackground(isTerminalToolUpdate);
    }
  }

  private maybeFlushTurnProgress(turn: ActiveTurnBridge): void {
    const now = Date.now();
    if (now - turn.lastDbFlushAt >= 150) {
      turn.lastDbFlushAt = now;
      this.db.updateMessage(turn.userId, turn.assistantMessageId, {
        contentText: turn.contentText,
        thoughtsText: turn.thoughtsText,
        activity: turn.activity,
      });
    }
  }

  private recordTextActivity(turn: ActiveTurnBridge, kind: 'content' | 'thoughts', offset: number): number {
    if (turn.activity.at(-1)?.kind !== kind) turn.activity.push({ kind, offset });
    return turn.activity.length - 1;
  }

  private bindAsyncSubagentTool(turn: ActiveTurnBridge, toolCallId: string): void {
    turn.asyncSubagentToolIds.add(toolCallId);
    const tracked = [...turn.subagents.values()].find((child) => child.toolCallId === `subagent:${child.sessionId}`);
    if (!tracked) return;

    const fallbackId = tracked.toolCallId;
    turn.toolCalls = turn.toolCalls.filter((tool) => tool.toolCallId !== fallbackId);
    const fallbackIndex = turn.activity.findIndex((entry) => entry.kind === 'tool' && entry.toolCallId === fallbackId);
    if (fallbackIndex >= 0) {
      if (turn.activity.some((entry) => entry.kind === 'tool' && entry.toolCallId === toolCallId)) {
        turn.activity.splice(fallbackIndex, 1);
      } else {
        turn.activity[fallbackIndex] = { kind: 'tool', toolCallId };
      }
    }
    tracked.toolCallId = toolCallId;
  }

  private publishToolActivity(worker: WorkerInstance, turn: ActiveTurnBridge, toolCallId: string): void {
    if (!turn.activity.some((entry) => entry.kind === 'tool' && entry.toolCallId === toolCallId)) {
      turn.activity.push({ kind: 'tool', toolCallId });
    }
    this.db.updateMessage(turn.userId, turn.assistantMessageId, {
      contentText: turn.contentText,
      thoughtsText: turn.thoughtsText,
      toolCalls: turn.toolCalls,
      activity: turn.activity,
    });
    this.hub.emitEphemeral({
      userId: worker.userId,
      type: 'run.tool_update',
      chatId: worker.chatId,
      runId: turn.runId,
      payload: { messageId: turn.assistantMessageId, toolCalls: turn.toolCalls, activity: turn.activity },
    });
  }

  private loadApiKeyForUser(userId: string): string | null {
    const enc = this.db.getAgyEncryptedApiKey(userId);
    if (!enc) return null;
    try {
      return decryptSmallSecret(enc, this.config.sessionSecret);
    } catch {
      return null;
    }
  }

  private async stopWorkerByKey(key: string): Promise<void> {
    const w = this.workers.get(key);
    if (!w) return;
    this.workers.delete(key);
    try {
      w.conn.close();
    } catch {
      // ignore
    }
    if (!w.process.killed && w.process.exitCode === null) {
      w.process.kill('SIGTERM');
    }
  }

  private isWorkerBusy(w: WorkerInstance): boolean {
    if (w.inFlight || w.activeTurn !== null) return true;
    for (const b of w.turnBridges.values()) {
      if (this.isBridgeBusy(b)) return true;
    }
    if (w.backgroundBridge && this.isBridgeBusy(w.backgroundBridge)) {
      return true;
    }
    return false;
  }

  private evictOneIdleIfFull(): void {
    if (this.workers.size < this.config.maxConcurrentAcp) return;
    let oldestIdle: WorkerInstance | null = null;
    for (const w of this.workers.values()) {
      if (!this.isWorkerBusy(w) && (!oldestIdle || w.lastUsedAt < oldestIdle.lastUsedAt)) {
        oldestIdle = w;
      }
    }
    if (oldestIdle && !this.isWorkerBusy(oldestIdle)) {
      void this.stopWorkerByKey(oldestIdle.key);
    }
  }

  private evictIdleWorkers(): void {
    const cutoff = Date.now() - this.config.idleWorkerMs;
    for (const w of this.workers.values()) {
      if (!this.isWorkerBusy(w) && w.lastUsedAt < cutoff) {
        void this.stopWorkerByKey(w.key);
      }
    }
  }
}
