import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { getAgyPermissionRules } from '../src/acp/profile-settings.js';
import {
  createTestServer,
  registerAndBindAgy,
  TestApiClient,
} from './helpers/test-harness.js';

type StartedTestServer = Awaited<ReturnType<typeof createTestServer>>;

const servers: StartedTestServer[] = [];
const httpServers: http.Server[] = [];

afterEach(async () => {
  while (httpServers.length > 0) {
    const s = httpServers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (servers.length > 0) {
    const s = servers.pop()!;
    await s.cleanup();
  }
});

async function runInspectPrompt(client: TestApiClient, chatId: string): Promise<Array<Record<string, unknown>>> {
  const sendRes = await client.request<{ run: { id: string } }>(
    'POST',
    `/api/chats/${chatId}/messages`,
    { text: '[MCP_INSPECT]' }
  );
  expect(sendRes.status).toBe(202);

  await client.waitForFrame(
    (f) => f.kind === 'event' && (f.event as { type?: string })?.type === 'run.finished',
    8000,
    false
  );

  const detail = await client.request<{
    messages: Array<{ role: string; contentText: string }>;
  }>('GET', `/api/chats/${chatId}`);
  expect(detail.status).toBe(200);
  const assistantMessages = detail.data.messages.filter((m) => m.role === 'assistant');
  const lastText = assistantMessages[assistantMessages.length - 1]?.contentText ?? '';
  const idx = lastText.indexOf('MCP_SERVERS:');
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(lastText.slice(idx + 'MCP_SERVERS:'.length)) as Array<Record<string, unknown>>;
}

describe('Admin-Only MCP Server Management, Scope Isolation, and Remote OAuth 2.1', () => {
  it('enforces admin-only RBAC, masks secrets, and isolates shared vs profile MCP servers over native ACP', async () => {
    const srv = await createTestServer();
    servers.push(srv);

    // First registered user is admin, second is regular user
    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'mcpadmin', 'user:admin-a');
    const { client: regular } = await registerAndBindAgy(srv.baseUrl, 'mcpuser', 'user:regular-b');

    const adminMe = await admin.request<{ user: { role: string } }>('GET', '/api/auth/me');
    const regularMe = await regular.request<{ user: { role: string } }>('GET', '/api/auth/me');
    expect(adminMe.data.user.role).toBe('admin');
    expect(regularMe.data.user.role).toBe('user');

    await admin.connectWs({ clientId: 'admin-ws' });
    await regular.connectWs({ clientId: 'user-ws' });

    // Non-admin must be blocked with 403 on all MCP endpoints
    expect((await regular.request('GET', '/api/mcp/servers')).status).toBe(403);
    expect(
      (
        await regular.request('POST', '/api/mcp/servers', {
          name: 'blocked',
          scope: 'shared',
          transport: 'http',
          url: 'https://example.com/mcp',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await regular.request('POST', '/api/mcp/import', {
          scope: 'shared',
          rawJson: '{"mcpServers":{}}',
        })
      ).status
    ).toBe(403);

    // Admin creates shared local (stdio) MCP
    const createStdio = await admin.request<{ server: Record<string, unknown> }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-local',
        description: 'Shared stdio tool',
        scope: 'shared',
        transport: 'stdio',
        command: 'node',
        args: [
          '-e',
          'process.stdin.once("data", () => { console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock-stdio-mcp", version: "1.0.0" } } })); });',
        ],
        env: [{ name: 'API_SECRET', value: 'super-secret-env-1234' }],
      }
    );
    expect(createStdio.status).toBe(201);
    const stdioEnv = createStdio.data.server.env as Array<{ name: string; maskedValue: string }>;
    expect(stdioEnv).toEqual([{ name: 'API_SECRET', maskedValue: '••••1234', hasValue: true }]);
    expect(JSON.stringify(createStdio.data)).not.toContain('super-secret-env-1234');

    // Admin tests stdio MCP initialize handshake
    const testStdio = await admin.request<{ result: { ok: boolean; resolvedCommand?: string } }>(
      'POST',
      `/api/mcp/servers/${createStdio.data.server.id}/test`,
      {}
    );
    expect(testStdio.status).toBe(200);
    expect(testStdio.data.result.ok).toBe(true);
    expect(testStdio.data.result.resolvedCommand).toBeTruthy();

    // Admin creates shared remote HTTP MCP with API key
    const createSharedHttp = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-api',
        scope: 'shared',
        transport: 'http',
        url: 'https://93.184.216.34/mcp',
        authType: 'api_key',
        headers: [{ name: 'X-API-Key', value: 'shared-key-9876' }],
      }
    );
    expect(createSharedHttp.status).toBe(201);

    // Admin creates shared remote SSE MCP with Bearer token
    const createSharedSse = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-sse',
        scope: 'shared',
        transport: 'sse',
        url: 'https://93.184.216.34/sse',
        authType: 'bearer',
        headers: [{ name: 'Authorization', value: 'Bearer shared-bearer-token' }],
      }
    );
    expect(createSharedSse.status).toBe(201);

    // Admin creates profile-only MCP
    const createProfileOnly = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'admin-private',
        scope: 'profile',
        transport: 'http',
        url: 'https://93.184.216.35/mcp',
        authType: 'headers',
        headers: [{ name: 'X-Admin-Token', value: 'admin-secret-token' }],
      }
    );
    expect(createProfileOnly.status).toBe(201);

    // Admin creates profile-scoped override with same name "shared-api"
    const createOverride = await admin.request<{ server: { id: string } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'shared-api',
        scope: 'profile',
        transport: 'http',
        url: 'https://93.184.216.36/mcp',
        authType: 'api_key',
        headers: [{ name: 'X-API-Key', value: 'admin-override-key' }],
      }
    );
    expect(createOverride.status).toBe(201);

    // PATCH with keepExisting preserves encrypted secret without returning plaintext
    const patchKeep = await admin.request<{ server: Record<string, unknown> }>(
      'PATCH',
      `/api/mcp/servers/${createSharedHttp.data.server.id}`,
      {
        description: 'Updated description',
        headers: [{ name: 'X-API-Key', keepExisting: true }],
      }
    );
    expect(patchKeep.status).toBe(200);
    expect(JSON.stringify(patchKeep.data)).not.toContain('shared-key-9876');

    // Non-admin still cannot update or delete admin's MCP server
    expect(
      (await regular.request('DELETE', `/api/mcp/servers/${createSharedHttp.data.server.id}`)).status
    ).toBe(403);

    // Inspect MCP servers delivered natively over ACP to regular user
    const userChat = await regular.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'User MCP Chat',
    });
    expect(userChat.status).toBe(201);
    const userMcp = await runInspectPrompt(regular, userChat.data.chat.id);
    const userNames = userMcp.map((m) => m.name).sort();
    expect(userNames).toEqual(['shared-api', 'shared-local', 'shared-sse']);

    const userSharedApi = userMcp.find((m) => m.name === 'shared-api') as {
      type: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(userSharedApi.type).toBe('http');
    expect(userSharedApi.url).toBe('https://93.184.216.34/mcp');
    expect(userSharedApi.headers).toEqual([{ name: 'X-API-Key', value: 'shared-key-9876' }]);

    const userSharedLocal = userMcp.find((m) => m.name === 'shared-local') as {
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    };
    expect(userSharedLocal.command).toContain('node');
    expect(userSharedLocal.env).toEqual([{ name: 'API_SECRET', value: 'super-secret-env-1234' }]);

    // Inspect MCP servers delivered natively over ACP to admin
    const adminChat = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Admin MCP Chat',
    });
    expect(adminChat.status).toBe(201);
    const adminMcp = await runInspectPrompt(admin, adminChat.data.chat.id);
    const adminNames = adminMcp.map((m) => m.name).sort();
    expect(adminNames).toEqual(['admin-private', 'shared-api', 'shared-local', 'shared-sse']);

    // Profile-scoped override wins for admin
    const adminSharedApi = adminMcp.find((m) => m.name === 'shared-api') as { url: string };
    expect(adminSharedApi.url).toBe('https://93.184.216.36/mcp');

    // SSRF protection: reject loopback, private, and link-local/metadata URLs by default
    for (const blockedUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/mcp',
      'http://localhost:3000/mcp',
      'http://localhost./mcp',
      'http://10.0.0.1/mcp',
      'http://[::1]/mcp',
    ]) {
      const ssrfRes = await admin.request('POST', '/api/mcp/servers', {
        name: 'ssrf-test',
        scope: 'profile',
        transport: 'http',
        url: blockedUrl,
      });
      expect(ssrfRes.status).toBe(400);
    }

    // X-Forwarded-Host header must not override callbackUrl host
    const listWithSpoofedHost = await admin.request<{ callbackUrl: string }>(
      'GET',
      '/api/mcp/servers',
      undefined,
      { headers: { 'x-forwarded-host': 'evil.example.com' } }
    );
    expect(listWithSpoofedHost.status).toBe(200);
    expect(listWithSpoofedHost.data.callbackUrl).not.toContain('evil.example.com');

    // JSON import skips invalid names instead of aborting valid entries
    const importRes = await admin.request<{ imported: Array<{ name: string; transport: string }>; skipped: string[] }>(
      'POST',
      '/api/mcp/import',
      {
        scope: 'profile',
        rawJson: JSON.stringify({
          mcpServers: {
            'bad name!': {
              serverUrl: 'https://invalid-name.example.com/mcp',
            },
            'imported-remote': {
              serverUrl: 'https://imported.example.com/mcp',
              headers: { Authorization: 'Bearer imported-tok' },
            },
            'imported-stdio': {
              command: 'node',
              args: ['--version'],
            },
          },
        }),
      }
    );
    expect(importRes.status).toBe(201);
    expect(importRes.data.imported.map((s) => s.name).sort()).toEqual([
      'imported-remote',
      'imported-stdio',
    ]);
    expect(importRes.data.skipped).toContain('bad name!');

    admin.closeWs();
    regular.closeWs();
  });

  it('completes full Remote MCP OAuth 2.1 flow (RFC 9728 + RFC 8414 + DCR + PKCE + refresh) and injects Bearer token into ACP', async () => {
    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);

    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'oauthadmin', 'user:oauth-a');
    const { client: regular } = await registerAndBindAgy(srv.baseUrl, 'oauthuser', 'user:oauth-b');
    await admin.connectWs({ clientId: 'oauth-admin-ws' });

    // Local mock OAuth 2.1 + Remote Streamable HTTP MCP server
    let issuedCodeChallenge = '';
    let currentAccessToken = 'oauth-access-token-v1';
    const currentRefreshToken = 'oauth-refresh-token-v1';
    let tokenRefreshCount = 0;

    let mockBaseUrl = '';
    const mockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', mockBaseUrl);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rawBody = Buffer.concat(chunks).toString('utf8');

      if (reqUrl.pathname === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            resource: `${mockBaseUrl}/mcp`,
            authorization_servers: [mockBaseUrl],
            scopes_supported: ['mcp:read', 'mcp:write'],
          })
        );
        return;
      }

      if (reqUrl.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: mockBaseUrl,
            authorization_endpoint: `${mockBaseUrl}/authorize`,
            token_endpoint: `${mockBaseUrl}/token`,
            registration_endpoint: `${mockBaseUrl}/register`,
            code_challenge_methods_supported: ['S256'],
          })
        );
        return;
      }

      if (reqUrl.pathname === '/register' && req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            client_id: 'dcr-client-123',
            token_endpoint_auth_method: 'none',
          })
        );
        return;
      }

      if (reqUrl.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(rawBody);
        const grantType = form.get('grant_type');
        if (grantType === 'authorization_code') {
          const verifier = form.get('code_verifier') ?? '';
          const computedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          if (computedChallenge !== issuedCodeChallenge) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: currentAccessToken,
              refresh_token: currentRefreshToken,
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'mcp:read mcp:write',
            })
          );
          return;
        }
        if (grantType === 'refresh_token' && form.get('refresh_token') === currentRefreshToken) {
          tokenRefreshCount += 1;
          currentAccessToken = `oauth-access-token-v${tokenRefreshCount + 1}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: currentAccessToken,
              refresh_token: currentRefreshToken,
              token_type: 'Bearer',
              expires_in: 3600,
            })
          );
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }

      if (reqUrl.pathname === '/mcp' && req.method === 'POST') {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${currentAccessToken}`) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${mockBaseUrl}/.well-known/oauth-protected-resource"`,
          });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'mock-oauth-mcp', version: '2.0.0' },
              capabilities: {},
            },
          })
        );
        return;
      }

      if (reqUrl.pathname === '/sse' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': keep-alive\n\n');
        // Keep stream open intentionally to verify SSE test resolves on headers
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockServer);
    const addr = mockServer.address() as { port: number };
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    // Admin adds remote OAuth MCP with ONLY url (no manual clientId/endpoints)
    const created = await admin.request<{ server: { id: string; oauth: { status: string } } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'remote-oauth',
        scope: 'shared',
        transport: 'http',
        url: `${mockBaseUrl}/mcp`,
        authType: 'oauth',
      }
    );
    expect(created.status).toBe(201);
    const serverId = created.data.server.id;
    expect(created.data.server.oauth.status).toBe('disconnected');

    // Connection test before auth detects 401 & discovers OAuth endpoints
    const preTest = await admin.request<{
      result: { ok: boolean; status: string; discoveredOAuth?: { authorizationUrl?: string } };
    }>('POST', `/api/mcp/servers/${serverId}/test`, {});
    expect(preTest.status).toBe(200);
    expect(preTest.data.result.ok).toBe(false);
    expect(preTest.data.result.status).toBe('oauth_required');
    expect(preTest.data.result.discoveredOAuth?.authorizationUrl).toBe(`${mockBaseUrl}/authorize`);

    // Start OAuth flow (performs discovery + RFC 7591 DCR + PKCE)
    const startRes = await admin.request<{ authorizationUrl: string; state: string }>(
      'POST',
      `/api/mcp/servers/${serverId}/oauth/start`,
      {}
    );
    expect(startRes.status).toBe(200);
    const authUrl = new URL(startRes.data.authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${mockBaseUrl}/authorize`);
    expect(authUrl.searchParams.get('client_id')).toBe('dcr-client-123');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    issuedCodeChallenge = authUrl.searchParams.get('code_challenge') ?? '';
    expect(issuedCodeChallenge.length).toBeGreaterThan(20);

    // Non-admin cannot hijack callback
    const hijackRes = await regular.request(
      'GET',
      `/api/mcp/oauth/callback?code=auth-code-1&state=${encodeURIComponent(startRes.data.state)}`
    );
    expect(hijackRes.status).toBe(403);

    // Admin completes OAuth callback
    const cbRes = await admin.request<string>(
      'GET',
      `/api/mcp/oauth/callback?code=auth-code-1&state=${encodeURIComponent(startRes.data.state)}`
    );
    expect(cbRes.status).toBe(200);
    expect(cbRes.data).toContain('agy-mcp-oauth-complete');

    // Connection test now succeeds with serverInfo
    const postTest = await admin.request<{
      result: { ok: boolean; status: string; serverInfo?: { name?: string } };
    }>('POST', `/api/mcp/servers/${serverId}/test`, {});
    expect(postTest.status).toBe(200);
    expect(postTest.data.result.ok).toBe(true);
    expect(postTest.data.result.serverInfo?.name).toBe('mock-oauth-mcp');

    // ACP session receives Authorization: Bearer oauth-access-token-v1
    const chatRes = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'OAuth MCP Chat',
    });
    const mcpList = await runInspectPrompt(admin, chatRes.data.chat.id);
    const oauthServer = mcpList.find((m) => m.name === 'remote-oauth') as {
      type: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(oauthServer).toBeTruthy();
    expect(oauthServer.type).toBe('http');
    expect(oauthServer.headers).toEqual([
      { name: 'Authorization', value: 'Bearer oauth-access-token-v1' },
    ]);

    // Force token expiry and verify automatic refresh on next session
    const storedRow = srv.ctx.db.getMcpServerById(serverId)!;
    const { encryptSmallSecret } = await import('../src/auth/password.js');
    srv.ctx.db.updateMcpServer(serverId, {
      encryptedOauthTokensJson: encryptSmallSecret(
        JSON.stringify({
          accessToken: 'oauth-access-token-v1',
          refreshToken: currentRefreshToken,
          tokenType: 'Bearer',
          expiresAt: Date.now() - 5000,
        }),
        srv.ctx.config.sessionSecret
      ),
    });
    await srv.ctx.acp.stopIdleWorkersForAllUsers();

    const chatRes2 = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'OAuth Refreshed Chat',
    });
    const mcpList2 = await runInspectPrompt(admin, chatRes2.data.chat.id);
    const refreshedServer = mcpList2.find((m) => m.name === 'remote-oauth') as {
      headers: Array<{ name: string; value: string }>;
    };
    expect(tokenRefreshCount).toBe(1);
    expect(refreshedServer.headers).toEqual([
      { name: 'Authorization', value: 'Bearer oauth-access-token-v2' },
    ]);

    // Disconnect clears tokens
    const discRes = await admin.request<{ server: { oauth: { status: string } } }>(
      'POST',
      `/api/mcp/servers/${serverId}/oauth/disconnect`,
      {}
    );
    expect(discRes.status).toBe(200);
    expect(discRes.data.server.oauth.status).toBe('disconnected');

    // Open SSE stream test must resolve immediately on 200 headers without timing out
    const sseCreated = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'open-sse-stream',
      scope: 'profile',
      transport: 'sse',
      url: `${mockBaseUrl}/sse`,
      authType: 'none',
    });
    expect(sseCreated.status).toBe(201);
    const sseTest = await admin.request<{ result: { ok: boolean; status: string } }>(
      'POST',
      `/api/mcp/servers/${sseCreated.data.server.id}/test`,
      {}
    );
    expect(sseTest.status).toBe(200);
    expect(sseTest.data.result.ok).toBe(true);
    expect(sseTest.data.result.status).toBe('connected');

    admin.closeWs();
  });

  it('auto-detects Tailscale HTTPS callback origin safely without trusting arbitrary Host headers', async () => {
    const { parseTailscaleDnsName, resolveRequestOriginWithTailscale } = await import(
      '../src/routes/mcp-routes.js'
    );
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ publicOrigin: null, allowedHosts: [] });

    expect(
      parseTailscaleDnsName(JSON.stringify({ Self: { DNSName: 'oracle-vm.tail1234.ts.net.' } }))
    ).toBe('oracle-vm.tail1234.ts.net');
    expect(parseTailscaleDnsName(JSON.stringify({ Self: { DNSName: 'evil.example.com.' } }))).toBeNull();

    // Direct Tailscale Host header -> https://<tsHostname>
    expect(
      resolveRequestOriginWithTailscale(
        {
          protocol: 'https',
          headers: { host: 'oracle-vm.tail1234.ts.net' },
          socket: { localPort: 3000 } as never,
        },
        cfg,
        'oracle-vm.tail1234.ts.net'
      )
    ).toBe('https://oracle-vm.tail1234.ts.net');

    // Tailscale Serve rewriting Host to 127.0.0.1:3000 with X-Forwarded-Proto: https -> https://<tsHostname>
    expect(
      resolveRequestOriginWithTailscale(
        {
          protocol: 'https',
          headers: { host: '127.0.0.1:3000' },
          socket: { localPort: 3000 } as never,
        },
        cfg,
        'oracle-vm.tail1234.ts.net'
      )
    ).toBe('https://oracle-vm.tail1234.ts.net');

    // Spoofed Host header is never used
    expect(
      resolveRequestOriginWithTailscale(
        {
          protocol: 'http',
          headers: { host: 'evil.example.com' },
          socket: { localPort: 3000 } as never,
        },
        cfg,
        'oracle-vm.tail1234.ts.net'
      )
    ).toBe('http://127.0.0.1:3000');

    // Explicit PUBLIC_ORIGIN always takes precedence
    const explicitCfg = loadConfig({ publicOrigin: 'https://chat.custom.example.com' });
    expect(
      resolveRequestOriginWithTailscale(
        {
          protocol: 'https',
          headers: { host: 'oracle-vm.tail1234.ts.net' },
          socket: { localPort: 3000 } as never,
        },
        explicitCfg,
        'oracle-vm.tail1234.ts.net'
      )
    ).toBe('https://chat.custom.example.com');
  });

  it('rejects non-MCP stdio/HTTP/SSE endpoints in connection tests and reports invalid JSON import entries explicitly', async () => {
    const mockHttp = http.createServer((req, res) => {
      if (req.url === '/plain-html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Not an MCP server</body></html>');
        return;
      }
      if (req.url === '/fake-sse') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/real-sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: endpoint\ndata: /messages\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => mockHttp.listen(0, '127.0.0.1', () => resolve()));
    httpServers.push(mockHttp);
    const addr = mockHttp.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);
    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'mcptestadmin', 'user:admin-t');

    // 1) Non-MCP stdio process that just prints "ok" and exits must fail test
    const badStdio = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'non-mcp-stdio',
      scope: 'profile',
      transport: 'stdio',
      command: 'node',
      args: ['-e', 'console.log("ok")'],
    });
    expect(badStdio.status).toBe(201);
    const badStdioTest = await admin.request<{ result: { ok: boolean; status: string } }>(
      'POST',
      `/api/mcp/servers/${badStdio.data.server.id}/test`,
      {}
    );
    expect(badStdioTest.status).toBe(200);
    expect(badStdioTest.data.result.ok).toBe(false);
    expect(badStdioTest.data.result.status).toBe('error');

    // 2) HTTP 200 plain HTML must fail MCP initialize test
    const badHttp = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'non-mcp-http',
      scope: 'profile',
      transport: 'http',
      url: `http://127.0.0.1:${port}/plain-html`,
      authType: 'none',
    });
    expect(badHttp.status).toBe(201);
    const badHttpTest = await admin.request<{ result: { ok: boolean; status: string } }>(
      'POST',
      `/api/mcp/servers/${badHttp.data.server.id}/test`,
      {}
    );
    expect(badHttpTest.status).toBe(200);
    expect(badHttpTest.data.result.ok).toBe(false);

    // 3) SSE 200 with application/json (not text/event-stream) must fail, while text/event-stream succeeds
    const badSse = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'non-mcp-sse',
      scope: 'profile',
      transport: 'sse',
      url: `http://127.0.0.1:${port}/fake-sse`,
      authType: 'none',
    });
    expect(badSse.status).toBe(201);
    const badSseTest = await admin.request<{ result: { ok: boolean } }>(
      'POST',
      `/api/mcp/servers/${badSse.data.server.id}/test`,
      {}
    );
    expect(badSseTest.status).toBe(200);
    expect(badSseTest.data.result.ok).toBe(false);

    const goodSse = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'valid-mcp-sse',
      scope: 'profile',
      transport: 'sse',
      url: `http://127.0.0.1:${port}/real-sse`,
      authType: 'none',
    });
    expect(goodSse.status).toBe(201);
    const goodSseTest = await admin.request<{ result: { ok: boolean } }>(
      'POST',
      `/api/mcp/servers/${goodSse.data.server.id}/test`,
      {}
    );
    expect(goodSseTest.status).toBe(200);
    expect(goodSseTest.data.result.ok).toBe(true);

    // 4) JSON import with missing url/command must report the invalid entry, NOT suggest overwrite
    const badImport = await admin.request<{ error?: string; message?: string }>(
      'POST',
      '/api/mcp/import',
      {
        scope: 'profile',
        rawJson: JSON.stringify({
          mcpServers: {
            brokenServer: { description: 'missing url and command' },
          },
        }),
      }
    );
    expect(badImport.status).toBe(400);
    expect(badImport.data.error).toBe('INVALID_IMPORT_ENTRIES');
    expect(badImport.data.message).toContain('brokenServer');
    expect(badImport.data.message).toContain('url または command');
    expect(badImport.data.message).not.toContain('上書き');
  });

  it('discovers MCP tools, defaults empty allowedTools to allow-all, and filters stdio/HTTP/SSE tools end-to-end', async () => {
    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);

    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'toolsadmin', 'user:tools-a');
    await admin.connectWs({ clientId: 'tools-admin-ws' });

    const upstreamCalls: string[] = [];
    const sseClients: Array<http.ServerResponse> = [];

    let remoteBaseUrl = '';
    const mockRemote = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', remoteBaseUrl);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const bodyStr = Buffer.concat(chunks).toString('utf8');

      if (reqUrl.pathname === '/sse' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('event: endpoint\ndata: /messages?sessionId=s1\n\n');
        sseClients.push(res);
        req.on('close', () => {
          const idx = sseClients.indexOf(res);
          if (idx >= 0) sseClients.splice(idx, 1);
        });
        return;
      }

      if (reqUrl.pathname === '/messages' && req.method === 'POST') {
        const rpc = JSON.parse(bodyStr) as { id?: number | string; method: string; params?: { name?: string } };
        if (rpc.method === 'tools/list') {
          const payload = {
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                { name: 'sse_safe', description: 'Safe SSE tool' },
                { name: 'sse_danger', description: 'Dangerous SSE tool' },
              ],
            },
          };
          for (const clientRes of sseClients) {
            clientRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          }
          res.writeHead(202).end();
          return;
        }
        if (rpc.method === 'tools/call') {
          upstreamCalls.push(`sse:${rpc.params?.name ?? ''}`);
          const payload = {
            jsonrpc: '2.0',
            id: rpc.id,
            result: { content: [{ type: 'text', text: `ran:${rpc.params?.name}` }] },
          };
          for (const clientRes of sseClients) {
            clientRes.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          }
          res.writeHead(202).end();
          return;
        }
        res.writeHead(202).end();
        return;
      }

      if (reqUrl.pathname === '/mcp-stream-sse' && req.method === 'POST') {
        const parsed = JSON.parse(bodyStr) as
          | { id?: number | string; method: string; params?: { name?: string } }
          | Array<{ id?: number | string; method: string; params?: { name?: string } }>;
        const items = Array.isArray(parsed) ? parsed : [parsed];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const rpc of items) {
          if (rpc.method === 'initialize') {
            res.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'http-sse-mcp', version: '1.0' } },
              })}\n\n`
            );
          } else if (rpc.method === 'tools/list') {
            res.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  tools: [
                    { name: 'safe_read', description: 'Read only' },
                    { name: 'danger_delete', description: 'Destructive delete' },
                  ],
                },
              })}\n\n`
            );
          } else if (rpc.method === 'tools/call') {
            upstreamCalls.push(`http-sse:${rpc.params?.name ?? ''}`);
            res.write(
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: { content: [{ type: 'text', text: `sse-ran:${rpc.params?.name ?? ''}` }] },
              })}\n\n`
            );
          }
        }
        res.end();
        return;
      }

      if (reqUrl.pathname === '/mcp' && req.method === 'POST') {
        const parsed = JSON.parse(bodyStr) as
          | { id?: number | string; method: string; params?: { name?: string } }
          | Array<{ id?: number | string; method: string; params?: { name?: string } }>;
        const handleOne = (rpc: { id?: number | string; method: string; params?: { name?: string } }) => {
          if (rpc.method === 'initialize') {
            return {
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'mock-http-mcp', version: '2.0.0' },
              },
            };
          }
          if (rpc.method === 'tools/list') {
            return {
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                tools: [
                  { name: 'safe_read', description: 'Read safely' },
                  { name: 'danger_delete', description: 'Delete permanently' },
                ],
              },
            };
          }
          if (rpc.method === 'tools/call') {
            upstreamCalls.push(`http:${rpc.params?.name ?? ''}`);
            return {
              jsonrpc: '2.0',
              id: rpc.id,
              result: { content: [{ type: 'text', text: `executed:${rpc.params?.name}` }] },
            };
          }
          return null;
        };

        if (Array.isArray(parsed)) {
          const replies = parsed.map(handleOne).filter(Boolean);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(replies));
          return;
        }
        if (parsed.method === 'notifications/initialized') {
          res.writeHead(202).end();
          return;
        }
        const reply = handleOne(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-123' });
        res.end(JSON.stringify(reply));
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockRemote.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockRemote);
    const addr = mockRemote.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    remoteBaseUrl = `http://127.0.0.1:${port}`;

    // 1) stdio MCP script supporting initialize + tools/list + tools/call
    const stdioScript =
      "const rl = require('node:readline').createInterface({ input: process.stdin });" +
      "rl.on('line', (line) => {" +
      "if (!line.trim()) return;" +
      "const msg = JSON.parse(line);" +
      "if (msg.method === 'initialize') {" +
      "console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stdio-tool-mcp', version: '1.0' } } }));" +
      "} else if (msg.method === 'tools/list') {" +
      "console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'stdio_read', description: 'Safe stdio read' }, { name: 'stdio_write', description: 'Unsafe stdio write' }] } }));" +
      "} else if (msg.method === 'tools/call') {" +
      "console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'stdio-ran:' + (msg.params && msg.params.name) }] } }));" +
      "}" +
      "});";

    // Default allowedTools is [] (all tools permitted)
    const createStdio = await admin.request<{ server: { id: string; allowedTools: string[] } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'stdio-filtered',
        scope: 'profile',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', stdioScript],
      }
    );
    expect(createStdio.status).toBe(201);
    expect(createStdio.data.server.allowedTools).toEqual([]);

    // Test stdio discovers all tools even while allowedTools is unset
    const stdioTest = await admin.request<{ result: { ok: boolean; tools?: Array<{ name: string; description?: string }> } }>(
      'POST',
      `/api/mcp/servers/${createStdio.data.server.id}/test`,
      {}
    );
    expect(stdioTest.status).toBe(200);
    expect(stdioTest.data.result.ok).toBe(true);
    expect(stdioTest.data.result.tools).toEqual([
      { name: 'stdio_read', description: 'Safe stdio read' },
      { name: 'stdio_write', description: 'Unsafe stdio write' },
    ]);

    // Control characters rejected in allowedTools
    const badAllowed = await admin.request('PATCH', `/api/mcp/servers/${createStdio.data.server.id}`, {
      allowedTools: ['good_tool', 'bad\ntool'],
    });
    expect(badAllowed.status).toBe(400);

    // HTTP server created with empty allowedTools -> test discovers tools
    const createHttp = await admin.request<{ server: { id: string; allowedTools: string[] } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'http-filtered',
        scope: 'profile',
        transport: 'http',
        url: `${remoteBaseUrl}/mcp`,
        authType: 'none',
      }
    );
    expect(createHttp.status).toBe(201);
    expect(createHttp.data.server.allowedTools).toEqual([]);

    const httpTest = await admin.request<{ result: { ok: boolean; tools?: Array<{ name: string; description?: string }> } }>(
      'POST',
      `/api/mcp/servers/${createHttp.data.server.id}/test`,
      {}
    );
    expect(httpTest.status).toBe(200);
    expect(httpTest.data.result.ok).toBe(true);
    expect(httpTest.data.result.tools).toEqual([
      { name: 'safe_read', description: 'Read safely' },
      { name: 'danger_delete', description: 'Delete permanently' },
    ]);

    // Verify unfiltered pass-through when allowedTools is []
    const chatRes = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'mcp-tools-test' });
    expect(chatRes.status).toBe(201);
    const unfilteredServers = await runInspectPrompt(admin, chatRes.data.chat.id);
    const unfilteredStdio = unfilteredServers.find((s) => s.name === 'stdio-filtered') as {
      command: string;
      args: string[];
    };
    const unfilteredHttp = unfilteredServers.find((s) => s.name === 'http-filtered') as { url: string };
    expect(unfilteredStdio.command).toBe(process.execPath);
    expect(unfilteredStdio.args[0]).toBe('-e');
    expect(unfilteredHttp.url).toBe(`${remoteBaseUrl}/mcp`);

    // Restrict allowedTools on stdio, HTTP, SSE, plus JSON import enabledTools
    const patchStdio = await admin.request<{ server: { allowedTools: string[] } }>(
      'PATCH',
      `/api/mcp/servers/${createStdio.data.server.id}`,
      { allowedTools: [' stdio_read ', 'stdio_read'] }
    );
    expect(patchStdio.status).toBe(200);
    expect(patchStdio.data.server.allowedTools).toEqual(['stdio_read']);

    const patchHttp = await admin.request<{ server: { allowedTools: string[] } }>(
      'PATCH',
      `/api/mcp/servers/${createHttp.data.server.id}`,
      { allowedTools: ['safe_read'] }
    );
    expect(patchHttp.status).toBe(200);
    expect(patchHttp.data.server.allowedTools).toEqual(['safe_read']);

    const createSse = await admin.request<{ server: { id: string; allowedTools: string[] } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'sse-filtered',
        scope: 'profile',
        transport: 'sse',
        url: `${remoteBaseUrl}/sse`,
        authType: 'none',
        allowedTools: ['sse_safe'],
      }
    );
    expect(createSse.status).toBe(201);

    const importWithEnabledTools = await admin.request<{
      imported: Array<{ name: string; allowedTools: string[] }>;
    }>('POST', '/api/mcp/import', {
      scope: 'profile',
      rawJson: JSON.stringify({
        mcpServers: {
          'http-sse-response-mcp': {
            url: `${remoteBaseUrl}/mcp-stream-sse`,
            enabledTools: ['safe_read'],
          },
        },
      }),
    });
    expect(importWithEnabledTools.status).toBe(201);
    expect(importWithEnabledTools.data.imported[0]?.allowedTools).toEqual(['safe_read']);

    // Re-inspect in new chat to get filtered ACP server descriptors
    const filteredChat = await admin.request<{ chat: { id: string } }>('POST', '/api/chats', { title: 'mcp-filtered' });
    expect(filteredChat.status).toBe(201);
    const filteredServers = await runInspectPrompt(admin, filteredChat.data.chat.id);

    // A) Exercise real stdio wrapper process from ACP descriptor
    const stdioAcp = filteredServers.find((s) => s.name === 'stdio-filtered') as {
      command: string;
      args: string[];
    };
    const stdioReplies = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const child = spawn(stdioAcp.command, stdioAcp.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      const out: Array<Record<string, unknown>> = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('stdio filter wrapper timeout'));
      }, 5000);
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) {
          if (!l.trim()) continue;
          out.push(JSON.parse(l) as Record<string, unknown>);
          if (out.length === 4) {
            clearTimeout(timer);
            child.kill();
            resolve(out);
          }
        }
      });
      child.on('error', reject);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stdio_write' } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stdio_read' } })}\n`);
    });

    const listMsg = stdioReplies.find((m) => m.id === 2) as { result: { tools: Array<{ name: string }> } };
    expect(listMsg.result.tools.map((t) => t.name)).toEqual(['stdio_read']);
    const blockedStdioMsg = stdioReplies.find((m) => m.id === 3) as { error?: { code: number; message: string } };
    expect(blockedStdioMsg.error?.code).toBe(-32602);
    const allowedStdioMsg = stdioReplies.find((m) => m.id === 4) as { result?: { content: Array<{ text: string }> } };
    expect(allowedStdioMsg.result?.content[0]?.text).toBe('stdio-ran:stdio_read');

    // B) Exercise real HTTP forwarder (application/json)
    const httpAcp = filteredServers.find((s) => s.name === 'http-filtered') as { url: string };
    expect(httpAcp.url).not.toBe(`${remoteBaseUrl}/mcp`);

    const httpListResp = await fetch(httpAcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
    });
    expect(httpListResp.status).toBe(200);
    const httpListJson = (await httpListResp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(httpListJson.result.tools.map((t) => t.name)).toEqual(['safe_read']);

    const httpBlockedResp = await fetch(httpAcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'danger_delete' } }),
    });
    const httpBlockedJson = (await httpBlockedResp.json()) as { error?: { code: number } };
    expect(httpBlockedJson.error?.code).toBe(-32602);
    expect(upstreamCalls).not.toContain('http:danger_delete');

    const httpAllowedResp = await fetch(httpAcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'safe_read' } }),
    });
    const httpAllowedJson = (await httpAllowedResp.json()) as { result?: { content: Array<{ text: string }> } };
    expect(httpAllowedJson.result?.content[0]?.text).toBe('executed:safe_read');
    expect(upstreamCalls).toContain('http:safe_read');

    // Batch mixed calls on HTTP forwarder
    const httpBatchResp = await fetch(httpAcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'safe_read' } },
        { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'danger_delete' } },
      ]),
    });
    const httpBatchJson = (await httpBatchResp.json()) as Array<{ id: number; result?: unknown; error?: { code: number } }>;
    expect(httpBatchJson.find((m) => m.id === 13)?.result).toBeTruthy();
    expect(httpBatchJson.find((m) => m.id === 14)?.error?.code).toBe(-32602);
    expect(upstreamCalls).not.toContain('http:danger_delete');

    // C) Exercise Streamable HTTP text/event-stream response filtering
    const streamSseAcp = filteredServers.find((s) => s.name === 'http-sse-response-mcp') as { url: string };
    const streamListResp = await fetch(streamSseAcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list', params: {} }),
    });
    const streamListText = await streamListResp.text();
    expect(streamListText).toContain('safe_read');
    expect(streamListText).not.toContain('danger_delete');

    const streamBatchResp = await fetch(streamSseAcp.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'safe_read' } },
        { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'danger_delete' } },
      ]),
    });
    const streamBatchText = await streamBatchResp.text();
    expect(streamBatchText).toContain('"id":21');
    expect(streamBatchText).toContain('sse-ran:safe_read');
    expect(streamBatchText).toContain('"id":22');
    expect(streamBatchText).toContain('-32602');
    expect(upstreamCalls).not.toContain('http-sse:danger_delete');

    // D) Exercise legacy SSE GET stream endpoint rewrite + async tools/list filter + POST call block
    const sseAcp = filteredServers.find((s) => s.name === 'sse-filtered') as { url: string };
    const sseController = new AbortController();
    const sseConn = await fetch(sseAcp.url, { signal: sseController.signal });
    const reader = sseConn.body!.getReader();
    const dec = new TextDecoder();
    let sseAccum = '';
    const readUntil = async (predicate: (text: string) => boolean) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (predicate(sseAccum)) return sseAccum;
        const chunk = await reader.read();
        if (chunk.done) break;
        sseAccum += dec.decode(chunk.value, { stream: true });
      }
      throw new Error(`SSE predicate timeout. Received: ${sseAccum}`);
    };

    try {
      await readUntil((t) => t.includes('event: endpoint') && t.includes('\n\n'));
      const epMatch = /event:\s*endpoint\s*\ndata:\s*(\S+)/.exec(sseAccum);
      expect(epMatch).toBeTruthy();
      const postTarget = new URL(epMatch![1], sseAcp.url).toString();
      expect(postTarget).toContain('/mcp/');

      await fetch(postTarget, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list', params: {} }),
      });

      await readUntil((t) => t.includes('"id":30'));
      expect(sseAccum).toContain('sse_safe');
      expect(sseAccum).not.toContain('sse_danger');

      const sseBlockedCall = await fetch(postTarget, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'sse_danger' } }),
      });
      const sseBlockedJson = (await sseBlockedCall.json()) as { error?: { code: number } };
      expect(sseBlockedJson.error?.code).toBe(-32602);
      expect(upstreamCalls).not.toContain('sse:sse_danger');
    } finally {
      sseController.abort();
    }

    admin.closeWs();
  });

  it('follows HTTP 3xx redirects during OAuth discovery, supports Antigravity CIMD fallback, cookie-less iOS PWA callback, and in-app manual completion', async () => {
    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);

    const { client: admin } = await registerAndBindAgy(srv.baseUrl, 'iospwaadmin', 'user:ios-admin');
    const { client: regular } = await registerAndBindAgy(srv.baseUrl, 'iospwauser', 'user:ios-user');

    let mockBaseUrl = '';
    let expectedPkceChallenge = '';
    let issuedAccessToken = 'tinyfish-like-token-1';

    const mockServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url || '/', mockBaseUrl);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rawBody = Buffer.concat(chunks).toString('utf8');

      // 1) Simulate 307 redirect on /.well-known/oauth-protected-resource/mcp -> /redirected-prm
      if (reqUrl.pathname === '/.well-known/oauth-protected-resource/mcp') {
        res.writeHead(307, { Location: `${mockBaseUrl}/redirected-prm` });
        res.end();
        return;
      }

      if (reqUrl.pathname === '/redirected-prm') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            resource: `${mockBaseUrl}/mcp`,
            authorization_servers: [`${mockBaseUrl}/auth-tenant`],
            scopes_supported: ['mcp:tools'],
          })
        );
        return;
      }

      // 2) Simulate path-inserted RFC 8414 endpoint redirecting (302) to tenant well-known with CIMD support (no DCR registration_endpoint)
      if (reqUrl.pathname === '/.well-known/oauth-authorization-server/auth-tenant') {
        res.writeHead(302, {
          Location: `${mockBaseUrl}/auth-tenant/.well-known/oauth-authorization-server`,
        });
        res.end();
        return;
      }

      if (reqUrl.pathname === '/auth-tenant/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: `${mockBaseUrl}/auth-tenant`,
            authorization_endpoint: `${mockBaseUrl}/auth-tenant/authorize`,
            token_endpoint: `${mockBaseUrl}/auth-tenant/token`,
            client_id_metadata_document_supported: true,
            code_challenge_methods_supported: ['S256'],
          })
        );
        return;
      }

      if (reqUrl.pathname === '/auth-tenant/token' && req.method === 'POST') {
        const form = new URLSearchParams(rawBody);
        const verifier = form.get('code_verifier') ?? '';
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== expectedPkceChallenge) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE mismatch' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: issuedAccessToken,
            token_type: 'Bearer',
            expires_in: 3600,
          })
        );
        return;
      }

      if (reqUrl.pathname === '/mcp' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${issuedAccessToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'tinyfish-mock', version: '1.0.0' },
              capabilities: {},
            },
          })
        );
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockServer);
    const addr = mockServer.address() as { port: number };
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;

    const created = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'tinyfish-cimd',
      scope: 'shared',
      transport: 'http',
      url: `${mockBaseUrl}/mcp`,
      authType: 'oauth',
    });
    expect(created.status).toBe(201);
    const serverId = created.data.server.id;

    // A) Start OAuth flow: should follow 307/302 redirects and use Antigravity CIMD client_id when DCR is absent
    const start1 = await admin.request<{
      authorizationUrl: string;
      state: string;
      mode: 'callback' | 'code_paste';
    }>('POST', `/api/mcp/servers/${serverId}/oauth/start`, {});
    expect(start1.status).toBe(200);
    expect(start1.data.mode).toBe('code_paste');
    const parsedAuth1 = new URL(start1.data.authorizationUrl);
    expect(parsedAuth1.origin + parsedAuth1.pathname).toBe(`${mockBaseUrl}/auth-tenant/authorize`);
    expect(parsedAuth1.searchParams.get('client_id')).toBe(
      'https://antigravity.google/oauth/client-metadata.json'
    );
    expectedPkceChallenge = parsedAuth1.searchParams.get('code_challenge') ?? '';

    // B) Complete in-app via POST /api/mcp/servers/:id/oauth/complete with full redirect URL
    const manualRes = await admin.request<{ server: { oauth: { status: string } } }>(
      'POST',
      `/api/mcp/servers/${serverId}/oauth/complete`,
      {
        codeOrUrl: `https://antigravity.google/oauth-callback?code=manual-code-123&state=${encodeURIComponent(start1.data.state)}`,
      }
    );
    expect(manualRes.status).toBe(200);
    expect(manualRes.data.server.oauth.status).toBe('connected');

    // C) Start a second OAuth flow and verify same-origin authenticated /api/mcp/oauth/launch redirect for iOS Standalone PWA
    issuedAccessToken = 'tinyfish-like-token-2';
    const start2 = await admin.request<{ authorizationUrl: string; launchUrl: string; state: string }>(
      'POST',
      `/api/mcp/servers/${serverId}/oauth/start`,
      {}
    );
    expect(start2.status).toBe(200);
    expect(start2.data.launchUrl).toContain(`/api/mcp/oauth/launch?state=${encodeURIComponent(start2.data.state)}`);
    expectedPkceChallenge = new URL(start2.data.authorizationUrl).searchParams.get('code_challenge') ?? '';

    // Unauthenticated or non-admin requests to /api/mcp/oauth/launch and /api/mcp/oauth/callback must be rejected with 403
    const unauthClient = new TestApiClient(srv.baseUrl);
    const unauthLaunch = await unauthClient.request(
      'GET',
      `/api/mcp/oauth/launch?state=${encodeURIComponent(start2.data.state)}`
    );
    expect(unauthLaunch.status).toBe(403);

    const unauthCallback = await unauthClient.request(
      'GET',
      `/api/mcp/oauth/callback?code=pwa-code&state=${encodeURIComponent(start2.data.state)}`
    );
    expect(unauthCallback.status).toBe(403);

    const nonAdminAttempt = await regular.request(
      'GET',
      `/api/mcp/oauth/callback?code=pwa-code&state=${encodeURIComponent(start2.data.state)}`
    );
    expect(nonAdminAttempt.status).toBe(403);

    // Admin session navigating to same-origin /api/mcp/oauth/launch receives 302 redirect to the authorizationUrl
    const launchRes = await fetch(`${srv.baseUrl}/api/mcp/oauth/launch?state=${encodeURIComponent(start2.data.state)}`, {
      redirect: 'manual',
      headers: { Cookie: admin.cookieHeader },
    });
    expect(launchRes.status).toBe(302);
    expect(launchRes.headers.get('location')).toBe(start2.data.authorizationUrl);

    // Admin session in the PWA WebView completes callback
    const pwaCallback = await admin.request<string>(
      'GET',
      `/api/mcp/oauth/callback?code=pwa-code&state=${encodeURIComponent(start2.data.state)}`
    );
    expect(pwaCallback.status).toBe(200);
    expect(pwaCallback.data).toContain('OAuth 認証が完了しました');

    // D) Verify that when `agy acp` omits `mcpCapabilities` (undefined) in its initialize response,
    // `resolveAcpMcpServersForUser` still passes remote HTTP/SSE MCP servers through to ACP session/new
    const adminMe = await admin.request<{ user: { id: string } }>('GET', '/api/auth/me');
    const resolvedWithoutCaps = await srv.ctx.mcpService.resolveAcpMcpServersForUser(
      adminMe.data.user.id,
      undefined
    );
    expect(resolvedWithoutCaps.some((s) => s.name === 'tinyfish-cimd')).toBe(true);

    const resolvedExplicitFalse = await srv.ctx.mcpService.resolveAcpMcpServersForUser(
      adminMe.data.user.id,
      { http: false, sse: false }
    );
    expect(resolvedExplicitFalse.some((s) => s.name === 'tinyfish-cimd')).toBe(false);
  });

  it('persists discoveredTools, filters disabledTools, and syncs alwaysAllowTools to settings.json permissions.allow', async () => {
    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);

    const { client: admin, userId: adminUserId } = await registerAndBindAgy(srv.baseUrl, 'syncadmin', 'user:sync-admin');
    const { userId: memberUserId } = await registerAndBindAgy(srv.baseUrl, 'syncmember', 'user:sync-member');

    let remoteBaseUrl = '';
    const mockHttpMcp = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number | string;
        method: string;
        params?: { name?: string };
      };
      if (rpc.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'perm-mcp', version: '1.0' } },
        }));
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (rpc.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [
              { name: 'tool_alpha', description: 'Alpha tool full description' },
              { name: 'tool_beta', description: 'Beta tool full description' },
              { name: 'tool_gamma', description: 'Gamma tool full description' },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockHttpMcp.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockHttpMcp);
    const port = (mockHttpMcp.address() as { port: number }).port;
    remoteBaseUrl = `http://127.0.0.1:${port}`;

    // 1) Create shared MCP server
    const createRes = await admin.request<{ server: { id: string; discoveredTools: unknown[] } }>(
      'POST',
      '/api/mcp/servers',
      {
        name: 'perm-sync-mcp',
        scope: 'shared',
        transport: 'http',
        url: `${remoteBaseUrl}/mcp`,
        authType: 'none',
      }
    );
    expect(createRes.status).toBe(201);
    const serverId = createRes.data.server.id;
    expect(createRes.data.server.discoveredTools).toEqual([]);

    // 2) Test persists discoveredTools in DB and returns updated server
    const testRes = await admin.request<{
      result: { ok: boolean; tools?: Array<{ name: string; description?: string }> };
      server?: { discoveredTools: Array<{ name: string; description?: string }> };
    }>('POST', `/api/mcp/servers/${serverId}/test`, {});
    expect(testRes.status).toBe(200);
    expect(testRes.data.result.ok).toBe(true);
    expect(testRes.data.server?.discoveredTools).toHaveLength(3);

    // 3) Setting tool_alpha to alwaysAllow writes mcp(perm-sync-mcp/tool_alpha) to all profiles' settings.json
    const allowRes = await admin.request<{ server: { alwaysAllowTools: string[] } }>(
      'PATCH',
      `/api/mcp/servers/${serverId}`,
      { alwaysAllowTools: ['tool_alpha'] }
    );
    expect(allowRes.status).toBe(200);
    expect(allowRes.data.server.alwaysAllowTools).toEqual(['tool_alpha']);

    const adminProfile = srv.ctx.db.getAgyProfile(adminUserId)!;
    const memberProfile = srv.ctx.db.getAgyProfile(memberUserId)!;
    expect(getAgyPermissionRules(adminProfile.profileDir).allow).toContain('mcp(perm-sync-mcp/tool_alpha)');
    expect(getAgyPermissionRules(memberProfile.profileDir).allow).toContain('mcp(perm-sync-mcp/tool_alpha)');

    // 4) Reverting back to Ask (alwaysAllowTools: []) removes the rule from settings.json
    const askRes = await admin.request<{ server: { alwaysAllowTools: string[] } }>(
      'PATCH',
      `/api/mcp/servers/${serverId}`,
      { alwaysAllowTools: [] }
    );
    expect(askRes.status).toBe(200);
    expect(getAgyPermissionRules(adminProfile.profileDir).allow).not.toContain('mcp(perm-sync-mcp/tool_alpha)');
    expect(getAgyPermissionRules(memberProfile.profileDir).allow).not.toContain('mcp(perm-sync-mcp/tool_alpha)');

    // 5) Disabling tool_beta excludes it from ACP tools AND excludes it from permissions.allow even if listed
    const disableRes = await admin.request<{
      server: { disabledTools: string[]; alwaysAllowTools: string[] };
    }>('PATCH', `/api/mcp/servers/${serverId}`, {
      disabledTools: ['tool_beta'],
      alwaysAllowTools: ['tool_alpha', 'tool_beta'],
    });
    expect(disableRes.status).toBe(200);
    expect(getAgyPermissionRules(adminProfile.profileDir).allow).toContain('mcp(perm-sync-mcp/tool_alpha)');
    expect(getAgyPermissionRules(adminProfile.profileDir).allow).not.toContain('mcp(perm-sync-mcp/tool_beta)');

    const acpServers = await srv.ctx.mcpService.resolveAcpMcpServersForUser(memberUserId);
    const acpTarget = acpServers.find((s) => s.name === 'perm-sync-mcp') as { url: string };
    const listResp = await fetch(acpTarget.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const listJson = (await listResp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listJson.result.tools.map((t) => t.name)).toEqual(['tool_alpha', 'tool_gamma']);

    // 6) Newly registered user also receives shared alwaysAllow rules in settings.json
    const { userId: newUserId } = await registerAndBindAgy(srv.baseUrl, 'latejoiner', 'user:late@gmail.com');
    const lateProfile = srv.ctx.db.getAgyProfile(newUserId)!;
    expect(getAgyPermissionRules(lateProfile.profileDir).allow).toContain('mcp(perm-sync-mcp/tool_alpha)');

    // 7) Deleting the MCP server cleans up its mcp(...) rules from settings.json
    const delRes = await admin.request('DELETE', `/api/mcp/servers/${serverId}`);
    expect(delRes.status).toBe(200);
    expect(getAgyPermissionRules(adminProfile.profileDir).allow).not.toContain('mcp(perm-sync-mcp/tool_alpha)');
    expect(getAgyPermissionRules(memberProfile.profileDir).allow).not.toContain('mcp(perm-sync-mcp/tool_alpha)');
    expect(getAgyPermissionRules(lateProfile.profileDir).allow).not.toContain('mcp(perm-sync-mcp/tool_alpha)');
  });

  it('enforces disabledTools before tool discovery and prevents non-owners from mutating shared alwaysAllowTools from chat', async () => {
    const srv = await createTestServer({ allowPrivateMcpUrls: true });
    servers.push(srv);

    const mockHttpMcp = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number | string;
        method: string;
        params?: { name?: string };
      };
      if (rpc.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'pre-disc-mcp', version: '1.0' } },
        }));
        return;
      }
      if (rpc.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (rpc.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [
              { name: 'safe_tool', description: 'Safe tool' },
              { name: 'danger_tool', description: 'Dangerous tool' },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockHttpMcp.listen(0, '127.0.0.1', resolve));
    httpServers.push(mockHttpMcp);
    const port = (mockHttpMcp.address() as { port: number }).port;
    const upstreamUrl = `http://127.0.0.1:${port}`;

    const { client: admin, userId: adminUserId } = await registerAndBindAgy(srv.baseUrl, 'admin', 'user:admin@gmail.com');
    const { client: member, userId: memberUserId } = await registerAndBindAgy(srv.baseUrl, 'member', 'user:member@gmail.com');

    // Create shared MCP with disabledTools BEFORE any discovery (discoveredToolsJson stays '[]')
    const sharedCreate = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'pre-discovery-shared',
      scope: 'shared',
      transport: 'http',
      url: upstreamUrl,
      disabledTools: ['danger_tool'],
    });
    expect(sharedCreate.status).toBe(201);
    const sharedId = sharedCreate.data.server.id;
    expect(srv.ctx.db.getMcpServerById(sharedId)?.discoveredToolsJson).toBe('[]');

    const acpServers = await srv.ctx.mcpService.resolveAcpMcpServersForUser(memberUserId);
    const acpTarget = acpServers.find((s) => s.name === 'pre-discovery-shared') as { url: string };
    expect(acpTarget?.url).toBeTruthy();

    const listResp = await fetch(acpTarget.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const listJson = (await listResp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(listJson.result.tools.map((t) => t.name)).toEqual(['safe_tool']);

    const callDisabledResp = await fetch(acpTarget.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'danger_tool', arguments: {} } }),
    });
    const callDisabledJson = (await callDisabledResp.json()) as { error?: { code: number } };
    expect(callDisabledJson.error?.code).toBe(-32602);

    // Profile server owned by admin gets updated only by admin, while shared server is untouched
    const profileCreate = await admin.request<{ server: { id: string } }>('POST', '/api/mcp/servers', {
      name: 'admin-profile-mcp',
      scope: 'profile',
      transport: 'http',
      url: upstreamUrl,
    });
    expect(profileCreate.status).toBe(201);
    const profileId = profileCreate.data.server.id;

    srv.ctx.mcpService.recordToolAlwaysAllowFromChat(memberUserId, 'pre-discovery-shared', 'safe_tool');
    srv.ctx.mcpService.recordToolAlwaysAllowFromChat(adminUserId, 'pre-discovery-shared', 'safe_tool');
    expect(JSON.parse(srv.ctx.db.getMcpServerById(sharedId)!.alwaysAllowToolsJson)).toEqual([]);

    srv.ctx.mcpService.recordToolAlwaysAllowFromChat(memberUserId, 'admin-profile-mcp', 'safe_tool');
    expect(JSON.parse(srv.ctx.db.getMcpServerById(profileId)!.alwaysAllowToolsJson)).toEqual([]);

    srv.ctx.mcpService.recordToolAlwaysAllowFromChat(adminUserId, 'admin-profile-mcp', 'safe_tool');
    expect(JSON.parse(srv.ctx.db.getMcpServerById(profileId)!.alwaysAllowToolsJson)).toEqual(['safe_tool']);

    // Personal chat allow rule on a shared server stays in member's settings.json without leaking into shared toPublicRecord
    const { addAgyAllowPermissionRule } = await import('../src/acp/profile-settings.js');
    const memberProfile = srv.ctx.db.getAgyProfile(memberUserId)!;
    addAgyAllowPermissionRule(memberProfile.profileDir, 'mcp(pre-discovery-shared/safe_tool)');

    const adminList = await admin.request<{ servers: Array<{ id: string; alwaysAllowTools: string[] }> }>(
      'GET',
      '/api/mcp/servers'
    );
    const sharedFromApi = adminList.data.servers.find((s) => s.id === sharedId);
    expect(sharedFromApi?.alwaysAllowTools).toEqual([]);

    // Admin PATCH or startup sync preserves member's personal chat allow rule on pre-discovery-shared
    const patchShared = await admin.request('PATCH', `/api/mcp/servers/${sharedId}`, {
      description: 'Updated description',
    });
    expect(patchShared.status).toBe(200);
    srv.ctx.mcpService.syncAllSharedMcpPermissionsToProfile(memberProfile.profileDir);
    expect(getAgyPermissionRules(memberProfile.profileDir).allow).toContain('mcp(pre-discovery-shared/safe_tool)');
  });
});


