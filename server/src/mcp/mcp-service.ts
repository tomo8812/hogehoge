import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { McpCapabilities, McpServer } from '@agentclientprotocol/sdk';
import { resolveHostExecutable } from '../acp/env-isolation.js';
import {
  formatMcpPermissionRule,
  getAgyPermissionRules,
  syncMcpServerAlwaysAllowRules,
} from '../acp/profile-settings.js';
import { decryptSmallSecret, encryptSmallSecret } from '../auth/password.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase, StoredMcpServerRow } from '../db/database.js';
import type { SyncHub } from '../sync/hub.js';
import type {
  McpAuthType,
  McpDiscoveredTool,
  McpOAuthConfig,
  McpOAuthStatus,
  McpOAuthSummary,
  McpScope,
  McpSecretEntrySummary,
  McpServerRecord,
  McpTestResult,
  McpTransport,
} from '../types.js';
import {
  createSseMcpToolFilterTransform,
  extractMcpToolsFromJsonRpcPayload,
  filterMcpServerJsonRpcPayload,
  inspectMcpClientJsonRpcPayload,
  normalizeAllowedToolsList,
  STDIO_MCP_TOOL_FILTER_SCRIPT,
} from './tool-filter.js';

export class McpValidationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'McpValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface SecretKeyValueInput {
  name: string;
  value?: string;
  keepExisting?: boolean;
}

export interface McpOAuthConfigInput {
  clientId?: string | null;
  clientSecret?: string | null;
  clearClientSecret?: boolean;
  authorizationUrl?: string | null;
  tokenUrl?: string | null;
  registrationUrl?: string | null;
  scopes?: string | null;
  resource?: string | null;
  extraAuthParams?: Record<string, string> | null;
}

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  scope: McpScope;
  transport: McpTransport;
  enabled?: boolean;
  allowedTools?: string[] | null;
  disabledTools?: string[] | null;
  alwaysAllowTools?: string[] | null;
  command?: string | null;
  args?: string[];
  env?: SecretKeyValueInput[];
  url?: string | null;
  authType?: McpAuthType;
  headers?: SecretKeyValueInput[];
  oauthConfig?: McpOAuthConfigInput | null;
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string;
  scope?: McpScope;
  transport?: McpTransport;
  enabled?: boolean;
  allowedTools?: string[] | null;
  disabledTools?: string[] | null;
  alwaysAllowTools?: string[] | null;
  command?: string | null;
  args?: string[];
  env?: SecretKeyValueInput[];
  url?: string | null;
  authType?: McpAuthType;
  headers?: SecretKeyValueInput[];
  oauthConfig?: McpOAuthConfigInput | null;
}

interface StoredOAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
}

interface DiscoveredOAuthMetadata {
  authorizationUrl: string | null;
  tokenUrl: string | null;
  registrationUrl: string | null;
  scopes: string[];
  resource: string | null;
  clientIdMetadataDocumentSupported?: boolean;
}

export const ANTIGRAVITY_CIMD_CLIENT_ID = 'https://antigravity.google/oauth/client-metadata.json';
export const ANTIGRAVITY_CIMD_REDIRECT_URI = 'https://antigravity.google/oauth-callback';

interface PendingOAuthFlow {
  state: string;
  serverId: string;
  adminUserId: string;
  authorizationUrl: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | null;
  resource: string | null;
  createdAt: number;
  expiresAt: number;
}

const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const OAUTH_REFRESH_SKEW_MS = 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_OUTBOUND_REDIRECTS = 5;

export function validateMcpName(raw: string): string {
  const name = raw.trim();
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new McpValidationError(
      'INVALID_MCP_NAME',
      'MCPサーバー名は半角英数字で始まり、半角英数字・ドット・ハイフン・アンダースコア（1〜64文字）で指定してください。'
    );
  }
  return name;
}

function normalizeHostnameForIpCheck(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) {
    return lower.slice(1, -1);
  }
  return lower.replace(/\.+$/, '');
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8 (private)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (private)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (private)
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = normalizeHostnameForIpCheck(rawIp).split('%')[0];
  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    return isBlockedIpv4(ip);
  }
  if (ipVersion === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped IPv6 (dotted or hex form)
    const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (mappedDotted) {
      return isBlockedIpv4(mappedDotted[1]);
    }
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
    if (mappedHex) {
      const hi = Number.parseInt(mappedHex[1], 16);
      const lo = Number.parseInt(mappedHex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIpv4(v4);
    }
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    const firstHextet = Number.parseInt(lower.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

export function validateRemoteUrl(
  raw: string,
  fieldLabel = 'URL',
  opts: { allowPrivate?: boolean } = {}
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new McpValidationError('INVALID_URL', `${fieldLabel}を入力してください。`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpValidationError('INVALID_URL', `${fieldLabel}の形式が正しくありません。`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpValidationError(
      'INVALID_URL',
      `${fieldLabel}は http:// または https:// で始まる URL を指定してください。`
    );
  }
  if (!opts.allowPrivate) {
    const host = normalizeHostnameForIpCheck(parsed.hostname);
    if (!host || host === 'localhost' || host.endsWith('.localhost')) {
      throw new McpValidationError(
        'BLOCKED_PRIVATE_URL',
        `${fieldLabel}にループバック・プライベート・リンクローカルアドレスは指定できません。`
      );
    }
    if (net.isIP(host) !== 0 && isBlockedIpAddress(host)) {
      throw new McpValidationError(
        'BLOCKED_PRIVATE_URL',
        `${fieldLabel}にループバック・プライベート・リンクローカルアドレスは指定できません。`
      );
    }
  }
  return parsed.toString();
}

function tryValidateRemoteUrl(
  raw: string | null | undefined,
  opts: { allowPrivate?: boolean } = {}
): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    return validateRemoteUrl(raw, 'URL', opts);
  } catch {
    return null;
  }
}

interface PinnedAddressEntry {
  address: string;
  family: 4 | 6;
}

interface PinnedOutboundTarget {
  url: string;
  parsed: URL;
  pinnedAddress: string | null;
  pinnedFamily: 4 | 6 | null;
  pinnedAddresses?: PinnedAddressEntry[];
}

async function resolvePinnedOutboundTarget(
  rawUrl: string,
  opts: { allowPrivate?: boolean } = {}
): Promise<PinnedOutboundTarget> {
  const normalized = validateRemoteUrl(rawUrl, 'URL', opts);
  const parsed = new URL(normalized);
  const host = normalizeHostnameForIpCheck(parsed.hostname);
  const literalFamily = net.isIP(host);

  if (opts.allowPrivate) {
    const fam = literalFamily === 4 || literalFamily === 6 ? literalFamily : null;
    return {
      url: normalized,
      parsed,
      pinnedAddress: literalFamily !== 0 ? host : null,
      pinnedFamily: fam,
      pinnedAddresses: literalFamily !== 0 && fam ? [{ address: host, family: fam }] : undefined,
    };
  }

  if (literalFamily !== 0) {
    if (isBlockedIpAddress(host)) {
      throw new McpValidationError(
        'BLOCKED_PRIVATE_URL',
        'ループバック・プライベート・リンクローカルアドレスへの接続は許可されていません。'
      );
    }
    const fam = literalFamily === 6 ? 6 : 4;
    return {
      url: normalized,
      parsed,
      pinnedAddress: host,
      pinnedFamily: fam,
      pinnedAddresses: [{ address: host, family: fam }],
    };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch {
    throw new McpValidationError('DNS_RESOLUTION_FAILED', `ホスト名 "${host}" を名前解決できませんでした。`);
  }
  if (resolved.length === 0 || resolved.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new McpValidationError(
      'BLOCKED_PRIVATE_URL',
      'ループバック・プライベート・リンクローカルアドレスへの接続は許可されていません。'
    );
  }
  // Prefer IPv4 first so IPv4-only Linux hosts don't fail when AAAA records are returned first
  const ordered: PinnedAddressEntry[] = [
    ...resolved
      .filter((r) => r.family !== 6)
      .map((r) => ({ address: r.address, family: 4 as const })),
    ...resolved
      .filter((r) => r.family === 6)
      .map((r) => ({ address: r.address, family: 6 as const })),
  ];
  const primary = ordered[0];
  return {
    url: normalized,
    parsed,
    pinnedAddress: primary.address,
    pinnedFamily: primary.family,
    pinnedAddresses: ordered,
  };
}

export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: { allowPrivate?: boolean } = {}
): Promise<string> {
  const target = await resolvePinnedOutboundTarget(rawUrl, opts);
  return target.url;
}

function assertNoControlChars(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new McpValidationError('INVALID_INPUT', `${label}に改行や制御文字は使用できません。`);
  }
}

export function maskSecretValue(value: string): string {
  if (!value) return '';
  if (value.length >= 10) {
    return `••••${value.slice(-4)}`;
  }
  return '••••••••';
}

function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

function parseArgsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function parseDiscoveredToolsJson(raw: string): McpDiscoveredTool[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: McpDiscoveredTool[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name !== 'string') continue;
      const name = obj.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description =
        typeof obj.description === 'string' && obj.description.trim()
          ? obj.description.trim().slice(0, 2000)
          : undefined;
      out.push(description ? { name, description } : { name });
    }
    return out;
  } catch {
    return [];
  }
}

function extractResourceMetadataUrlFromWwwAuthenticate(headerVal: string | null): string | null {
  if (!headerVal) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(headerVal);
  if (match && match[1]) return match[1].trim();
  const unquoted = /resource_metadata\s*=\s*([^\s,;]+)/i.exec(headerVal);
  return unquoted?.[1]?.trim() ?? null;
}

function extractScopesFromWwwAuthenticate(headerVal: string | null): string[] {
  if (!headerVal) return [];
  const match = /\bscope\s*=\s*"([^"]+)"/i.exec(headerVal);
  const raw = match?.[1] ?? /\bscope\s*=\s*([^\s,;]+)/i.exec(headerVal)?.[1] ?? '';
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MAX_OUTBOUND_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeRequestHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) {
      out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function createPinnedLookup(target: PinnedOutboundTarget) {
  const list =
    target.pinnedAddresses && target.pinnedAddresses.length > 0
      ? target.pinnedAddresses
      : target.pinnedAddress
        ? [
            {
              address: target.pinnedAddress,
              family: (target.pinnedFamily ?? (net.isIP(target.pinnedAddress) === 6 ? 6 : 4)) as 4 | 6,
            },
          ]
        : null;
  if (!list || list.length === 0) return undefined;
  const primary = list[0];
  return (
    _hostname: string,
    options: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void
  ) => {
    const allRequested =
      typeof options === 'object' && options !== null && Boolean((options as { all?: boolean }).all);
    if (allRequested) {
      callback(null, list);
    } else {
      callback(null, primary.address, primary.family);
    }
  };
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; allowPrivate?: boolean; headersOnly?: boolean; maxRedirects?: number } = {}
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> | null; text: string }> {
  const maxRedirects = opts.maxRedirects ?? MAX_OUTBOUND_REDIRECTS;
  let currentUrl = url;
  let currentMethod = (init.method ?? 'GET').toUpperCase();
  let currentHeaders = normalizeRequestHeaders(init.headers);
  let currentBodyBuf =
    typeof init.body === 'string'
      ? Buffer.from(init.body, 'utf8')
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await resolvePinnedOutboundTarget(currentUrl, { allowPrivate: opts.allowPrivate });
    const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
    const reqHeaders = { ...currentHeaders };

    if (currentBodyBuf && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = String(currentBodyBuf.byteLength);
    }

    const pinnedLookup = createPinnedLookup(target);
    const bodyForHop = currentBodyBuf;
    const methodForHop = currentMethod;

    const hopResult = await new Promise<{
      redirectLocation?: string;
      status: number;
      headers: Headers;
      json: Record<string, unknown> | null;
      text: string;
    }>((resolve, reject) => {
      const isHttps = target.parsed.protocol === 'https:';
      const requestFn = isHttps ? https.request : http.request;
      const reqOptions: https.RequestOptions = {
        protocol: target.parsed.protocol,
        hostname: target.parsed.hostname,
        port: target.parsed.port ? Number(target.parsed.port) : isHttps ? 443 : 80,
        path: `${target.parsed.pathname}${target.parsed.search}`,
        method: methodForHop,
        headers: reqHeaders,
        ...(isHttps ? { servername: target.parsed.hostname } : {}),
        ...(pinnedLookup ? { lookup: pinnedLookup as never } : {}),
      };

      let settled = false;
      const finish = (
        err: Error | null,
        value?: {
          redirectLocation?: string;
          status: number;
          headers: Headers;
          json: Record<string, unknown> | null;
          text: string;
        }
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };

      const req = requestFn(reqOptions, (res) => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) headers.append(k, item);
          } else if (typeof v === 'string') {
            headers.set(k, v);
          }
        }

        if (status >= 300 && status < 400 && res.headers.location) {
          const location = Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location;
          res.resume();
          finish(null, { redirectLocation: location, status, headers, json: null, text: '' });
          return;
        }

        if (opts.headersOnly) {
          finish(null, { status, headers, json: null, text: '' });
          res.destroy();
          req.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_OUTBOUND_RESPONSE_BYTES) {
            res.destroy();
            finish(new Error('Response body exceeded maximum allowed size'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              json = parsed as Record<string, unknown>;
            }
          } catch {
            // non-JSON response
          }
          finish(null, { status, headers, json, text });
        });
        res.on('error', (err) => finish(err));
      });

      const timer = setTimeout(() => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      req.on('error', (err) => finish(err));
      if (bodyForHop) {
        req.write(bodyForHop);
      }
      req.end();
    });

    if (hopResult.redirectLocation) {
      if (hop >= maxRedirects) {
        throw new McpValidationError('REDIRECT_LIMIT_EXCEEDED', 'リモートMCPからのリダイレクト回数が上限を超えました。');
      }
      let resolvedNextUrl: string;
      try {
        resolvedNextUrl = new URL(hopResult.redirectLocation, target.url).toString();
      } catch {
        throw new McpValidationError('INVALID_URL', 'リダイレクト先URLの形式が正しくありません。');
      }
      // Validate next URL immediately so SSRF to private/loopback via redirect is blocked
      const nextTarget = await resolvePinnedOutboundTarget(resolvedNextUrl, {
        allowPrivate: opts.allowPrivate,
      });
      const isCrossOrigin = nextTarget.parsed.origin !== target.parsed.origin;
      if (
        (hopResult.status === 301 || hopResult.status === 302 || hopResult.status === 303) &&
        currentMethod !== 'GET' &&
        currentMethod !== 'HEAD'
      ) {
        currentMethod = 'GET';
        currentBodyBuf = null;
        const stripped: Record<string, string> = {};
        for (const [k, v] of Object.entries(currentHeaders)) {
          const low = k.toLowerCase();
          if (low === 'content-type' || low === 'content-length' || low === 'transfer-encoding') continue;
          stripped[k] = v;
        }
        currentHeaders = stripped;
      }
      if (isCrossOrigin) {
        if (currentBodyBuf !== null) {
          throw new McpValidationError(
            'CROSS_ORIGIN_BODY_REDIRECT_BLOCKED',
            'リクエストボディを含むクロスオリジンリダイレクトはセキュリティ上許可されていません。'
          );
        }
        const stripped: Record<string, string> = {};
        for (const [k, v] of Object.entries(currentHeaders)) {
          const low = k.toLowerCase();
          if (low === 'authorization' || low === 'cookie' || low === 'x-api-key') continue;
          stripped[k] = v;
        }
        currentHeaders = stripped;
      }
      currentUrl = nextTarget.url;
      continue;
    }

    return {
      status: hopResult.status,
      headers: hopResult.headers,
      json: hopResult.json,
      text: hopResult.text,
    };
  }

  throw new McpValidationError('REDIRECT_LIMIT_EXCEEDED', 'リモートMCPからのリダイレクト回数が上限を超えました。');
}

interface ForwardedMcpTarget extends PinnedOutboundTarget {
  allowedTools?: ReadonlySet<string>;
  disabledTools?: ReadonlySet<string>;
  trackedToolsListIds?: Set<string>;
  activeSseResponses?: Set<http.ServerResponse>;
}

const MAX_FORWARDED_BODY_BYTES = 16 * 1024 * 1024;

function readIncomingBody(stream: NodeJS.ReadableStream, maxBytes = MAX_FORWARDED_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function createDecodedResponseStream(
  upRes: http.IncomingMessage
): { stream: NodeJS.ReadableStream; decoded: boolean } {
  const enc = String(upRes.headers['content-encoding'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') {
    return { stream: upRes.pipe(zlib.createGunzip()), decoded: true };
  }
  if (enc === 'deflate') {
    return { stream: upRes.pipe(zlib.createInflate()), decoded: true };
  }
  if (enc === 'br') {
    return { stream: upRes.pipe(zlib.createBrotliDecompress()), decoded: true };
  }
  return { stream: upRes, decoded: false };
}

class PinnedHttpsForwarder {
  private server: http.Server | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  private readonly routes = new Map<string, ForwardedMcpTarget>();
  private readonly maxRoutes = 500;

  private async ensureListening(): Promise<number> {
    if (this.port !== null) return this.port;
    if (this.starting) return this.starting;

    this.starting = new Promise<number>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          if (!res.writableEnded) {
            res.end('Upstream MCP forwarder error');
          }
        });
      });
      srv.once('error', (err) => {
        this.starting = null;
        reject(err);
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          this.starting = null;
          reject(new Error('Failed to bind pinned HTTPS MCP forwarder'));
          return;
        }
        this.server = srv;
        this.port = addr.port;
        this.starting = null;
        resolve(addr.port);
      });
    });

    return this.starting;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const match = /^\/mcp\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(reqUrl.pathname);
    if (!match) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const token = match[1];
    const extraPath = match[2] ?? '';
    const target = this.routes.get(token);
    if (!target) {
      res.writeHead(404);
      res.end('Unknown MCP route');
      return;
    }

    const isRootRelativeRewrite = extraPath.startsWith('/__root/');
    const resolvedExtraPath = isRootRelativeRewrite ? extraPath.slice('/__root'.length) : extraPath;
    const mergedQuery = reqUrl.search || target.parsed.search;
    const upstreamPath = isRootRelativeRewrite
      ? `${resolvedExtraPath}${mergedQuery}`
      : `${target.parsed.pathname === '/' && resolvedExtraPath ? '' : target.parsed.pathname}${resolvedExtraPath}${mergedQuery}`;

    const filterActive =
      target.allowedTools !== undefined || target.disabledTools !== undefined;
    const outHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'keep-alive' || lower === 'proxy-connection') {
        continue;
      }
      if (filterActive && lower === 'accept-encoding') {
        continue;
      }
      outHeaders[k] = v;
    }
    outHeaders.host = target.parsed.host;

    if (filterActive) {
      outHeaders['accept-encoding'] = 'identity';
    }

    let requestBodyBuf: Buffer | null = null;
    let localToolsListIds = new Set<string>();
    let blockedBatchErrors: Record<string, unknown>[] = [];

    if (filterActive && req.method === 'POST') {
      try {
        requestBodyBuf = await readIncomingBody(req);
      } catch (err) {
        if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Payload Too Large');
          return;
        }
        throw err;
      }

      const inspectRes = inspectMcpClientJsonRpcPayload(
        requestBodyBuf.toString('utf8'),
        target.allowedTools ?? null,
        target.trackedToolsListIds,
        target.disabledTools ?? null
      );
      if (inspectRes.kind === 'reject_all') {
        const respBuf = Buffer.from(inspectRes.responseBody, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(respBuf.byteLength),
        });
        res.end(respBuf);
        return;
      }
      localToolsListIds = inspectRes.localToolsListIds;
      if (inspectRes.kind === 'partial') {
        requestBodyBuf = Buffer.from(inspectRes.forwardBody, 'utf8');
        blockedBatchErrors = inspectRes.blockedErrors;
      }
      for (const k of Object.keys(outHeaders)) {
        if (k.toLowerCase() === 'transfer-encoding' || k.toLowerCase() === 'content-length') {
          delete outHeaders[k];
        }
      }
      outHeaders['content-length'] = String(requestBodyBuf.byteLength);
    }

    const isHttps = target.parsed.protocol === 'https:';
    const pinnedLookup = createPinnedLookup(target);
    const reqOptions = {
      protocol: isHttps ? 'https:' : 'http:',
      hostname: target.parsed.hostname,
      port: target.parsed.port ? Number(target.parsed.port) : isHttps ? 443 : 80,
      path: upstreamPath,
      method: req.method || 'GET',
      headers: outHeaders,
      ...(isHttps ? { servername: target.parsed.hostname } : {}),
      ...(pinnedLookup ? { lookup: pinnedLookup as never } : {}),
    };

    const upReq = (isHttps ? https.request : http.request)(reqOptions, (upRes) => {
      const status = upRes.statusCode ?? 502;
      if (status >= 300 && status < 400 && upRes.headers.location) {
        upRes.resume();
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end('Upstream redirect blocked');
        return;
      }

      if (!filterActive) {
        res.writeHead(status, upRes.headers);
        upRes.pipe(res);
        return;
      }

      const contentType = String(upRes.headers['content-type'] ?? '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        const respHeaders: http.OutgoingHttpHeaders = { ...upRes.headers };
        delete respHeaders['content-length'];
        delete respHeaders['content-encoding'];
        delete respHeaders['transfer-encoding'];
        res.writeHead(status, respHeaders);
        if (req.method !== 'POST' && target.activeSseResponses) {
          target.activeSseResponses.add(res);
          res.once('close', () => {
            target.activeSseResponses?.delete(res);
          });
        }
        if (blockedBatchErrors.length > 0 && !res.writableEnded) {
          for (const errPayload of blockedBatchErrors) {
            res.write(`event: message\ndata: ${JSON.stringify(errPayload)}\n\n`);
          }
        }
        const { stream } = createDecodedResponseStream(upRes);
        const sseFilter = createSseMcpToolFilterTransform({
          allowedTools: target.allowedTools ?? null,
          disabledTools: target.disabledTools ?? null,
          trackedToolsListIds: target.trackedToolsListIds,
          localToolsListIds,
          routeToken: token,
          upstreamOrigin: target.parsed.origin,
        });
        stream.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        sseFilter.on('error', () => {
          if (!res.writableEnded) res.end();
        });
        stream.pipe(sseFilter).pipe(res);
        return;
      }

      const mayNeedJsonFilter =
        localToolsListIds.size > 0 ||
        blockedBatchErrors.length > 0 ||
        ((target.trackedToolsListIds?.size ?? 0) > 0 && contentType.includes('application/json'));

      if (mayNeedJsonFilter && contentType.includes('application/json')) {
        const { stream } = createDecodedResponseStream(upRes);
        void readIncomingBody(stream)
          .then((respBuf) => {
            let finalText = respBuf.toString('utf8');
            let modified = false;
            try {
              const parsed = JSON.parse(finalText);
              const combinedIds = new Set<string>([
                ...(target.trackedToolsListIds ?? []),
                ...localToolsListIds,
              ]);
              const forceList = localToolsListIds.size > 0 && blockedBatchErrors.length === 0;
              const filtered = filterMcpServerJsonRpcPayload(
                parsed,
                target.allowedTools ?? null,
                combinedIds,
                forceList,
                target.disabledTools ?? null
              );
              let finalValue = filtered.value;
              if (filtered.changed) {
                modified = true;
                for (const idKey of localToolsListIds) {
                  target.trackedToolsListIds?.delete(idKey);
                }
              }
              if (blockedBatchErrors.length > 0) {
                modified = true;
                finalValue = Array.isArray(finalValue)
                  ? [...finalValue, ...blockedBatchErrors]
                  : [finalValue, ...blockedBatchErrors];
              }
              if (modified) {
                finalText = JSON.stringify(finalValue);
              }
            } catch {
              // Forward raw payload if non-JSON
            }
            const outBuf = modified ? Buffer.from(finalText, 'utf8') : respBuf;
            const respHeaders: http.OutgoingHttpHeaders = { ...upRes.headers };
            delete respHeaders['content-encoding'];
            delete respHeaders['transfer-encoding'];
            respHeaders['content-length'] = String(outBuf.byteLength);
            if (!res.headersSent) res.writeHead(status, respHeaders);
            res.end(outBuf);
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            if (!res.writableEnded) res.end('Upstream MCP response error');
          });
        return;
      }

      if (blockedBatchErrors.length > 0 && target.activeSseResponses && target.activeSseResponses.size > 0) {
        for (const sseRes of target.activeSseResponses) {
          if (sseRes.writableEnded) continue;
          for (const errPayload of blockedBatchErrors) {
            sseRes.write(`event: message\ndata: ${JSON.stringify(errPayload)}\n\n`);
          }
        }
      }

      res.writeHead(status, upRes.headers);
      upRes.pipe(res);
    });

    upReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end('Upstream MCP connection failed');
      }
    });
    res.on('close', () => {
      if (!upReq.destroyed) upReq.destroy();
    });

    if (requestBodyBuf !== null) {
      upReq.end(requestBodyBuf);
    } else {
      req.pipe(upReq);
    }
  }

  async registerRoute(target: ForwardedMcpTarget): Promise<string> {
    const port = await this.ensureListening();
    if (this.routes.size >= this.maxRoutes) {
      const oldestKey = this.routes.keys().next().value;
      if (oldestKey) this.routes.delete(oldestKey);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    this.routes.set(token, target);
    return `http://127.0.0.1:${port}/mcp/${token}`;
  }

  async shutdown(): Promise<void> {
    this.routes.clear();
    const srv = this.server;
    this.server = null;
    this.port = null;
    this.starting = null;
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
}

export class McpService {
  private readonly pendingOAuthFlows = new Map<string, PendingOAuthFlow>();
  private readonly inFlightOAuthRefreshes = new Map<string, Promise<string | null>>();
  private readonly httpsForwarder = new PinnedHttpsForwarder();

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub: SyncHub
  ) {}

  async shutdown(): Promise<void> {
    await this.httpsForwarder.shutdown();
  }

  private decryptRecord(encrypted: string | null): Record<string, string> {
    if (!encrypted) return {};
    try {
      const plain = decryptSmallSecret(encrypted, this.config.sessionSecret);
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') out[k] = v;
        }
        return out;
      }
      return {};
    } catch {
      return {};
    }
  }

  private encryptRecord(record: Record<string, string>): string | null {
    const entries = Object.entries(record);
    if (entries.length === 0) return null;
    return encryptSmallSecret(JSON.stringify(record), this.config.sessionSecret);
  }

  private decryptTokens(encrypted: string | null): StoredOAuthTokens | null {
    if (!encrypted) return null;
    try {
      const plain = decryptSmallSecret(encrypted, this.config.sessionSecret);
      const parsed = JSON.parse(plain) as StoredOAuthTokens;
      if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private encryptTokens(tokens: StoredOAuthTokens | null): string | null {
    if (!tokens || !tokens.accessToken) return null;
    return encryptSmallSecret(JSON.stringify(tokens), this.config.sessionSecret);
  }

  private decryptClientSecret(encrypted: string | null): string | null {
    if (!encrypted) return null;
    try {
      const val = decryptSmallSecret(encrypted, this.config.sessionSecret);
      return val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  private mergeSecretEntries(
    inputs: SecretKeyValueInput[] | undefined,
    existing: Record<string, string>,
    kindLabel: string
  ): Record<string, string> {
    if (!inputs) return { ...existing };
    const out: Record<string, string> = {};
    for (const item of inputs) {
      const name = item.name.trim();
      if (!name) continue;
      assertNoControlChars(name, `${kindLabel}名`);
      if (item.keepExisting) {
        if (Object.prototype.hasOwnProperty.call(existing, name)) {
          out[name] = existing[name];
        }
        continue;
      }
      const val = item.value ?? '';
      assertNoControlChars(val, `${kindLabel}値 (${name})`);
      out[name] = val;
    }
    return out;
  }

  private normalizeOAuthConfig(
    input: McpOAuthConfigInput | null | undefined,
    existing: McpOAuthConfig | null
  ): McpOAuthConfig | null {
    if (input === null) return null;
    if (input === undefined) return existing;
    const urlOpts = { allowPrivate: this.config.allowPrivateMcpUrls };

    const merged: McpOAuthConfig = {
      clientId: input.clientId !== undefined ? (input.clientId?.trim() || null) : (existing?.clientId ?? null),
      authorizationUrl:
        input.authorizationUrl !== undefined
          ? (input.authorizationUrl?.trim() ? validateRemoteUrl(input.authorizationUrl, 'Authorization URL', urlOpts) : null)
          : (existing?.authorizationUrl ?? null),
      tokenUrl:
        input.tokenUrl !== undefined
          ? (input.tokenUrl?.trim() ? validateRemoteUrl(input.tokenUrl, 'Token URL', urlOpts) : null)
          : (existing?.tokenUrl ?? null),
      registrationUrl:
        input.registrationUrl !== undefined
          ? (input.registrationUrl?.trim() ? validateRemoteUrl(input.registrationUrl, 'Registration URL', urlOpts) : null)
          : (existing?.registrationUrl ?? null),
      scopes: input.scopes !== undefined ? (input.scopes?.trim() || null) : (existing?.scopes ?? null),
      resource:
        input.resource !== undefined
          ? (input.resource?.trim() ? validateRemoteUrl(input.resource, 'Resource URL', urlOpts) : null)
          : (existing?.resource ?? null),
      extraAuthParams:
        input.extraAuthParams !== undefined
          ? this.sanitizeExtraAuthParams(input.extraAuthParams)
          : (existing?.extraAuthParams ?? null),
    };

    return merged;
  }

  private static readonly RESERVED_OAUTH_PARAMS = new Set([
    'response_type',
    'client_id',
    'redirect_uri',
    'state',
    'code_challenge',
    'code_challenge_method',
    'scope',
    'resource',
  ]);

  private sanitizeExtraAuthParams(raw: Record<string, string> | null | undefined): Record<string, string> | null {
    if (!raw) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = k.trim();
      const val = typeof v === 'string' ? v.trim() : '';
      if (!key || !val) continue;
      if (McpService.RESERVED_OAUTH_PARAMS.has(key.toLowerCase())) continue;
      assertNoControlChars(key, 'OAuthパラメータ名');
      assertNoControlChars(val, 'OAuthパラメータ値');
      out[key] = val;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private resolveTargetProfileDirs(scope: McpScope, ownerUserId: string | null): string[] {
    if (scope === 'shared') {
      return this.db.listAgyProfileDirs();
    }
    if (ownerUserId) {
      const profile = this.db.getAgyProfile(ownerUserId);
      return profile ? [profile.profileDir] : [];
    }
    return [];
  }

  private computeEffectiveAlwaysAllowTools(row: StoredMcpServerRow): string[] {
    if (!row.enabled) return [];
    const alwaysAllow = parseArgsJson(row.alwaysAllowToolsJson);
    if (alwaysAllow.length === 0) return [];
    const disabledSet = new Set(parseArgsJson(row.disabledToolsJson));
    const allowedList = parseArgsJson(row.allowedToolsJson);
    const allowedSet = allowedList.length > 0 ? new Set(allowedList) : null;
    return alwaysAllow.filter((tool) => {
      if (disabledSet.has(tool)) return false;
      if (allowedSet && !allowedSet.has(tool)) return false;
      return true;
    });
  }

  private syncRowPermissionsToSettings(
    row: StoredMcpServerRow,
    previousRow?: StoredMcpServerRow | null
  ): void {
    const currentDirs = this.resolveTargetProfileDirs(row.scope, row.ownerUserId);
    const effectiveAlwaysAllow = this.computeEffectiveAlwaysAllowTools(row);

    this.db.withAgyProfileSettingsWrite(() => {
      if (
        previousRow &&
        (previousRow.scope !== row.scope ||
          previousRow.ownerUserId !== row.ownerUserId ||
          previousRow.name !== row.name)
      ) {
        const prevDirs = this.resolveTargetProfileDirs(previousRow.scope, previousRow.ownerUserId);
        syncMcpServerAlwaysAllowRules({
          profileDirs: prevDirs,
          serverName: previousRow.name,
          alwaysAllowTools: [],
        });
      }

      syncMcpServerAlwaysAllowRules({
        profileDirs: currentDirs,
        serverName: row.name,
        previousServerName: previousRow?.name ?? null,
        alwaysAllowTools: effectiveAlwaysAllow,
      });
    });
  }

  syncAllSharedMcpPermissionsToProfile(profileDir: string): void {
    if (!profileDir) return;
    const rows = this.db.listMcpServersForAdmin('');
    this.db.withAgyProfileSettingsWrite(() => {
      for (const row of rows) {
        if (row.scope !== 'shared') continue;
        syncMcpServerAlwaysAllowRules({
          profileDirs: [profileDir],
          serverName: row.name,
          alwaysAllowTools: this.computeEffectiveAlwaysAllowTools(row),
        });
      }
    });
  }

  recordToolAlwaysAllowFromChat(userId: string, serverName: string, toolName: string): void {
    const cleanServer = serverName.trim();
    const cleanTool = toolName.trim();
    if (!cleanServer || !cleanTool) return;
    const rows = this.db
      .listEffectiveMcpServersForUser(userId)
      .filter((r) => r.name === cleanServer && r.scope === 'profile' && r.ownerUserId === userId);
    for (const row of rows) {
      const curAlways = parseArgsJson(row.alwaysAllowToolsJson);
      if (!curAlways.includes(cleanTool)) {
        const nextAlways = [...curAlways, cleanTool];
        this.db.updateMcpServer(row.id, {
          alwaysAllowToolsJson: JSON.stringify(nextAlways),
        });
        this.emitUpdated(row.scope, row.ownerUserId, row.id);
      }
    }
  }

  private toPublicRecord(row: StoredMcpServerRow): McpServerRecord {
    const envMap = this.decryptRecord(row.encryptedEnvJson);
    const headerMap = this.decryptRecord(row.encryptedHeadersJson);
    const envSummary: McpSecretEntrySummary[] = Object.entries(envMap).map(([name, value]) => ({
      name,
      maskedValue: maskSecretValue(value),
      hasValue: value.length > 0,
    }));
    const headerSummary: McpSecretEntrySummary[] = Object.entries(headerMap).map(([name, value]) => ({
      name,
      maskedValue: maskSecretValue(value),
      hasValue: value.length > 0,
    }));

    let oauth: McpOAuthSummary | null = null;
    if (row.authType === 'oauth') {
      const cfg = parseJsonObject<McpOAuthConfig>(row.oauthConfigJson);
      const tokens = this.decryptTokens(row.encryptedOauthTokensJson);
      let status: McpOAuthStatus = row.oauthStatus;
      if (status === 'connected' && tokens?.expiresAt && tokens.expiresAt <= Date.now() && !tokens.refreshToken) {
        status = 'expired';
      }
      oauth = {
        status,
        clientId: cfg?.clientId ?? null,
        hasClientSecret: Boolean(row.encryptedOauthClientSecret),
        authorizationUrl: cfg?.authorizationUrl ?? null,
        tokenUrl: cfg?.tokenUrl ?? null,
        registrationUrl: cfg?.registrationUrl ?? null,
        scopes: cfg?.scopes ?? null,
        resource: cfg?.resource ?? null,
        extraAuthParams: cfg?.extraAuthParams ?? {},
        expiresAt: tokens?.expiresAt ?? null,
        hasRefreshToken: Boolean(tokens?.refreshToken),
        error: row.oauthError,
        updatedAt: row.oauthUpdatedAt,
      };
    }

    const storedAlwaysAllow = parseArgsJson(row.alwaysAllowToolsJson);
    const alwaysAllowSet = new Set(storedAlwaysAllow);
    // Also reflect any mcp(server/tool) rules present in the owner/admin profile's settings.json
    const checkDirs = this.resolveTargetProfileDirs(row.scope, row.ownerUserId);
    const prefix = `mcp(${row.name}/`;
    for (const dir of checkDirs.slice(0, 1)) {
      try {
        const rules = getAgyPermissionRules(dir, { createIfMissing: false });
        for (const allowRule of rules.allow) {
          if (allowRule.startsWith(prefix) && allowRule.endsWith(')')) {
            const toolName = allowRule.slice(prefix.length, -1).trim();
            if (toolName) alwaysAllowSet.add(toolName);
          }
        }
      } catch {
        // ignore read error
      }
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope,
      ownerUserId: row.ownerUserId,
      transport: row.transport,
      enabled: row.enabled,
      allowedTools: parseArgsJson(row.allowedToolsJson),
      disabledTools: parseArgsJson(row.disabledToolsJson),
      alwaysAllowTools: [...alwaysAllowSet],
      discoveredTools: parseDiscoveredToolsJson(row.discoveredToolsJson),
      command: row.command,
      args: parseArgsJson(row.argsJson),
      env: envSummary,
      url: row.url,
      authType: row.authType,
      headers: headerSummary,
      oauth,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private emitUpdated(scope: McpScope, ownerUserId: string | null, serverId: string): void {
    const targetAdminIds =
      scope === 'shared'
        ? this.db.listAdminUserIds()
        : ownerUserId
          ? [ownerUserId]
          : this.db.listAdminUserIds();

    for (const userId of targetAdminIds) {
      this.hub.emitDurable({
        userId,
        type: 'mcp.updated',
        payload: { serverId, scope },
      });
    }
  }

  private assertAdminCanAccessRow(adminUserId: string, row: StoredMcpServerRow): void {
    if (row.scope === 'profile' && row.ownerUserId !== adminUserId) {
      throw new McpValidationError('FORBIDDEN', '他の管理者の個人プロファイル専用MCPにはアクセスできません。', 403);
    }
  }

  listServersForAdmin(adminUserId: string): McpServerRecord[] {
    return this.db.listMcpServersForAdmin(adminUserId).map((row) => this.toPublicRecord(row));
  }

  getServerForAdmin(adminUserId: string, serverId: string): McpServerRecord {
    const row = this.db.getMcpServerById(serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, row);
    return this.toPublicRecord(row);
  }

  createServer(adminUserId: string, input: CreateMcpServerInput): McpServerRecord {
    const name = validateMcpName(input.name);
    const scope: McpScope = input.scope === 'profile' ? 'profile' : 'shared';
    const ownerUserId = scope === 'profile' ? adminUserId : null;
    const transport: McpTransport = input.transport;
    const description = (input.description ?? '').trim().slice(0, 500);
    const enabled = input.enabled !== undefined ? Boolean(input.enabled) : true;
    const allowedTools = normalizeAllowedToolsList(input.allowedTools, (msg) => {
      throw new McpValidationError('INVALID_ALLOWED_TOOLS', msg);
    });
    const disabledTools = normalizeAllowedToolsList(input.disabledTools, (msg) => {
      throw new McpValidationError('INVALID_DISABLED_TOOLS', msg);
    });
    const alwaysAllowTools = normalizeAllowedToolsList(input.alwaysAllowTools, (msg) => {
      throw new McpValidationError('INVALID_ALWAYS_ALLOW_TOOLS', msg);
    });

    const existingDup = this.db.findMcpServerByScopeAndName(scope, ownerUserId, name);
    if (existingDup) {
      throw new McpValidationError(
        'MCP_NAME_EXISTS',
        `同じスコープに "${name}" というMCPサーバーが既に存在します。`,
        409
      );
    }

    let command: string | null = null;
    let args: string[] = [];
    let encryptedEnvJson: string | null = null;
    let url: string | null = null;
    let authType: McpAuthType = 'none';
    let encryptedHeadersJson: string | null = null;
    let oauthConfigJson: string | null = null;
    let encryptedOauthClientSecret: string | null = null;

    if (transport === 'stdio') {
      const cmd = (input.command ?? '').trim();
      if (!cmd) {
        throw new McpValidationError('COMMAND_REQUIRED', 'ローカルMCPには実行コマンドを指定してください。');
      }
      assertNoControlChars(cmd, 'コマンド');
      command = cmd;
      args = (input.args ?? []).map((a) => String(a));
      for (const a of args) assertNoControlChars(a, 'コマンド引数');
      const envMap = this.mergeSecretEntries(input.env, {}, '環境変数');
      encryptedEnvJson = this.encryptRecord(envMap);
      authType = 'none';
    } else {
      url = validateRemoteUrl(input.url ?? '', 'リモートMCP URL', {
        allowPrivate: this.config.allowPrivateMcpUrls,
      });
      authType = input.authType ?? 'none';
      const headerMap = this.mergeSecretEntries(input.headers, {}, 'HTTPヘッダー');
      encryptedHeadersJson = this.encryptRecord(headerMap);

      if (authType === 'oauth') {
        const oauthCfg = this.normalizeOAuthConfig(input.oauthConfig, null);
        oauthConfigJson = oauthCfg ? JSON.stringify(oauthCfg) : null;
        const secret = input.oauthConfig?.clientSecret?.trim();
        if (secret) {
          encryptedOauthClientSecret = encryptSmallSecret(secret, this.config.sessionSecret);
        }
      }
    }

    const row = this.db.createMcpServer({
      id: crypto.randomUUID(),
      name,
      description,
      scope,
      ownerUserId,
      transport,
      enabled,
      allowedToolsJson: JSON.stringify(allowedTools),
      disabledToolsJson: JSON.stringify(disabledTools),
      alwaysAllowToolsJson: JSON.stringify(alwaysAllowTools),
      discoveredToolsJson: '[]',
      command,
      argsJson: JSON.stringify(args),
      encryptedEnvJson,
      url,
      authType,
      encryptedHeadersJson,
      oauthConfigJson,
      encryptedOauthClientSecret,
      encryptedOauthTokensJson: null,
      oauthStatus: 'disconnected',
      oauthError: null,
      oauthUpdatedAt: null,
      createdBy: adminUserId,
    });

    this.syncRowPermissionsToSettings(row, null);
    this.emitUpdated(row.scope, row.ownerUserId, row.id);
    return this.toPublicRecord(row);
  }

  updateServer(adminUserId: string, serverId: string, input: UpdateMcpServerInput): McpServerRecord {
    const existing = this.db.getMcpServerById(serverId);
    if (!existing) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, existing);

    const nextName = input.name !== undefined ? validateMcpName(input.name) : existing.name;
    const nextScope: McpScope = input.scope !== undefined ? input.scope : existing.scope;
    const nextOwnerUserId = nextScope === 'profile' ? adminUserId : null;
    const nextTransport: McpTransport = input.transport !== undefined ? input.transport : existing.transport;
    const nextDescription =
      input.description !== undefined ? input.description.trim().slice(0, 500) : existing.description;
    const nextEnabled = input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled;
    const nextAllowedToolsJson =
      input.allowedTools !== undefined
        ? JSON.stringify(
            normalizeAllowedToolsList(input.allowedTools, (msg) => {
              throw new McpValidationError('INVALID_ALLOWED_TOOLS', msg);
            })
          )
        : existing.allowedToolsJson;
    const nextDisabledToolsJson =
      input.disabledTools !== undefined
        ? JSON.stringify(
            normalizeAllowedToolsList(input.disabledTools, (msg) => {
              throw new McpValidationError('INVALID_DISABLED_TOOLS', msg);
            })
          )
        : existing.disabledToolsJson;
    const nextAlwaysAllowToolsJson =
      input.alwaysAllowTools !== undefined
        ? JSON.stringify(
            normalizeAllowedToolsList(input.alwaysAllowTools, (msg) => {
              throw new McpValidationError('INVALID_ALWAYS_ALLOW_TOOLS', msg);
            })
          )
        : existing.alwaysAllowToolsJson;

    if (
      nextName !== existing.name ||
      nextScope !== existing.scope ||
      nextOwnerUserId !== existing.ownerUserId
    ) {
      const dup = this.db.findMcpServerByScopeAndName(nextScope, nextOwnerUserId, nextName);
      if (dup && dup.id !== existing.id) {
        throw new McpValidationError(
          'MCP_NAME_EXISTS',
          `同じスコープに "${nextName}" というMCPサーバーが既に存在します。`,
          409
        );
      }
    }

    let nextCommand = existing.command;
    let nextArgsJson = existing.argsJson;
    let nextEncryptedEnvJson = existing.encryptedEnvJson;
    let nextUrl = existing.url;
    let nextAuthType: McpAuthType = existing.authType;
    let nextEncryptedHeadersJson = existing.encryptedHeadersJson;
    let nextOAuthConfigJson = existing.oauthConfigJson;
    let nextEncryptedClientSecret = existing.encryptedOauthClientSecret;
    let nextEncryptedTokensJson = existing.encryptedOauthTokensJson;
    let nextOAuthStatus: McpOAuthStatus = existing.oauthStatus;
    let nextOAuthError = existing.oauthError;

    if (nextTransport === 'stdio') {
      const cmd = input.command !== undefined ? (input.command ?? '').trim() : (existing.command ?? '').trim();
      if (!cmd) {
        throw new McpValidationError('COMMAND_REQUIRED', 'ローカルMCPには実行コマンドを指定してください。');
      }
      assertNoControlChars(cmd, 'コマンド');
      nextCommand = cmd;
      if (input.args !== undefined) {
        const args = input.args.map((a) => String(a));
        for (const a of args) assertNoControlChars(a, 'コマンド引数');
        nextArgsJson = JSON.stringify(args);
      }
      if (input.env !== undefined) {
        const existingEnv = this.decryptRecord(existing.encryptedEnvJson);
        const mergedEnv = this.mergeSecretEntries(input.env, existingEnv, '環境変数');
        nextEncryptedEnvJson = this.encryptRecord(mergedEnv);
      }
      nextUrl = null;
      nextAuthType = 'none';
      nextEncryptedHeadersJson = null;
      nextOAuthConfigJson = null;
      nextEncryptedClientSecret = null;
      nextEncryptedTokensJson = null;
      nextOAuthStatus = 'disconnected';
      nextOAuthError = null;
    } else {
      const rawUrl = input.url !== undefined ? (input.url ?? '') : (existing.url ?? '');
      nextUrl = validateRemoteUrl(rawUrl, 'リモートMCP URL', {
        allowPrivate: this.config.allowPrivateMcpUrls,
      });
      nextAuthType = input.authType !== undefined ? input.authType : existing.authType;
      nextCommand = null;
      nextArgsJson = '[]';
      nextEncryptedEnvJson = null;

      if (input.headers !== undefined) {
        const existingHeaders = this.decryptRecord(existing.encryptedHeadersJson);
        const mergedHeaders = this.mergeSecretEntries(input.headers, existingHeaders, 'HTTPヘッダー');
        nextEncryptedHeadersJson = this.encryptRecord(mergedHeaders);
      }

      if (nextAuthType === 'oauth') {
        const existingCfg = parseJsonObject<McpOAuthConfig>(existing.oauthConfigJson);
        const mergedCfg = this.normalizeOAuthConfig(input.oauthConfig, existingCfg);
        nextOAuthConfigJson = mergedCfg ? JSON.stringify(mergedCfg) : null;

        if (input.oauthConfig?.clearClientSecret) {
          nextEncryptedClientSecret = null;
        } else if (typeof input.oauthConfig?.clientSecret === 'string' && input.oauthConfig.clientSecret.trim()) {
          nextEncryptedClientSecret = encryptSmallSecret(
            input.oauthConfig.clientSecret.trim(),
            this.config.sessionSecret
          );
        }

        // If URL changed, invalidate previous OAuth tokens because they belong to the old resource
        if (nextUrl !== existing.url) {
          nextEncryptedTokensJson = null;
          nextOAuthStatus = 'disconnected';
          nextOAuthError = null;
        }
      } else {
        nextOAuthConfigJson = null;
        nextEncryptedClientSecret = null;
        nextEncryptedTokensJson = null;
        nextOAuthStatus = 'disconnected';
        nextOAuthError = null;
      }
    }

    const updated = this.db.updateMcpServer(existing.id, {
      name: nextName,
      description: nextDescription,
      scope: nextScope,
      ownerUserId: nextOwnerUserId,
      transport: nextTransport,
      enabled: nextEnabled,
      allowedToolsJson: nextAllowedToolsJson,
      disabledToolsJson: nextDisabledToolsJson,
      alwaysAllowToolsJson: nextAlwaysAllowToolsJson,
      command: nextCommand,
      argsJson: nextArgsJson,
      encryptedEnvJson: nextEncryptedEnvJson,
      url: nextUrl,
      authType: nextAuthType,
      encryptedHeadersJson: nextEncryptedHeadersJson,
      oauthConfigJson: nextOAuthConfigJson,
      encryptedOauthClientSecret: nextEncryptedClientSecret,
      encryptedOauthTokensJson: nextEncryptedTokensJson,
      oauthStatus: nextOAuthStatus,
      oauthError: nextOAuthError,
    });

    if (!updated) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }

    this.syncRowPermissionsToSettings(updated, existing);
    this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
    if (existing.scope !== updated.scope) {
      this.emitUpdated(existing.scope, existing.ownerUserId, updated.id);
    }
    return this.toPublicRecord(updated);
  }

  deleteServer(adminUserId: string, serverId: string): { deleted: boolean; scope: McpScope; ownerUserId: string | null } {
    const existing = this.db.getMcpServerById(serverId);
    if (!existing) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, existing);
    const deleted = this.db.deleteMcpServer(existing.id);
    if (deleted) {
      const targetDirs = this.resolveTargetProfileDirs(existing.scope, existing.ownerUserId);
      this.db.withAgyProfileSettingsWrite(() => {
        syncMcpServerAlwaysAllowRules({
          profileDirs: targetDirs,
          serverName: existing.name,
          alwaysAllowTools: [],
        });
      });
      this.emitUpdated(existing.scope, existing.ownerUserId, existing.id);
    }
    return { deleted, scope: existing.scope, ownerUserId: existing.ownerUserId };
  }

  /**
   * Imports one or more MCP servers from standard Claude / Cursor / Antigravity / VS Code JSON.
   */
  importFromJson(
    adminUserId: string,
    params: { scope: McpScope; rawJson: string; overwrite?: boolean }
  ): { imported: McpServerRecord[]; skipped: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(params.rawJson);
    } catch {
      throw new McpValidationError('INVALID_JSON', 'JSONの構文が正しくありません。');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new McpValidationError('INVALID_JSON', 'JSONオブジェクト形式で入力してください。');
    }

    const root = parsed as Record<string, unknown>;
    let serverMap: Record<string, unknown>;
    if (root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)) {
      serverMap = root.mcpServers as Record<string, unknown>;
    } else if (root.servers && typeof root.servers === 'object' && !Array.isArray(root.servers)) {
      serverMap = root.servers as Record<string, unknown>;
    } else {
      serverMap = root;
    }

    const entries = Object.entries(serverMap);
    if (entries.length === 0) {
      throw new McpValidationError('EMPTY_IMPORT', 'インポート可能なMCPサーバー定義が見つかりませんでした。');
    }

    const imported: McpServerRecord[] = [];
    const skipped: string[] = [];
    const duplicateSkipped: string[] = [];
    const invalidEntries: string[] = [];
    const ownerUserId = params.scope === 'profile' ? adminUserId : null;

    for (const [rawName, rawCfg] of entries) {
      if (!rawCfg || typeof rawCfg !== 'object' || Array.isArray(rawCfg)) {
        skipped.push(rawName);
        invalidEntries.push(`${rawName}（設定がオブジェクト形式ではありません）`);
        continue;
      }
      try {
        const cfg = rawCfg as Record<string, unknown>;
        const name = validateMcpName(rawName);

        const remoteUrlRaw =
          (typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()) ||
          (typeof cfg.url === 'string' && cfg.url.trim()) ||
          (typeof cfg.httpUrl === 'string' && cfg.httpUrl.trim()) ||
          null;
        const commandRaw = typeof cfg.command === 'string' && cfg.command.trim() ? cfg.command.trim() : null;

        if (!remoteUrlRaw && !commandRaw) {
          skipped.push(rawName);
          invalidEntries.push(`${rawName}（url または command が不足しています）`);
          continue;
        }

        const rawType = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : typeof cfg.transport === 'string' ? cfg.transport.toLowerCase() : '';
        let transport: McpTransport;
        if (commandRaw && rawType !== 'http' && rawType !== 'sse') {
          transport = 'stdio';
        } else if (rawType === 'sse' || (remoteUrlRaw && /\/sse\/?(?:\?|$)/i.test(remoteUrlRaw))) {
          transport = 'sse';
        } else {
          transport = 'http';
        }

        const args = Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [];
        const envEntries: SecretKeyValueInput[] = [];
        if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
          for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
            if (typeof v === 'string') envEntries.push({ name: k, value: v });
          }
        }

        const headerEntries: SecretKeyValueInput[] = [];
        if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
          for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
            if (typeof v === 'string') headerEntries.push({ name: k, value: v });
          }
        }

        let authType: McpAuthType = 'none';
        let oauthConfig: McpOAuthConfigInput | null = null;
        if (transport !== 'stdio') {
          if (cfg.oauth && typeof cfg.oauth === 'object' && !Array.isArray(cfg.oauth)) {
            const o = cfg.oauth as Record<string, unknown>;
            authType = 'oauth';
            oauthConfig = {
              clientId: typeof o.clientId === 'string' ? o.clientId : typeof o.client_id === 'string' ? o.client_id : null,
              clientSecret:
                typeof o.clientSecret === 'string' ? o.clientSecret : typeof o.client_secret === 'string' ? o.client_secret : null,
              authorizationUrl:
                typeof o.authorizationUrl === 'string'
                  ? o.authorizationUrl
                  : typeof o.authorization_url === 'string'
                    ? o.authorization_url
                    : null,
              tokenUrl:
                typeof o.tokenUrl === 'string' ? o.tokenUrl : typeof o.token_url === 'string' ? o.token_url : null,
              scopes:
                typeof o.scopes === 'string'
                  ? o.scopes
                  : Array.isArray(o.scopes)
                    ? o.scopes.filter((s): s is string => typeof s === 'string').join(' ')
                    : null,
            };
          } else if (headerEntries.length > 0) {
            const authHeader = headerEntries.find((h) => h.name.toLowerCase() === 'authorization');
            if (authHeader && /^bearer\s+/i.test(authHeader.value ?? '')) {
              authType = 'bearer';
            } else if (headerEntries.length === 1 && /api[-_]?key/i.test(headerEntries[0].name)) {
              authType = 'api_key';
            } else {
              authType = 'headers';
            }
          }
        }

        const rawAllowedTools = Array.isArray(cfg.enabledTools)
          ? cfg.enabledTools
          : Array.isArray(cfg.allowedTools)
            ? cfg.allowedTools
            : undefined;
        const allowedTools =
          rawAllowedTools !== undefined
            ? normalizeAllowedToolsList(rawAllowedTools, (msg) => {
                throw new McpValidationError('INVALID_ALLOWED_TOOLS', msg);
              })
            : undefined;

        const existing = this.db.findMcpServerByScopeAndName(params.scope, ownerUserId, name);
        if (existing) {
          if (!params.overwrite) {
            skipped.push(name);
            duplicateSkipped.push(name);
            continue;
          }
          const updated = this.updateServer(adminUserId, existing.id, {
            description: typeof cfg.description === 'string' ? cfg.description : existing.description,
            transport,
            enabled: typeof cfg.disabled === 'boolean' ? !cfg.disabled : existing.enabled,
            ...(allowedTools !== undefined ? { allowedTools } : {}),
            command: commandRaw,
            args,
            env: envEntries,
            url: remoteUrlRaw,
            authType,
            headers: headerEntries,
            oauthConfig,
          });
          imported.push(updated);
        } else {
          const created = this.createServer(adminUserId, {
            name,
            description: typeof cfg.description === 'string' ? cfg.description : '',
            scope: params.scope,
            transport,
            enabled: typeof cfg.disabled === 'boolean' ? !cfg.disabled : true,
            ...(allowedTools !== undefined ? { allowedTools } : {}),
            command: commandRaw,
            args,
            env: envEntries,
            url: remoteUrlRaw,
            authType,
            headers: headerEntries,
            oauthConfig,
          });
          imported.push(created);
        }
      } catch (err) {
        skipped.push(rawName);
        const reason = err instanceof Error ? err.message : '設定が不正です';
        invalidEntries.push(`${rawName}（${reason}）`);
      }
    }

    if (imported.length === 0) {
      if (invalidEntries.length > 0) {
        const dupHint =
          duplicateSkipped.length > 0
            ? ` また、既存の同名サーバー（${duplicateSkipped.join(', ')}）を上書きする場合は「上書き」を有効にしてください。`
            : '';
        throw new McpValidationError(
          'INVALID_IMPORT_ENTRIES',
          `インポートできない不正な項目があります: ${invalidEntries.join(' / ')}。${dupHint}`
        );
      }
      if (duplicateSkipped.length > 0) {
        throw new McpValidationError(
          'NOTHING_IMPORTED',
          `インポートされたサーバーがありませんでした（既存の同名サーバー: ${duplicateSkipped.join(', ')}）。上書きする場合は「上書き」を有効にしてください。`
        );
      }
    }

    return { imported, skipped };
  }

  // ---- OAuth 2.0 / 2.1 Discovery, DCR, PKCE Flow & Refresh ----

  async discoverOAuthMetadata(mcpUrl: string): Promise<DiscoveredOAuthMetadata> {
    const urlOpts = { allowPrivate: this.config.allowPrivateMcpUrls };
    const safeMcpUrl = validateRemoteUrl(mcpUrl, 'リモートMCP URL', urlOpts);
    const parsedUrl = new URL(safeMcpUrl);
    const origin = parsedUrl.origin;
    const pathSuffix = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname.replace(/\/+$/, '');

    let resourceMetadataUrl: string | null = null;
    let authorizationUrl: string | null = null;
    let tokenUrl: string | null = null;
    let registrationUrl: string | null = null;
    let clientIdMetadataDocumentSupported = false;
    let scopes: string[] = [];
    let resource: string | null = safeMcpUrl;
    const authServerIssuers: string[] = [];

    const addUniqueCandidate = (list: string[], rawCandidate: string | null | undefined) => {
      const valid = tryValidateRemoteUrl(rawCandidate, urlOpts);
      if (valid && !list.includes(valid)) {
        list.push(valid);
      }
    };

    const inspectMetadataJson = (json: Record<string, unknown> | null) => {
      if (!json) return;
      const servers = json.authorization_servers;
      if (Array.isArray(servers)) {
        for (const s of servers) {
          if (typeof s === 'string') addUniqueCandidate(authServerIssuers, s);
        }
      }
      if (typeof json.authorization_endpoint === 'string' && !authorizationUrl) {
        authorizationUrl = tryValidateRemoteUrl(json.authorization_endpoint, urlOpts);
      }
      if (typeof json.token_endpoint === 'string' && !tokenUrl) {
        tokenUrl = tryValidateRemoteUrl(json.token_endpoint, urlOpts);
      }
      if (typeof json.registration_endpoint === 'string' && !registrationUrl) {
        registrationUrl = tryValidateRemoteUrl(json.registration_endpoint, urlOpts);
      }
      if (json.client_id_metadata_document_supported === true) {
        clientIdMetadataDocumentSupported = true;
      }
      if (scopes.length === 0 && Array.isArray(json.scopes_supported)) {
        scopes = json.scopes_supported.filter((s): s is string => typeof s === 'string');
      }
      if (typeof json.resource === 'string') {
        const validResource = tryValidateRemoteUrl(json.resource, urlOpts);
        if (validResource) resource = validResource;
      }
    };

    // 1) Probe MCP URL for WWW-Authenticate resource_metadata / scope header (RFC 9728)
    try {
      const probe = await fetchJsonWithTimeout(
        safeMcpUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
            },
          }),
        },
        urlOpts
      );
      if (probe.status === 401 || probe.status === 403) {
        const wwwAuth = probe.headers.get('www-authenticate');
        resourceMetadataUrl = extractResourceMetadataUrlFromWwwAuthenticate(wwwAuth);
        const headerScopes = extractScopesFromWwwAuthenticate(wwwAuth);
        if (headerScopes.length > 0 && scopes.length === 0) {
          scopes = headerScopes;
        }
        inspectMetadataJson(probe.json);
      }
    } catch {
      // Fall through to GET probe and well-known probes
    }

    if (!resourceMetadataUrl && (!authorizationUrl || !tokenUrl)) {
      try {
        const getProbe = await fetchJsonWithTimeout(
          safeMcpUrl,
          {
            method: 'GET',
            headers: { Accept: 'application/json, text/event-stream' },
          },
          { ...urlOpts, headersOnly: true }
        );
        if (getProbe.status === 401 || getProbe.status === 403) {
          const wwwAuth = getProbe.headers.get('www-authenticate');
          resourceMetadataUrl = extractResourceMetadataUrlFromWwwAuthenticate(wwwAuth);
          const headerScopes = extractScopesFromWwwAuthenticate(wwwAuth);
          if (headerScopes.length > 0 && scopes.length === 0) {
            scopes = headerScopes;
          }
        }
      } catch {
        // ignore
      }
    }

    const prmCandidates: string[] = [];
    if (resourceMetadataUrl) {
      try {
        addUniqueCandidate(prmCandidates, new URL(resourceMetadataUrl, safeMcpUrl).toString());
      } catch {
        // ignore invalid URL
      }
    }
    if (pathSuffix) {
      addUniqueCandidate(prmCandidates, `${origin}/.well-known/oauth-protected-resource${pathSuffix}`);
      addUniqueCandidate(prmCandidates, `${origin}${pathSuffix}/.well-known/oauth-protected-resource`);
    }
    addUniqueCandidate(prmCandidates, `${origin}/.well-known/oauth-protected-resource`);

    for (const candidate of prmCandidates) {
      try {
        const res = await fetchJsonWithTimeout(
          candidate,
          { method: 'GET', headers: { Accept: 'application/json' } },
          urlOpts
        );
        if (res.status >= 200 && res.status < 300 && res.json) {
          inspectMetadataJson(res.json);
          if (authServerIssuers.length > 0 || (authorizationUrl && tokenUrl)) break;
        }
      } catch {
        // try next candidate
      }
    }

    const issuerBases: string[] = [...authServerIssuers];
    if (pathSuffix) {
      addUniqueCandidate(issuerBases, `${origin}${pathSuffix}`);
    }
    addUniqueCandidate(issuerBases, origin);

    const asCandidates: string[] = [];
    for (const rawIssuer of issuerBases) {
      const issuerBase = rawIssuer.replace(/\/+$/, '');
      const issuerUrl = new URL(issuerBase);
      const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/+$/, '');
      if (issuerPath) {
        addUniqueCandidate(asCandidates, `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`);
        addUniqueCandidate(asCandidates, `${issuerBase}/.well-known/oauth-authorization-server`);
        addUniqueCandidate(asCandidates, `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`);
        addUniqueCandidate(asCandidates, `${issuerBase}/.well-known/openid-configuration`);
      }
      addUniqueCandidate(asCandidates, `${issuerUrl.origin}/.well-known/oauth-authorization-server`);
      addUniqueCandidate(asCandidates, `${issuerUrl.origin}/.well-known/openid-configuration`);
    }

    for (const candidate of asCandidates) {
      if (authorizationUrl && tokenUrl) break;
      try {
        const res = await fetchJsonWithTimeout(
          candidate,
          { method: 'GET', headers: { Accept: 'application/json' } },
          urlOpts
        );
        if (res.status >= 200 && res.status < 300 && res.json) {
          inspectMetadataJson(res.json);
          if (authorizationUrl && tokenUrl) break;
        }
      } catch {
        // try next candidate
      }
    }

    return {
      authorizationUrl,
      tokenUrl,
      registrationUrl,
      scopes,
      resource,
      clientIdMetadataDocumentSupported,
    };
  }

  private pruneExpiredOAuthFlows(): void {
    const now = Date.now();
    for (const [state, flow] of this.pendingOAuthFlows.entries()) {
      if (flow.expiresAt <= now) {
        this.pendingOAuthFlows.delete(state);
      }
    }
  }

  async startOAuthFlow(
    adminUserId: string,
    serverId: string,
    origin: string
  ): Promise<{
    authorizationUrl: string;
    launchUrl: string;
    redirectUri: string;
    state: string;
    mode: 'callback' | 'code_paste';
  }> {
    this.pruneExpiredOAuthFlows();
    const row = this.db.getMcpServerById(serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, row);
    if (row.transport === 'stdio' || !row.url) {
      throw new McpValidationError('OAUTH_UNSUPPORTED', 'OAuth認証はリモートMCPサーバーのみ利用できます。');
    }
    if (row.authType !== 'oauth') {
      throw new McpValidationError('OAUTH_NOT_ENABLED', '認証方式を OAuth に設定してから認証を開始してください。');
    }

    const urlOpts = { allowPrivate: this.config.allowPrivateMcpUrls };
    const defaultRedirectUri = `${origin.replace(/\/+$/, '')}/api/mcp/oauth/callback`;
    const existingCfg = parseJsonObject<McpOAuthConfig>(row.oauthConfigJson) ?? {};
    let authorizationUrl = existingCfg.authorizationUrl ?? null;
    let tokenUrl = existingCfg.tokenUrl ?? null;
    let registrationUrl = existingCfg.registrationUrl ?? null;
    let scopes = existingCfg.scopes ?? null;
    let resource = existingCfg.resource ?? row.url;
    let clientId = existingCfg.clientId ?? null;
    let clientSecret = this.decryptClientSecret(row.encryptedOauthClientSecret);
    let cimdSupported = false;

    if (!authorizationUrl || !tokenUrl || (!clientId && !registrationUrl)) {
      const discovered = await this.discoverOAuthMetadata(row.url);
      authorizationUrl = authorizationUrl || discovered.authorizationUrl;
      tokenUrl = tokenUrl || discovered.tokenUrl;
      registrationUrl = registrationUrl || discovered.registrationUrl;
      cimdSupported = Boolean(discovered.clientIdMetadataDocumentSupported);
      if (!scopes && discovered.scopes.length > 0) {
        scopes = discovered.scopes.join(' ');
      }
      if (!existingCfg.resource && discovered.resource) {
        resource = discovered.resource;
      }
    }

    if (!authorizationUrl || !tokenUrl) {
      throw new McpValidationError(
        'OAUTH_DISCOVERY_FAILED',
        'OAuthエンドポイントを自動検出できませんでした。詳細設定で Authorization URL と Token URL を手動入力してください。'
      );
    }

    authorizationUrl = validateRemoteUrl(authorizationUrl, 'Authorization URL', urlOpts);
    tokenUrl = validateRemoteUrl(tokenUrl, 'Token URL', urlOpts);
    if (registrationUrl) {
      registrationUrl = validateRemoteUrl(registrationUrl, 'Registration URL', urlOpts);
    }

    let redirectUri =
      clientId === ANTIGRAVITY_CIMD_CLIENT_ID ? ANTIGRAVITY_CIMD_REDIRECT_URI : defaultRedirectUri;

    // Dynamic Client Registration (RFC 7591) when clientId is not configured
    if (!clientId && registrationUrl) {
      try {
        const dcrRes = await fetchJsonWithTimeout(
          registrationUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              client_name: 'AGY-ChatUI',
              redirect_uris: [defaultRedirectUri],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            }),
          },
          urlOpts
        );
        if (dcrRes.status >= 200 && dcrRes.status < 300 && dcrRes.json && typeof dcrRes.json.client_id === 'string') {
          clientId = dcrRes.json.client_id;
          redirectUri = defaultRedirectUri;
          if (typeof dcrRes.json.client_secret === 'string' && dcrRes.json.client_secret.trim()) {
            clientSecret = dcrRes.json.client_secret.trim();
          }
        } else if (cimdSupported) {
          clientId = ANTIGRAVITY_CIMD_CLIENT_ID;
          redirectUri = ANTIGRAVITY_CIMD_REDIRECT_URI;
        } else {
          throw new McpValidationError(
            'OAUTH_DCR_FAILED',
            `動的クライアント登録（DCR）に失敗しました (HTTP ${dcrRes.status})。詳細設定で Client ID を手動入力してください。`
          );
        }
      } catch (err) {
        if (cimdSupported) {
          clientId = ANTIGRAVITY_CIMD_CLIENT_ID;
          redirectUri = ANTIGRAVITY_CIMD_REDIRECT_URI;
        } else {
          throw err;
        }
      }
    }

    // Native Antigravity CIMD fallback when server supports Client ID Metadata Documents without DCR
    if (!clientId && cimdSupported) {
      clientId = ANTIGRAVITY_CIMD_CLIENT_ID;
      redirectUri = ANTIGRAVITY_CIMD_REDIRECT_URI;
    }

    if (!clientId) {
      throw new McpValidationError(
        'OAUTH_CLIENT_ID_REQUIRED',
        'このMCPサーバーは動的クライアント登録に対応していないため、詳細設定で Client ID を入力してください。'
      );
    }

    // Persist discovered/registered endpoints and clientId
    const updatedCfg: McpOAuthConfig = {
      ...existingCfg,
      clientId,
      authorizationUrl,
      tokenUrl,
      registrationUrl,
      scopes,
      resource,
    };
    this.db.updateMcpServer(row.id, {
      oauthConfigJson: JSON.stringify(updatedCfg),
      encryptedOauthClientSecret: clientSecret
        ? encryptSmallSecret(clientSecret, this.config.sessionSecret)
        : row.encryptedOauthClientSecret,
      oauthError: null,
    });

    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');

    const authUrl = new URL(authorizationUrl);
    if (existingCfg.extraAuthParams) {
      for (const [k, v] of Object.entries(existingCfg.extraAuthParams)) {
        if (McpService.RESERVED_OAUTH_PARAMS.has(k.toLowerCase())) continue;
        authUrl.searchParams.set(k, v);
      }
    }
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (scopes) {
      authUrl.searchParams.set('scope', scopes);
    }
    if (resource) {
      authUrl.searchParams.set('resource', resource);
    }

    const fullAuthorizationUrl = authUrl.toString();
    const now = Date.now();
    this.pendingOAuthFlows.set(state, {
      state,
      serverId: row.id,
      adminUserId,
      authorizationUrl: fullAuthorizationUrl,
      codeVerifier,
      redirectUri,
      tokenUrl,
      clientId,
      clientSecret,
      resource,
      createdAt: now,
      expiresAt: now + OAUTH_FLOW_TTL_MS,
    });

    return {
      authorizationUrl: fullAuthorizationUrl,
      launchUrl: `${origin.replace(/\/+$/, '')}/api/mcp/oauth/launch?state=${encodeURIComponent(state)}`,
      redirectUri,
      state,
      mode: redirectUri === ANTIGRAVITY_CIMD_REDIRECT_URI ? 'code_paste' : 'callback',
    };
  }

  resolvePendingOAuthLaunchUrl(adminUserId: string, state: string | undefined | null): string {
    this.pruneExpiredOAuthFlows();
    const trimmed = state?.trim() ?? '';
    if (!trimmed) {
      throw new McpValidationError('OAUTH_INVALID_STATE', 'OAuth state パラメータが不足しています。');
    }
    const flow = this.pendingOAuthFlows.get(trimmed);
    if (!flow) {
      throw new McpValidationError(
        'OAUTH_STATE_EXPIRED',
        'OAuth 認証セッションが見つからないか期限切れです。もう一度開始してください。'
      );
    }
    if (flow.adminUserId !== adminUserId) {
      throw new McpValidationError('FORBIDDEN', 'このOAuth認証セッションを開始する権限がありません。', 403);
    }
    return flow.authorizationUrl;
  }

  async completeOAuthManualInput(
    adminUserId: string,
    serverId: string,
    params: { codeOrUrl: string; state?: string | null }
  ): Promise<{ server: McpServerRecord }> {
    this.pruneExpiredOAuthFlows();
    const raw = params.codeOrUrl.trim();
    if (!raw) {
      throw new McpValidationError('OAUTH_CODE_MISSING', '認可コードまたはコールバックURLを入力してください。');
    }

    let code = raw;
    let extractedState = params.state?.trim() || '';
    let error: string | undefined;
    let errorDescription: string | undefined;

    if (/^https?:\/\//i.test(raw) || (raw.includes('code=') && (raw.includes('?') || raw.includes('&')))) {
      try {
        const parsed = /^https?:\/\//i.test(raw)
          ? new URL(raw)
          : new URL(raw.startsWith('?') ? `http://localhost/${raw}` : `http://localhost/?${raw}`);
        const qCode = parsed.searchParams.get('code');
        const qState = parsed.searchParams.get('state');
        const qErr = parsed.searchParams.get('error');
        const qErrDesc = parsed.searchParams.get('error_description');
        if (qCode) code = qCode.trim();
        if (qState) extractedState = qState.trim();
        if (qErr) error = qErr.trim();
        if (qErrDesc) errorDescription = qErrDesc.trim();
      } catch {
        // Treat as raw code if URL parsing fails
      }
    }

    let targetState = extractedState;
    const explicitFlow = targetState ? this.pendingOAuthFlows.get(targetState) : undefined;
    if (explicitFlow && explicitFlow.serverId !== serverId) {
      throw new McpValidationError(
        'OAUTH_INVALID_STATE',
        '指定されたOAuth stateは別のMCPサーバーの認証セッションに属しています。'
      );
    }

    if (!explicitFlow) {
      // Find the most recent pending flow for this (adminUserId, serverId)
      let latestFlow: PendingOAuthFlow | null = null;
      for (const flow of this.pendingOAuthFlows.values()) {
        if (flow.adminUserId === adminUserId && flow.serverId === serverId) {
          if (!latestFlow || flow.createdAt >= latestFlow.createdAt) {
            latestFlow = flow;
          }
        }
      }
      if (latestFlow) {
        targetState = latestFlow.state;
      }
    }

    const matchedFlow = targetState ? this.pendingOAuthFlows.get(targetState) : undefined;
    if (matchedFlow && matchedFlow.serverId !== serverId) {
      throw new McpValidationError(
        'OAUTH_INVALID_STATE',
        '指定されたOAuth stateは別のMCPサーバーの認証セッションに属しています。'
      );
    }

    return this.completeOAuthCallback(adminUserId, {
      code,
      state: targetState,
      error,
      errorDescription,
    });
  }

  async completeOAuthCallback(
    adminUserId: string,
    params: { code?: string; state?: string; error?: string; errorDescription?: string }
  ): Promise<{ server: McpServerRecord }> {
    this.pruneExpiredOAuthFlows();
    const state = params.state?.trim() ?? '';
    if (!state) {
      throw new McpValidationError('OAUTH_INVALID_STATE', 'OAuth state パラメータが不足しています。');
    }
    const flow = this.pendingOAuthFlows.get(state);
    if (!flow) {
      throw new McpValidationError('OAUTH_STATE_EXPIRED', 'OAuth 認証セッションが見つからないか期限切れです。もう一度開始してください。');
    }
    if (flow.adminUserId !== adminUserId) {
      throw new McpValidationError('FORBIDDEN', 'このOAuth認証セッションを完了する権限がありません。', 403);
    }
    this.pendingOAuthFlows.delete(state);

    const row = this.db.getMcpServerById(flow.serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '対象のMCPサーバーが見つかりません。', 404);
    }

    if (params.error) {
      const msg = params.errorDescription ? `${params.error}: ${params.errorDescription}` : params.error;
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'error',
        oauthError: msg,
        oauthUpdatedAt: Date.now(),
      });
      this.emitUpdated(row.scope, row.ownerUserId, row.id);
      throw new McpValidationError('OAUTH_PROVIDER_ERROR', `OAuth認証が拒否されました: ${msg}`);
    }

    const code = params.code?.trim() ?? '';
    if (!code) {
      throw new McpValidationError('OAUTH_CODE_MISSING', '認可コードが返却されませんでした。');
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', flow.redirectUri);
    body.set('client_id', flow.clientId);
    body.set('code_verifier', flow.codeVerifier);
    if (flow.clientSecret) {
      body.set('client_secret', flow.clientSecret);
    }
    if (flow.resource) {
      body.set('resource', flow.resource);
    }

    const tokenHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const tokenRes = await fetchJsonWithTimeout(
      flow.tokenUrl,
      {
        method: 'POST',
        headers: tokenHeaders,
        body: body.toString(),
      },
      { allowPrivate: this.config.allowPrivateMcpUrls }
    );

    if (tokenRes.status < 200 || tokenRes.status >= 300 || !tokenRes.json || typeof tokenRes.json.access_token !== 'string') {
      const detail =
        (tokenRes.json && typeof tokenRes.json.error_description === 'string' && tokenRes.json.error_description) ||
        (tokenRes.json && typeof tokenRes.json.error === 'string' && tokenRes.json.error) ||
        `HTTP ${tokenRes.status}`;
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'error',
        oauthError: `トークン取得に失敗しました: ${detail}`,
        oauthUpdatedAt: Date.now(),
      });
      this.emitUpdated(row.scope, row.ownerUserId, row.id);
      throw new McpValidationError('OAUTH_TOKEN_EXCHANGE_FAILED', `OAuthトークン取得に失敗しました: ${detail}`);
    }

    const expiresInRaw = Number(tokenRes.json.expires_in);
    const expiresAt = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Date.now() + expiresInRaw * 1000 : null;
    const tokens: StoredOAuthTokens = {
      accessToken: tokenRes.json.access_token,
      refreshToken: typeof tokenRes.json.refresh_token === 'string' ? tokenRes.json.refresh_token : null,
      tokenType: typeof tokenRes.json.token_type === 'string' ? tokenRes.json.token_type : 'Bearer',
      expiresAt,
      scope: typeof tokenRes.json.scope === 'string' ? tokenRes.json.scope : null,
    };

    const updated = this.db.updateMcpServer(row.id, {
      encryptedOauthTokensJson: this.encryptTokens(tokens),
      oauthStatus: 'connected',
      oauthError: null,
      oauthUpdatedAt: Date.now(),
    });

    if (!updated) {
      throw new McpValidationError('MCP_NOT_FOUND', '対象のMCPサーバーが見つかりません。', 404);
    }

    this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
    return { server: this.toPublicRecord(updated) };
  }

  disconnectOAuth(adminUserId: string, serverId: string): McpServerRecord {
    const existing = this.db.getMcpServerById(serverId);
    if (!existing) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, existing);

    const updated = this.db.updateMcpServer(existing.id, {
      encryptedOauthTokensJson: null,
      oauthStatus: 'disconnected',
      oauthError: null,
      oauthUpdatedAt: Date.now(),
    })!;

    this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
    return this.toPublicRecord(updated);
  }

  private async ensureFreshOAuthAccessToken(row: StoredMcpServerRow): Promise<string | null> {
    const existingRefresh = this.inFlightOAuthRefreshes.get(row.id);
    if (existingRefresh) {
      return existingRefresh;
    }

    const latestRow = this.db.getMcpServerById(row.id) ?? row;
    const tokens = this.decryptTokens(latestRow.encryptedOauthTokensJson);
    if (!tokens) return null;

    const isExpiring = Boolean(tokens.expiresAt && tokens.expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS);
    if (!isExpiring) {
      return tokens.accessToken;
    }

    const refreshPromise = this.performOAuthTokenRefresh(latestRow, tokens).finally(() => {
      if (this.inFlightOAuthRefreshes.get(row.id) === refreshPromise) {
        this.inFlightOAuthRefreshes.delete(row.id);
      }
    });
    this.inFlightOAuthRefreshes.set(row.id, refreshPromise);
    return refreshPromise;
  }

  private async performOAuthTokenRefresh(
    row: StoredMcpServerRow,
    tokens: StoredOAuthTokens
  ): Promise<string | null> {
    const cfg = parseJsonObject<McpOAuthConfig>(row.oauthConfigJson);
    if (!tokens.refreshToken || !cfg?.tokenUrl || !cfg?.clientId) {
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'expired',
        oauthError: 'OAuthアクセストークンの有効期限が切れました。再認証してください。',
        oauthUpdatedAt: Date.now(),
      });
      return null;
    }

    try {
      const body = new URLSearchParams();
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', tokens.refreshToken);
      body.set('client_id', cfg.clientId);
      const clientSecret = this.decryptClientSecret(row.encryptedOauthClientSecret);
      if (clientSecret) {
        body.set('client_secret', clientSecret);
      }
      if (cfg.resource) {
        body.set('resource', cfg.resource);
      }

      const res = await fetchJsonWithTimeout(
        cfg.tokenUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        },
        { allowPrivate: this.config.allowPrivateMcpUrls }
      );

      if (res.status < 200 || res.status >= 300 || !res.json || typeof res.json.access_token !== 'string') {
        const detail =
          (res.json && typeof res.json.error_description === 'string' && res.json.error_description) ||
          (res.json && typeof res.json.error === 'string' && res.json.error) ||
          `HTTP ${res.status}`;
        this.db.updateMcpServer(row.id, {
          oauthStatus: 'expired',
          oauthError: `トークン更新に失敗しました: ${detail}`,
          oauthUpdatedAt: Date.now(),
        });
        return null;
      }

      const expiresInRaw = Number(res.json.expires_in);
      const nextTokens: StoredOAuthTokens = {
        accessToken: res.json.access_token,
        refreshToken:
          typeof res.json.refresh_token === 'string' && res.json.refresh_token
            ? res.json.refresh_token
            : tokens.refreshToken,
        tokenType: typeof res.json.token_type === 'string' ? res.json.token_type : tokens.tokenType ?? 'Bearer',
        expiresAt: Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? Date.now() + expiresInRaw * 1000 : null,
        scope: typeof res.json.scope === 'string' ? res.json.scope : tokens.scope ?? null,
      };

      this.db.updateMcpServer(row.id, {
        encryptedOauthTokensJson: this.encryptTokens(nextTokens),
        oauthStatus: 'connected',
        oauthError: null,
        oauthUpdatedAt: Date.now(),
      });
      return nextTokens.accessToken;
    } catch (err) {
      this.db.updateMcpServer(row.id, {
        oauthStatus: 'error',
        oauthError: err instanceof Error ? err.message : 'トークン更新に失敗しました。',
        oauthUpdatedAt: Date.now(),
      });
      return null;
    }
  }

  // ---- Connection Test ----

  private async probeStdioMcpInitialize(
    resolvedCmd: string,
    args: string[],
    env: Record<string, string>
  ): Promise<McpTestResult> {
    return new Promise((resolve) => {
      let settled = false;
      let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let toolsProbeTimer: ReturnType<typeof setTimeout> | null = null;
      let initSuccessResult: McpTestResult | null = null;
      let toolsProbeSent = false;
      let stdoutBuf = '';
      let stderrBuf = '';

      const useProcessGroup = process.platform !== 'win32';
      const child = spawn(resolvedCmd, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: useProcessGroup,
      });

      const signalChild = (sig: NodeJS.Signals) => {
        if (exited) return;
        if (useProcessGroup && child.pid) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            // fallback to direct child kill
          }
        }
        try {
          child.kill(sig);
        } catch {
          // ignore
        }
      };

      const finish = (result: McpTestResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (toolsProbeTimer) {
          clearTimeout(toolsProbeTimer);
          toolsProbeTimer = null;
        }
        try {
          child.stdin?.end();
        } catch {
          // ignore
        }
        if (!exited) {
          signalChild('SIGTERM');
          killTimer = setTimeout(() => {
            killTimer = null;
            signalChild('SIGKILL');
          }, 1500);
          killTimer.unref?.();
        }
        resolve(result);
      };

      const handleRpcObject = (rawObj: unknown): void => {
        if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) return;
        const msg = rawObj as Record<string, unknown>;
        if (msg.jsonrpc !== '2.0') return;

        if (msg.id === 1 && !initSuccessResult) {
          if (msg.error && typeof msg.error === 'object') {
            const errObj = msg.error as Record<string, unknown>;
            const errMsg = typeof errObj.message === 'string' ? errObj.message : 'MCP initialize エラー';
            finish({
              ok: false,
              status: 'error',
              message: `stdio MCP サーバーが初期化エラーを返しました: ${errMsg}`,
              resolvedCommand: resolvedCmd,
            });
            return;
          }
          if (msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)) {
            const resultObj = msg.result as Record<string, unknown>;
            const serverInfoObj =
              resultObj.serverInfo && typeof resultObj.serverInfo === 'object' && !Array.isArray(resultObj.serverInfo)
                ? (resultObj.serverInfo as Record<string, unknown>)
                : null;
            const serverInfo = serverInfoObj
              ? {
                  name: typeof serverInfoObj.name === 'string' ? serverInfoObj.name : undefined,
                  version: typeof serverInfoObj.version === 'string' ? serverInfoObj.version : undefined,
                }
              : undefined;
            initSuccessResult = {
              ok: true,
              status: 'connected',
              message: serverInfo?.name
                ? `stdio MCP 接続成功: ${serverInfo.name}${serverInfo.version ? ` v${serverInfo.version}` : ''} (${resolvedCmd})`
                : `stdio MCP サーバーの初期化を確認しました (${resolvedCmd})`,
              resolvedCommand: resolvedCmd,
              serverInfo,
            };
            if (exited) {
              finish(initSuccessResult);
              return;
            }
            if (!toolsProbeSent) {
              toolsProbeSent = true;
              try {
                child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
                child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
              } catch {
                finish(initSuccessResult);
                return;
              }
              toolsProbeTimer = setTimeout(() => {
                if (initSuccessResult) finish(initSuccessResult);
              }, 1_200);
              toolsProbeTimer.unref?.();
            }
          }
          return;
        }

        if (msg.id === 2 && initSuccessResult) {
          if (msg.error) {
            finish(initSuccessResult);
            return;
          }
          const tools = extractMcpToolsFromJsonRpcPayload(msg);
          finish({
            ...initSuccessResult,
            ...(tools.length > 0 ? { tools } : {}),
          });
        }
      };

      const inspectStdout = () => {
        // 1) Support LSP-style Content-Length framed JSON-RPC
        while (stdoutBuf.length > 0) {
          const clMatch = /Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(stdoutBuf);
          if (!clMatch) break;
          const len = Number.parseInt(clMatch[1], 10);
          const bodyStart = clMatch.index + clMatch[0].length;
          const restBuf = Buffer.from(stdoutBuf.slice(bodyStart), 'utf8');
          if (restBuf.byteLength < len) break;
          const payload = restBuf.subarray(0, len).toString('utf8');
          stdoutBuf = restBuf.subarray(len).toString('utf8');
          try {
            handleRpcObject(JSON.parse(payload));
          } catch {
            // ignore non-JSON payload
          }
          if (settled) return;
        }
        // 2) Support newline-delimited JSON-RPC (standard MCP stdio)
        const lines = stdoutBuf.split(/\r?\n/);
        const lastIdx = stdoutBuf.endsWith('\n') ? lines.length : lines.length - 1;
        for (let i = 0; i < lastIdx; i += 1) {
          const trimmed = lines[i].trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            handleRpcObject(JSON.parse(trimmed));
          } catch {
            // incomplete or non-JSON line
          }
          if (settled) return;
        }
        stdoutBuf = lastIdx < lines.length ? lines[lastIdx] : '';
      };

      const timer = setTimeout(() => {
        if (initSuccessResult) {
          finish(initSuccessResult);
          return;
        }
        const stderrHint = stderrBuf.trim().slice(0, 200);
        finish({
          ok: false,
          status: 'error',
          message: stderrHint
            ? `stdio MCP の初期化応答がタイムアウトしました (${resolvedCmd}): ${stderrHint}`
            : `stdio MCP の初期化応答がタイムアウトしました (${resolvedCmd})。MCP サーバーとして起動しているか確認してください。`,
          resolvedCommand: resolvedCmd,
        });
      }, 5_000);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBuf.length < 256_000) {
          stdoutBuf += chunk.toString('utf8');
        }
        inspectStdout();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBuf.length < 4_000) {
          stderrBuf += chunk.toString('utf8');
        }
      });

      child.on('error', (err) => {
        exited = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        finish({
          ok: false,
          status: 'error',
          message: `stdio MCP プロセスの起動に失敗しました: ${err.message}`,
          resolvedCommand: resolvedCmd,
        });
      });

      child.on('exit', (code, signal) => {
        exited = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (stdoutBuf.trim()) {
          stdoutBuf = `${stdoutBuf}\n`;
          inspectStdout();
        }
        if (initSuccessResult && !settled) {
          finish(initSuccessResult);
          return;
        }
        if (!settled) {
          const stderrHint = stderrBuf.trim().slice(0, 200);
          finish({
            ok: false,
            status: 'error',
            message: stderrHint
              ? `stdio MCP プロセスが初期化応答を返さず終了しました (code=${code ?? 'null'}, signal=${signal ?? 'none'}): ${stderrHint}`
              : `stdio MCP プロセスが初期化応答を返さず終了しました (code=${code ?? 'null'}, signal=${signal ?? 'none'})。`,
            resolvedCommand: resolvedCmd,
          });
        }
      });

      const initPayload = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
        },
      })}\n`;
      try {
        child.stdin?.write(initPayload);
      } catch {
        // exit/error handler will settle
      }
    });
  }

  private async probeSseMcpInitializeAndTools(
    sseUrl: string,
    headers: Record<string, string>,
    urlOpts: { allowPrivate?: boolean }
  ): Promise<McpTestResult> {
    const target = await resolvePinnedOutboundTarget(sseUrl, urlOpts);
    const isHttps = target.parsed.protocol === 'https:';
    const pinnedLookup = createPinnedLookup(target);
    const reqHeaders: Record<string, string> = {
      Accept: 'text/event-stream',
      ...headers,
    };

    return new Promise((resolve) => {
      let settled = false;
      let sseHeadersOk = false;
      let endpointPath: string | null = null;
      let discoveredServerInfo: { name?: string; version?: string } | undefined;
      let discoveredTools: McpDiscoveredTool[] | undefined;
      let probeStarted = false;
      let lineBuf = '';
      let eventName = '';
      let dataLines: string[] = [];

      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      let headerFallbackTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: McpTestResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        clearTimeout(probeTimer);
        clearTimeout(headerFallbackTimer);
        try {
          req.destroy();
        } catch {
          // ignore
        }
        resolve(result);
      };

      const overallTimer = setTimeout(() => {
        if (sseHeadersOk || endpointPath) {
          finish({
            ok: true,
            status: 'connected',
            message: discoveredServerInfo?.name
              ? `接続成功: ${discoveredServerInfo.name}${discoveredServerInfo.version ? ` v${discoveredServerInfo.version}` : ''}`
              : 'SSEエンドポイントへの接続を確認しました',
            ...(discoveredServerInfo ? { serverInfo: discoveredServerInfo } : {}),
            ...(discoveredTools ? { tools: discoveredTools } : {}),
          });
        } else {
          finish({
            ok: false,
            status: 'error',
            message: 'SSEエンドポイントへの接続がタイムアウトしました。',
          });
        }
      }, 3_500);

      const sendPostProbe = async (postUrl: string) => {
        try {
          await fetchJsonWithTimeout(
            postUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                  protocolVersion: '2025-03-26',
                  capabilities: {},
                  clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
                },
              }),
            },
            { ...urlOpts, timeoutMs: 1_500 }
          ).catch(() => null);

          await fetchJsonWithTimeout(
            postUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
            },
            { ...urlOpts, timeoutMs: 1_000 }
          ).catch(() => null);

          await fetchJsonWithTimeout(
            postUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
            },
            { ...urlOpts, timeoutMs: 1_500 }
          ).catch(() => null);
        } catch {
          // ignore best-effort tool discovery error
        }
      };

      const handleEventBlock = () => {
        if (!eventName && dataLines.length === 0) return;
        const dataStr = dataLines.join('\n').trim();
        const curEvent = eventName;
        eventName = '';
        dataLines = [];

        if (curEvent === 'endpoint' && dataStr && !endpointPath) {
          endpointPath = dataStr;
          clearTimeout(headerFallbackTimer);
          if (!probeStarted) {
            probeStarted = true;
            try {
              const postUrl = new URL(dataStr, target.url).toString();
              void sendPostProbe(postUrl);
              probeTimer = setTimeout(() => {
                finish({
                  ok: true,
                  status: 'connected',
                  message: discoveredServerInfo?.name
                    ? `接続成功: ${discoveredServerInfo.name}${discoveredServerInfo.version ? ` v${discoveredServerInfo.version}` : ''}`
                    : 'SSEエンドポイントへの接続を確認しました',
                  ...(discoveredServerInfo ? { serverInfo: discoveredServerInfo } : {}),
                  ...(discoveredTools ? { tools: discoveredTools } : {}),
                });
              }, 1_800);
            } catch {
              finish({
                ok: true,
                status: 'connected',
                message: 'SSEエンドポイントへの接続を確認しました',
              });
            }
          }
          return;
        }

        if (dataStr.startsWith('{') || dataStr.startsWith('[')) {
          try {
            const parsed = JSON.parse(dataStr);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
              const msg = item as Record<string, unknown>;
              if (msg.id === 1 && msg.result && typeof msg.result === 'object') {
                const info = (msg.result as Record<string, unknown>).serverInfo;
                if (info && typeof info === 'object' && !Array.isArray(info)) {
                  const infoObj = info as Record<string, unknown>;
                  discoveredServerInfo = {
                    name: typeof infoObj.name === 'string' ? infoObj.name : undefined,
                    version: typeof infoObj.version === 'string' ? infoObj.version : undefined,
                  };
                }
              }
              if (msg.id === 2 && msg.result && typeof msg.result === 'object') {
                const extracted = extractMcpToolsFromJsonRpcPayload(msg);
                if (extracted.length > 0) {
                  discoveredTools = extracted;
                }
                finish({
                  ok: true,
                  status: 'connected',
                  message: discoveredServerInfo?.name
                    ? `接続成功: ${discoveredServerInfo.name}${discoveredServerInfo.version ? ` v${discoveredServerInfo.version}` : ''}`
                    : 'SSEエンドポイントへの接続を確認しました',
                  ...(discoveredServerInfo ? { serverInfo: discoveredServerInfo } : {}),
                  ...(discoveredTools ? { tools: discoveredTools } : {}),
                });
                return;
              }
            }
          } catch {
            // ignore non-JSON SSE event
          }
        }
      };

      const req = (isHttps ? https.request : http.request)(
        {
          protocol: target.parsed.protocol,
          hostname: target.parsed.hostname,
          port: target.parsed.port ? Number(target.parsed.port) : isHttps ? 443 : 80,
          path: `${target.parsed.pathname}${target.parsed.search}`,
          method: 'GET',
          headers: reqHeaders,
          ...(isHttps ? { servername: target.parsed.hostname } : {}),
          ...(pinnedLookup ? { lookup: pinnedLookup as never } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status === 401) {
            res.resume();
            void this.discoverOAuthMetadata(sseUrl).then((discovered) => {
              finish({
                ok: false,
                status: 'oauth_required',
                message: '認証が必要です (HTTP 401)。OAuth認証または認証ヘッダーを設定してください。',
                discoveredOAuth: {
                  authorizationUrl: discovered.authorizationUrl,
                  tokenUrl: discovered.tokenUrl,
                  registrationUrl: discovered.registrationUrl,
                  scopes: discovered.scopes,
                },
              });
            });
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            finish({
              ok: false,
              status: 'error',
              message: `リモートMCPサーバーからエラーが返されました (HTTP ${status})`,
            });
            return;
          }
          const contentType = String(res.headers['content-type'] ?? '');
          if (!contentType.toLowerCase().includes('text/event-stream')) {
            res.resume();
            finish({
              ok: false,
              status: 'error',
              message: `HTTP ${status} が返されましたが、SSE ストリーム (text/event-stream) ではありませんでした（Content-Type: ${contentType || '未設定'}）。URL または接続方式を確認してください。`,
            });
            return;
          }

          sseHeadersOk = true;
          headerFallbackTimer = setTimeout(() => {
            finish({
              ok: true,
              status: 'connected',
              message: `SSEエンドポイントへの接続を確認しました (HTTP ${status}, text/event-stream)`,
            });
          }, 500);

          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            lineBuf += chunk.toString('utf8');
            let nlIdx = lineBuf.indexOf('\n');
            while (nlIdx !== -1) {
              let line = lineBuf.slice(0, nlIdx);
              lineBuf = lineBuf.slice(nlIdx + 1);
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (line === '') {
                handleEventBlock();
              } else if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''));
              }
              nlIdx = lineBuf.indexOf('\n');
            }
          });

          res.on('end', () => {
            if (settled) return;
            if (lineBuf.trim()) {
              const tail = lineBuf.trim();
              if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''));
              handleEventBlock();
            }
            finish({
              ok: true,
              status: 'connected',
              message: `SSEエンドポイントへの接続を確認しました (HTTP ${status}, text/event-stream)`,
              ...(discoveredServerInfo ? { serverInfo: discoveredServerInfo } : {}),
              ...(discoveredTools ? { tools: discoveredTools } : {}),
            });
          });
        }
      );

      req.on('error', (err) => {
        finish({
          ok: false,
          status: 'error',
          message: `接続に失敗しました: ${err.message}`,
        });
      });
      req.end();
    });
  }

  async testServer(adminUserId: string, serverId: string): Promise<McpTestResult & { server?: McpServerRecord }> {
    const row = this.db.getMcpServerById(serverId);
    if (!row) {
      throw new McpValidationError('MCP_NOT_FOUND', '指定されたMCPサーバーが見つかりません。', 404);
    }
    this.assertAdminCanAccessRow(adminUserId, row);

    const persistDiscoveredTools = (result: McpTestResult): McpTestResult & { server?: McpServerRecord } => {
      if (result.ok && Array.isArray(result.tools)) {
        const updated = this.db.updateMcpServer(row.id, {
          discoveredToolsJson: JSON.stringify(result.tools),
        });
        if (updated) {
          this.emitUpdated(updated.scope, updated.ownerUserId, updated.id);
          return { ...result, server: this.toPublicRecord(updated) };
        }
      }
      return result;
    };

    if (row.transport === 'stdio') {
      const cmd = row.command ?? '';
      const resolved = resolveHostExecutable(cmd);
      if (!resolved) {
        return {
          ok: false,
          status: 'error',
          message: `実行コマンド "${cmd}" がサーバーの PATH 上に見つかりません。絶対パスまたはインストール状態を確認してください。`,
          resolvedCommand: null,
        };
      }
      const args = parseArgsJson(row.argsJson);
      const envMap = this.decryptRecord(row.encryptedEnvJson);
      const result = await this.probeStdioMcpInitialize(resolved, args, envMap);
      return persistDiscoveredTools(result);
    }

    if (!row.url) {
      return { ok: false, status: 'error', message: 'URLが設定されていません。' };
    }

    const headers: Record<string, string> = {
      ...this.decryptRecord(row.encryptedHeadersJson),
    };

    if (row.authType === 'oauth') {
      const token = await this.ensureFreshOAuthAccessToken(row);
      if (token) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'authorization') delete headers[key];
        }
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const urlOpts = { allowPrivate: this.config.allowPrivateMcpUrls };
    try {
      if (row.transport === 'sse') {
        const result = await this.probeSseMcpInitializeAndTools(row.url, headers, urlOpts);
        return persistDiscoveredTools(result);
      }

      // Streamable HTTP MCP initialize probe
      const res = await fetchJsonWithTimeout(
        row.url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'antigravity-chat-ui', version: this.config.appVersion },
            },
          }),
        },
        urlOpts
      );

      if (res.status === 401) {
        const discovered = await this.discoverOAuthMetadata(row.url);
        return {
          ok: false,
          status: 'oauth_required',
          message: '認証が必要です (HTTP 401)。OAuth認証またはAPIキー/トークンを設定してください。',
          discoveredOAuth: {
            authorizationUrl: discovered.authorizationUrl,
            tokenUrl: discovered.tokenUrl,
            registrationUrl: discovered.registrationUrl,
            scopes: discovered.scopes,
          },
        };
      }

      if (res.status >= 200 && res.status < 300) {
        let rpcPayload: Record<string, unknown> | null = res.json;
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!rpcPayload && contentType.includes('text/event-stream') && res.text) {
          for (const line of res.text.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                rpcPayload = parsed as Record<string, unknown>;
                break;
              }
            } catch {
              // ignore non-JSON event data
            }
          }
        }

        if (rpcPayload && rpcPayload.jsonrpc === '2.0' && rpcPayload.error && typeof rpcPayload.error === 'object') {
          const errMsg =
            typeof (rpcPayload.error as Record<string, unknown>).message === 'string'
              ? ((rpcPayload.error as Record<string, unknown>).message as string)
              : 'JSON-RPC エラー';
          return {
            ok: false,
            status: 'error',
            message: `リモートMCPサーバーが初期化エラーを返しました: ${errMsg}`,
          };
        }

        const resultObj =
          rpcPayload &&
          rpcPayload.jsonrpc === '2.0' &&
          typeof rpcPayload.result === 'object' &&
          rpcPayload.result !== null &&
          !Array.isArray(rpcPayload.result)
            ? (rpcPayload.result as Record<string, unknown>)
            : null;

        if (!resultObj) {
          return {
            ok: false,
            status: 'error',
            message: `HTTP ${res.status} が返されましたが、MCPプロトコル (initialize) の応答を確認できませんでした。URL または接続方式を確認してください。`,
          };
        }

        const serverInfoObj =
          typeof resultObj.serverInfo === 'object' && resultObj.serverInfo !== null
            ? (resultObj.serverInfo as Record<string, unknown>)
            : null;
        const serverInfo = serverInfoObj
          ? {
              name: typeof serverInfoObj.name === 'string' ? serverInfoObj.name : undefined,
              version: typeof serverInfoObj.version === 'string' ? serverInfoObj.version : undefined,
            }
          : undefined;

        let discoveredTools: McpDiscoveredTool[] | undefined;
        try {
          const sessionIdHeader = res.headers.get('mcp-session-id');
          const probeHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
          };
          if (sessionIdHeader) {
            probeHeaders['Mcp-Session-Id'] = sessionIdHeader;
          }

          await fetchJsonWithTimeout(
            row.url,
            {
              method: 'POST',
              headers: probeHeaders,
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
              }),
            },
            { ...urlOpts, timeoutMs: 1_500 }
          ).catch(() => null);

          const toolsRes = await fetchJsonWithTimeout(
            row.url,
            {
              method: 'POST',
              headers: probeHeaders,
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {},
              }),
            },
            { ...urlOpts, timeoutMs: 2_500 }
          );

          if (toolsRes.status >= 200 && toolsRes.status < 300) {
            let toolsPayload: unknown = toolsRes.json;
            const toolsCt = (toolsRes.headers.get('content-type') ?? '').toLowerCase();
            if (!toolsPayload && toolsCt.includes('text/event-stream') && toolsRes.text) {
              for (const line of toolsRes.text.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const dataStr = line.slice(5).trim();
                if (!dataStr || dataStr === '[DONE]') continue;
                try {
                  toolsPayload = JSON.parse(dataStr);
                  break;
                } catch {
                  // ignore non-JSON event data
                }
              }
            }
            const extracted = extractMcpToolsFromJsonRpcPayload(toolsPayload);
            if (extracted.length > 0) {
              discoveredTools = extracted;
            }
          }
        } catch {
          // Best-effort tool discovery; initialize already succeeded
        }

        return persistDiscoveredTools({
          ok: true,
          status: 'connected',
          message: serverInfo?.name
            ? `接続成功: ${serverInfo.name}${serverInfo.version ? ` v${serverInfo.version}` : ''}`
            : `リモートMCPサーバーの初期化を確認しました (HTTP ${res.status})`,
          serverInfo,
          ...(discoveredTools ? { tools: discoveredTools } : {}),
        });
      }

      return {
        ok: false,
        status: 'error',
        message: `リモートMCPサーバーからエラーが返されました (HTTP ${res.status})`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        message: `接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private resolveEffectiveToolPolicy(row: StoredMcpServerRow): {
    allowedTools: string[] | null;
    disabledTools: string[] | null;
  } | null {
    const allowedTools = parseArgsJson(row.allowedToolsJson);
    const disabledTools = parseArgsJson(row.disabledToolsJson);
    const disabledSet = new Set(disabledTools);

    if (allowedTools.length > 0) {
      return {
        allowedTools: allowedTools.filter((name) => !disabledSet.has(name)),
        disabledTools: null,
      };
    }

    if (disabledTools.length > 0) {
      return {
        allowedTools: null,
        disabledTools,
      };
    }

    return null;
  }

  // ---- ACP Native mcpServers Resolution ----

  /**
   * Resolves all enabled MCP servers applicable to `userId` into native ACP `McpServer[]`
   * entries. Profile-scoped servers override shared servers with the same name.
   * Respects `agentCapabilities.mcpCapabilities` so unsupported remote transports are not sent.
   */
  async resolveAcpMcpServersForUser(
    userId: string,
    capabilities?: McpCapabilities | null
  ): Promise<McpServer[]> {
    const rows = this.db.listEffectiveMcpServersForUser(userId);
    if (rows.length === 0) return [];

    // Deduplicate by name: rows are ordered shared-first, profile-second, so profile overrides shared.
    const byName = new Map<string, StoredMcpServerRow>();
    for (const row of rows) {
      byName.set(row.name, row);
    }

    // Antigravity CLI (`agy acp` 1.5.x+) supports HTTP/SSE MCP servers in `session/new`, `session/load`,
    // and `session/resume`, but omits `mcpCapabilities` from its `initialize` response.
    // Only skip a remote transport when the agent explicitly advertises `false`.
    const supportsHttp = capabilities?.http !== false;
    const supportsSse = capabilities?.sse !== false;
    const out: McpServer[] = [];

    for (const row of byName.values()) {
      const toolPolicy = this.resolveEffectiveToolPolicy(row);

      if (row.transport === 'stdio') {
        if (!row.command) continue;
        const resolvedCmd = resolveHostExecutable(row.command) ?? row.command;
        const args = parseArgsJson(row.argsJson);
        const envMap = this.decryptRecord(row.encryptedEnvJson);
        const env = Object.entries(envMap).map(([name, value]) => ({ name, value }));

        if (toolPolicy !== null) {
          const nodeBin = resolveHostExecutable('node') ?? process.execPath;
          out.push({
            name: row.name,
            command: nodeBin,
            args: [
              '--input-type=commonjs',
              '-e',
              STDIO_MCP_TOOL_FILTER_SCRIPT,
              JSON.stringify({
                command: resolvedCmd,
                args,
                ...(toolPolicy.allowedTools ? { allowedTools: toolPolicy.allowedTools } : {}),
                ...(toolPolicy.disabledTools ? { disabledTools: toolPolicy.disabledTools } : {}),
              }),
            ],
            env,
          });
        } else {
          out.push({
            name: row.name,
            command: resolvedCmd,
            args,
            env,
          });
        }
        continue;
      }

      if (!row.url) continue;
      if (row.transport === 'http' && !supportsHttp) continue;
      if (row.transport === 'sse' && !supportsSse) continue;

      let target: PinnedOutboundTarget;
      try {
        target = await resolvePinnedOutboundTarget(row.url, {
          allowPrivate: this.config.allowPrivateMcpUrls,
        });
      } catch {
        // Skip remote server whose URL fails SSRF/DNS validation
        continue;
      }

      const headerMap = this.decryptRecord(row.encryptedHeadersJson);

      let acpUrl = target.url;

      if (toolPolicy !== null) {
        acpUrl = await this.httpsForwarder.registerRoute({
          ...target,
          ...(toolPolicy.allowedTools ? { allowedTools: new Set(toolPolicy.allowedTools) } : {}),
          ...(toolPolicy.disabledTools ? { disabledTools: new Set(toolPolicy.disabledTools) } : {}),
          trackedToolsListIds: new Set(),
          activeSseResponses: new Set(),
        });
      }

      if (row.authType === 'oauth') {
        const accessToken = await this.ensureFreshOAuthAccessToken(row);
        if (!accessToken) {
          // Skip unauthenticated/expired OAuth server rather than failing ACP session creation
          continue;
        }
        for (const key of Object.keys(headerMap)) {
          if (key.toLowerCase() === 'authorization') delete headerMap[key];
        }
        headerMap.Authorization = `Bearer ${accessToken}`;
      }

      const headers = Object.entries(headerMap).map(([name, value]) => ({ name, value }));

      if (row.transport === 'http') {
        out.push({
          type: 'http',
          name: row.name,
          url: acpUrl,
          headers,
        });
      } else {
        out.push({
          type: 'sse',
          name: row.name,
          url: acpUrl,
          headers,
        });
      }
    }

    return out;
  }
}
