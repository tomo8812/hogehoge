import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { SyncHub } from '../sync/hub.js';
import type { PushSubscriptionRecord } from '../types.js';

export interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
  chatId?: string;
  runId?: string;
  url?: string;
  vibrate?: number[];
}

interface StoredVapidKeys {
  privateJwk: crypto.JsonWebKey;
  publicKeyBase64Url: string;
}

const VAPID_KV_KEY = 'vapid_keys_v1';

function padTo32(buf: Buffer): Buffer {
  if (buf.length === 32) return buf;
  if (buf.length > 32) return buf.subarray(buf.length - 32);
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}

export function decodeBase64Url(input: string): Buffer {
  const trimmed = input.trim();
  if (!trimmed || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new Error('Invalid base64 string');
  }
  const normalized = trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return Buffer.from(normalized, 'base64url');
}

export function validateSubscriptionKeys(params: { p256dh: string; auth: string }): {
  uaPublicKey: Buffer;
  authSecret: Buffer;
} {
  const uaPublicKey = decodeBase64Url(params.p256dh);
  const authSecret = decodeBase64Url(params.auth);

  if (uaPublicKey.length !== 65 || uaPublicKey[0] !== 0x04) {
    throw new Error('p256dh key must be an uncompressed 65-byte P-256 point');
  }
  if (authSecret.length !== 16) {
    throw new Error('auth secret must be 16 bytes');
  }

  // Verify the point is genuinely on prime256v1
  const probe = crypto.createECDH('prime256v1');
  probe.generateKeys();
  probe.computeSecret(uaPublicKey);

  return { uaPublicKey, authSecret };
}

export function isAllowedPushEndpoint(endpoint: string, allowTestLocalhost: boolean): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (allowTestLocalhost && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }

  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('169.254.')) {
    return false;
  }
  return true;
}

export function loadOrCreateVapidKeys(db: AppDatabase): {
  privateKey: crypto.KeyObject;
  publicKeyBase64Url: string;
} {
  const raw = db.getAppValue(VAPID_KV_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredVapidKeys;
      if (parsed.privateJwk && parsed.publicKeyBase64Url) {
        const privateKey = crypto.createPrivateKey({ key: parsed.privateJwk, format: 'jwk' });
        return { privateKey, publicKeyBase64Url: parsed.publicKeyBase64Url };
      }
    } catch {
      // Regenerate if stored entry was corrupted
    }
  }

  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  if (!privateJwk.x || !privateJwk.y) {
    throw new Error('Failed to export VAPID P-256 coordinates');
  }
  const xBuf = padTo32(Buffer.from(privateJwk.x, 'base64url'));
  const yBuf = padTo32(Buffer.from(privateJwk.y, 'base64url'));
  const rawPublic = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);
  const publicKeyBase64Url = rawPublic.toString('base64url');

  const stored: StoredVapidKeys = { privateJwk, publicKeyBase64Url };
  db.setAppValue(VAPID_KV_KEY, JSON.stringify(stored));
  return { privateKey, publicKeyBase64Url };
}

export function createVapidJwt(params: {
  audience: string;
  subject: string;
  privateKey: crypto.KeyObject;
  expirationSec?: number;
}): string {
  const headerB64 = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' }), 'utf8').toString('base64url');
  const exp = params.expirationSec ?? Math.floor(Date.now() / 1000) + 12 * 3600;
  const payloadB64 = Buffer.from(
    JSON.stringify({
      aud: params.audience,
      exp,
      sub: params.subject,
    }),
    'utf8'
  ).toString('base64url');

  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: params.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

/**
 * Encrypts a notification payload using RFC 8291 (aes128gcm content encoding)
 * + RFC 8188 single-record framing using pure Node.js built-in crypto.
 */
export function encryptWebPushPayload(params: {
  payload: string | Buffer;
  p256dh: string;
  auth: string;
}): {
  body: Buffer;
  salt: Buffer;
  asPublicKey: Buffer;
  cek: Buffer;
  nonce: Buffer;
} {
  const { uaPublicKey, authSecret } = validateSubscriptionKeys({
    p256dh: params.p256dh,
    auth: params.auth,
  });

  const asEcdh = crypto.createECDH('prime256v1');
  const asPublicKey = asEcdh.generateKeys();
  const ecdhSecret = asEcdh.computeSecret(uaPublicKey);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\x00', 'ascii'), uaPublicKey, asPublicKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\x00', 'ascii'), 16)
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\x00', 'ascii'), 12)
  );

  const plaintext = Buffer.isBuffer(params.payload)
    ? params.payload
    : Buffer.from(params.payload, 'utf8');
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Math.max(4096, encrypted.length + 1);
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(recordSize, 0);

  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublicKey.length]), asPublicKey]);
  return {
    body: Buffer.concat([header, encrypted]),
    salt,
    asPublicKey,
    cek,
    nonce,
  };
}

function truncatePreview(text: string | undefined, maxChars = 120): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

export interface SendToUserResult {
  sent: number;
  failed: number;
  removed: number;
  total: number;
  lastError?: string;
  currentDeviceRegistered?: boolean;
  currentDeviceSent?: boolean;
  currentDeviceError?: string;
}

export class PushNotificationService {
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKeyBase64Url: string;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly hub?: SyncHub
  ) {
    const loaded = loadOrCreateVapidKeys(db);
    this.privateKey = loaded.privateKey;
    this.publicKeyBase64Url = loaded.publicKeyBase64Url;

    if (/(?:\.local|@localhost)(?:$|[:/])/i.test(this.config.vapidSubject)) {
      console.warn(
        `[web-push] Warning: VAPID_SUBJECT "${this.config.vapidSubject}" uses a non-public host and may be rejected (HTTP 403 BadJwtToken) by Apple Web Push.`
      );
    }
  }

  getPublicKey(): string {
    return this.publicKeyBase64Url;
  }

  async sendToSubscription(
    sub: PushSubscriptionRecord,
    payloadObj: NotificationPayload
  ): Promise<{ ok: boolean; status?: number; gone?: boolean; error?: string }> {
    try {
      const targetUrl = new URL(sub.endpoint);
      const jwt = createVapidJwt({
        audience: targetUrl.origin,
        subject: this.config.vapidSubject,
        privateKey: this.privateKey,
      });

      const jsonPayload = JSON.stringify(payloadObj);
      const { body } = encryptWebPushPayload({
        payload: jsonPayload,
        p256dh: sub.p256dh,
        auth: sub.auth,
      });

      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${jwt}, k=${this.publicKeyBase64Url}`,
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          TTL: '86400',
          Urgency: 'high',
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 404 || res.status === 410) {
        this.db.deletePushSubscriptionById(sub.id);
        return { ok: false, status: res.status, gone: true, error: `Subscription gone (${res.status})` };
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          error: `Push service HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`,
        };
      }

      return { ok: true, status: res.status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async sendToUser(
    userId: string,
    payloadObj: NotificationPayload,
    options?: { currentEndpoint?: string; skipEndpoints?: ReadonlySet<string> }
  ): Promise<SendToUserResult> {
    const subs = this.db.listPushSubscriptions(userId);
    const currentEndpoint = options?.currentEndpoint?.trim() || undefined;
    const skipEndpoints = options?.skipEndpoints;
    const targetSubs =
      skipEndpoints && skipEndpoints.size > 0
        ? subs.filter((sub) => !skipEndpoints.has(sub.endpoint))
        : subs;

    if (targetSubs.length === 0) {
      const currentSubPresent = currentEndpoint
        ? subs.some((sub) => sub.endpoint === currentEndpoint)
        : false;
      return {
        sent: 0,
        failed: 0,
        removed: 0,
        total: subs.length,
        ...(currentEndpoint
          ? { currentDeviceRegistered: currentSubPresent, currentDeviceSent: false }
          : {}),
      };
    }

    const results = await Promise.all(
      targetSubs.map(async (sub) => ({ sub, res: await this.sendToSubscription(sub, payloadObj) }))
    );
    let sent = 0;
    let failed = 0;
    let removed = 0;
    let lastError: string | undefined;
    let currentDeviceRegistered = false;
    let currentDeviceSent = false;
    let currentDeviceError: string | undefined;

    for (const { sub, res: r } of results) {
      if (r.ok) {
        sent += 1;
      } else {
        failed += 1;
        if (r.gone) removed += 1;
        if (r.error) lastError = r.error;
      }
      if (currentEndpoint && sub.endpoint === currentEndpoint) {
        currentDeviceRegistered = true;
        currentDeviceSent = r.ok;
        if (!r.ok && r.error) {
          currentDeviceError = r.error;
        }
      }
    }

    if (failed > 0 && this.config.nodeEnv !== 'test') {
      console.warn(
        `[web-push] Delivery issue for user=${userId} tag=${payloadObj.tag}: sent=${sent}, failed=${failed}, removed=${removed}, lastError=${lastError ?? 'unknown'}`
      );
    }

    return {
      sent,
      failed,
      removed,
      total: subs.length,
      lastError,
      ...(currentEndpoint
        ? {
            currentDeviceRegistered,
            currentDeviceSent,
            ...(currentDeviceError ? { currentDeviceError } : {}),
          }
        : {}),
    };
  }

  async notifyRunFinished(params: {
    userId: string;
    chatId: string;
    runId: string;
    status: 'completed' | 'error' | 'cancelled';
    previewText?: string;
    errorMessage?: string | null;
    tagOverride?: string;
  }): Promise<SendToUserResult | null> {
    if (params.status === 'cancelled') return null;

    const prefs = this.db.getPreferences(params.userId);
    if (!prefs.notifyOnResponse) return null;

    const chat = this.db.getChat(params.userId, params.chatId);
    const chatTitle = chat?.title || 'Antigravity Chat';
    const cleanTitle = chatTitle.length > 60 ? `${chatTitle.slice(0, 59)}…` : chatTitle;

    const vibrateComplete = prefs.hapticFeedback ? [14, 55, 16, 55, 42] : undefined;
    const vibrateError = prefs.hapticFeedback ? [65, 65, 65, 65, 65] : undefined;
    const tag = params.tagOverride || `run-${params.runId}`;

    const payload: NotificationPayload =
      params.status === 'error'
        ? {
            title: `エラーで終了 — ${cleanTitle}`,
            body:
              truncatePreview(params.errorMessage || params.previewText || undefined, 120) ||
              '応答の生成中にエラーが発生しました。',
            tag,
            chatId: params.chatId,
            runId: params.runId,
            url: `/?chatId=${encodeURIComponent(params.chatId)}`,
            ...(vibrateError ? { vibrate: vibrateError } : {}),
          }
        : {
            title: cleanTitle,
            body: truncatePreview(params.previewText, 120) || '応答が完了しました。',
            tag,
            chatId: params.chatId,
            runId: params.runId,
            url: `/?chatId=${encodeURIComponent(params.chatId)}`,
            ...(vibrateComplete ? { vibrate: vibrateComplete } : {}),
          };

    const skipEndpoints = this.hub?.getVisiblePushEndpoints(params.userId);
    return this.sendToUser(params.userId, payload, { skipEndpoints });
  }

  async notifyPermissionRequested(params: {
    userId: string;
    chatId: string;
    runId: string;
    permissionId: string;
    toolTitle?: string | null;
    isQuestion?: boolean;
  }): Promise<SendToUserResult | null> {
    const prefs = this.db.getPreferences(params.userId);
    if (!prefs.notifyOnResponse) return null;

    const chat = this.db.getChat(params.userId, params.chatId);
    const chatTitle = chat?.title || 'Antigravity Chat';
    const cleanTitle = chatTitle.length > 52 ? `${chatTitle.slice(0, 51)}…` : chatTitle;
    const isQuestion = Boolean(params.isQuestion);
    const label =
      truncatePreview(params.toolTitle || undefined, 90) ||
      (isQuestion ? 'エージェントからの質問' : 'ツール実行の許可');
    const vibratePermission = prefs.hapticFeedback ? [24, 60, 24] : undefined;

    const skipEndpoints = this.hub?.getVisiblePushEndpoints(params.userId);
    return this.sendToUser(
      params.userId,
      {
        title: `${isQuestion ? '質問待ち' : '確認待ち'} — ${cleanTitle}`,
        body: isQuestion ? label : `${label} の承認が必要です。`,
        tag: `perm-${params.permissionId}`,
        chatId: params.chatId,
        runId: params.runId,
        url: `/?chatId=${encodeURIComponent(params.chatId)}`,
        ...(vibratePermission ? { vibrate: vibratePermission } : {}),
      },
      { skipEndpoints }
    );
  }

  async notifyElicitationRequested(params: {
    userId: string;
    chatId: string;
    runId: string;
    elicitationId: string;
    message?: string | null;
  }): Promise<SendToUserResult | null> {
    const prefs = this.db.getPreferences(params.userId);
    if (!prefs.notifyOnResponse) return null;

    const chat = this.db.getChat(params.userId, params.chatId);
    const chatTitle = chat?.title || 'Antigravity Chat';
    const cleanTitle = chatTitle.length > 52 ? `${chatTitle.slice(0, 51)}…` : chatTitle;
    const label = truncatePreview(params.message || undefined, 90) || 'エージェントからの質問';
    const vibratePermission = prefs.hapticFeedback ? [24, 60, 24] : undefined;

    const skipEndpoints = this.hub?.getVisiblePushEndpoints(params.userId);
    return this.sendToUser(
      params.userId,
      {
        title: `質問待ち — ${cleanTitle}`,
        body: label,
        tag: `elicit-${params.elicitationId}`,
        chatId: params.chatId,
        runId: params.runId,
        url: `/?chatId=${encodeURIComponent(params.chatId)}`,
        ...(vibratePermission ? { vibrate: vibratePermission } : {}),
      },
      { skipEndpoints }
    );
  }
}
