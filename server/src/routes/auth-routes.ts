import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { probeBwrapSandbox } from '../acp/env-isolation.js';
import { AGY_AGENT_MODES, ensureAgyProfileSettings, getAgyAgentMode, setAgyAgentMode } from '../acp/profile-settings.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { AgyAuthManager } from '../auth/agy-auth.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  authenticateRequest,
  clearSessionCookies,
  issueSessionCookies,
  verifyCsrfIfMutating,
} from '../auth/session.js';
import { ensureUserDirs } from '../files/workspace.js';
import type { SkillService } from '../skills/skill-service.js';
import type { SyncHub } from '../sync/hub.js';
import type { AppBuildInfo } from '../version.js';

export interface RouteDeps {
  config: AppConfig;
  db: AppDatabase;
  hub: SyncHub;
  agyAuth: AgyAuthManager;
  skillService?: SkillService;
  buildId?: string;
  buildInfo?: AppBuildInfo;
}

const registerSchema = z.object({
  username: z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, '英数字と _ . - のみ使用できます'),
  displayName: z.string().trim().min(1).max(60).optional(),
  password: z.string().min(6).max(128),
});

const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

const prefsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  notifyOnResponse: z.boolean().optional(),
  hapticFeedback: z.boolean().optional(),
  defaultModelId: z.string().nullable().optional(),
  defaultEffortValue: z.string().nullable().optional(),
});

const agentModeSchema = z.object({ agentMode: z.enum(AGY_AGENT_MODES) }).strict();

export function requireAuth(req: FastifyRequest, reply: FastifyReply, db: AppDatabase) {
  const session = authenticateRequest(req, db);
  if (!session) {
    reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Webログインが必要です。' });
    return null;
  }
  if (!verifyCsrfIfMutating(req)) {
    reply.code(403).send({ error: 'CSRF_INVALID', message: 'CSRFトークンが無効です。ページを再読込してください。' });
    return null;
  }
  return session;
}

export async function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, db, hub, agyAuth, skillService, buildId = 'dev', buildInfo } = deps;
  const version = buildInfo?.version ?? config.appVersion;
  const shortSha = buildInfo?.shortSha ?? null;
  const builtAt = buildInfo?.builtAt ?? null;

  app.get('/api/auth/bootstrap', async (req) => {
    const userCount = db.countUsers();
    const session = authenticateRequest(req, db);
    if (!session) {
      return {
        userCount,
        allowPublicSignup: config.allowPublicSignup,
        agyMode: config.agyMode,
        buildId,
        version,
        shortSha,
        builtAt,
        authenticated: false,
        user: null,
        agyProfile: null,
        preferences: null,
        loginFlow: null,
        sandbox: null,
      };
    }

    return {
      userCount,
      allowPublicSignup: config.allowPublicSignup,
      agyMode: config.agyMode,
      buildId,
      version,
      shortSha,
      builtAt,
      authenticated: true,
      user: session.user,
      agyProfile: db.getAgyProfile(session.user.id),
      preferences: db.getPreferences(session.user.id),
      loginFlow: agyAuth.getFlowState(session.user.id),
      sandbox: probeBwrapSandbox(config),
    };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? 'Invalid input' });
    }

    const userCount = db.countUsers();
    const existingSession = authenticateRequest(req, db);
    if (userCount > 0 && !config.allowPublicSignup && existingSession?.user.role !== 'admin') {
      return reply.code(403).send({ error: 'SIGNUP_DISABLED', message: '新規登録は無効化されています。' });
    }

    const normalizedUsername = parsed.data.username.toLowerCase();
    if (db.findUserByUsername(normalizedUsername)) {
      return reply.code(409).send({ error: 'USERNAME_TAKEN', message: 'そのユーザー名は既に使用されています。' });
    }

    const userId = crypto.randomUUID();
    const { profileDir } = ensureUserDirs({
      profilesRoot: config.profilesRoot,
      workspacesRoot: config.workspacesRoot,
      projectsRoot: config.projectsRoot,
      userId,
    });

    const passwordHash = await hashPassword(parsed.data.password);
    ensureAgyProfileSettings(profileDir);
    skillService?.syncBuiltinSkillsToProfile(profileDir);
    const user = db.createUser({
      id: userId,
      username: normalizedUsername,
      displayName: parsed.data.displayName || parsed.data.username,
      passwordHash,
      role: userCount === 0 ? 'admin' : 'user',
      profileDir,
    });

    // If not created while already signed in as admin creating a second account, sign in cleanly
    const signInCreatedUser = !existingSession;
    if (signInCreatedUser) {
      issueSessionCookies({ req, reply, config, db, userId: user.id });
    }

    return reply.code(201).send({
      user,
      agyProfile: db.getAgyProfile(user.id),
      preferences: db.getPreferences(user.id),
      loginFlow: agyAuth.getFlowState(user.id),
      sandbox: probeBwrapSandbox(config),
    });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: 'ユーザー名とパスワードを入力してください。' });
    }

    const normalizedUsername = parsed.data.username.toLowerCase();
    const stored = db.findUserByUsername(normalizedUsername);
    if (!stored || !(await verifyPassword(parsed.data.password, stored.passwordHash))) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'ユーザー名またはパスワードが正しくありません。' });
    }

    const { profileDir } = ensureUserDirs({
      profilesRoot: config.profilesRoot,
      workspacesRoot: config.workspacesRoot,
      projectsRoot: config.projectsRoot,
      userId: stored.id,
    });
    skillService?.syncBuiltinSkillsToProfile(profileDir);

    issueSessionCookies({ req, reply, config, db, userId: stored.id });

    return {
      user: {
        id: stored.id,
        username: stored.username,
        displayName: stored.displayName,
        role: stored.role,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      },
      agyProfile: db.getAgyProfile(stored.id),
      preferences: db.getPreferences(stored.id),
      loginFlow: agyAuth.getFlowState(stored.id),
      sandbox: probeBwrapSandbox(config),
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const session = authenticateRequest(req, db);
    if (session) {
      if (!verifyCsrfIfMutating(req)) {
        return reply.code(403).send({ error: 'CSRF_INVALID', message: 'CSRF token mismatch' });
      }
      db.deleteWebSession(session.sessionIdHash);
      hub.disconnectSession(session.user.id, session.sessionIdHash, 'user_logout');
    }
    clearSessionCookies(req, reply, config);
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    db.deleteAllUserSessions(session.user.id);
    db.deleteAllPushSubscriptionsForUser(session.user.id);
    hub.disconnectAllForUser(session.user.id, 'logout_all');
    clearSessionCookies(req, reply, config);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    return {
      user: session.user,
      agyProfile: db.getAgyProfile(session.user.id),
      preferences: db.getPreferences(session.user.id),
      loginFlow: agyAuth.getFlowState(session.user.id),
      agyMode: config.agyMode,
      sandbox: probeBwrapSandbox(config),
    };
  });

  app.patch('/api/preferences', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: '設定値が不正です。' });
    }
    const updated = db.updatePreferences(session.user.id, parsed.data);
    hub.emitDurable({
      userId: session.user.id,
      type: 'preferences.updated',
      payload: { preferences: updated },
    });
    return { preferences: updated };
  });

  // ---- Antigravity Profile & Authorization-Code Paste Endpoints ----

  app.get('/api/agy/agent-mode', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const profile = db.getAgyProfile(session.user.id);
    if (!profile) return reply.code(404).send({ error: 'AGY_PROFILE_NOT_FOUND', message: 'Antigravity プロファイルがありません。' });
    return reply.header('Cache-Control', 'no-store').send({ agentMode: getAgyAgentMode(profile.profileDir) });
  });

  app.patch('/api/agy/agent-mode', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const parsed = agentModeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: 'エージェントモードの設定値が不正です。' });
    }
    const profile = db.getAgyProfile(session.user.id);
    if (!profile) return reply.code(404).send({ error: 'AGY_PROFILE_NOT_FOUND', message: 'Antigravity プロファイルがありません。' });
    db.withAgyProfileSettingsWrite(() => setAgyAgentMode(profile.profileDir, parsed.data.agentMode));
    return { agentMode: parsed.data.agentMode };
  });

  app.get('/api/agy/status', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    return {
      profile: db.getAgyProfile(session.user.id),
      loginFlow: agyAuth.getFlowState(session.user.id),
    };
  });

  app.post('/api/agy/login/start', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const body = z.object({ accountLabel: z.string().max(120).optional().nullable() }).safeParse(req.body ?? {});
    const loginFlow = await agyAuth.startCodePasteLogin(session.user.id, {
      accountLabel: body.success ? body.data.accountLabel : null,
    });
    return {
      profile: db.getAgyProfile(session.user.id),
      loginFlow,
    };
  });

  app.post('/api/agy/login/code', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const body = z.object({ code: z.string().trim().min(1) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'INVALID_CODE', message: '認証コードを貼り付けてください。' });
    }
    try {
      const loginFlow = await agyAuth.submitAuthorizationCode(session.user.id, body.data.code);
      return {
        profile: db.getAgyProfile(session.user.id),
        loginFlow,
      };
    } catch (err) {
      return reply.code(400).send({
        error: 'AGY_LOGIN_FAILED',
        message: err instanceof Error ? err.message : '認証コード送信に失敗しました。',
      });
    }
  });

  app.post('/api/agy/login/cancel', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    await agyAuth.cancelLogin(session.user.id);
    return {
      profile: db.getAgyProfile(session.user.id),
      loginFlow: agyAuth.getFlowState(session.user.id),
    };
  });

  app.post('/api/agy/api-key', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const body = z
      .object({
        apiKey: z.string().trim().min(5),
        accountLabel: z.string().trim().max(120).optional().nullable(),
      })
      .safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'INVALID_API_KEY', message: '有効なAPIキーを入力してください。' });
    }
    try {
      const profile = await agyAuth.configureGeminiApiKey(session.user.id, body.data.apiKey, body.data.accountLabel);
      return { profile };
    } catch (err) {
      return reply.code(400).send({
        error: 'AGY_API_KEY_INVALID',
        message: err instanceof Error ? err.message : 'APIキー認証に失敗しました。',
      });
    }
  });

  app.post('/api/agy/disconnect', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const profile = await agyAuth.disconnectAgyProfile(session.user.id);
    return { profile };
  });
}
