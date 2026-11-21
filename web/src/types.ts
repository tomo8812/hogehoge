export type UserRole = 'admin' | 'user';
export type AgyAuthStatus = 'unauthenticated' | 'pending_login' | 'authenticated' | 'error';
export type AgyAuthMethod = 'oauth-personal' | 'gemini-api-key' | 'mock' | null;

export interface WebUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
}

export interface AgyProfile {
  userId: string;
  profileDir: string;
  authStatus: AgyAuthStatus;
  authMethod: AgyAuthMethod;
  accountLabel: string | null;
  lastVerifiedAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface AgyLoginFlowState {
  userId: string;
  status: 'idle' | 'starting' | 'awaiting_url' | 'awaiting_code' | 'verifying' | 'succeeded' | 'failed' | 'cancelled';
  authUrl: string | null;
  outputLines: string[];
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface AcpSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string | null;
  currentValue: string;
  options: AcpSelectOption[];
}

export interface AvailableCommandItem {
  name: string;
  description: string;
  inputHint?: string | null;
  source?: 'acp' | 'skill' | 'builtin';
  scope?: SkillScope;
}

export type SkillScope = 'global' | 'project' | 'workspace';
export type SkillOrigin = 'builtin' | 'custom';

export interface SkillResourceFile {
  relPath: string;
  name: string;
  sizeBytes: number;
  updatedAt: number;
}

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  scope: SkillScope;
  origin?: SkillOrigin;
  hasBuiltinConflict?: boolean;
  projectId: string | null;
  chatId: string | null;
  enabled: boolean;
  disableModelInvocation: boolean;
  resourceCount: number;
  updatedAt: number;
  storageKind?: 'canonical' | 'legacy' | 'builtin';
}

export interface SkillDetail extends SkillSummary {
  instructions: string;
  rawSkillMd: string;
  resources: SkillResourceFile[];
}

export interface SkillTemplate {
  slug: string;
  name: string;
  description: string;
  instructions: string;
}

export interface SkillsListResponse {
  global: SkillSummary[];
  project: SkillSummary[];
  workspace: SkillSummary[];
  projectId: string | null;
  chatId: string | null;
  templates: SkillTemplate[];
  commands: AvailableCommandItem[];
}

export interface ParsedSessionOptions {
  configOptions: AcpConfigOption[];
  modelOptionId: string | null;
  effortOptionId: string | null;
  currentModelId: string | null;
  currentEffortValue: string | null;
  availableCommands?: AvailableCommandItem[];
}

export interface ProjectFileRecord {
  id: string;
  projectId: string;
  userId: string;
  relPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  description: string;
  instructions: string;
  contextVersion: number;
  storageDir: string;
  createdAt: number;
  updatedAt: number;
  files: ProjectFileRecord[];
}

export interface RunRecord {
  id: string;
  chatId: string;
  userId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: 'queued' | 'running' | 'awaiting_permission' | 'completed' | 'cancelled' | 'error';
  queuePosition: number;
  modelId: string | null;
  effortValue: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface ChatRecord {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  workspaceDir: string;
  acpSessionId: string | null;
  modelId: string | null;
  effortValue: string | null;
  projectContextVersion: number;
  contextUsed?: number | null;
  contextSize?: number | null;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  activeRun?: RunRecord | null;
}

export type PreviewKind =
  | 'code'
  | 'markdown'
  | 'image'
  | 'svg'
  | 'pdf'
  | 'table'
  | 'docx'
  | 'pptx'
  | 'html'
  | 'mermaid'
  | 'audio'
  | 'video'
  | 'diff'
  | 'binary';

export interface AttachmentRef {
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  relPath: string;
  previewKind: PreviewKind;
}

export interface SubagentActivityItem {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: string;
  status: string;
  contentText?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
}

export interface SessionMessageItem {
  messageId: string;
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  senderMessageId?: string | null;
  recipientMessageId?: string | null;
  contentText: string;
  done: boolean;
  updatedAt: number;
}

export interface ToolCallItem {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: string;
  status: string;
  isSubagent?: boolean;
  subagentLabel?: string;
  subagentSessionId?: string;
  subagentState?: 'running' | 'idle' | 'requires_action' | 'unknown';
  subagentStopReason?: string | null;
  subagentThoughtsText?: string;
  subagentContentText?: string;
  subagentToolCalls?: SubagentActivityItem[];
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
  contentText?: string;
  diffStats?: { added: number; removed: number };
}

export type MessageActivity =
  | { kind: 'content'; offset: number }
  | { kind: 'thoughts'; offset: number }
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'answer_end' };

export interface MessageRecord {
  id: string;
  chatId: string;
  userId: string;
  clientMessageId: string | null;
  role: 'user' | 'assistant' | 'system';
  contentText: string;
  thoughtsText: string;
  toolCalls: ToolCallItem[];
  activity?: MessageActivity[];
  sessionMessages?: SessionMessageItem[];
  attachments: AttachmentRef[];
  artifactIds: string[];
  status: 'queued' | 'streaming' | 'completed' | 'cancelled' | 'error';
  runId: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PermissionOptionItem {
  optionId: string;
  name: string;
  kind: string;
}

export interface PendingPermissionRecord {
  id: string;
  runId: string;
  chatId: string;
  userId: string;
  toolCall: ToolCallItem;
  options: PermissionOptionItem[];
  status: 'pending' | 'resolved' | 'cancelled';
  selectedOptionId: string | null;
  resolvedByClientId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface ArtifactRecord {
  id: string;
  userId: string;
  chatId: string;
  messageId: string | null;
  runId: string | null;
  relPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  source: 'attachment' | 'generated' | 'project_copy';
  previewKind: PreviewKind;
  diffPatch: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QuotaBucket {
  model: string;
  group?: string;
  windowLabel?: string;
  remainingPercent: number | null;
  usedPercent: number | null;
  remainingLabel: string;
  resetAt: string | null;
  status: 'ok' | 'limited' | 'unknown';
}

export interface QuotaSnapshotRecord {
  userId: string;
  status: 'ok' | 'unavailable' | 'error';
  buckets: QuotaBucket[];
  rawSummary: string | null;
  errorMessage: string | null;
  fetchedAt: number;
}

export interface UserPreferences {
  userId: string;
  theme: 'system' | 'light' | 'dark';
  notifyOnResponse: boolean;
  hapticFeedback: boolean;
  defaultModelId: string | null;
  defaultEffortValue: string | null;
  updatedAt: number;
}

export interface SandboxStatus {
  mode: 'auto' | 'strict' | 'off';
  active: boolean;
  backend: 'bwrap' | 'mock' | 'none';
  reason: string | null;
  remediation: string | null;
}

export interface BootstrapResponse {
  userCount: number;
  allowPublicSignup: boolean;
  agyMode: 'real' | 'mock';
  buildId?: string;
  version?: string;
  shortSha?: string | null;
  builtAt?: string | null;
  authenticated: boolean;
  user: WebUser | null;
  agyProfile: AgyProfile | null;
  preferences: UserPreferences | null;
  loginFlow: AgyLoginFlowState | null;
  sandbox?: SandboxStatus | null;
}

export interface ChatDetailResponse {
  chat: ChatRecord;
  messages: MessageRecord[];
  artifacts: ArtifactRecord[];
  pendingPermissions: PendingPermissionRecord[];
  activeRun: RunRecord | null;
  project: ProjectRecord | null;
  sessionOptions: ParsedSessionOptions | null;
}

export interface SyncEventEnvelope {
  seq: number;
  eventId: string;
  userId: string;
  type: string;
  chatId: string | null;
  projectId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type WsIncomingMessage =
  | {
      kind: 'hello';
      userId: string;
      clientId: string;
      buildId?: string;
      version?: string;
      latestSeq: number;
      resyncRequired: boolean;
      events: SyncEventEnvelope[];
    }
  | {
      kind: 'event';
      event: SyncEventEnvelope;
    }
  | {
      kind: 'ephemeral';
      event: {
        eventId: string;
        userId: string;
        type: string;
        chatId: string | null;
        runId: string | null;
        payload: Record<string, unknown>;
        createdAt: number;
      };
    }
  | {
      kind: 'pong';
      ts: number;
    };

export type McpScope = 'shared' | 'profile';
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpAuthType = 'none' | 'bearer' | 'api_key' | 'headers' | 'oauth';
export type McpOAuthStatus = 'disconnected' | 'connected' | 'expired' | 'error';

export interface McpSecretEntrySummary {
  name: string;
  maskedValue: string;
  hasValue: boolean;
}

export interface McpOAuthSummary {
  status: McpOAuthStatus;
  clientId: string | null;
  hasClientSecret: boolean;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  registrationUrl: string | null;
  scopes: string | null;
  resource: string | null;
  extraAuthParams: Record<string, string>;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  error: string | null;
  updatedAt: number | null;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  description: string;
  scope: McpScope;
  ownerUserId: string | null;
  transport: McpTransport;
  enabled: boolean;
  allowedTools: string[];
  command: string | null;
  args: string[];
  env: McpSecretEntrySummary[];
  url: string | null;
  authType: McpAuthType;
  headers: McpSecretEntrySummary[];
  oauth: McpOAuthSummary | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpTestResult {
  ok: boolean;
  status: 'connected' | 'oauth_required' | 'error';
  message: string;
  serverInfo?: { name?: string; version?: string };
  resolvedCommand?: string | null;
  tools?: McpDiscoveredTool[];
  discoveredOAuth?: {
    authorizationUrl?: string | null;
    tokenUrl?: string | null;
    registrationUrl?: string | null;
    scopes?: string[];
  };
}

