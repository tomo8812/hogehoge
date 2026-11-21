import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AcpClientManager } from '../acp/client-manager.js';
import { authenticateRequest } from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import { McpService, McpValidationError } from '../mcp/mcp-service.js';
import type { McpScope } from '../types.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

const execFileAsync = promisify(execFile);

export interface McpRouteDeps extends RouteDeps {
  mcpService: McpService;
  acp: AcpClientManager;
}

const TAILSCALE_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.ts\.net$/;
const TAILSCALE_CACHE_OK_MS = 5 * 60 * 1000;
const TAILSCALE_CACHE_MISS_MS = 30 * 1000;

let cachedTailscaleHost: { value: string | null; expiresAt: number } | null = null;

export function parseTailscaleDnsName(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { Self?: { DNSName?: unknown } };
    const dnsName = parsed?.Self?.DNSName;
    if (typeof dnsName !== 'string') return null;
    const normalized = dnsName.trim().toLowerCase().replace(/\.+$/, '');
    if (!TAILSCALE_HOST_RE.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

async function detectTailscaleHostname(config: AppConfig): Promise<string | null> {
  if (config.nodeEnv === 'test') return null;
  const now = Date.now();
  if (cachedTailscaleHost && cachedTailscaleHost.expiresAt > now) {
    return cachedTailscaleHost.value;
  }
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json'], {
      timeout: 1500,
      maxBuffer: 1024 * 1024,
    });
    const hostname = parseTailscaleDnsName(stdout);
    cachedTailscaleHost = {
      value: hostname,
      expiresAt: now + (hostname ? TAILSCALE_CACHE_OK_MS : TAILSCALE_CACHE_MISS_MS),
    };
    return hostname;
  } catch {
    cachedTailscaleHost = {
      value: null,
      expiresAt: now + TAILSCALE_CACHE_MISS_MS,
    };
    return null;
  }
}

const secretEntrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  value: z.string().max(16_384).optional(),
  keepExisting: z.boolean().optional(),
});

const oauthConfigSchema = z
  .object({
    clientId: z.string().max(512).nullable().optional(),
    clientSecret: z.string().max(4096).nullable().optional(),
    clearClientSecret: z.boolean().optional(),
    authorizationUrl: z.string().max(2048).nullable().optional(),
    tokenUrl: z.string().max(2048).nullable().optional(),
    registrationUrl: z.string().max(2048).nullable().optional(),
    scopes: z.string().max(2048).nullable().optional(),
    resource: z.string().max(2048).nullable().optional(),
    extraAuthParams: z.record(z.string().max(2048)).nullable().optional(),
  })
  .nullable()
  .optional();

const createMcpSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(500).optional(),
  scope: z.enum(['shared', 'profile']).default('shared'),
  transport: z.enum(['stdio', 'http', 'sse']),
  enabled: z.boolean().optional(),
  allowedTools: z.array(z.string().max(200)).max(500).nullable().optional(),
  disabledTools: z.array(z.string().max(200)).max(500).nullable().optional(),
  alwaysAllowTools: z.array(z.string().max(200)).max(500).nullable().optional(),
  command: z.string().max(1024).nullable().optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  env: z.array(secretEntrySchema).max(100).optional(),
  url: z.string().max(2048).nullable().optional(),
  authType: z.enum(['none', 'bearer', 'api_key', 'headers', 'oauth']).optional(),
  headers: z.array(secretEntrySchema).max(100).optional(),
  oauthConfig: oauthConfigSchema,
});

const updateMcpSchema = createMcpSchema.partial();

const importMcpSchema = z.object({
  scope: z.enum(['shared', 'profile']).default('shared'),
  rawJson: z.string().min(2).max(200_000),
  overwrite: z.boolean().optional(),
});

function requireAdmin(req: FastifyRequest, reply: FastifyReply, db: AppDatabase) {
  const session = requireAuth(req, reply, db);
  if (!session) return null;
  if (session.user.role !== 'admin') {
    reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'MCPサーバーの管理は管理者のみ実行できます。',
    });
    return null;
  }
  return session;
}

function handleMcpError(reply: FastifyReply, err: unknown) {
  if (err instanceof McpValidationError) {
    return reply.code(err.statusCode).send({ error: err.code, message: err.message });
  }
  return reply.code(400).send({
    error: 'MCP_ERROR',
    message: err instanceof Error ? err.message : 'MCPサーバー操作に失敗しました。',
  });
}

function parseAllowlistedHost(
  rawHost: string | undefined,
  allowedHostnames: ReadonlySet<string>
): string | null {
  if (!rawHost) return null;
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || /[\s/\\@?#]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.host !== trimmed
    ) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (!allowedHostnames.has(hostname) && !allowedHostnames.has(parsed.host)) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

export function resolveRequestOriginWithTailscale(
  req: Pick<FastifyRequest, 'protocol' | 'headers' | 'socket'>,
  config: AppConfig,
  tailscaleHostname: string | null
): string {
  if (config.publicOrigin) {
    return config.publicOrigin;
  }
  const proto = req.protocol === 'https' ? 'https' : 'http';
  if (tailscaleHostname) {
    const tsAllowlist = new Set<string>([tailscaleHostname]);
    const matchedTsHost = parseAllowlistedHost(req.headers.host, tsAllowlist);
    if (matchedTsHost || proto === 'https') {
      return `https://${matchedTsHost ?? tailscaleHostname}`;
    }
  }
  const allowedHostnames = new Set<string>([
    '127.0.0.1',
    'localhost',
    '[::1]',
    '::1',
    config.host.trim().toLowerCase(),
    ...config.allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean),
  ]);
  const fallbackPort = req.socket?.localPort ?? config.port;
  const fallbackHost = `${config.host}:${fallbackPort}`;
  const host = parseAllowlistedHost(req.headers.host, allowedHostnames) ?? fallbackHost;
  return `${proto}://${host}`;
}

async function resolveRequestOrigin(req: FastifyRequest, config: AppConfig): Promise<string> {
  if (config.publicOrigin) {
    return config.publicOrigin;
  }
  const tsHostname = await detectTailscaleHostname(config);
  return resolveRequestOriginWithTailscale(req, config, tsHostname);
}

const completeMcpOAuthSchema = z.object({
  codeOrUrl: z.string().trim().min(1).max(8192),
  state: z.string().trim().max(512).nullable().optional(),
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderOAuthCallbackHtml(payload: {
  ok: boolean;
  serverId?: string;
  serverName?: string;
  message: string;
}): string {
  const safeJson = JSON.stringify({
    type: 'agy-mcp-oauth-complete',
    ok: payload.ok,
    serverId: payload.serverId ?? null,
    serverName: payload.serverName ?? null,
    message: payload.message,
    ts: Date.now(),
  }).replace(/</g, '\\u003c');

  const title = payload.ok ? 'OAuth 認証が完了しました' : 'OAuth 認証に失敗しました';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f1115;
      color: #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      max-width: 440px;
      width: 100%;
      background: #181b22;
      border: 1px solid #2b3140;
      border-radius: 14px;
      padding: 24px;
      text-align: center;
    }
    h1 { font-size: 18px; margin: 0 0 10px; color: ${payload.ok ? '#4ade80' : '#f87171'}; }
    p { font-size: 14px; line-height: 1.5; color: #cbd5e1; margin: 0 0 14px; word-break: break-word; }
    .hint { font-size: 12px; color: #94a3b8; margin: 0 0 18px; }
    .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    button, a.btn-link {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 9px 18px;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    a.btn-secondary {
      background: #2b3140;
      color: #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(payload.message)}</p>
    <p class="hint">iOS PWA（ホーム画面アプリ）の場合は画面端の「完了」をタップするか、下のボタンでアプリへ戻ると自動的に反映されます。</p>
    <div class="actions">
      <button type="button" onclick="closeOrReturn()">このウィンドウを閉じる</button>
      <a class="btn-link btn-secondary" href="/">チャット画面へ戻る</a>
    </div>
  </div>
  <script>
    function closeOrReturn() {
      try { window.close(); } catch (_) {}
      setTimeout(function () {
        if (!document.hidden) {
          window.location.replace('/');
        }
      }, 300);
    }
    (function () {
      var data = ${safeJson};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(data, window.location.origin);
        }
      } catch (_) {}
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          var bc = new BroadcastChannel('agy_mcp_oauth');
          bc.postMessage(data);
          bc.close();
        }
      } catch (_) {}
      try {
        localStorage.setItem('agy_mcp_oauth_complete', JSON.stringify(data));
      } catch (_) {}
      if (data.ok && window.opener && !window.opener.closed) {
        setTimeout(function () {
          try { window.close(); } catch (_) {}
        }, 900);
      }
    })();
  </script>
</body>
</html>`;
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): Promise<void> {
  const { config, db, mcpService, acp } = deps;

  const refreshWorkersForScope = async (scope: McpScope, ownerUserId: string | null) => {
    if (scope === 'shared') {
      await acp.stopIdleWorkersForAllUsers();
    } else if (ownerUserId) {
      await acp.stopIdleWorkersForUser(ownerUserId);
    }
  };

  app.get('/api/mcp/servers', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const servers = mcpService.listServersForAdmin(session.user.id);
    const origin = await resolveRequestOrigin(req, config);
    return {
      servers,
      callbackUrl: `${origin}/api/mcp/oauth/callback`,
    };
  });

  app.post('/api/mcp/servers', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const parsed = createMcpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? '入力内容が正しくありません。',
      });
    }
    try {
      const server = mcpService.createServer(session.user.id, parsed.data);
      await refreshWorkersForScope(server.scope, server.ownerUserId);
      return reply.code(201).send({ server });
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.patch('/api/mcp/servers/:id', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const { id } = req.params as { id: string };
    const parsed = updateMcpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? '入力内容が正しくありません。',
      });
    }
    try {
      const prev = mcpService.getServerForAdmin(session.user.id, id);
      const server = mcpService.updateServer(session.user.id, id, parsed.data);
      if (prev.scope === 'shared' || server.scope === 'shared') {
        await acp.stopIdleWorkersForAllUsers();
      } else {
        await refreshWorkersForScope(server.scope, server.ownerUserId);
      }
      return { server };
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.delete('/api/mcp/servers/:id', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const { id } = req.params as { id: string };
    try {
      const { scope, ownerUserId } = mcpService.deleteServer(session.user.id, id);
      await refreshWorkersForScope(scope, ownerUserId);
      return { ok: true };
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.post('/api/mcp/import', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const parsed = importMcpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? 'JSON入力が正しくありません。',
      });
    }
    try {
      const result = mcpService.importFromJson(session.user.id, parsed.data);
      await refreshWorkersForScope(
        parsed.data.scope,
        parsed.data.scope === 'profile' ? session.user.id : null
      );
      return reply.code(201).send(result);
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.post('/api/mcp/servers/:id/test', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const { id } = req.params as { id: string };
    try {
      const { server, ...result } = await mcpService.testServer(session.user.id, id);
      return server ? { result, server } : { result };
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.post('/api/mcp/servers/:id/oauth/start', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const { id } = req.params as { id: string };
    try {
      const origin = await resolveRequestOrigin(req, config);
      const flow = await mcpService.startOAuthFlow(session.user.id, id, origin);
      return flow;
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.post('/api/mcp/servers/:id/oauth/complete', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const { id } = req.params as { id: string };
    const parsed = completeMcpOAuthSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? '認可コードまたはコールバックURLを入力してください。',
      });
    }
    try {
      const { server } = await mcpService.completeOAuthManualInput(session.user.id, id, parsed.data);
      await refreshWorkersForScope(server.scope, server.ownerUserId);
      return { server };
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.post('/api/mcp/servers/:id/oauth/disconnect', async (req, reply) => {
    const session = requireAdmin(req, reply, db);
    if (!session) return;
    const { id } = req.params as { id: string };
    try {
      const server = mcpService.disconnectOAuth(session.user.id, id);
      await refreshWorkersForScope(server.scope, server.ownerUserId);
      return { server };
    } catch (err) {
      return handleMcpError(reply, err);
    }
  });

  app.get('/api/mcp/oauth/launch', async (req, reply) => {
    const session = authenticateRequest(req, db);
    if (!session || session.user.role !== 'admin') {
      return reply
        .code(403)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(
          renderOAuthCallbackHtml({
            ok: false,
            message: '管理者としてログインした状態でOAuth認証を開始してください。',
          })
        );
    }

    const query = (req.query ?? {}) as { state?: string };
    try {
      const targetUrl = mcpService.resolvePendingOAuthLaunchUrl(session.user.id, query.state);
      return reply
        .header('Cache-Control', 'no-store')
        .redirect(targetUrl, 302);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth認証の開始に失敗しました。';
      const statusCode = err instanceof McpValidationError ? err.statusCode : 400;
      return reply
        .code(statusCode)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(renderOAuthCallbackHtml({ ok: false, message }));
    }
  });

  app.get('/api/mcp/oauth/callback', async (req, reply) => {
    const session = authenticateRequest(req, db);
    if (!session || session.user.role !== 'admin') {
      return reply
        .code(403)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(
          renderOAuthCallbackHtml({
            ok: false,
            message: '管理者としてログインした状態でOAuth認証を完了してください。',
          })
        );
    }

    const query = (req.query ?? {}) as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    try {
      const { server } = await mcpService.completeOAuthCallback(session.user.id, {
        code: query.code,
        state: query.state,
        error: query.error,
        errorDescription: query.error_description,
      });
      await refreshWorkersForScope(server.scope, server.ownerUserId);
      return reply
        .code(200)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(
          renderOAuthCallbackHtml({
            ok: true,
            serverId: server.id,
            serverName: server.name,
            message: `MCPサーバー「${server.name}」のOAuth認証が完了しました。このウィンドウを閉じてチャットへ戻れます。`,
          })
        );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth認証の完了に失敗しました。';
      const statusCode = err instanceof McpValidationError ? err.statusCode : 400;
      return reply
        .code(statusCode)
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(renderOAuthCallbackHtml({ ok: false, message }));
    }
  });
}
