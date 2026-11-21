import type {
  AgyLoginFlowState,
  AgyProfile,
  ArtifactRecord,
  AttachmentRef,
  BootstrapResponse,
  ChatDetailResponse,
  ChatRecord,
  McpAuthType,
  McpScope,
  McpServerRecord,
  McpTestResult,
  McpTransport,
  MessageRecord,
  ParsedSessionOptions,
  PendingPermissionRecord,
  ProjectFileRecord,
  ProjectRecord,
  QuotaSnapshotRecord,
  RunRecord,
  SandboxStatus,
  SkillDetail,
  SkillScope,
  SkillsListResponse,
  UserPreferences,
  WebUser,
} from '../types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type AgyAgentMode = 'auto' | '' | 'accept-edits' | 'plan';

export function getCsrfToken(): string {
  const cookies = document.cookie.split(';');
  for (const part of cookies) {
    const trimmed = part.trim();
    if (trimmed.startsWith('agy_chat_csrf=')) {
      return decodeURIComponent(trimmed.slice('agy_chat_csrf='.length));
    }
  }
  return '';
}

async function apiFetch<T>(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    formData?: FormData;
  } = {}
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = getCsrfToken();
    if (csrf) {
      headers['x-csrf-token'] = csrf;
    }
  }

  let fetchBody: BodyInit | undefined;
  if (options.formData) {
    fetchBody = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(options.body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: fetchBody,
    credentials: 'include',
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const code = (data && typeof data.error === 'string' && data.error) || `HTTP_${res.status}`;
    const msg = (data && typeof data.message === 'string' && data.message) || `リクエストに失敗しました (${res.status})`;
    throw new ApiError(res.status, code, msg, data);
  }

  return data as T;
}

export const api = {
  bootstrap: () => apiFetch<BootstrapResponse>('/api/auth/bootstrap'),

  register: (payload: { username: string; displayName?: string; password: string }) =>
    apiFetch<{
      user: WebUser;
      agyProfile: AgyProfile;
      preferences: UserPreferences;
      loginFlow: AgyLoginFlowState;
      sandbox?: SandboxStatus | null;
    }>('/api/auth/register', { method: 'POST', body: payload }),

  login: (payload: { username: string; password: string }) =>
    apiFetch<{
      user: WebUser;
      agyProfile: AgyProfile;
      preferences: UserPreferences;
      loginFlow: AgyLoginFlowState;
      sandbox?: SandboxStatus | null;
    }>('/api/auth/login', { method: 'POST', body: payload }),

  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  logoutAll: () => apiFetch<{ ok: boolean }>('/api/auth/logout-all', { method: 'POST' }),

  updatePreferences: (
    patch: Partial<
      Pick<
        UserPreferences,
        | 'theme'
        | 'notifyOnResponse'
        | 'hapticFeedback'
        | 'defaultModelId'
        | 'defaultEffortValue'
      >
    >
  ) =>
    apiFetch<{ preferences: UserPreferences }>('/api/preferences', { method: 'PATCH', body: patch }),

  // Antigravity account binding
  getAgyStatus: () =>
    apiFetch<{ profile: AgyProfile; loginFlow: AgyLoginFlowState }>('/api/agy/status'),

  getAgyAgentMode: () =>
    apiFetch<{ agentMode: string | null }>('/api/agy/agent-mode'),

  updateAgyAgentMode: (agentMode: AgyAgentMode) =>
    apiFetch<{ agentMode: AgyAgentMode }>('/api/agy/agent-mode', { method: 'PATCH', body: { agentMode } }),

  startAgyLogin: (accountLabel?: string | null) =>
    apiFetch<{ profile: AgyProfile; loginFlow: AgyLoginFlowState }>('/api/agy/login/start', {
      method: 'POST',
      body: { accountLabel: accountLabel ?? null },
    }),

  submitAgyCode: (code: string) =>
    apiFetch<{ profile: AgyProfile; loginFlow: AgyLoginFlowState }>('/api/agy/login/code', {
      method: 'POST',
      body: { code },
    }),

  cancelAgyLogin: () =>
    apiFetch<{ profile: AgyProfile; loginFlow: AgyLoginFlowState }>('/api/agy/login/cancel', {
      method: 'POST',
    }),

  setAgyApiKey: (apiKey: string, accountLabel?: string | null) =>
    apiFetch<{ profile: AgyProfile }>('/api/agy/api-key', {
      method: 'POST',
      body: { apiKey, accountLabel: accountLabel ?? null },
    }),

  disconnectAgy: () => apiFetch<{ profile: AgyProfile }>('/api/agy/disconnect', { method: 'POST' }),

  // Projects
  listProjects: () => apiFetch<{ projects: ProjectRecord[] }>('/api/projects'),

  createProject: (payload: { name: string; description?: string; instructions?: string }) =>
    apiFetch<{ project: ProjectRecord }>('/api/projects', { method: 'POST', body: payload }),

  updateProject: (projectId: string, patch: { name?: string; description?: string; instructions?: string }) =>
    apiFetch<{ project: ProjectRecord }>(`/api/projects/${projectId}`, { method: 'PATCH', body: patch }),

  deleteProject: (projectId: string) =>
    apiFetch<{ ok: boolean }>(`/api/projects/${projectId}`, { method: 'DELETE' }),

  uploadProjectFiles: (projectId: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return apiFetch<{ project: ProjectRecord; uploaded: ProjectFileRecord[] }>(
      `/api/projects/${projectId}/files`,
      { method: 'POST', formData: fd }
    );
  },

  deleteProjectFile: (projectId: string, fileId: string) =>
    apiFetch<{ project: ProjectRecord }>(`/api/projects/${projectId}/files/${fileId}`, {
      method: 'DELETE',
    }),

  // Chats
  listChats: (params?: { search?: string; projectId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.projectId) qs.set('projectId', params.projectId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ chats: ChatRecord[] }>(`/api/chats${suffix}`);
  },

  createChat: (payload: { title?: string; projectId?: string | null; modelId?: string | null; effortValue?: string | null }) =>
    apiFetch<{ chat: ChatRecord; sessionOptions: ParsedSessionOptions | null }>('/api/chats', {
      method: 'POST',
      body: payload,
    }),

  getChat: (chatId: string) => apiFetch<ChatDetailResponse>(`/api/chats/${chatId}`),

  patchChat: (chatId: string, patch: { title?: string; modelId?: string | null; effortValue?: string | null }) =>
    apiFetch<{ chat: ChatRecord; sessionOptions: ParsedSessionOptions | null }>(`/api/chats/${chatId}`, {
      method: 'PATCH',
      body: patch,
    }),

  deleteChat: (chatId: string) =>
    apiFetch<{ ok: boolean }>(`/api/chats/${chatId}`, { method: 'DELETE' }),

  syncChatProject: (chatId: string) =>
    apiFetch<{ chat: ChatRecord; syncedPaths: string[] }>(`/api/chats/${chatId}/sync-project`, {
      method: 'POST',
    }),

  uploadChatAttachments: (chatId: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return apiFetch<{ attachments: AttachmentRef[] }>(`/api/chats/${chatId}/attachments`, {
      method: 'POST',
      formData: fd,
    });
  },

  sendMessage: (
    chatId: string,
    payload: { text: string; attachmentIds?: string[]; clientMessageId?: string }
  ) =>
    apiFetch<{
      userMessage: MessageRecord;
      assistantMessage: MessageRecord;
      run: RunRecord;
      chat?: ChatRecord;
      deduplicated: boolean;
    }>(`/api/chats/${chatId}/messages`, { method: 'POST', body: payload }),

  cancelRun: (chatId: string, runId: string) =>
    apiFetch<{ run: RunRecord }>(`/api/chats/${chatId}/runs/${runId}/cancel`, { method: 'POST' }),

  resolvePermission: (
    chatId: string,
    permissionId: string,
    payload: { optionId?: string | null; alwaysAllow?: boolean; cancel?: boolean; clientId?: string }
  ) =>
    apiFetch<{ permission: PendingPermissionRecord }>(
      `/api/chats/${chatId}/permissions/${permissionId}`,
      { method: 'POST', body: payload }
    ),

  resolveElicitation: (
    chatId: string,
    elicitationId: string,
    payload: {
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, string | number | boolean | string[]> | null;
      clientId?: string;
    }
  ) =>
    apiFetch<{ elicitation: import('../types').PendingElicitationRecord }>(
      `/api/chats/${chatId}/elicitations/${elicitationId}`,
      { method: 'POST', body: payload }
    ),

  // Artifacts
  resolveLink: (chatId: string, reference: string) =>
    apiFetch<{ artifact: ArtifactRecord; previewUrl: string; downloadUrl: string }>(
      `/api/chats/${chatId}/resolve-link`,
      { method: 'POST', body: { reference } }
    ),

  getArtifact: (artifactId: string) =>
    apiFetch<{ artifact: ArtifactRecord }>(`/api/files/${artifactId}`),

  copyArtifactToProject: (artifactId: string, projectId: string) =>
    apiFetch<{ project: ProjectRecord; file: ProjectFileRecord }>(
      `/api/files/${artifactId}/copy-to-project`,
      { method: 'POST', body: { projectId } }
    ),

  // Agent Skills
  listSkills: (params?: { projectId?: string | null; chatId?: string | null }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.chatId) qs.set('chatId', params.chatId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<SkillsListResponse>(`/api/skills${suffix}`);
  },

  getSkill: (scope: SkillScope, slug: string, params?: { projectId?: string | null; chatId?: string | null }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.chatId) qs.set('chatId', params.chatId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${suffix}`
    );
  },

  createSkill: (payload: {
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
  }) =>
    apiFetch<{ skill: SkillDetail }>('/api/skills', { method: 'POST', body: payload }),

  saveSkill: (
    scope: SkillScope,
    slug: string,
    payload: {
      projectId?: string | null;
      chatId?: string | null;
      name?: string;
      description?: string;
      instructions?: string;
      rawSkillMd?: string;
      disableModelInvocation?: boolean;
      enabled?: boolean;
    }
  ) =>
    apiFetch<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}`,
      { method: 'PUT', body: payload }
    ),

  toggleSkill: (
    scope: SkillScope,
    slug: string,
    enabled: boolean,
    params?: { projectId?: string | null; chatId?: string | null }
  ) =>
    apiFetch<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}`,
      {
        method: 'PUT',
        body: {
          enabled,
          projectId: params?.projectId ?? null,
          chatId: params?.chatId ?? null,
        },
      }
    ),

  deleteSkill: (scope: SkillScope, slug: string, params?: { projectId?: string | null; chatId?: string | null }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.chatId) qs.set('chatId', params.chatId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ ok: boolean }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${suffix}`,
      { method: 'DELETE' }
    );
  },

  uploadSkillFiles: (
    scope: SkillScope,
    slug: string,
    files: File[],
    params?: { projectId?: string | null; chatId?: string | null; folder?: string }
  ) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.chatId) qs.set('chatId', params.chatId);
    if (params?.folder) qs.set('folder', params.folder);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/files${suffix}`,
      { method: 'POST', formData: fd }
    );
  },

  saveSkillTextFile: (
    scope: SkillScope,
    slug: string,
    payload: { relPath: string; content: string; projectId?: string | null; chatId?: string | null }
  ) =>
    apiFetch<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/files`,
      { method: 'POST', body: payload }
    ),

  readSkillFile: (
    scope: SkillScope,
    slug: string,
    filePath: string,
    params?: { projectId?: string | null; chatId?: string | null }
  ) => {
    const qs = new URLSearchParams({ path: filePath });
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.chatId) qs.set('chatId', params.chatId);
    return apiFetch<{ relPath: string; content: string }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/files?${qs.toString()}`
    );
  },

  deleteSkillFile: (
    scope: SkillScope,
    slug: string,
    filePath: string,
    params?: { projectId?: string | null; chatId?: string | null }
  ) => {
    const qs = new URLSearchParams({ path: filePath });
    if (params?.projectId) qs.set('projectId', params.projectId);
    if (params?.chatId) qs.set('chatId', params.chatId);
    return apiFetch<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}/files?${qs.toString()}`,
      { method: 'DELETE' }
    );
  },

  // Health & version detection
  getHealth: () =>
    apiFetch<{
      ok: boolean;
      agyMode: 'real' | 'mock';
      version?: string;
      tag?: string | null;
      shortSha?: string | null;
      builtAt?: string | null;
      buildId?: string;
      uptimeSec: number;
    }>('/api/health'),

  // Pre-chat model & effort options
  getAgyOptions: (modelId?: string | null) => {
    const qs = modelId ? `?modelId=${encodeURIComponent(modelId)}` : '';
    return apiFetch<{ sessionOptions: ParsedSessionOptions | null }>(`/api/agy/options${qs}`);
  },

  // Quota
  getQuota: () => apiFetch<{ quota: QuotaSnapshotRecord }>('/api/quota'),

  refreshQuota: (auto = false, minAgeMs?: number) =>
    apiFetch<{ quota: QuotaSnapshotRecord }>('/api/quota/refresh', {
      method: 'POST',
      body: {
        ...(auto ? { auto: true } : {}),
        ...(minAgeMs !== undefined ? { minAgeMs } : {}),
      },
    }),

  // Web Push Notifications
  getNotificationConfig: () =>
    apiFetch<{ vapidPublicKey: string; subscriptionCount: number }>('/api/notifications/config'),

  getNotificationStatus: (endpoint?: string | null) =>
    apiFetch<{ registeredOnServer: boolean; subscriptionCount: number }>('/api/notifications/status', {
      method: 'POST',
      body: endpoint ? { endpoint } : {},
    }),

  subscribePush: (payload: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
  }) =>
    apiFetch<{ ok: boolean; subscriptionCount: number }>('/api/notifications/subscribe', {
      method: 'POST',
      body: payload,
    }),

  unsubscribePush: (endpoint: string) =>
    apiFetch<{ ok: boolean; removed: boolean; subscriptionCount: number }>('/api/notifications/unsubscribe', {
      method: 'POST',
      body: { endpoint },
    }),

  sendTestPush: (endpoint?: string | null) =>
    apiFetch<{
      sent: number;
      failed: number;
      removed: number;
      total: number;
      lastError?: string;
      currentDeviceRegistered?: boolean;
      currentDeviceSent?: boolean;
      currentDeviceError?: string;
    }>('/api/notifications/test', { method: 'POST', body: endpoint ? { endpoint } : {} }),

  // Admin MCP Server Management
  listMcpServers: () =>
    apiFetch<{ servers: McpServerRecord[]; callbackUrl: string }>('/api/mcp/servers'),

  createMcpServer: (payload: {
    name: string;
    description?: string;
    scope: McpScope;
    transport: McpTransport;
    enabled?: boolean;
    allowedTools?: string[];
    disabledTools?: string[];
    alwaysAllowTools?: string[];
    command?: string | null;
    args?: string[];
    env?: Array<{ name: string; value?: string; keepExisting?: boolean }>;
    url?: string | null;
    authType?: McpAuthType;
    headers?: Array<{ name: string; value?: string; keepExisting?: boolean }>;
    oauthConfig?: {
      clientId?: string | null;
      clientSecret?: string | null;
      clearClientSecret?: boolean;
      authorizationUrl?: string | null;
      tokenUrl?: string | null;
      registrationUrl?: string | null;
      scopes?: string | null;
      resource?: string | null;
      extraAuthParams?: Record<string, string> | null;
    } | null;
  }) =>
    apiFetch<{ server: McpServerRecord }>('/api/mcp/servers', {
      method: 'POST',
      body: payload,
    }),

  updateMcpServer: (
    id: string,
    payload: {
      name?: string;
      description?: string;
      scope?: McpScope;
      transport?: McpTransport;
      enabled?: boolean;
      allowedTools?: string[];
      disabledTools?: string[];
      alwaysAllowTools?: string[];
      command?: string | null;
      args?: string[];
      env?: Array<{ name: string; value?: string; keepExisting?: boolean }>;
      url?: string | null;
      authType?: McpAuthType;
      headers?: Array<{ name: string; value?: string; keepExisting?: boolean }>;
      oauthConfig?: {
        clientId?: string | null;
        clientSecret?: string | null;
        clearClientSecret?: boolean;
        authorizationUrl?: string | null;
        tokenUrl?: string | null;
        registrationUrl?: string | null;
        scopes?: string | null;
        resource?: string | null;
        extraAuthParams?: Record<string, string> | null;
      } | null;
    }
  ) =>
    apiFetch<{ server: McpServerRecord }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: payload,
    }),

  deleteMcpServer: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  importMcpJson: (payload: { scope: McpScope; rawJson: string; overwrite?: boolean }) =>
    apiFetch<{ imported: McpServerRecord[]; skipped: string[] }>('/api/mcp/import', {
      method: 'POST',
      body: payload,
    }),

  testMcpServer: (id: string) =>
    apiFetch<{ result: McpTestResult; server?: McpServerRecord }>(`/api/mcp/servers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: {},
    }),

  startMcpOAuth: (id: string) =>
    apiFetch<{
      authorizationUrl: string;
      launchUrl?: string;
      redirectUri: string;
      state: string;
      mode?: 'callback' | 'code_paste';
    }>(`/api/mcp/servers/${encodeURIComponent(id)}/oauth/start`, { method: 'POST', body: {} }),

  completeMcpOAuth: (id: string, payload: { codeOrUrl: string; state?: string | null }) =>
    apiFetch<{ server: McpServerRecord }>(
      `/api/mcp/servers/${encodeURIComponent(id)}/oauth/complete`,
      { method: 'POST', body: payload }
    ),

  disconnectMcpOAuth: (id: string) =>
    apiFetch<{ server: McpServerRecord }>(
      `/api/mcp/servers/${encodeURIComponent(id)}/oauth/disconnect`,
      { method: 'POST', body: {} }
    ),
};
