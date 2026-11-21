import { Transform, type TransformCallback } from 'node:stream';
import type { McpDiscoveredTool } from '../types.js';

export const MAX_MCP_ALLOWED_TOOLS = 500;
export const MAX_MCP_TOOL_NAME_LEN = 200;

export function normalizeAllowedToolsList(
  raw: unknown,
  onInvalid?: (reason: string) => never
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    if (onInvalid) onInvalid('許可するツールは文字列の配列で指定してください。');
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      if (onInvalid) onInvalid('ツール名は文字列で指定してください。');
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
      if (onInvalid) onInvalid('ツール名に制御文字は使用できません。');
      continue;
    }
    if (trimmed.length > MAX_MCP_TOOL_NAME_LEN) {
      if (onInvalid) onInvalid(`ツール名は ${MAX_MCP_TOOL_NAME_LEN} 文字以内で指定してください。`);
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
      if (out.length > MAX_MCP_ALLOWED_TOOLS) {
        if (onInvalid) onInvalid(`許可ツール数は最大 ${MAX_MCP_ALLOWED_TOOLS} 件までです。`);
        break;
      }
    }
  }
  return out;
}

export function jsonRpcIdKey(id: unknown): string | null {
  if (typeof id === 'string' || typeof id === 'number') {
    return JSON.stringify(id);
  }
  return null;
}

function recordToolsListId(idKey: string, target: Set<string>): void {
  if (target.size >= 500) {
    const oldest = target.values().next().value;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.add(idKey);
}

export type ClientJsonRpcInspectResult =
  | { kind: 'pass'; localToolsListIds: Set<string> }
  | { kind: 'reject_all'; responseBody: string }
  | {
      kind: 'partial';
      forwardBody: string;
      blockedErrors: Record<string, unknown>[];
      localToolsListIds: Set<string>;
    };

export function isMcpToolPermitted(
  toolName: string,
  allowedTools?: ReadonlySet<string> | null,
  disabledTools?: ReadonlySet<string> | null
): boolean {
  if (!toolName) return false;
  if (disabledTools && disabledTools.has(toolName)) return false;
  if (allowedTools && !allowedTools.has(toolName)) return false;
  return true;
}

export function inspectMcpClientJsonRpcPayload(
  rawBody: string,
  allowedTools?: ReadonlySet<string> | null,
  trackedToolsListIds?: Set<string>,
  disabledTools?: ReadonlySet<string> | null
): ClientJsonRpcInspectResult {
  const localToolsListIds = new Set<string>();
  const trimmed = rawBody.trim();
  if (!trimmed) return { kind: 'pass', localToolsListIds };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'pass', localToolsListIds };
  }

  const isBatch = Array.isArray(parsed);
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const forwarded: unknown[] = [];
  const blockedErrors: Record<string, unknown>[] = [];
  let changed = false;

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      forwarded.push(item);
      continue;
    }
    const msg = item as Record<string, unknown>;
    if (msg.method === 'tools/list') {
      const idKey = jsonRpcIdKey(msg.id);
      if (idKey !== null) {
        localToolsListIds.add(idKey);
        if (trackedToolsListIds) {
          recordToolsListId(idKey, trackedToolsListIds);
        }
      }
      forwarded.push(msg);
      continue;
    }

    if (msg.method === 'tools/call') {
      const params =
        msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
          ? (msg.params as Record<string, unknown>)
          : null;
      const toolName = typeof params?.name === 'string' ? params.name : '';
      if (!isMcpToolPermitted(toolName, allowedTools, disabledTools)) {
        changed = true;
        if (msg.id !== undefined && msg.id !== null) {
          blockedErrors.push({
            jsonrpc: '2.0',
            id: msg.id,
            error: {
              code: -32602,
              message: `Tool "${toolName || '(unknown)'}" is not permitted by tool policy`,
            },
          });
        }
        continue;
      }
    }

    forwarded.push(msg);
  }

  if (!changed) {
    return { kind: 'pass', localToolsListIds };
  }

  if (forwarded.length === 0) {
    const responseBody = isBatch
      ? JSON.stringify(blockedErrors)
      : JSON.stringify(blockedErrors[0] ?? {});
    return { kind: 'reject_all', responseBody };
  }

  return {
    kind: 'partial',
    forwardBody: JSON.stringify(isBatch ? forwarded : forwarded[0]),
    blockedErrors,
    localToolsListIds,
  };
}

export function filterMcpServerJsonRpcPayload(
  payload: unknown,
  allowedTools: ReadonlySet<string> | null | undefined,
  activeToolsListIds: Set<string>,
  forceToolsList = false,
  disabledTools?: ReadonlySet<string> | null
): { changed: boolean; value: unknown } {
  if (!payload || typeof payload !== 'object') {
    return { changed: false, value: payload };
  }

  const filterMessage = (item: unknown): { changed: boolean; value: unknown } => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { changed: false, value: item };
    }
    const msg = item as Record<string, unknown>;
    const result =
      msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)
        ? (msg.result as Record<string, unknown>)
        : null;
    if (!result || !Array.isArray(result.tools)) {
      return { changed: false, value: item };
    }
    const idKey = jsonRpcIdKey(msg.id);
    const matchesTracked = idKey !== null && activeToolsListIds.has(idKey);
    if (!matchesTracked && !forceToolsList) {
      return { changed: false, value: item };
    }
    if (matchesTracked && idKey !== null) {
      activeToolsListIds.delete(idKey);
    }
    const filteredTools = result.tools.filter((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
      const toolName = (tool as Record<string, unknown>).name;
      return typeof toolName === 'string' && isMcpToolPermitted(toolName, allowedTools, disabledTools);
    });
    return {
      changed: true,
      value: {
        ...msg,
        result: {
          ...result,
          tools: filteredTools,
        },
      },
    };
  };

  if (Array.isArray(payload)) {
    let anyChanged = false;
    const out = payload.map((item) => {
      const res = filterMessage(item);
      if (res.changed) anyChanged = true;
      return res.value;
    });
    return { changed: anyChanged, value: out };
  }

  return filterMessage(payload);
}

export function extractMcpToolsFromJsonRpcPayload(payload: unknown): McpDiscoveredTool[] {
  if (!payload || typeof payload !== 'object') return [];
  const items = Array.isArray(payload) ? payload : [payload];
  const seen = new Set<string>();
  const out: McpDiscoveredTool[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const msg = item as Record<string, unknown>;
    const result =
      msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)
        ? (msg.result as Record<string, unknown>)
        : null;
    if (!result || !Array.isArray(result.tools)) continue;
    for (const rawTool of result.tools) {
      if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) continue;
      const t = rawTool as Record<string, unknown>;
      if (typeof t.name !== 'string') continue;
      const name = t.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const description =
        typeof t.description === 'string' && t.description.trim()
          ? t.description.trim().slice(0, 2000)
          : undefined;
      out.push(description ? { name, description } : { name });
      if (out.length >= MAX_MCP_ALLOWED_TOOLS) return out;
    }
  }
  return out;
}

export function createSseMcpToolFilterTransform(opts: {
  allowedTools?: ReadonlySet<string> | null;
  disabledTools?: ReadonlySet<string> | null;
  trackedToolsListIds?: Set<string>;
  localToolsListIds?: Set<string>;
  routeToken?: string;
  upstreamOrigin?: string;
}): Transform {
  let lineBuf = '';
  let eventLines: string[] = [];

  const rewriteEndpointValue = (rawEndpoint: string): string => {
    if (!opts.routeToken) return rawEndpoint;
    const prefix = `/mcp/${opts.routeToken}/__root`;
    if (opts.upstreamOrigin && rawEndpoint.startsWith(opts.upstreamOrigin)) {
      const rest = rawEndpoint.slice(opts.upstreamOrigin.length) || '/';
      return `${prefix}${rest.startsWith('/') ? rest : `/${rest}`}`;
    }
    if (rawEndpoint.startsWith('/') && !rawEndpoint.startsWith(`/mcp/${opts.routeToken}`)) {
      return `${prefix}${rawEndpoint}`;
    }
    return rawEndpoint;
  };

  const processEventBlock = (lines: string[]): string => {
    if (lines.length === 0) return '\n';
    let eventName = '';
    const dataPayloads: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataPayloads.push(line.slice(5).replace(/^ /, ''));
      }
    }

    if (eventName === 'endpoint' && opts.routeToken && dataPayloads.length === 1) {
      const rewritten = rewriteEndpointValue(dataPayloads[0].trim());
      if (rewritten !== dataPayloads[0].trim()) {
        const outLines = lines.map((line) =>
          line.startsWith('data:') ? `data: ${rewritten}` : line
        );
        return `${outLines.join('\n')}\n\n`;
      }
      return `${lines.join('\n')}\n\n`;
    }

    if ((opts.allowedTools != null || opts.disabledTools != null) && dataPayloads.length > 0) {
      const rawJson = dataPayloads.join('\n').trim();
      if (rawJson.startsWith('{') || rawJson.startsWith('[')) {
        try {
          const parsed = JSON.parse(rawJson);
          let changed = false;
          let value: unknown = parsed;
          if (opts.localToolsListIds && opts.localToolsListIds.size > 0) {
            const res = filterMcpServerJsonRpcPayload(
              value,
              opts.allowedTools,
              opts.localToolsListIds,
              false,
              opts.disabledTools
            );
            changed = res.changed;
            value = res.value;
          }
          if (!changed && opts.trackedToolsListIds && opts.trackedToolsListIds.size > 0) {
            const res = filterMcpServerJsonRpcPayload(
              value,
              opts.allowedTools,
              opts.trackedToolsListIds,
              false,
              opts.disabledTools
            );
            changed = res.changed;
            value = res.value;
          }
          if (changed) {
            const nonDataLines = lines.filter((line) => !line.startsWith('data:'));
            return `${[...nonDataLines, `data: ${JSON.stringify(value)}`].join('\n')}\n\n`;
          }
        } catch {
          // Leave non-JSON SSE events unchanged
        }
      }
    }

    return `${lines.join('\n')}\n\n`;
  };

  return new Transform({
    decodeStrings: false,
    transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        lineBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let out = '';
        let nlIdx = lineBuf.indexOf('\n');
        while (nlIdx !== -1) {
          let line = lineBuf.slice(0, nlIdx);
          lineBuf = lineBuf.slice(nlIdx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line === '') {
            out += processEventBlock(eventLines);
            eventLines = [];
          } else {
            eventLines.push(line);
          }
          nlIdx = lineBuf.indexOf('\n');
        }
        if (out) this.push(out, 'utf8');
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    flush(callback: TransformCallback) {
      try {
        let out = '';
        if (lineBuf.length > 0) {
          const tail = lineBuf.endsWith('\r') ? lineBuf.slice(0, -1) : lineBuf;
          lineBuf = '';
          if (tail !== '') eventLines.push(tail);
        }
        if (eventLines.length > 0) {
          out += processEventBlock(eventLines);
          eventLines = [];
        }
        if (out) this.push(out, 'utf8');
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}

/**
 * Self-contained CommonJS wrapper run via `node --input-type=commonjs -e` so stdio MCP
 * tool allowlists work both on the host and inside bubblewrap sandboxes without relying on
 * external filesystem script mounts.
 */
export const STDIO_MCP_TOOL_FILTER_SCRIPT = `
'use strict';
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const cfg = JSON.parse(process.argv[1] || '{}');
const allowed = Array.isArray(cfg.allowedTools) ? new Set(cfg.allowedTools) : null;
const disabled = Array.isArray(cfg.disabledTools) ? new Set(cfg.disabledTools) : null;
const listIds = new Set();

function isPermitted(name) {
  if (typeof name !== 'string' || !name) return false;
  if (disabled && disabled.has(name)) return false;
  if (allowed && !allowed.has(name)) return false;
  return true;
}

function idKey(id) {
  return typeof id === 'string' || typeof id === 'number' ? JSON.stringify(id) : null;
}

const child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

function handleClientLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    child.stdin.write('\\n');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    child.stdin.write(rawLine + '\\n');
    return;
  }
  const isBatch = Array.isArray(parsed);
  const items = isBatch ? parsed : [parsed];
  const forwarded = [];
  let changed = false;

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      forwarded.push(item);
      continue;
    }
    if (item.method === 'tools/list') {
      const k = idKey(item.id);
      if (k !== null) {
        if (listIds.size >= 500) {
          const oldest = listIds.values().next().value;
          if (oldest !== undefined) listIds.delete(oldest);
        }
        listIds.add(k);
      }
      forwarded.push(item);
      continue;
    }
    if (item.method === 'tools/call') {
      const toolName = item.params && typeof item.params === 'object' ? item.params.name : '';
      if (!isPermitted(toolName)) {
        changed = true;
        if (item.id !== undefined && item.id !== null) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: item.id,
            error: {
              code: -32602,
              message: 'Tool "' + String(toolName || '(unknown)') + '" is not permitted by tool policy',
            },
          }) + '\\n');
        }
        continue;
      }
    }
    forwarded.push(item);
  }

  if (!changed) {
    child.stdin.write(rawLine + '\\n');
  } else if (forwarded.length > 0) {
    child.stdin.write(JSON.stringify(isBatch ? forwarded : forwarded[0]) + '\\n');
  }
}

function handleServerLine(rawLine) {
  const trimmed = rawLine.trim();
  if (listIds.size === 0 || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    process.stdout.write(rawLine + '\\n');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    process.stdout.write(rawLine + '\\n');
    return;
  }
  const isBatch = Array.isArray(parsed);
  const items = isBatch ? parsed : [parsed];
  let changed = false;
  const out = items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    if (!item.result || typeof item.result !== 'object' || !Array.isArray(item.result.tools)) return item;
    const k = idKey(item.id);
    if (k === null || !listIds.has(k)) return item;
    listIds.delete(k);
    changed = true;
    return {
      ...item,
      result: {
        ...item.result,
        tools: item.result.tools.filter((t) => t && typeof t === 'object' && isPermitted(t.name)),
      },
    };
  });
  process.stdout.write((changed ? JSON.stringify(isBatch ? out : out[0]) : rawLine) + '\\n');
}

const inDec = new StringDecoder('utf8');
let inBuf = '';
process.stdin.on('data', (chunk) => {
  inBuf += inDec.write(chunk);
  let idx;
  while ((idx = inBuf.indexOf('\\n')) !== -1) {
    let line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    if (line.endsWith('\\r')) line = line.slice(0, -1);
    handleClientLine(line);
  }
});
process.stdin.on('end', () => {
  const tail = inBuf + inDec.end();
  if (tail.trim()) handleClientLine(tail.replace(/\\r$/, ''));
  try { child.stdin.end(); } catch {}
});

const outDec = new StringDecoder('utf8');
let outBuf = '';
let stdoutEnded = false;
let childExited = false;
let exitInfo = { code: 0, signal: null };

function maybeFinish() {
  if (!stdoutEnded || !childExited) return;
  if (exitInfo.signal) {
    process.kill(process.pid, exitInfo.signal);
  } else {
    process.exit(exitInfo.code ?? 0);
  }
}

child.stdout.on('data', (chunk) => {
  outBuf += outDec.write(chunk);
  let idx;
  while ((idx = outBuf.indexOf('\\n')) !== -1) {
    let line = outBuf.slice(0, idx);
    outBuf = outBuf.slice(idx + 1);
    if (line.endsWith('\\r')) line = line.slice(0, -1);
    handleServerLine(line);
  }
});
child.stdout.on('end', () => {
  const tail = outBuf + outDec.end();
  if (tail.trim()) handleServerLine(tail.replace(/\\r$/, ''));
  stdoutEnded = true;
  maybeFinish();
});

child.on('error', (err) => {
  process.stderr.write((err && err.message ? err.message : String(err)) + '\\n');
  process.exit(1);
});
child.on('exit', (code, signal) => {
  childExited = true;
  exitInfo = { code: code ?? 0, signal: signal ?? null };
  maybeFinish();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch {}
  });
}
`.trim();
