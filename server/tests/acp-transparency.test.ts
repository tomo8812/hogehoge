import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveAgyPermissionRule } from '../src/acp/client-manager.js';
import { getAgyPermissionRules } from '../src/acp/profile-settings.js';
import type { AcpConfigOption, MessageRecord } from '../src/types.js';
import { PathContainmentError, resolveContainedWriteTarget, supportsWorkspaceTextWrites, writeWorkspaceTextFile } from '../src/files/workspace.js';
import { getMessageActivity } from '../../web/src/utils/messageActivity.js';
import { newerMessage } from '../../web/src/utils/messageSnapshot.js';
import { createTestServer, registerAndBindAgy } from './helpers/test-harness.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('ACP transparency & Reactive Wakeup behavior (Issue #2)', () => {
  it('passes the saved agent mode to new sessions and leaves restored sessions to ACP', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    type ChatResponse = {
      chat: { id: string };
      sessionOptions: { configOptions: AcpConfigOption[] } | null;
    };
    const getMode = (data: ChatResponse) =>
      data.sessionOptions?.configOptions.find((option) => option.category === 'mode')?.currentValue;

    const autoChat = await client.request<ChatResponse>('POST', '/api/chats', { title: 'Auto' });
    expect(autoChat.status).toBe(201);
    expect(getMode(autoChat.data)).toBe('auto');

    expect((await client.request('PATCH', '/api/agy/agent-mode', { agentMode: 'plan' })).status).toBe(200);
    const planChat = await client.request<ChatResponse>('POST', '/api/chats', { title: 'Plan' });
    expect(planChat.status).toBe(201);
    expect(getMode(planChat.data)).toBe('plan');

    const chatUrl = `/api/chats/${planChat.data.chat.id}`;
    expect((await client.request('PATCH', '/api/agy/agent-mode', { agentMode: 'auto' })).status).toBe(200);
    expect(getMode((await client.request<ChatResponse>('GET', chatUrl)).data)).toBe('plan');
    expect(await srv.ctx.acp.stopChatWorkerIfIdle(userId, planChat.data.chat.id)).toBe(true);
    // The mock's session/load returns its native default in a fresh worker.
    expect(getMode((await client.request<ChatResponse>('GET', chatUrl)).data)).toBe('default');

    expect(await srv.ctx.acp.stopChatWorkerIfIdle(userId, planChat.data.chat.id)).toBe(true);
    srv.ctx.db.updateChat(userId, planChat.data.chat.id, { acpSessionId: 'missing-session' });
    expect(getMode((await client.request<ChatResponse>('GET', chatUrl)).data)).toBe('auto');

    const profile = srv.ctx.db.getAgyProfile(userId)!;
    const settingsFile = path.join(profile.profileDir, '.gemini', 'antigravity-cli', 'settings.json');
    fs.writeFileSync(settingsFile, '{}');
    const defaultChat = await client.request<ChatResponse>('POST', '/api/chats', { title: 'Native default' });
    expect(defaultChat.status).toBe(201);
    expect(getMode(defaultChat.data)).toBe('default');
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{}');

    fs.unlinkSync(settingsFile);
    const missingSettingsChat = await client.request<ChatResponse>('POST', '/api/chats', { title: 'Missing settings' });
    expect(missingSettingsChat.status).toBe(201);
    expect(getMode(missingSettingsChat.data)).toBe('default');
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  it.skipIf(!supportsWorkspaceTextWrites)('relays native ACP permission requests and replays activity in ACP order', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);
    const { client } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await client.connectWs();

    const { data: { chat } } = await client.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST', '/api/chats', {}
    );
    const url = `/api/chats/${chat.id}`;
    const send = async (text: string) => {
      const { data: { run } } = await client.request<{ run: { id: string } }>('POST', `${url}/messages`, { text });
      return run.id;
    };
    const waitForPermission = async (runId: string) => {
      const frame = await client.waitForFrame((frame) => {
        if (frame.kind !== 'event') return false;
        const event = frame.event as { type: string; runId: string };
        return event.type === 'permission.requested' && event.runId === runId;
      });
      return (frame.event as { payload: { permission: { id: string } } }).payload.permission;
    };
    const firstRun = await send('[ACTIVITY_SEQUENCE] [PERMISSION]');
    const firstPermission = await waitForPermission(firstRun);
    const filename = path.join(chat.workspaceDir, 'created-by-tool.md');
    expect(fs.existsSync(filename)).toBe(false);
    const approval = await client.request('POST', `${url}/permissions/${firstPermission.id}`, { optionId: 'allow_once' });
    expect(approval.status).toBe(200);
    await client.waitForFrame((frame) =>
      frame.kind === 'event' && (frame.event as { type: string }).type === 'run.finished'
    );
    const fileContent = fs.readFileSync(filename, 'utf8');
    expect(fileContent).toContain('Created with user permission');

    const detail = await client.request<{ messages: MessageRecord[] }>('GET', url);
    const message = detail.data.messages.find((item) => item.role === 'assistant')!;
    expect(message.activity?.map(({ kind }) => kind)).toEqual([
      'thoughts', 'tool', 'tool', 'content', 'tool', 'content', 'answer_end',
    ]);
    const staleSnapshot = { ...message, status: 'streaming' } as const;
    expect(newerMessage(message, staleSnapshot)).toBe(message);
    expect(newerMessage(staleSnapshot, message)).toBe(message);
    const laterSnapshot = { ...staleSnapshot, updatedAt: message.updatedAt + 1 };
    expect(newerMessage(message, laterSnapshot)).toBe(laterSnapshot);

    const activity = getMessageActivity(message);
    expect(activity.blocks.map(({ kind }) => kind)).toEqual(['thoughts', 'tools', 'commentary', 'tools']);
    expect(activity.hasCurrentAnswer).toBe(true);
    expect(message.toolCalls.at(-1)?.diffStats).toEqual({ added: 4, removed: 0 });
    expect(activity.answer).toContain('created-by-tool.md');
    expect(activity.answer).not.toContain('作業フォルダを確認しました');

    fs.chmodSync(filename, 0o200);
    const nextRun = await send('[ACTIVITY_SEQUENCE] [PERMISSION]');
    const nextPermission = await waitForPermission(nextRun);
    expect((await client.request('POST', `${url}/permissions/${nextPermission.id}`, { optionId: 'allow_once' })).status).toBe(200);
    await client.waitForFrame((frame) => {
      if (frame.kind !== 'event') return false;
      const event = frame.event as { type: string; runId: string };
      return event.type === 'run.finished' && event.runId === nextRun;
    });
    const nextDetail = await client.request<{ messages: MessageRecord[] }>('GET', url);
    const updated = nextDetail.data.messages.find((item) => item.role === 'assistant' && item.runId === nextRun)!;
    expect(updated.toolCalls.at(-1)?.status).toBe('completed');
    expect(updated.toolCalls.at(-1)?.diffStats).toBeUndefined();
    const commandIds = [message, updated].flatMap((item) =>
      item.toolCalls.filter((tool) => tool.kind === 'execute').map((tool) => tool.toolCallId)
    );
    expect(new Set(commandIds).size).toBe(4);
    fs.chmodSync(filename, 0o600);

    // Replacing the same in-workspace path with an external symlink requires a decision.
    const outside = path.join(path.dirname(chat.workspaceDir), 'external.md');
    fs.renameSync(filename, outside);
    fs.symlinkSync(outside, filename);
    const blockedRun = await send('[PERMISSION]');
    const permission = await waitForPermission(blockedRun);
    const rejection = await client.request('POST', `${url}/permissions/${permission.id}`, { optionId: 'reject_once' });
    expect(rejection.status).toBe(200);
    expect(() => writeWorkspaceTextFile(chat.workspaceDir, 'created-by-tool.md', 'denied')).toThrow(PathContainmentError);
    fs.symlinkSync(path.dirname(outside), path.join(chat.workspaceDir, 'outside-dir'));
    expect(() => writeWorkspaceTextFile(chat.workspaceDir, 'outside-dir/external.md', 'denied')).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe(fileContent);

    writeWorkspaceTextFile(chat.workspaceDir, 'nested/notes.md', 'nested write');
    const nested = path.join(chat.workspaceDir, 'nested/notes.md');
    expect(fs.readFileSync(nested, 'utf8')).toBe('nested write');
    fs.symlinkSync('nested', path.join(chat.workspaceDir, 'nested-link'));
    writeWorkspaceTextFile(chat.workspaceDir, 'nested-link/via-directory.md', 'directory link write');
    expect(fs.readFileSync(path.join(chat.workspaceDir, 'nested/via-directory.md'), 'utf8')).toBe('directory link write');
    const fileLink = path.join(chat.workspaceDir, 'notes-link.md');
    fs.symlinkSync('nested/notes.md', fileLink);
    writeWorkspaceTextFile(chat.workspaceDir, 'notes-link.md', 'file link write');
    expect(fs.lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(nested, 'utf8')).toBe('file link write');
    fs.chmodSync(nested, 0o400);
    if (process.getuid?.() !== 0) {
      expect(() => writeWorkspaceTextFile(chat.workspaceDir, 'nested/notes.md', 'denied')).toThrow();
      expect(fs.readFileSync(nested, 'utf8')).toBe('file link write');
    }
    fs.chmodSync(nested, 0o200);
    writeWorkspaceTextFile(chat.workspaceDir, 'nested/notes.md', 'write-only update');
    fs.chmodSync(nested, 0o600);
    expect(fs.readFileSync(nested, 'utf8')).toBe('write-only update');
    const danglingLink = path.join(chat.workspaceDir, 'dangling.md');
    fs.symlinkSync(path.join(chat.workspaceDir, 'missing.md'), danglingLink);
    expect(() => resolveContainedWriteTarget(chat.workspaceDir, 'dangling.md')).toThrow(PathContainmentError);
    client.closeWs();
  });

  it.each(['', ' [REMAP_TOOL]'])('reports delayed subagent work once and preserves native status and logs (%s)', async (mode) => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Delayed Subagent Test' }
    );
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: `Run [DELAYED_SUBAGENT]${mode}`,
    });

    const finishedFrame = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );
    expect(
      (finishedFrame.event as { payload?: { run?: { status?: string } } }).payload?.run?.status
    ).toBe('completed');

    // Wait for background child session to reach idle and emit full content
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'message.updated' &&
        Boolean(
          (
            f.event as {
              payload?: {
                message?: {
                  toolCalls?: Array<{ subagentState?: string; subagentContentText?: string }>;
                };
              };
            }
          ).payload?.message?.toolCalls?.some(
            (tc) =>
              tc.subagentState === 'idle' &&
              (tc.subagentContentText?.length ?? 0) > 300
          )
        )
    );

    const detail = await alice.request<{
      messages: MessageRecord[];
      artifacts: Array<{ relPath: string }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistant = detail.data.messages.filter((m) => m.role === 'assistant').pop()!;
    expect(assistant).toBeTruthy();
    expect(assistant.toolCalls).toHaveLength(1);
    const subTc = assistant.toolCalls[0];
    expect(assistant.activity?.filter((entry) => entry.kind === 'tool')).toEqual([
      { kind: 'tool', toolCallId: subTc.toolCallId },
    ]);
    // Native tool_call status ('completed') must not be rewritten to 'in_progress'
    expect(subTc.status).toBe('completed');
    expect(subTc.subagentState).toBe('idle');
    expect(subTc.subagentThoughtsText).toContain('子セッション思考ログ: 詳細解析中...');
    expect((subTc.subagentContentText ?? '').length).toBeGreaterThan(300);
    expect(subTc.subagentToolCalls?.some((c) => c.title === 'child_read_file' && c.status === 'completed')).toBe(
      true
    );

    // Background workspace file creation must be synced as an artifact
    expect(fs.existsSync(path.join(workspaceDir, 'delayed-output.txt'))).toBe(true);
    expect(detail.data.artifacts.some((a) => a.relPath === 'delayed-output.txt')).toBe(true);

    alice.closeWs();
  });

  it('does not revert terminal run status on background requestPermission and still resolves it (#3)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Background Permission Test' }
    );
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    const msgRes = await alice.request<{ run: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: 'Start [BG_PERMISSION]' }
    );
    const runId = msgRes.data.run.id;

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const permFrame = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'permission.requested'
    );
    const permId = (
      permFrame.event as { payload?: { permission?: { id: string } } }
    ).payload?.permission?.id;
    expect(permId).toBeTruthy();

    // Terminal run must remain 'completed' (never reverted to 'awaiting_permission')
    const detailDuringPerm = await alice.request<{
      activeRun: unknown;
    }>('GET', `/api/chats/${chatId}`);
    expect(detailDuringPerm.data.activeRun).toBeNull();
    const runRecord = srv.ctx.db.getRun(userId, runId);
    expect(runRecord?.status).toBe('completed');

    const respondRes = await alice.request(
      'POST',
      `/api/chats/${chatId}/permissions/${permId}`,
      { optionId: 'allow_once' }
    );
    expect(respondRes.status).toBe(200);

    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'message.updated' &&
        Boolean(
          (f.event as { payload?: { message?: { contentText?: string } } }).payload?.message
            ?.contentText?.includes('背景Permissionが承認され完了しました')
        )
    );

    expect(fs.existsSync(path.join(workspaceDir, 'bg-permitted.txt'))).toBe(true);
    alice.closeWs();
  });

  it('persists session_message and session_message_chunk updates in message.sessionMessages (#7)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Session Message Test',
    });
    const chatId = chatRes.data.chat.id;

    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Trigger [SESSION_MESSAGE_TEST]',
    });

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    const detail = await alice.request<{
      messages: Array<{
        role: string;
        contentText: string;
        sessionMessages?: Array<{
          messageId: string;
          senderSessionId?: string;
          recipientSessionId?: string;
          contentText: string;
          done?: boolean;
        }>;
      }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistant = detail.data.messages.filter((m) => m.role === 'assistant').pop()!;
    expect(assistant.contentText).toContain('セッション間メッセージを受信しました。');
    expect(assistant.sessionMessages).toHaveLength(1);
    expect(assistant.sessionMessages?.[0].contentText).toBe('初期本文:チャンク追記完了');
    expect(assistant.sessionMessages?.[0].done).toBe(true);

    alice.closeWs();
  });

  it('keeps worker alive during skill update while background subagent is active and isolates multi-turn background bridges (#1, #2, #8)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Multi-Turn Background Isolation Test',
    });
    const chatId = chatRes.data.chat.id;

    // Turn A starts a background subagent (150ms delay)
    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Turn A [MULTI_TURN_BG]',
    });

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    // Updating skills while background subagent is active must NOT evict the worker (#1, #8)
    const skillRes = await alice.request('POST', '/api/skills', {
      scope: 'global',
      slug: 'bg-safe-skill',
      name: 'BG Safe Skill',
      description: 'Test skill created while background subagent runs',
      instructions: 'Be helpful.',
    });
    expect(skillRes.status).toBe(201);

    // Immediately send Turn B (creating artifacts) while Turn A's background subagent is still running
    const turnBRes = await alice.request<{ run: { id: string } }>(
      'POST',
      `/api/chats/${chatId}/messages`,
      { text: 'ターンB通常応答 [ARTIFACT]' }
    );
    const turnBRunId = turnBRes.data.run.id;

    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === turnBRunId
    );

    // Wait for Turn A's delayed subagent output to arrive
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string }).type === 'message.updated' &&
        Boolean(
          (
            f.event as {
              payload?: {
                message?: {
                  toolCalls?: Array<{ subagentContentText?: string }>;
                };
              };
            }
          ).payload?.message?.toolCalls?.some((tc) =>
            tc.subagentContentText?.includes('ターンA子の遅延出力')
          )
        )
    );

    const detail = await alice.request<{
      messages: Array<{
        id: string;
        role: string;
        contentText: string;
        artifactIds?: string[];
        toolCalls: Array<{ subagentContentText?: string; subagentState?: string }>;
      }>;
      artifacts: Array<{ id: string; relPath: string; messageId: string | null }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistants = detail.data.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    const [turnAAssistant, turnBAssistant] = assistants;

    expect(turnAAssistant.contentText).toContain('ターンA初期応答');
    expect(turnAAssistant.toolCalls[0]?.subagentContentText).toContain('ターンA子の遅延出力');
    expect(turnAAssistant.toolCalls[0]?.subagentState).toBe('idle');

    // Turn B must NOT be polluted by Turn A's background subagent output
    expect(turnBAssistant.contentText).toContain('ターンB通常応答');
    expect(turnBAssistant.contentText).not.toContain('ターンA子の遅延出力');
    expect(turnBAssistant.toolCalls).toHaveLength(0);

    // Turn B's artifacts must remain owned by Turn B (not stolen by Turn A's background sync)
    const summaryArt = detail.data.artifacts.find((a) => a.relPath === 'summary.md');
    expect(summaryArt).toBeTruthy();
    expect(summaryArt?.messageId).toBe(turnBAssistant.id);
    expect(turnAAssistant.artifactIds ?? []).not.toContain(summaryArt?.id);

    alice.closeWs();
  });

  it('does not inject synthetic transcript bridge into user prompts after worker restart (#9)', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Prompt Transparency Test',
    });
    const chatId = chatRes.data.chat.id;

    const r1 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'ファーストメッセージ',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === r1.data.run.id
    );

    // Force idle worker stop so next turn re-loads/re-creates session
    await srv.ctx.acp.stopChatWorkerIfIdle(chatId);

    const r2 = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'セカンドメッセージ',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === r2.data.run.id
    );

    const detail = await alice.request<{
      messages: Array<{ role: string; contentText: string }>;
    }>('GET', `/api/chats/${chatId}`);

    const assistants = detail.data.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[1].contentText).toContain('セカンドメッセージ');
    expect(assistants[1].contentText).not.toContain('[これまでの会話履歴]');

    alice.closeWs();
  });

  it('derives native Antigravity permission rules and persists Always Allow into settings.json transparently', async () => {
    const ws = '/tmp/ws-demo';
    expect(
      deriveAgyPermissionRule({
        toolCall: {
          toolCallId: 'tc-1',
          title: 'call_mcp_tool',
          name: 'call_mcp_tool',
          status: 'pending',
          rawInput: { ServerName: 'linear', ToolName: 'create_issue' },
        },
        workspaceDir: ws,
        sandboxWorkspaceRoot: '/workspace',
      })
    ).toBe('mcp(linear/create_issue)');

    expect(
      deriveAgyPermissionRule({
        toolCall: {
          toolCallId: 'tc-2',
          title: 'mcp_my_srv_fetch',
          name: 'mcp_my_srv_fetch',
          status: 'pending',
        },
        workspaceDir: ws,
        sandboxWorkspaceRoot: '/workspace',
        knownMcpServerNames: ['my_srv'],
      })
    ).toBe('mcp(my_srv/fetch)');

    expect(
      deriveAgyPermissionRule({
        toolCall: {
          toolCallId: 'tc-3',
          title: 'Run command',
          name: 'run_command',
          kind: 'execute',
          status: 'pending',
          rawInput: { CommandLine: 'git status' },
        },
        workspaceDir: ws,
        sandboxWorkspaceRoot: '/workspace',
      })
    ).toBe('command(git status)');

    expect(
      deriveAgyPermissionRule({
        toolCall: {
          toolCallId: 'tc-4',
          title: 'Read URL',
          name: 'read_url_content',
          kind: 'fetch',
          status: 'pending',
          rawInput: { Url: 'https://docs.example.com/guide' },
        },
        workspaceDir: ws,
        sandboxWorkspaceRoot: '/workspace',
      })
    ).toBe('read_url(docs.example.com)');

    expect(
      deriveAgyPermissionRule({
        toolCall: {
          toolCallId: 'interaction_abc',
          title: 'Ask question',
          status: 'pending',
        },
        workspaceDir: ws,
        sandboxWorkspaceRoot: '/workspace',
      })
    ).toBeNull();

    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string; workspaceDir: string } }>(
      'POST',
      '/api/chats',
      { title: 'Always Allow Chat Test' }
    );
    const chatId = chatRes.data.chat.id;
    const workspaceDir = chatRes.data.chat.workspaceDir;

    await alice.request('POST', `/api/chats/${chatId}/messages`, {
      text: 'Run [PERMISSION]',
    });

    const permFrame = await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'permission.requested'
    );
    const perm = (
      permFrame.event as { payload?: { permission?: { id: string; alwaysAllowRule?: string | null } } }
    ).payload?.permission;
    expect(perm?.id).toBeTruthy();
    expect(perm?.alwaysAllowRule).toBe('write_file(created-by-tool.md)');

    const resolveRes = await alice.request('POST', `/api/chats/${chatId}/permissions/${perm!.id}`, {
      optionId: 'allow_once',
      alwaysAllow: true,
    });
    expect(resolveRes.status).toBe(200);

    await alice.waitForFrame(
      (f) => f.kind === 'event' && (f.event as { type: string }).type === 'run.finished'
    );

    expect(fs.existsSync(path.join(workspaceDir, 'created-by-tool.md'))).toBe(true);
    const profile = srv.ctx.db.getAgyProfile(userId)!;
    expect(getAgyPermissionRules(profile.profileDir).allow).toContain('write_file(created-by-tool.md)');

    alice.closeWs();
  });

  it('supports interaction_* questions, ACP elicitation form/url modes, completion, cancel, and recovery', async () => {
    const srv = await createTestServer();
    cleanups.push(srv.cleanup);

    const { client: alice, userId } = await registerAndBindAgy(srv.baseUrl, 'alice', 'user:alice@gmail.com');
    await alice.connectWs();

    const chatRes = await alice.request<{ chat: { id: string } }>('POST', '/api/chats', {
      title: 'Question Support Test',
    });
    const chatId = chatRes.data.chat.id;

    // 1) interaction_* question via session/request_permission
    const qRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '[QUESTION_INTERACTION]',
    });
    const qPermFrame = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId: string }).type === 'permission.requested' &&
        (f.event as { runId: string }).runId === qRun.data.run.id
    );
    const qPerm = (
      qPermFrame.event as {
        payload: {
          permission: {
            id: string;
            toolCall: { toolCallId: string; title: string };
            alwaysAllowRule?: string | null;
          };
        };
      }
    ).payload.permission;
    expect(qPerm.toolCall.toolCallId).toBe('interaction_q1');
    expect(qPerm.alwaysAllowRule).toBeNull();

    const qAns = await alice.request('POST', `/api/chats/${chatId}/permissions/${qPerm.id}`, {
      optionId: '2',
    });
    expect(qAns.status).toBe(200);
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === qRun.data.run.id
    );

    // 2) ACP elicitation/create (form mode) + REST persistence + duplicate 409 check
    const fRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '[ELICITATION_FORM]',
    });
    const fReqFrame = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId: string }).type === 'elicitation.requested' &&
        (f.event as { runId: string }).runId === fRun.data.run.id
    );
    const fElicit = (
      fReqFrame.event as {
        payload: {
          elicitation: {
            id: string;
            mode: string;
            message: string;
            requestedSchema: { properties: Record<string, unknown>; required?: string[] } | null;
          };
        };
      }
    ).payload.elicitation;
    expect(fElicit.mode).toBe('form');
    expect(fElicit.requestedSchema?.required).toEqual(['framework']);

    const midDetail = await alice.request<{
      pendingElicitations: Array<{ id: string }>;
      activeRun: { status: string } | null;
    }>('GET', `/api/chats/${chatId}`);
    expect(midDetail.data.pendingElicitations.some((e) => e.id === fElicit.id)).toBe(true);
    expect(midDetail.data.activeRun?.status).toBe('awaiting_permission');

    const fAns = await alice.request('POST', `/api/chats/${chatId}/elicitations/${fElicit.id}`, {
      action: 'accept',
      content: {
        framework: 'react',
        features: ['ts', 'test'],
        notes: 'App Router は不要',
        strictMode: true,
      },
    });
    expect(fAns.status).toBe(200);

    // Duplicate resolution returns 409 ALREADY_RESOLVED
    const dupAns = await alice.request('POST', `/api/chats/${chatId}/elicitations/${fElicit.id}`, {
      action: 'decline',
    });
    expect(dupAns.status).toBe(409);

    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === fRun.data.run.id
    );

    // 3) ACP elicitation/create (url mode) + elicitation/complete notification
    const uRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '[ELICITATION_URL] [AUTO_COMPLETE_URL]',
    });
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId: string }).type === 'elicitation.resolved' &&
        (f.event as { runId: string }).runId === uRun.data.run.id
    );
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === uRun.data.run.id
    );

    // 4) Cancel run while elicitation is pending
    const cRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: '[ELICITATION_URL]',
    });
    const cReqFrame = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId: string }).type === 'elicitation.requested' &&
        (f.event as { runId: string }).runId === cRun.data.run.id
    );
    const cElicitId = (
      cReqFrame.event as { payload: { elicitation: { id: string } } }
    ).payload.elicitation.id;

    const cancelRes = await alice.request('POST', `/api/chats/${chatId}/runs/${cRun.data.run.id}/cancel`, {});
    expect(cancelRes.status).toBe(200);
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === cRun.data.run.id
    );
    expect(srv.ctx.db.getElicitation(userId, cElicitId)?.status).toBe('cancelled');

    // Verify all agent outputs in chat detail
    const finalDetail = await alice.request<{
      pendingElicitations: unknown[];
      messages: Array<{ role: string; contentText: string }>;
    }>('GET', `/api/chats/${chatId}`);
    expect(finalDetail.data.pendingElicitations).toHaveLength(0);
    const assistantTexts = finalDetail.data.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.contentText);
    expect(assistantTexts[0]).toContain('質問への回答: optionId=2');
    expect(assistantTexts[1]).toContain('action=accept');
    expect(assistantTexts[1]).toContain('"framework":"react"');
    expect(assistantTexts[1]).toContain('capForm=true, capUrl=true');
    expect(assistantTexts[2]).toContain('URL Elicitation結果: action=accept');

    // 5) DB recovery cancels leftover pending elicitations
    const syntheticRunId = 'run-recover-elicit';
    srv.ctx.db.createRun({
      id: syntheticRunId,
      chatId,
      userId,
      userMessageId: 'u-rec',
      assistantMessageId: 'a-rec',
      status: 'awaiting_permission',
      queuePosition: 0,
      modelId: null,
      effortValue: null,
    });
    const leftover = srv.ctx.db.createPendingElicitation({
      id: 'elicit-recover-1',
      runId: syntheticRunId,
      chatId,
      userId,
      mode: 'form',
      message: 'Unanswered question',
      requestedSchema: { type: 'object', properties: {} },
    });
    expect(leftover.status).toBe('pending');
    srv.ctx.db.recoverInterruptedRuns();
    expect(srv.ctx.db.getElicitation(userId, 'elicit-recover-1')?.status).toBe('cancelled');

    // 6) Selecting a reject option with alwaysAllow=true must NOT persist alwaysAllowRule
    const rejectRun = await alice.request<{ run: { id: string } }>('POST', `/api/chats/${chatId}/messages`, {
      text: 'Reject [PERMISSION]',
    });
    const rPermFrame = await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; runId: string }).type === 'permission.requested' &&
        (f.event as { runId: string }).runId === rejectRun.data.run.id
    );
    const rPermId = (rPermFrame.event as { payload: { permission: { id: string } } }).payload.permission.id;
    const rejectRes = await alice.request('POST', `/api/chats/${chatId}/permissions/${rPermId}`, {
      optionId: 'reject_once',
      alwaysAllow: true,
    });
    expect(rejectRes.status).toBe(200);
    await alice.waitForFrame(
      (f) =>
        f.kind === 'event' &&
        (f.event as { type: string; payload?: { run?: { id: string } } }).type === 'run.finished' &&
        (f.event as { payload?: { run?: { id: string } } }).payload?.run?.id === rejectRun.data.run.id
    );
    const profileAfterReject = srv.ctx.db.getAgyProfile(userId)!;
    expect(getAgyPermissionRules(profileAfterReject.profileDir).allow).not.toContain('write_file(created-by-tool.md)');

    alice.closeWs();
  });
});

