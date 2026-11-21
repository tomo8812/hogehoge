import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp, type AppContext } from '../../src/app.js';

export interface RecordedWsFrame {
  kind: string;
  [key: string]: unknown;
}

export class TestApiClient {
  private readonly cookies = new Map<string, string>();
  public ws: WebSocket | null = null;
  public readonly wsFrames: RecordedWsFrame[] = [];
  private wsWaiters: Array<{
    predicate: (frame: RecordedWsFrame) => boolean;
    resolve: (frame: RecordedWsFrame) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(public readonly baseUrl: string) {}

  get cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get csrfToken(): string {
    return this.cookies.get('agy_chat_csrf') ?? '';
  }

  private captureCookies(res: Response): void {
    const headers = res.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) {
        const name = first.slice(0, eq).trim();
        const val = first.slice(eq + 1).trim();
        if (val === '') this.cookies.delete(name);
        else this.cookies.set(name, val);
      }
    }
  }

  async request<T = Record<string, unknown>>(
    method: string,
    urlPath: string,
    body?: unknown,
    opts: { omitCsrf?: boolean; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookieHeader) headers.Cookie = this.cookieHeader;
    if (
      !opts.omitCsrf &&
      !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) &&
      this.csrfToken
    ) {
      headers['x-csrf-token'] = decodeURIComponent(this.csrfToken);
    }

    let reqBody: BodyInit | undefined;
    if (body instanceof FormData) {
      reqBody = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }

    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers,
      body: reqBody,
    });
    this.captureCookies(res);

    const ct = res.headers.get('content-type') || '';
    const data = (ct.includes('application/json') ? await res.json() : await res.text()) as T;
    return { status: res.status, data, headers: res.headers };
  }

  async connectWs(params: { sinceSeq?: number; clientId?: string } = {}): Promise<RecordedWsFrame> {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams();
    if (params.sinceSeq !== undefined) qs.set('sinceSeq', String(params.sinceSeq));
    if (params.clientId) qs.set('clientId', params.clientId);

    const wsUrl = `${wsBase}/api/ws?${qs.toString()}`;
    const socket = new WebSocket(wsUrl, {
      headers: this.cookieHeader ? { Cookie: this.cookieHeader } : undefined,
    });
    this.ws = socket;

    const helloPromise = new Promise<RecordedWsFrame>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for WS hello')), 5000);
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as RecordedWsFrame;
        this.wsFrames.push(frame);
        this.notifyWaiters(frame);
        if (frame.kind === 'hello') {
          clearTimeout(timeout);
          resolve(frame);
        }
      });
      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      socket.once('close', (code, reason) => {
        clearTimeout(timeout);
        reject(new Error(`WS closed (${code}): ${String(reason)}`));
      });
    });

    return helloPromise;
  }

  waitForFrame(
    predicate: (frame: RecordedWsFrame) => boolean,
    timeoutMs = 8000,
    searchExisting = true
  ): Promise<RecordedWsFrame> {
    if (searchExisting) {
      const match = this.wsFrames.find(predicate);
      if (match) return Promise.resolve(match);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wsWaiters = this.wsWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for WS event`));
      }, timeoutMs);
      this.wsWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  private notifyWaiters(frame: RecordedWsFrame): void {
    const remaining: typeof this.wsWaiters = [];
    for (const waiter of this.wsWaiters) {
      if (waiter.predicate(frame)) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        remaining.push(waiter);
      }
    }
    this.wsWaiters = remaining;
  }

  closeWs(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

export async function createTestServer(
  configOverrides: Parameters<typeof createApp>[0] = {}
): Promise<{
  ctx: AppContext;
  baseUrl: string;
  dataRoot: string;
  cleanup: () => Promise<void>;
}> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-chat-test-'));
  const ctx = await createApp({
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    agyMode: 'mock',
    dataRoot,
    builtinSkillsDir: path.join(dataRoot, '.empty-builtin-skills'),
    docRuntimeDir: path.join(dataRoot, '.empty-doc-runtime'),
    maxConcurrentAcp: 4,
    maxAcpPerUser: 2,
    idleWorkerMs: 60_000,
    allowPublicSignup: true,
    secureCookies: 'never',
    ...configOverrides,
  });

  const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  return {
    ctx,
    baseUrl: address,
    dataRoot,
    cleanup: async () => {
      await ctx.shutdown();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

export async function registerAndBindAgy(
  baseUrl: string,
  username: string,
  codeOrAccount: string
): Promise<{ client: TestApiClient; userId: string }> {
  const client = new TestApiClient(baseUrl);
  const reg = await client.request<{ user: { id: string } }>('POST', '/api/auth/register', {
    username,
    displayName: username,
    password: 'password123',
  });
  if (reg.status !== 201) {
    throw new Error(`Register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  }

  const start = await client.request<{ loginFlow: { authUrl: string | null } }>(
    'POST',
    '/api/agy/login/start',
    { accountLabel: codeOrAccount }
  );
  if (!start.data.loginFlow?.authUrl?.startsWith('https://accounts.google.com/')) {
    throw new Error(`Expected Google auth URL, got: ${JSON.stringify(start.data)}`);
  }

  const submit = await client.request<{ profile: { authStatus: string } }>(
    'POST',
    '/api/agy/login/code',
    { code: codeOrAccount }
  );
  if (submit.data.profile.authStatus !== 'authenticated') {
    throw new Error(`Agy code auth failed: ${JSON.stringify(submit.data)}`);
  }

  return { client, userId: reg.data.user.id };
}
