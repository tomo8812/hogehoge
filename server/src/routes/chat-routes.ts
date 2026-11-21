import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AcpClientManager } from '../acp/client-manager.js';
import type { ExecutionScheduler } from '../acp/scheduler.js';
import type { SkillService } from '../skills/skill-service.js';
import {
  detectMimeAndPreviewKind,
  resolveContainedWriteTarget,
  sanitizeFileName,
  syncProjectFilesToWorkspace,
} from '../files/workspace.js';
import type { AttachmentRef } from '../types.js';
import { requireAuth, type RouteDeps } from './auth-routes.js';

export interface ChatRouteDeps extends RouteDeps {
  acp: AcpClientManager;
  scheduler: ExecutionScheduler;
  skillService?: SkillService;
}

const createChatSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  effortValue: z.string().nullable().optional(),
});

const patchChatSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  modelId: z.string().nullable().optional(),
  effortValue: z.string().nullable().optional(),
});

const sendMessageSchema = z.object({
  text: z.string().max(100_000),
  attachmentIds: z.array(z.string()).max(20).optional(),
  clientMessageId: z.string().max(128).optional().nullable(),
});

const permissionActionSchema = z.object({
  optionId: z.string().nullable().optional(),
  alwaysAllow: z.boolean().optional(),
  cancel: z.boolean().optional(),
  clientId: z.string().max(128).optional().nullable(),
});

const elicitationContentValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

const elicitationActionSchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), elicitationContentValueSchema).nullable().optional(),
  clientId: z.string().max(128).optional().nullable(),
});

export async function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): Promise<void> {
  const { config, db, hub, acp, scheduler, skillService } = deps;

  const ensureAgyAuthenticated = (userId: string) => {
    const prof = db.getAgyProfile(userId);
    return prof?.authStatus === 'authenticated';
  };

  app.get('/api/agy/options', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    if (!ensureAgyAuthenticated(session.user.id)) {
      return reply.code(403).send({ error: 'AGY_AUTH_REQUIRED', message: 'Antigravity認証が必要です。' });
    }
    const query = (req.query ?? {}) as { modelId?: string };
    const prefs = db.getPreferences(session.user.id);
    const desiredModel = query.modelId?.trim() || prefs.defaultModelId || null;
    try {
      const sessionOptions = await acp.getOrProbeUserOptions(session.user.id, desiredModel);
      return { sessionOptions };
    } catch {
      return { sessionOptions: null };
    }
  });

  app.get('/api/chats', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const query = req.query as { search?: string; projectId?: string };
    const chats = db.listChats(session.user.id, {
      search: query.search,
      projectId: query.projectId,
    });
    const enriched = chats.map((c) => ({
      ...c,
      activeRun: db.getActiveRunForChat(session.user.id, c.id),
    }));
    return { chats: enriched };
  });

  app.post('/api/chats', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;

    if (!ensureAgyAuthenticated(session.user.id)) {
      return reply.code(403).send({
        error: 'AGY_AUTH_REQUIRED',
        message: 'チャットを作成するには先にAntigravity公式認証を完了してください。',
      });
    }

    const parsed = createChatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: '不正な入力です。' });
    }

    let project = null;
    let projectContextVersion = 0;
    if (parsed.data.projectId) {
      project = db.getProject(session.user.id, parsed.data.projectId);
      if (!project) {
        return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: '指定されたプロジェクトが見つかりません。' });
      }
      projectContextVersion = project.contextVersion;
    }

    const chatId = crypto.randomUUID();
    const workspaceDir = path.join(config.workspacesRoot, session.user.id, chatId);
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

    if (project) {
      const files = db.listProjectFiles(session.user.id, project.id);
      if (files.length > 0) {
        syncProjectFilesToWorkspace({
          projectStorageDir: project.storageDir,
          workspaceDir,
          relPaths: files.map((f) => f.relPath),
        });
      }
      skillService?.syncProjectSkillsToChat(session.user.id, project.id, workspaceDir);
    }

    const prefs = db.getPreferences(session.user.id);
    const chat = db.createChat({
      id: chatId,
      userId: session.user.id,
      projectId: project?.id ?? null,
      title: parsed.data.title ?? '新しいチャット',
      workspaceDir,
      modelId: parsed.data.modelId ?? prefs.defaultModelId,
      effortValue: parsed.data.effortValue ?? prefs.defaultEffortValue,
      projectContextVersion,
    });

    let sessionOptions = null;
    try {
      sessionOptions = await acp.ensureSessionOptions(session.user.id, chatId);
    } catch {
      // Allow chat creation to return cleanly; errors will surface visibly on prompt if ACP init fails
    }

    const refreshedChat = db.getChat(session.user.id, chatId)!;
    hub.emitDurable({
      userId: session.user.id,
      type: 'chat.created',
      chatId,
      payload: { chat: refreshedChat },
    });

    return reply.code(201).send({
      chat: refreshedChat,
      sessionOptions,
    });
  });

  app.get('/api/chats/:chatId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });

    const messages = db.listMessages(session.user.id, chatId);
    const artifacts = db.listArtifactsForChat(session.user.id, chatId);
    const pendingPermissions = db.listPendingPermissionsForChat(session.user.id, chatId);
    const pendingElicitations = db.listPendingElicitationsForChat(session.user.id, chatId);
    const activeRun = db.getActiveRunForChat(session.user.id, chatId);
    const project = chat.projectId ? db.getProject(session.user.id, chat.projectId) : null;

    let sessionOptions = null;
    if (ensureAgyAuthenticated(session.user.id)) {
      try {
        sessionOptions = await acp.ensureSessionOptions(session.user.id, chatId);
      } catch {
        sessionOptions = null;
      }
    }

    return {
      chat: db.getChat(session.user.id, chatId),
      messages,
      artifacts,
      pendingPermissions,
      pendingElicitations,
      activeRun,
      project,
      sessionOptions,
    };
  });

  app.patch('/api/chats/:chatId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });

    const parsed = patchChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: '入力値が不正です。' });
    }

    let updated = chat;
    if (parsed.data.title !== undefined) {
      updated = db.updateChat(session.user.id, chatId, { title: parsed.data.title })!;
    }

    let sessionOptions = null;
    if (parsed.data.modelId !== undefined || parsed.data.effortValue !== undefined) {
      if (!ensureAgyAuthenticated(session.user.id)) {
        return reply.code(403).send({ error: 'AGY_AUTH_REQUIRED', message: 'Antigravity認証が必要です。' });
      }
      const res = await acp.setChatConfig(session.user.id, chatId, {
        modelId: parsed.data.modelId,
        effortValue: parsed.data.effortValue,
      });
      updated = res.chat;
      sessionOptions = res.configOptions;
    } else {
      hub.emitDurable({
        userId: session.user.id,
        type: 'chat.updated',
        chatId,
        payload: { chat: updated },
      });
    }

    return { chat: updated, sessionOptions };
  });

  app.delete('/api/chats/:chatId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });

    const active = db.getActiveRunForChat(session.user.id, chatId);
    if (active) {
      await scheduler.cancelRun(session.user.id, chatId, active.id);
    }
    await acp.stopChatWorker(session.user.id, chatId);
    db.deleteChat(session.user.id, chatId);
    fs.rmSync(chat.workspaceDir, { recursive: true, force: true });

    hub.emitDurable({
      userId: session.user.id,
      type: 'chat.deleted',
      chatId,
      payload: { chatId },
    });
    return { ok: true };
  });

  app.post('/api/chats/:chatId/sync-project', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat || !chat.projectId) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'プロジェクトに紐づくチャットが見つかりません。' });
    }
    const project = db.getProject(session.user.id, chat.projectId);
    if (!project) {
      return reply.code(404).send({ error: 'PROJECT_NOT_FOUND', message: 'プロジェクトが存在しません。' });
    }

    const files = db.listProjectFiles(session.user.id, project.id);
    const syncedPaths = syncProjectFilesToWorkspace({
      projectStorageDir: project.storageDir,
      workspaceDir: chat.workspaceDir,
      relPaths: files.map((f) => f.relPath),
    });
    skillService?.syncProjectSkillsToChat(session.user.id, project.id, chat.workspaceDir);

    // Reset ACP worker so next turn loads refreshed project instructions & skills if changed
    await acp.stopChatWorker(session.user.id, chatId);

    const updated = db.updateChat(session.user.id, chatId, {
      projectContextVersion: project.contextVersion,
      acpSessionId: null,
    })!;

    hub.emitDurable({
      userId: session.user.id,
      type: 'chat.updated',
      chatId,
      payload: { chat: updated },
    });

    return { chat: updated, syncedPaths };
  });

  app.post('/api/chats/:chatId/attachments', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });

    fs.mkdirSync(chat.workspaceDir, { recursive: true, mode: 0o700 });
    const attachments: AttachmentRef[] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const filename = sanitizeFileName(part.filename || 'attachment.bin');
      const relInput = `attachments/${Date.now()}-${filename}`;
      const target = resolveContainedWriteTarget(chat.workspaceDir, relInput);
      fs.mkdirSync(path.dirname(target.absPath), { recursive: true, mode: 0o700 });

      const buf = await part.toBuffer();
      await fs.promises.writeFile(target.absPath, buf);
      const { mimeType, previewKind } = detectMimeAndPreviewKind(filename, part.mimetype);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

      const artifact = db.upsertArtifact({
        id: crypto.randomUUID(),
        userId: session.user.id,
        chatId,
        messageId: null,
        runId: null,
        relPath: target.relPath,
        filename,
        mimeType,
        sizeBytes: buf.length,
        sha256,
        source: 'attachment',
        previewKind,
        diffPatch: null,
      });

      attachments.push({
        artifactId: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        relPath: artifact.relPath,
        previewKind: artifact.previewKind,
      });

      hub.emitDurable({
        userId: session.user.id,
        type: 'artifact.created',
        chatId,
        payload: { artifact },
      });
    }

    if (attachments.length === 0) {
      return reply.code(400).send({ error: 'NO_FILES', message: 'ファイルが添付されていません。' });
    }
    return reply.code(201).send({ attachments });
  });

  app.post('/api/chats/:chatId/messages', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;

    if (!ensureAgyAuthenticated(session.user.id)) {
      return reply.code(403).send({
        error: 'AGY_AUTH_REQUIRED',
        message: 'メッセージ送信の前にAntigravity公式認証を完了してください。',
      });
    }

    const { chatId } = req.params as { chatId: string };
    const chat = db.getChat(session.user.id, chatId);
    if (!chat) return reply.code(404).send({ error: 'NOT_FOUND', message: 'チャットが見つかりません。' });

    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: 'メッセージ内容を確認してください。' });
    }

    const attachmentRefs: AttachmentRef[] = [];
    for (const artId of parsed.data.attachmentIds ?? []) {
      const art = db.getArtifact(session.user.id, artId);
      if (art && art.chatId === chatId) {
        attachmentRefs.push({
          artifactId: art.id,
          filename: art.filename,
          mimeType: art.mimeType,
          sizeBytes: art.sizeBytes,
          relPath: art.relPath,
          previewKind: art.previewKind,
        });
      }
    }

    if (!parsed.data.text.trim() && attachmentRefs.length === 0) {
      return reply.code(400).send({ error: 'EMPTY_MESSAGE', message: 'メッセージまたはファイルを指定してください。' });
    }

    const result = scheduler.enqueueTurn({
      userId: session.user.id,
      chatId,
      userText: parsed.data.text,
      attachments: attachmentRefs,
      clientMessageId: parsed.data.clientMessageId,
    });

    return reply.code(result.deduplicated ? 200 : 202).send(result);
  });

  app.post('/api/chats/:chatId/runs/:runId/cancel', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, runId } = req.params as { chatId: string; runId: string };
    const run = await scheduler.cancelRun(session.user.id, chatId, runId);
    if (!run) return reply.code(404).send({ error: 'NOT_FOUND', message: '実行が見つかりません。' });
    return { run };
  });

  app.post('/api/chats/:chatId/permissions/:permissionId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, permissionId } = req.params as { chatId: string; permissionId: string };
    const parsed = permissionActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT' });
    }

    const existing = db.getPermission(session.user.id, permissionId);
    if (!existing || existing.chatId !== chatId) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '承認リクエストが見つかりません。' });
    }

    if (existing.status !== 'pending') {
      return reply.code(409).send({
        error: 'ALREADY_RESOLVED',
        message: 'この承認リクエストは既に別端末または前回操作で処理済みです。',
        permission: existing,
      });
    }

    const resolved = acp.resolvePendingPermission({
      userId: session.user.id,
      chatId,
      permissionId,
      selectedOptionId: parsed.data.optionId ?? null,
      alwaysAllow: parsed.data.alwaysAllow ?? false,
      cancel: parsed.data.cancel ?? false,
      clientId: parsed.data.clientId,
    });

    if (!resolved) {
      return reply.code(409).send({
        error: 'ALREADY_RESOLVED',
        message: 'この承認リクエストは既に処理済みです。',
      });
    }
    return { permission: resolved };
  });

  app.post('/api/chats/:chatId/elicitations/:elicitationId', async (req, reply) => {
    const session = requireAuth(req, reply, db);
    if (!session) return;
    const { chatId, elicitationId } = req.params as { chatId: string; elicitationId: string };
    const parsed = elicitationActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', message: '入力値が不正です。' });
    }

    const existing = db.getElicitation(session.user.id, elicitationId);
    if (!existing || existing.chatId !== chatId) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '質問リクエストが見つかりません。' });
    }

    if (existing.status !== 'pending') {
      return reply.code(409).send({
        error: 'ALREADY_RESOLVED',
        message: 'この質問リクエストは既に処理済みです。',
        elicitation: existing,
      });
    }

    const resolved = acp.resolvePendingElicitation({
      userId: session.user.id,
      chatId,
      elicitationId,
      action: parsed.data.action,
      content: parsed.data.content ?? null,
      clientId: parsed.data.clientId,
    });

    if (!resolved) {
      return reply.code(409).send({
        error: 'ALREADY_RESOLVED',
        message: 'この質問リクエストは既に処理済みです。',
      });
    }
    return { elicitation: resolved };
  });
}
