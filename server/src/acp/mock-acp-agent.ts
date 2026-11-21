/**
 * ACP-compliant mock agent powered strictly by official @agentclientprotocol/sdk (`agent()`).
 * Used ONLY when `AGY_MODE=mock` for integration tests & offline UI verification.
 * Simulates unmodified `agy`:
 *   - `--login`: outputs unbroken Google OAuth URL in terminal and reads pasted code from stdin
 *   - `auth logout`: clears its own internal `$HOME/.mock-agy-auth.json`
 *   - `-p /usage --output-format json`: emits per-profile JSON usage info
 *   - `acp`: runs stdio JSON-RPC ACP agent enforcing auth via `-32000`, configOptions, streaming chunks,
 *            tool calls, `session/request_permission`, `session/cancel`, and file creation inside `cwd`.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockArtifactBytes } from './mock-artifact-fixtures.js';
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type ContentBlock,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';

const args = process.argv.slice(2);
const homeDir = process.env.HOME || process.cwd();
const authMarkerFile = path.join(homeDir, '.mock-agy-auth.json');

function readMockAuth(): { authenticated: boolean; label: string; method: string } | null {
  if (process.env.GEMINI_API_KEY) {
    return { authenticated: true, label: 'api-key-user', method: 'gemini-api-key' };
  }
  if (!fs.existsSync(authMarkerFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(authMarkerFile, 'utf8'));
  } catch {
    return null;
  }
}

async function runCliLogin(): Promise<number> {
  const stateToken = Buffer.from(homeDir).toString('base64url').slice(0, 12);
  process.stdout.write(
    `\nPlease visit the following URL to authorize Antigravity:\n` +
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=antigravity-cli-mock&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid+email&state=${stateToken}\n\n` +
      `Enter the authorization code: `
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const code = await new Promise<string>((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
  });

  if (!code || code.toLowerCase() === 'invalid') {
    process.stderr.write('\nAuthorization failed: invalid code.\n');
    return 1;
  }

  fs.mkdirSync(homeDir, { recursive: true });
  const label = code.startsWith('user:') ? code.slice(5) : `mock-account-${stateToken}`;
  fs.writeFileSync(
    authMarkerFile,
    JSON.stringify({ authenticated: true, label, method: 'oauth-personal', codeSuffix: code.slice(-4) }),
    'utf8'
  );
  process.stdout.write(`\nSuccessfully authenticated as ${label}.\n`);
  return 0;
}

function runCliLogout(): number {
  if (fs.existsSync(authMarkerFile)) {
    fs.unlinkSync(authMarkerFile);
  }
  process.stdout.write('Logged out of Antigravity CLI.\n');
  return 0;
}

function runCliUsage(): number {
  const auth = readMockAuth();
  if (!auth) {
    process.stderr.write('Authentication required.\n');
    return 1;
  }
  // agy normalizes the user's settings on headless startup.
  const settingsFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json');
  if (fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (settings.agentMode === 'auto') {
      delete settings.agentMode;
      const temporary = `${settingsFile}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(settings));
      fs.renameSync(temporary, settingsFile);
    }
  }
  const suffix = auth.label.includes('b') ? 42 : 84;
  const payload = {
    account: auth.label,
    buckets: [
      {
        model: 'gemini-2.5-pro',
        remainingPercent: suffix,
        usedPercent: 100 - suffix,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
        status: 'ok',
      },
      {
        model: 'gemini-2.5-flash',
        remainingPercent: 95,
        usedPercent: 5,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
        status: 'ok',
      },
    ],
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  return 0;
}

interface SessionState {
  id: string;
  cwd: string;
  modelId: string;
  effortValue: string;
  mode: string;
  systemPromptText: string | null;
  mcpServers: unknown[];
  history: string[];
  cancelled: boolean;
}

function buildConfigOptions({ modelId, effortValue, mode }: SessionState): SessionConfigOption[] {
  const isFlash = modelId === 'gemini-2.5-flash';
  const effortOptions = isFlash
    ? [
        { value: 'low', name: 'Low', description: '高速応答' },
        { value: 'medium', name: 'Medium', description: '標準バランス' },
      ]
    : [
        { value: 'low', name: 'Low', description: '軽量推論' },
        { value: 'medium', name: 'Medium', description: '標準推論' },
        { value: 'high', name: 'High', description: '深い推論' },
      ];
  const validEffort = effortOptions.some((o) => o.value === effortValue) ? effortValue : effortOptions[0].value;

  return [
    {
      id: 'mode',
      name: 'Agent Mode',
      category: 'mode',
      type: 'select',
      currentValue: mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept Edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelId,
      options: [
        { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '高度な推論・分析・構成向け' },
        { value: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: '高速レスポンス向け' },
        { value: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', description: '最新プレビューモデル' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: validEffort,
      options: effortOptions,
    },
  ];
}

interface MockDiscoveredSkill {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  scope: 'global' | 'workspace';
}

function parseMockSkillFile(raw: string, fallbackSlug: string): { name: string; description: string; instructions: string } {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) {
    return { name: fallbackSlug, description: fallbackSlug, instructions: normalized.trim() };
  }
  const fm = match[1];
  const body = (match[2] ?? '').trim();
  const nameMatch = /^name\s*:\s*(.+)$/m.exec(fm);
  const descMatch = /^description\s*:\s*(.+)$/m.exec(fm);
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
  return {
    name: nameMatch ? unquote(nameMatch[1]) : fallbackSlug,
    description: descMatch ? unquote(descMatch[1]) : fallbackSlug,
    instructions: body,
  };
}

function discoverMockActiveSkills(home: string, cwd: string): MockDiscoveredSkill[] {
  const bySlug = new Map<string, MockDiscoveredSkill>();
  const scanRoots: Array<{ dir: string; scope: 'global' | 'workspace' }> = [
    { dir: path.join(home, '.gemini', 'skills'), scope: 'global' },
    { dir: path.join(home, '.gemini', 'antigravity', 'skills'), scope: 'global' },
    { dir: path.join(home, '.gemini', 'config', 'skills'), scope: 'global' },
    { dir: path.join(cwd, '.agent', 'skills'), scope: 'workspace' },
    { dir: path.join(cwd, '.agents', 'skills'), scope: 'workspace' },
  ];

  for (const root of scanRoots) {
    if (!fs.existsSync(root.dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillMd = path.join(root.dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      try {
        const parsed = parseMockSkillFile(fs.readFileSync(skillMd, 'utf8'), entry.name);
        bySlug.set(entry.name, {
          slug: entry.name,
          name: parsed.name,
          description: parsed.description,
          instructions: parsed.instructions,
          scope: root.scope,
        });
      } catch {
        // ignore unreadable skill
      }
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function buildAvailableCommandsForSession(home: string, cwd: string) {
  const skills = discoverMockActiveSkills(home, cwd);
  const cmds: Array<{ name: string; description: string }> = [
    { name: 'compact', description: '会話履歴を圧縮してコンテキストを節約' },
  ];
  for (const s of skills) {
    cmds.push({ name: s.slug, description: s.description || s.name });
  }
  return cmds;
}

function runAcpServer(): void {
  const sessions = new Map<string, SessionState>();
  let seqCounter = 0;
  let advertisedCapabilities: Record<string, unknown> | undefined;

  const requireAuthenticated = () => {
    const auth = readMockAuth();
    if (!auth && process.env.MOCK_ALLOW_UNAUTH !== '1') {
      throw new RequestError(-32000, 'Authentication required: run agy acp --login');
    }
    return auth;
  };

  const app = agent({ name: 'mock-agy-acp' })
    .onRequest(methods.agent.initialize, async ({ params }) => {
      advertisedCapabilities = params.clientCapabilities as Record<string, unknown> | undefined;
      if (process.env.MOCK_CLIENT_INFO_PATH) {
        try {
          fs.writeFileSync(
            process.env.MOCK_CLIENT_INFO_PATH,
            JSON.stringify(params.clientInfo ?? null),
            'utf8'
          );
        } catch {
          // ignore
        }
      }
      return {
        protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: {
            http: true,
            sse: true,
          },
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: true,
          },
          sessionCapabilities: {
            list: {},
            resume: {},
            close: {},
            systemPrompt: {
              mode: { override: {} },
            },
          },
          auth: { logout: {} },
        },
        authMethods: [
          { id: 'oauth-personal', name: 'Login with Google', description: 'Google OAuth authorization code' },
          { id: 'gemini-api-key', name: 'Gemini API Key', description: 'Use GEMINI_API_KEY env' },
        ],
        agentInfo: {
          name: 'mock-agy-acp',
          title: 'Mock Antigravity ACP',
          version: '1.5.9-mock',
        },
      };
    })
    .onRequest(methods.agent.logout, async () => {
      if (fs.existsSync(authMarkerFile)) fs.unlinkSync(authMarkerFile);
      return {};
    })
    .onRequest(methods.agent.session.new, async ({ params, client }) => {
      requireAuthenticated();
      seqCounter += 1;
      const id = `mock-sess-${seqCounter}-${Date.now()}`;
      const sysText =
        params.systemPrompt?.content
          ?.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n') ?? null;

      const state: SessionState = {
        id,
        cwd: params.cwd,
        modelId: 'gemini-2.5-pro',
        effortValue: 'medium',
        mode: 'default',
        systemPromptText: sysText,
        mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
        history: [],
        cancelled: false,
      };
      sessions.set(id, state);
      await client.notify(methods.client.session.update, {
        sessionId: id,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: buildAvailableCommandsForSession(homeDir, state.cwd),
        },
      });
      return {
        sessionId: id,
        configOptions: buildConfigOptions(state),
      };
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      requireAuthenticated();
      let state = sessions.get(params.sessionId);
      if (!state) {
        // Persist across simulated ACP restarts if sessionId starts with mock-sess-
        if (!params.sessionId.startsWith('mock-sess-')) {
          throw new RequestError(-32002, 'Session not found');
        }
        state = {
          id: params.sessionId,
          cwd: params.cwd,
          modelId: 'gemini-2.5-pro',
          effortValue: 'medium',
          mode: 'default',
          systemPromptText: null,
          mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
          history: [],
          cancelled: false,
        };
        sessions.set(params.sessionId, state);
      } else {
        state.mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      }
      await client.notify(methods.client.session.update, {
        sessionId: state.id,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: buildAvailableCommandsForSession(homeDir, state.cwd),
        },
      });
      return {
        configOptions: buildConfigOptions(state),
      };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      requireAuthenticated();
      let state = sessions.get(params.sessionId);
      if (!state) {
        if (!params.sessionId.startsWith('mock-sess-')) {
          throw new RequestError(-32002, 'Session not found');
        }
        state = {
          id: params.sessionId,
          cwd: params.cwd,
          modelId: 'gemini-2.5-pro',
          effortValue: 'medium',
          mode: 'default',
          systemPromptText: null,
          mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
          history: [],
          cancelled: false,
        };
        sessions.set(params.sessionId, state);
      } else {
        state.mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
      }
      await client.notify(methods.client.session.update, {
        sessionId: state.id,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: buildAvailableCommandsForSession(homeDir, state.cwd),
        },
      });
      return {
        configOptions: buildConfigOptions(state),
      };
    })
    .onRequest(methods.agent.session.setConfigOption, async ({ params, client }) => {
      requireAuthenticated();
      const state = sessions.get(params.sessionId);
      if (!state) throw new RequestError(-32002, 'Session not found');
      if (params.configId === 'model' && typeof params.value === 'string') {
        state.modelId = params.value;
      } else if (params.configId === 'reasoning_effort' && typeof params.value === 'string') {
        state.effortValue = params.value;
      } else if (params.configId === 'mode' && typeof params.value === 'string') {
        state.mode = params.value;
      }
      const configOptions = buildConfigOptions(state);
      const effortOpt = configOptions.find((c) => c.id === 'reasoning_effort');
      if (effortOpt && effortOpt.type === 'select') {
        state.effortValue = effortOpt.currentValue;
      }
      await client.notify(methods.client.session.update, {
        sessionId: state.id,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions,
        },
      });
      return { configOptions };
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      sessions.delete(params.sessionId);
      return {};
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const state = sessions.get(params.sessionId);
      if (state) state.cancelled = true;
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const auth = requireAuthenticated();
      const state = sessions.get(ctx.params.sessionId);
      if (!state) throw new RequestError(-32002, 'Session not found');
      state.cancelled = false;

      const textParts: string[] = [];
      for (const block of ctx.params.prompt) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'resource_link') textParts.push(`[添付: ${block.name}]`);
        else if (block.type === 'image') textParts.push(`[画像: ${block.mimeType}]`);
      }
      const promptText = textParts.join('\n').trim();
      state.history.push(promptText);

      const sendUpdate = async (update: Parameters<AgentContext['notify']>[1]) => {
        await ctx.client.notify(methods.client.session.update, update as never);
      };

      const activeSkills = discoverMockActiveSkills(homeDir, state.cwd);
      const slashMatch = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/i.exec(promptText);
      const matchedSkill = slashMatch
        ? activeSkills.find((s) => s.slug === slashMatch[1].toLowerCase()) ?? null
        : null;

      // Emit thought chunk
      await sendUpdate({
        sessionId: state.id,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: {
            type: 'text',
            text: matchedSkill
              ? `[Skill Active: /${matchedSkill.slug} (${matchedSkill.scope})] ${matchedSkill.instructions.slice(0, 120)}\nモデル ${state.modelId} (effort=${state.effortValue}) でリクエストを確認しています...\n`
              : `モデル ${state.modelId} (effort=${state.effortValue}) でリクエストを確認しています...\n`,
          },
        },
      });

      // Sleep support for concurrency / cancellation tests
      const sleepMatch = /\[SLEEP_MS:(\d+)\]/.exec(promptText);
      if (sleepMatch) {
        const total = Math.min(Number(sleepMatch[1]), 15_000);
        const step = 40;
        for (let elapsed = 0; elapsed < total; elapsed += step) {
          if (state.cancelled) {
            return { stopReason: 'cancelled' as const };
          }
          await delay(step);
        }
      }

      if (state.cancelled) {
        return { stopReason: 'cancelled' as const };
      }

      if (promptText.includes('[MCP_INSPECT]')) {
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `MCP_SERVERS:${JSON.stringify(state.mcpServers)}`,
            },
          },
        });
        return { stopReason: 'end_turn' as const };
      }

      // Simulate out-of-workspace permission request (must be auto-rejected by client without prompting user)
      let outsidePermissionNotes = '';
      if (promptText.includes('[OUTSIDE_PERMISSION]')) {
        const outsidePath = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', state.id, 'outside-secret.txt');
        const permRes = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: state.id,
          toolCall: {
            toolCallId: `tc-outside-${Date.now()}`,
            title: `Read ${outsidePath}`,
            kind: 'read',
            status: 'pending',
            locations: [{ path: outsidePath }],
          },
          options: [
            { optionId: 'allow_once', name: '許可', kind: 'allow_once' },
            { optionId: 'reject_once', name: '拒否', kind: 'reject_once' },
          ],
        });
        const allowed =
          permRes.outcome.outcome === 'selected' && permRes.outcome.optionId.startsWith('allow');
        outsidePermissionNotes = allowed
          ? '\n[OUTSIDE_ALLOWED_UNEXPECTED]'
          : '\n[OUTSIDE_BLOCKED_AUTOMATICALLY] `/workspace` 外へのアクセスは拒否されました。';
      }

      // Simulate native Antigravity invoke_subagent ("完了したらお知らせします" -> end_turn -> background subagent -> reactive wakeup)
      if (promptText.includes('[SUBAGENT_IMAGE]')) {
        const subToolId = `tc-subagent-${Date.now()}`;
        const childSessionId = `${state.id}-subagent-1`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: subToolId,
            title: 'invoke_subagent',
            kind: 'other',
            status: 'in_progress',
            rawInput: {
              Subagents: [
                {
                  TypeName: 'media',
                  Role: 'Image Generator',
                  Prompt: 'Generate a cute cyber cat',
                },
              ],
            },
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'subagent_update',
            sessionId: childSessionId,
            title: 'Image Generator',
            description: 'media',
            state: { state: 'running' },
          },
        });
        // invoke_subagent returns immediately once the background subagent is spawned
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: subToolId,
            status: 'completed',
            rawOutput: { conversationId: childSessionId },
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: '画像生成サブエージェントを起動しました。完了したらお知らせします。',
            },
          },
        });

        // Background subagent runs asynchronously after initial session/prompt returns end_turn,
        // writes image to brain directory, and triggers native Reactive Wakeup on parent session
        void (async () => {
          await delay(80);
          if (state.cancelled) return;
          const brainSessionDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', childSessionId);
          fs.mkdirSync(brainSessionDir, { recursive: true, mode: 0o700 });
          const subagentImgPath = path.join(brainSessionDir, 'subagent-art.png');
          const minimalPng = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64'
          );
          fs.writeFileSync(subagentImgPath, minimalPng);

          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'subagent_update',
              sessionId: childSessionId,
              title: 'Image Generator',
              state: { state: 'idle', stopReason: 'end_turn' },
            },
          });

          // Parent session reactive wakeup starts (`state_update: running`), streams continuation response,
          // and reports `state_update: idle` when done
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'state_update',
              state: 'running',
              background: [],
            },
          });

          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `サブエージェントによる画像生成が完了しました！\n\n![生成イラスト](${subagentImgPath})`,
              },
            },
          });

          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'state_update',
              state: 'idle',
              stopReason: 'end_turn',
              background: [],
            },
          });
        })();

        return { stopReason: 'end_turn' as const };
      }

      // Exercise all file delivery channels after the native foreground turn has ended.
      if (promptText.includes('[SUBAGENT_FILES]')) {
        const childId = `${state.id}-file-worker`;
        const toolId = `${childId}-launch`;
        await sendUpdate({ sessionId: state.id, update: {
          sessionUpdate: 'tool_call', toolCallId: toolId, title: 'invoke_subagent', status: 'completed',
          rawInput: { Subagents: [{ Role: 'File Worker' }] },
        } });
        await sendUpdate({ sessionId: state.id, update: {
          sessionUpdate: 'subagent_update', sessionId: childId, toolCallId: toolId, state: { state: 'running' },
        } });
        void (async () => {
          await delay(80);
          if (state.cancelled) return;
          const dir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', childId);
          fs.mkdirSync(dir, { recursive: true });
          await sendUpdate({ sessionId: state.id, update: { sessionUpdate: 'state_update', state: 'running' } });
          for (const ext of ['png', 'svg', 'pdf', 'docx', 'xlsx', 'pptx', 'zip', 'md', 'csv', 'html', 'wav', 'mp4'] as const) {
            const filename = `report (v1) [final] #50%.${ext}`;
            const file = path.join(dir, filename);
            fs.writeFileSync(file, mockArtifactBytes(ext));
            const uri = pathToFileURL(file).href.replace(/[()[\]]/g, c => `%${c.charCodeAt(0).toString(16)}`);
            const text = `[${ext} file](${uri})`;
            const split = text.indexOf('/brain/');
            for (const chunk of [text.slice(0, split), text.slice(split)]) {
              await sendUpdate({ sessionId: childId, update: {
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk },
              } });
              await sendUpdate({ sessionId: childId, update: {
                sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk },
              } });
              await sendUpdate({ sessionId: state.id, update: {
                sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk },
              } });
              await sendUpdate({ sessionId: state.id, update: {
                sessionUpdate: 'session_message_chunk', messageId: `file-${ext}`,
                senderSessionId: childId, content: { type: 'text', text: chunk }, done: false,
              } as never });
            }
            await sendUpdate({ sessionId: state.id, update: {
              sessionUpdate: 'session_message', messageId: `file-${ext}`, done: true,
            } as never });
            await sendUpdate({ sessionId: childId, update: {
              sessionUpdate: 'tool_call', toolCallId: `file-tool-${ext}`, title: `Export ${ext}`, status: 'completed',
              locations: [{ path: file }], rawOutput: { path: file },
              content: [
                { type: 'content', content: { type: 'text', text } },
                { type: 'content', content: { type: 'text', text: 'Tool result complete' } },
                { type: 'content', content: { type: 'resource_link', uri: file, name: filename } },
              ],
            } });
            await sendUpdate({ sessionId: childId, update: {
              sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: file, name: filename },
            } });
          }
          // Deliberately conflicting extension: explicit native image/png must win over .svg.
          const declaredFile = path.join(dir, 'declared-source.svg');
          fs.writeFileSync(declaredFile, mockArtifactBytes('png'));
          const declaredBlock: ContentBlock = {
            type: 'resource_link', uri: pathToFileURL(declaredFile).href,
            name: 'declared image.svg', mimeType: 'image/png',
          };
          await sendUpdate({ sessionId: childId, update: {
            sessionUpdate: 'agent_message_chunk', content: declaredBlock,
          } });
          const inlineBlocks: ContentBlock[] = [
            { type: 'resource', resource: { uri: 'artifact:///inline%20notes.md', mimeType: 'text/markdown', text: '# Inline notes' } },
            { type: 'resource', resource: { uri: 'artifact:///inline%20document.bin', mimeType: 'application/pdf', blob: mockArtifactBytes('pdf').toString('base64') } },
            { type: 'resource', resource: { uri: 'artifact:///empty.txt', mimeType: 'text/plain', text: '' } },
            { type: 'resource', resource: { uri: 'artifact:///shared.bin', mimeType: 'application/octet-stream', blob: mockArtifactBytes('png').toString('base64') } },
            { type: 'resource', resource: { uri: 'artifact:///shared.bin', mimeType: 'image/png', blob: mockArtifactBytes('png').toString('base64') } },
            { type: 'audio', mimeType: 'audio/wav', data: mockArtifactBytes('wav').toString('base64') },
            { type: 'image', mimeType: 'image/png', data: mockArtifactBytes('png').toString('base64') },
            { type: 'image', mimeType: 'image/png', data: mockArtifactBytes('pngAlternate').toString('base64') },
          ];
          for (const [i, block] of inlineBlocks.entries()) {
            await sendUpdate({ sessionId: childId, update: { sessionUpdate: 'agent_message_chunk', content: block } });
            await sendUpdate({ sessionId: state.id, update: { sessionUpdate: 'agent_message_chunk', content: block } });
            await sendUpdate({ sessionId: childId, update: { sessionUpdate: 'agent_thought_chunk', content: block } });
            await sendUpdate({ sessionId: state.id, update: { sessionUpdate: 'agent_thought_chunk', content: block } });
            await sendUpdate({ sessionId: childId, update: {
              sessionUpdate: 'tool_call', toolCallId: `inline-${i}`, title: 'Inline file', status: 'completed',
              content: [{ type: 'content', content: block }],
            } });
            await sendUpdate({ sessionId: state.id, update: {
              sessionUpdate: 'session_message', messageId: `inline-${i}`, content: [block], done: true,
            } as never });
          }
          await sendUpdate({ sessionId: childId, update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });
          await sendUpdate({ sessionId: state.id, update: {
            sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn', background: [],
          } });
        })();
        return { stopReason: 'end_turn' as const };
      }

      // [DELAYED_SUBAGENT]: invoke_subagent completes BEFORE subagent_update(running) arrives (#18, #5, #6, #13)
      if (promptText.includes('[DELAYED_SUBAGENT]')) {
        const remap = promptText.includes('[REMAP_TOOL]');
        const subToolId = `tc-delayed-sub-${Date.now()}`;
        const childSessionId = `${state.id}-delayed-sub-1`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: subToolId,
            title: remap ? 'ツール実行' : 'invoke_subagent',
            kind: 'other',
            status: 'in_progress',
            ...(remap ? {} : {
              rawInput: { Subagents: [{ TypeName: 'research', Role: 'Delayed Worker', Prompt: 'Research' }] },
            }),
          },
        });
        if (remap) {
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'subagent_update',
              sessionId: childSessionId,
              title: 'Delayed Worker',
              state: { state: 'running' },
            },
          });
        }
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call_update',
            ...(remap ? { title: 'invoke_subagent' } : {}),
            toolCallId: subToolId,
            status: 'completed',
            rawOutput: { conversationId: childSessionId },
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '非同期サブエージェントを起動しました。' },
          },
        });

        void (async () => {
          await delay(60);
          if (state.cancelled) return;
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'subagent_update',
              sessionId: childSessionId,
              toolCallId: subToolId,
              title: 'Delayed Worker',
              state: { state: 'running' },
            },
          });
          await sendUpdate({
            sessionId: childSessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: '子セッション思考ログ: 詳細解析中...' },
            },
          });
          await sendUpdate({
            sessionId: childSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `${childSessionId}-tc-1`,
              title: 'child_read_file',
              kind: 'read',
              status: 'completed',
            },
          });
          const longChildText = '子セッション出力テスト: ' + 'A'.repeat(350);
          await sendUpdate({
            sessionId: childSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: longChildText },
            },
          });
          fs.writeFileSync(path.join(state.cwd, 'delayed-output.txt'), 'created in background\n', 'utf8');
          await sendUpdate({
            sessionId: childSessionId,
            update: {
              sessionUpdate: 'state_update',
              state: 'idle',
              stopReason: 'end_turn',
            },
          });
        })();

        return { stopReason: 'end_turn' as const };
      }

      // [BG_PERMISSION]: requestPermission arrives after end_turn (#3)
      if (promptText.includes('[BG_PERMISSION]')) {
        const bgToolId = `tc-bg-perm-${Date.now()}`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'バックグラウンド処理を開始しました。' },
          },
        });

        void (async () => {
          await delay(50);
          if (state.cancelled) return;
          const permRes = await ctx.client.request(methods.client.session.requestPermission, {
            sessionId: state.id,
            toolCall: {
              toolCallId: bgToolId,
              title: '背景ファイル bg-permitted.txt の作成許可',
              kind: 'edit',
              status: 'pending',
              locations: [{ path: path.join(state.cwd, 'bg-permitted.txt') }],
            },
            options: [
              { optionId: 'allow_once', name: '許可', kind: 'allow_once' },
              { optionId: 'reject_once', name: '拒否', kind: 'reject_once' },
            ],
          });
          if (permRes.outcome.outcome === 'selected') {
            fs.writeFileSync(path.join(state.cwd, 'bg-permitted.txt'), 'bg permitted\n', 'utf8');
            await sendUpdate({
              sessionId: state.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '背景Permissionが承認され完了しました。' },
              },
            });
          }
        })();

        return { stopReason: 'end_turn' as const };
      }

      // [SESSION_MESSAGE_TEST]: session_message and session_message_chunk (#7)
      if (promptText.includes('[SESSION_MESSAGE_TEST]')) {
        const interId = `inter-msg-${Date.now()}`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'session_message',
            messageId: interId,
            senderSessionId: `${state.id}-worker-a`,
            recipientSessionId: state.id,
            content: [{ type: 'text', text: '初期本文:' }],
          } as never,
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'session_message_chunk',
            messageId: interId,
            content: { type: 'text', text: 'チャンク追記完了' },
            done: true,
          } as never,
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'セッション間メッセージを受信しました。' },
          },
        });
        return { stopReason: 'end_turn' as const };
      }

      // [QUESTION_INTERACTION]: simulate agy acp ask_question via session/request_permission with interaction_* toolCallId
      if (promptText.includes('[QUESTION_INTERACTION]')) {
        const questionRes = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: state.id,
          toolCall: {
            toolCallId: 'interaction_q1',
            title: 'どのフレームワークを使用しますか？',
            status: 'pending',
          },
          options: [
            { optionId: '1', name: 'React + Vite', kind: 'allow_once' },
            { optionId: '2', name: 'Next.js App Router', kind: 'allow_once' },
            { optionId: 'skip', name: 'スキップ', kind: 'reject_once' },
          ],
        });
        const text =
          questionRes.outcome.outcome === 'selected'
            ? `質問への回答: optionId=${questionRes.outcome.optionId}`
            : `質問キャンセル: ${questionRes.outcome.outcome}`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
        return { stopReason: 'end_turn' as const };
      }

      // [ELICITATION_FORM]: simulate standard ACP elicitation/create (form mode)
      if (promptText.includes('[ELICITATION_FORM]')) {
        const elicitCap = (advertisedCapabilities?.elicitation ?? null) as
          | { form?: unknown; url?: unknown }
          | null;
        const elicitRes = await ctx.client.request(methods.client.elicitation.create, {
          sessionId: state.id,
          mode: 'form',
          message: 'プロジェクトの初期設定を選択してください。',
          requestedSchema: {
            type: 'object',
            title: 'プロジェクト設定',
            properties: {
              framework: {
                type: 'string',
                title: 'フレームワーク',
                oneOf: [
                  { const: 'react', title: 'React' },
                  { const: 'vue', title: 'Vue' },
                ],
              },
              features: {
                type: 'array',
                title: '追加機能',
                items: {
                  anyOf: [
                    { const: 'ts', title: 'TypeScript' },
                    { const: 'test', title: 'Vitest' },
                  ],
                },
              },
              notes: {
                type: 'string',
                title: '自由記述',
              },
              strictMode: {
                type: 'boolean',
                title: 'Strictモード',
                default: true,
              },
            },
            required: ['framework'],
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Elicitation結果: action=${elicitRes.action}, content=${JSON.stringify(
                'content' in elicitRes ? (elicitRes.content ?? null) : null
              )}, capForm=${Boolean(elicitCap?.form)}, capUrl=${Boolean(elicitCap?.url)}`,
            },
          },
        });
        return { stopReason: 'end_turn' as const };
      }

      // [ELICITATION_URL]: simulate standard ACP elicitation/create (url mode) + optional elicitation/complete
      if (promptText.includes('[ELICITATION_URL]')) {
        const externalId = 'ext-elicit-123';
        if (promptText.includes('[AUTO_COMPLETE_URL]')) {
          void (async () => {
            await delay(80);
            if (state.cancelled) return;
            await ctx.client.notify(methods.client.elicitation.complete, {
              elicitationId: externalId,
            });
          })();
        }
        const elicitRes = await ctx.client.request(methods.client.elicitation.create, {
          sessionId: state.id,
          mode: 'url',
          elicitationId: externalId,
          url: 'https://example.com/auth',
          message: '外部認証を完了してください。',
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `URL Elicitation結果: action=${elicitRes.action}`,
            },
          },
        });
        return { stopReason: 'end_turn' as const };
      }

      // [MULTI_TURN_BG]: Turn A background subagent finishes after Turn B starts (#2)
      if (promptText.includes('[MULTI_TURN_BG]')) {
        const subToolId = `tc-turn-a-${Date.now()}`;
        const childSessionId = `${state.id}-turn-a-sub`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: subToolId,
            title: 'invoke_subagent',
            kind: 'other',
            status: 'completed',
            rawInput: { Subagents: [{ TypeName: 'research', Role: 'TurnA Worker', Prompt: 'A' }] },
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'subagent_update',
            sessionId: childSessionId,
            toolCallId: subToolId,
            title: 'TurnA Worker',
            state: { state: 'running' },
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ターンA初期応答' },
          },
        });

        void (async () => {
          await delay(150);
          if (state.cancelled) return;
          await sendUpdate({
            sessionId: childSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'ターンA子の遅延出力' },
            },
          });
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'subagent_update',
              sessionId: childSessionId,
              toolCallId: subToolId,
              title: 'TurnA Worker',
              state: { state: 'idle', stopReason: 'end_turn' },
            },
          });
        })();

        return { stopReason: 'end_turn' as const };
      }

      if (promptText.includes('[ACTIVITY_SEQUENCE]')) {
        const sequenceId = randomUUID();
        for (const [index, title] of ['pwd', 'rg --files'].entries()) {
          const toolCallId = `activity-command-${sequenceId}-${index}`;
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call', toolCallId, kind: 'execute', title, status: 'in_progress' },
          });
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
          });
        }
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '作業フォルダを確認しました。レポートを作成します。' },
          },
        });
      }

      // Tool call & interactive permission check
      if (promptText.includes('[PERMISSION]')) {
        const toolCallId = `tc-${Date.now()}`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: 'ワークスペースへレポートファイル created-by-tool.md を作成',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: path.join(state.cwd, 'created-by-tool.md') }],
          },
        });

        const permRes = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: state.id,
          toolCall: {
            toolCallId,
            title: 'ファイル created-by-tool.md への書き込み許可',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: path.join(state.cwd, 'created-by-tool.md') }],
          },
          options: [
            { optionId: 'allow_once', name: '今回のみ許可', kind: 'allow_once' },
            { optionId: 'reject_once', name: '拒否', kind: 'reject_once' },
          ],
        });

        if (state.cancelled || permRes.outcome.outcome === 'cancelled') {
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' },
          });
          return { stopReason: state.cancelled ? ('cancelled' as const) : ('refusal' as const) };
        }

        if (permRes.outcome.outcome === 'selected' && permRes.outcome.optionId.startsWith('allow')) {
          const targetPath = path.join(state.cwd, 'created-by-tool.md');
          const newText = `# Created with user permission\n\nAccount: ${auth?.label ?? 'anon'}\nModel: ${state.modelId}\n`;
          const created = !fs.existsSync(targetPath);
          await ctx.client.request(methods.client.fs.writeTextFile, {
            sessionId: state.id,
            path: targetPath,
            content: newText,
          });
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'completed',
              ...(created ? { content: [{ type: 'diff', path: targetPath, newText }] } : {}),
              rawOutput: { wrote: 'created-by-tool.md' },
            },
          });
        } else {
          await sendUpdate({
            sessionId: state.id,
            update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { rejected: true } },
          });
          await sendUpdate({
            sessionId: state.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '操作が拒否されたため、ファイルは作成しませんでした。' },
            },
          });
          return { stopReason: 'end_turn' as const };
        }
      }

      // Generate sample artifacts inside workspace if requested
      if (promptText.includes('[ARTIFACT]')) {
        fs.writeFileSync(
          path.join(state.cwd, 'summary.md'),
          `# Summary Report\n\nGenerated by ${auth?.label ?? 'mock'} using \`${state.modelId}\`.\n`,
          'utf8'
        );
        fs.writeFileSync(
          path.join(state.cwd, 'metrics.csv'),
          'metric,value,unit\nlatency_ms,42,ms\nworkers,2,procs\n',
          'utf8'
        );
        fs.writeFileSync(
          path.join(state.cwd, 'widget.html'),
          '<!doctype html><html><body><h1>Isolated Preview</h1><script>document.body.dataset.rendered="ok";</script></body></html>',
          'utf8'
        );
      }

      // Simulate Antigravity CLI generated brain image stored under $HOME/.gemini/antigravity-cli/brain/<session>/
      let brainImageNotes = '';
      if (promptText.includes('[BRAIN_IMAGE]')) {
        const brainSessionDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', state.id);
        fs.mkdirSync(brainSessionDir, { recursive: true, mode: 0o700 });
        const brainImgPath = path.join(brainSessionDir, 'mock-brain-art.jpg');
        const minimalJpeg = Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
          0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
        ]);
        fs.writeFileSync(brainImgPath, minimalJpeg);

        const imgToolId = `tc-img-${Date.now()}`;
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: imgToolId,
            title: `File ${brainImgPath}`,
            kind: 'edit',
            status: 'in_progress',
            rawInput: { Path: brainImgPath },
            locations: [{ path: brainImgPath }],
          },
        });
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: imgToolId,
            status: 'completed',
            rawOutput: { path: brainImgPath },
          },
        });

        brainImageNotes = [
          '\nイラストを生成しました！',
          `\n\n![生成イラスト](${brainImgPath})`,
          `\n\n保存先: [mock-brain-art.jpg](file://${brainImgPath})`,
        ].join('');
      }

      // Inspect project context files cleanly if [CONTEXT_CHECK] is requested
      let contextNotes = '';
      if (promptText.includes('[CONTEXT_CHECK]')) {
        const ctxDir = path.join(state.cwd, '.project-context');
        const files = fs.existsSync(ctxDir) ? fs.readdirSync(ctxDir) : [];
        const samples = files.map((f) => `${f}: ${fs.readFileSync(path.join(ctxDir, f), 'utf8').trim()}`);
        contextNotes = `\n\n### プロジェクト共有参照確認\n- Instructions: ${state.systemPromptText ?? '(none)'}\n- Shared files:\n${samples.map((s) => `  - ${s}`).join('\n')}`;
      }

      const skillNote = matchedSkill
        ? `\nスキル \`/${matchedSkill.slug}\` (${matchedSkill.scope}) を適用しました: ${matchedSkill.instructions.split('\n')[0] || matchedSkill.name}`
        : '';

      const reply = [
        `[${auth?.label ?? 'mock'} | ${state.modelId}/${state.effortValue}] 受信メッセージ: "${promptText}"`,
        skillNote,
        promptText.includes('[ARTIFACT]')
          ? '\n生成物を作成しました: [summary.md](summary.md), [metrics.csv](metrics.csv), [widget.html](widget.html)'
          : '',
        promptText.includes('[PERMISSION]')
          ? '\n許可されたファイル [created-by-tool.md](created-by-tool.md) を作成しました。'
          : '',
        outsidePermissionNotes,
        brainImageNotes,
        contextNotes,
        '\n\n```ts\nexport const status = "ok";\n```',
      ].join('');

      // Stream in chunks to test real-time streaming & mid-stream join
      const chunkSize = 18;
      for (let i = 0; i < reply.length; i += chunkSize) {
        if (state.cancelled) return { stopReason: 'cancelled' as const };
        await sendUpdate({
          sessionId: state.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: reply.slice(i, i + chunkSize) },
          },
        });
        await delay(15);
      }

      await sendUpdate({
        sessionId: state.id,
        update: {
          sessionUpdate: 'usage_update',
          used: 1200 + state.history.length * 100,
          size: 1_000_000,
        },
      });

      return { stopReason: 'end_turn' as const };
    });

  const stdinWeb = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stdoutWeb = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  app.connect(ndJsonStream(stdoutWeb, stdinWeb));
}

if (args.includes('--login')) {
  runCliLogin().then((code) => process.exit(code));
} else if (args[0] === 'auth' && args[1] === 'logout') {
  process.exit(runCliLogout());
} else if (args.includes('/usage')) {
  process.exit(runCliUsage());
} else {
  runAcpServer();
}
