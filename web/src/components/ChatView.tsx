import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../api/client';
import type {
  ArtifactRecord,
  AttachmentRef,
  AvailableCommandItem,
  ChatRecord,
  ElicitationContentValue,
  ElicitationEnumOption,
  ElicitationPropertySchema,
  MessageRecord,
  ParsedSessionOptions,
  PendingElicitationRecord,
  PendingPermissionRecord,
  ProjectRecord,
  RunRecord,
  ToolCallItem,
} from '../types';
import { getMessageActivity } from '../utils/messageActivity';
import { isAppleTouchHapticsFallback, triggerHaptic } from '../utils/haptics';
import { EffortBar } from './EffortBar';
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  ComposeIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  SlashIcon,
  SparklesIcon,
  StopIcon,
  TerminalIcon,
} from './Icons';
import { FileReferenceLink, MarkdownContent, type FileLinkProps } from './MarkdownContent';

type ChatViewMessage = MessageRecord & { optimisticPop?: true };

function getMessageKey(message: MessageRecord): string {
  return message.clientMessageId ? `cm:${message.clientMessageId}` : message.id;
}

interface ChatViewProps {
  chat: ChatRecord | null;
  project: ProjectRecord | null;
  messages: ChatViewMessage[];
  artifacts: ArtifactRecord[];
  pendingPermissions: PendingPermissionRecord[];
  pendingElicitations: PendingElicitationRecord[];
  activeRun: RunRecord | null;
  sessionOptions: ParsedSessionOptions | null;
  availableCommands?: AvailableCommandItem[];
  selectedModelId: string;
  selectedEffortValue: string;
  contextUsage?: { used: number; size: number } | null;
  draftResetToken?: number;
  isDraftChat?: boolean;
  chatLoadError?: string | null;
  actionError?: string | null;
  clientId: string;
  hapticEnabled?: boolean;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effortValue: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onRetryLoadChat?: () => void;
  onDismissActionError?: () => void;
  onSendPrompt: (text: string, files: AttachmentRef[]) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<AttachmentRef[]>;
  onCancelRun: (runId: string) => Promise<void>;
  onSyncProject: () => Promise<void>;
  onOpenArtifact: (artifact: ArtifactRecord) => void;
  onPermissionUpdated: (perm: PendingPermissionRecord) => void;
  onElicitationUpdated: (elicit: PendingElicitationRecord) => void;
  onOpenSkills?: () => void;
  externalDraftCommand?: { slug: string; token: number } | null;
}

interface LongPressMenuState {
  textToCopy: string;
  messageKey: string;
  source: HTMLElement;
  alignEnd: boolean;
  isTouch: boolean;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) return;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fallback below
    }
  }
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function formatContextPercent(used: number, size: number): string {
  if (size <= 0 || used <= 0) return '0%';
  const raw = Math.min(100, (used / size) * 100);
  if (raw < 10) {
    return `${raw.toFixed(1)}%`;
  }
  return `${Math.round(raw)}%`;
}

function formatTokenCount(count: number): string {
  return new Intl.NumberFormat(undefined).format(Math.max(0, Math.round(count)));
}

const ContextUsageControl: React.FC<{
  contextUsage?: { used: number; size: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = React.memo(({ contextUsage, open, onOpenChange }) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const hasData = Boolean(contextUsage && contextUsage.size > 0);
  const used = hasData ? Math.max(0, contextUsage!.used) : 0;
  const size = hasData ? contextUsage!.size : 0;
  const pct = hasData ? Math.min(100, Math.max(0, (used / size) * 100)) : 0;
  const pctLabel = hasData ? formatContextPercent(used, size) : '0%';
  const toneClass = !hasData
    ? 'is-empty'
    : pct >= 90
      ? 'is-danger'
      : pct >= 70
        ? 'is-warn'
        : 'is-normal';

  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const { target } = event;
      if (
        target instanceof Node &&
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        onOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`context-ring-btn ${toneClass} ${open ? 'active' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          hasData
            ? `コンテキスト利用量 ${pctLabel} (${formatTokenCount(used)} / ${formatTokenCount(size)})`
            : 'コンテキスト利用量（未計測）'
        }
        title={
          hasData
            ? `コンテキスト: ${pctLabel} (${formatTokenCount(used)} / ${formatTokenCount(size)})`
            : 'コンテキスト利用量を表示'
        }
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            className="context-ring-track"
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            strokeWidth="2.6"
          />
          <circle
            className="context-ring-fill"
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={hasData ? dashOffset : circumference}
            transform="rotate(-90 12 12)"
          />
        </svg>
      </button>

      {open && (
        <div ref={popoverRef} className="context-popover" role="dialog" aria-label="コンテキスト利用量">
          <div className="context-popover-head">
            <span className="context-popover-title">コンテキスト利用量</span>
            <span className={`context-popover-pct ${toneClass}`}>
              {hasData ? pctLabel : '—%'}
            </span>
          </div>

          <div className="context-popover-bar-track" aria-hidden="true">
            <div
              className={`context-popover-bar-fill ${toneClass}`}
              style={{ width: `${hasData ? Math.max(pct > 0 ? 2 : 0, pct) : 0}%` }}
            />
          </div>

          {hasData ? (
            <dl className="context-popover-stats">
              <div className="context-popover-row">
                <dt>使用率</dt>
                <dd>{pctLabel}</dd>
              </div>
              <div className="context-popover-row">
                <dt>利用コンテキスト</dt>
                <dd>{formatTokenCount(used)} tokens</dd>
              </div>
              <div className="context-popover-row">
                <dt>最大コンテキスト</dt>
                <dd>{formatTokenCount(size)} tokens</dd>
              </div>
            </dl>
          ) : (
            <div className="context-popover-empty">
              まだコンテキスト利用量が取得されていません。応答を受信するとここに表示されます。
            </div>
          )}
        </div>
      )}
    </>
  );
});

const EMPTY_PERMS: PendingPermissionRecord[] = [];
const EMPTY_ARTIFACTS: ArtifactRecord[] = [];
const EMPTY_SELECT_OPTIONS: NonNullable<ParsedSessionOptions['configOptions']>[number]['options'] = [];

function toolIsActive(tool: ToolCallItem): boolean {
  return tool.status === 'pending' || tool.status === 'in_progress' ||
    tool.subagentState === 'running' || tool.subagentState === 'requires_action';
}

function toolIcon(kind: ToolCallItem['kind']) {
  switch (kind) {
    case 'execute': return TerminalIcon;
    case 'edit': return ComposeIcon;
    case 'read': return FileIcon;
    case 'search': return SearchIcon;
    default: return SparklesIcon;
  }
}

function toolSummary(tools: ToolCallItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    let label: string;
    switch (tool.kind) {
      case 'edit': label = 'ファイル編集'; break;
      case 'execute': label = 'コマンド'; break;
      case 'read': label = '読み取り'; break;
      case 'search': label = '検索'; break;
      default: label = 'ツール実行';
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count}件`).join(' · ');
}

const ToolActivity: React.FC<FileLinkProps & { tools: ToolCallItem[] }> = ({ tools, ...fileLinks }) => {
  const active = tools.findLast(toolIsActive);
  const Icon = toolIcon(tools[0].kind);

  return (
    <details className="activity-tools">
      <summary className="activity-summary">
        {active ? <span className="owui-tool-spinner" aria-hidden="true" /> : <Icon size={15} />}
        <span className="truncate" title={active?.title}>
          {active ? `実行中 · ${active.subagentLabel || active.title}` : toolSummary(tools)}
        </span>
        <ChevronIcon size={13} dir="right" className="activity-chevron" />
      </summary>
      <ToolCallsList toolCalls={tools} {...fileLinks} />
    </details>
  );
};

function isSubagentTool(tc: ToolCallItem): boolean {
  if (tc.isSubagent) return true;
  return /subagent|invoke_subagent|define_subagent|manage_subagents|generate_image|image_gen|画像生成|サブエージェント/i.test(
    `${tc.name ?? ''} ${tc.title ?? ''}`
  );
}

function toolOutputStatus(tool: ToolCallItem): MessageRecord['status'] {
  return toolIsActive(tool) ? 'streaming' : 'completed';
}

const ToolLocations: React.FC<FileLinkProps & { locations: ToolCallItem['locations'] }> = ({ locations, ...fileLinks }) => {
  if (!locations?.length) return null;
  return (
    <div className="muted-xs">
      対象: {locations.map((location, index) => (
        <React.Fragment key={index}>
          {index > 0 && ', '}
          <FileReferenceLink reference={location.path} {...fileLinks} />
        </React.Fragment>
      ))}
    </div>
  );
};

const ToolCallsList: React.FC<FileLinkProps & { toolCalls: ToolCallItem[] }> = React.memo(({ toolCalls, ...fileLinks }) => {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="owui-tools-list">
      {toolCalls.map((tc) => {
        const isOpen = Boolean(openIds[tc.toolCallId]);
        const subagent = isSubagentTool(tc);
        const messageStatus = toolOutputStatus(tc);
        const isRunning = messageStatus === 'streaming';
        const Icon = toolIcon(tc.kind);
        const isFailed = tc.status === 'failed';
        const displayTitle = tc.subagentLabel || tc.title;
        const hasDetails =
          Boolean(tc.locations && tc.locations.length > 0) ||
          Boolean(tc.contentText) ||
          Boolean(tc.subagentThoughtsText) ||
          Boolean(tc.subagentContentText) ||
          Boolean(tc.subagentToolCalls && tc.subagentToolCalls.length > 0) ||
          tc.rawInput !== undefined ||
          tc.rawOutput !== undefined;

        return (
          <div
            key={tc.toolCallId}
            className={`owui-tool-item ${isRunning ? 'is-running' : ''} ${isFailed ? 'is-failed' : ''}`}
          >
            <button
              type="button"
              className="owui-tool-head"
              disabled={!hasDetails}
              onClick={() => setOpenIds((prev) => ({ ...prev, [tc.toolCallId]: !prev[tc.toolCallId] }))}
              aria-expanded={hasDetails ? isOpen : undefined}
            >
              {isRunning ? (
                <span className="owui-tool-spinner" aria-hidden="true" />
              ) : isFailed ? (
                <CloseIcon size={13} className="owui-tool-icon-fail" />
              ) : (
                <Icon size={14} className="owui-tool-icon-ok" />
              )}
              {subagent && <span className="owui-subagent-tag">Subagent</span>}
              <span className="owui-tool-title truncate" title={displayTitle}>
                {isRunning ? `実行中: ${displayTitle}` : displayTitle}
              </span>
              {tc.subagentState && tc.subagentState !== 'idle' && (
                <span className="muted-xs" style={{ marginLeft: 6 }}>
                  ({tc.subagentState})
                </span>
              )}
              {tc.diffStats && (
                <span className="activity-diff" aria-label={`${tc.diffStats.added} 行追加、${tc.diffStats.removed} 行削除`}>
                  <span className="activity-diff-added">+{tc.diffStats.added}</span>
                  <span className="activity-diff-removed">−{tc.diffStats.removed}</span>
                </span>
              )}
              {isFailed && <span className="owui-tool-fail-label">失敗</span>}
              {hasDetails && (
                <ChevronIcon size={13} dir={isOpen ? 'down' : 'right'} className="owui-disclosure-chevron" />
              )}
            </button>
            {isOpen && hasDetails && (
              <div className="owui-tool-body">
                <ToolLocations locations={tc.locations} {...fileLinks} />
                {tc.contentText && (
                  <MarkdownContent content={tc.contentText} messageStatus={messageStatus} {...fileLinks} />
                )}
                {tc.subagentThoughtsText && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted-xs">Subagent Thoughts</div>
                    <MarkdownContent content={tc.subagentThoughtsText} messageStatus={messageStatus} {...fileLinks} />
                  </div>
                )}
                {tc.subagentToolCalls && tc.subagentToolCalls.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted-xs">Subagent Tools ({tc.subagentToolCalls.length})</div>
                    {tc.subagentToolCalls.map((stc) => (
                      <div key={stc.toolCallId} className="muted-xs" style={{ marginTop: 2 }}>
                        [{stc.status}] {stc.title}
                        <ToolLocations locations={stc.locations} {...fileLinks} />
                        {stc.contentText && (
                          <MarkdownContent content={stc.contentText} messageStatus={toolOutputStatus(stc)} {...fileLinks} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {tc.subagentContentText && (
                  <div style={{ marginTop: 6 }}>
                    <div className="muted-xs">Subagent Output</div>
                    <MarkdownContent content={tc.subagentContentText} messageStatus={messageStatus} {...fileLinks} />
                  </div>
                )}
                {tc.rawInput !== undefined && (
                  <pre className="tool-json">{JSON.stringify(tc.rawInput, null, 2)}</pre>
                )}
                {tc.rawOutput !== undefined && (
                  <pre className="tool-json">{JSON.stringify(tc.rawOutput, null, 2)}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

const PermissionCard: React.FC<{
  perm: PendingPermissionRecord;
  clientId: string;
  onResolved: (perm: PendingPermissionRecord) => void;
}> = React.memo(({ perm, clientId, onResolved }) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const isQuestion = perm.toolCall.toolCallId.startsWith('interaction_');
  const allowOption = perm.options.find((o) => o.kind.startsWith('allow') && o.kind !== 'allow_always');
  const hasNativeAlwaysOption = perm.options.some((o) => o.kind === 'allow_always');
  const hasRejectOption = perm.options.some((o) => o.kind.startsWith('reject'));
  const showAlwaysAllowButton =
    !isQuestion &&
    !hasNativeAlwaysOption &&
    Boolean(allowOption) &&
    hasRejectOption &&
    Boolean(perm.alwaysAllowRule);

  const handleAction = async (optionId?: string, cancel?: boolean, alwaysAllow?: boolean) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.resolvePermission(perm.chatId, perm.id, {
        optionId: optionId ?? null,
        alwaysAllow: Boolean(alwaysAllow),
        cancel: Boolean(cancel),
        clientId,
      });
      onResolved(res.permission);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_RESOLVED') {
        const already = (err.data as { permission?: PendingPermissionRecord } | undefined)?.permission;
        if (already) {
          onResolved(already);
        }
        setNotice('別の端末または直前の操作で既に処理されました。');
      } else {
        setNotice(err instanceof ApiError ? err.message : '送信に失敗しました。');
      }
    } finally {
      setBusy(false);
    }
  };

  if (isQuestion) {
    const choiceOptions = perm.options.filter((o) => !o.kind.startsWith('reject'));
    const rejectOptions = perm.options.filter((o) => o.kind.startsWith('reject'));
    return (
      <div className="question-card" role="region" aria-label="エージェントからの質問">
        <div className="question-head">
          <span className="question-badge" aria-hidden="true">?</span>
          <div className="question-head-text">
            <div className="question-title">エージェントからの質問</div>
          </div>
        </div>
        {perm.toolCall.title && (
          <div className="question-prompt-text">{perm.toolCall.title}</div>
        )}
        {choiceOptions.length > 0 && (
          <div className="question-options-list">
            {choiceOptions.map((opt) => (
              <button
                key={opt.optionId}
                type="button"
                disabled={busy}
                className="btn btn-question-option"
                onClick={() => void handleAction(opt.optionId, false, false)}
              >
                {opt.name}
              </button>
            ))}
          </div>
        )}
        <div className="question-actions">
          {rejectOptions.map((opt) => (
            <button
              key={opt.optionId}
              type="button"
              disabled={busy}
              className="btn btn-secondary btn-sm"
              onClick={() => void handleAction(opt.optionId, false, false)}
            >
              {opt.name}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            className="btn btn-ghost btn-sm"
            onClick={() => void handleAction(undefined, true, false)}
          >
            キャンセル
          </button>
        </div>
        {notice && <div className="question-notice" role="alert">{notice}</div>}
      </div>
    );
  }

  return (
    <div className="permission-card" role="region" aria-label="ツール実行の承認待ち">
      <div className="permission-head">
        <ShieldIcon size={16} className="warn-icon" />
        <div>
          <div className="permission-title">ツール実行の許可が求められています</div>
          <div className="muted-sm">{perm.toolCall.title}</div>
        </div>
      </div>

      {perm.toolCall.locations && perm.toolCall.locations.length > 0 && (
        <div className="permission-paths">
          {perm.toolCall.locations.map((loc, idx) => (
            <code key={idx} className="inline-code">
              {loc.path}
              {loc.line ? `:${loc.line}` : ''}
            </code>
          ))}
        </div>
      )}

      {perm.toolCall.rawInput !== undefined && (
        <pre className="tool-json">{JSON.stringify(perm.toolCall.rawInput, null, 2)}</pre>
      )}

      {showAlwaysAllowButton && perm.alwaysAllowRule && (
        <div className="permission-rule-preview muted-xs">
          <span>常に許可の登録対象:</span>
          <code className="inline-code">{perm.alwaysAllowRule}</code>
        </div>
      )}

      <div className="permission-actions">
        {perm.options.map((opt) => {
          const isReject = opt.kind.startsWith('reject');
          return (
            <button
              key={opt.optionId}
              type="button"
              disabled={busy}
              className={`btn btn-sm ${isReject ? 'btn-danger-outline' : 'btn-primary'}`}
              onClick={() => void handleAction(opt.optionId, false, opt.kind === 'allow_always')}
            >
              {opt.name}
            </button>
          );
        })}
        {showAlwaysAllowButton && allowOption && (
          <button
            type="button"
            disabled={busy}
            className="btn btn-secondary btn-sm"
            title={perm.alwaysAllowRule ? `次回から確認せず許可 (${perm.alwaysAllowRule})` : undefined}
            onClick={() => void handleAction(allowOption.optionId, false, true)}
          >
            常に許可
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          className="btn btn-ghost btn-sm"
          onClick={() => void handleAction(undefined, true, false)}
        >
          キャンセル
        </button>
      </div>
      {notice && <div className="muted-xs" style={{ marginTop: 6 }}>{notice}</div>}
    </div>
  );
});

function normalizeElicitationChoices(
  prop: ElicitationPropertySchema
): Array<{ value: string; label: string; description?: string | null }> {
  if (prop.type === 'string') {
    const strProp = prop as Extract<ElicitationPropertySchema, { type: 'string' }>;
    if (Array.isArray(strProp.oneOf) && strProp.oneOf.length > 0) {
      return strProp.oneOf.map((o: ElicitationEnumOption) => ({
        value: o.const,
        label: o.title || o.const,
        description: o.description ?? null,
      }));
    }
    if (Array.isArray(strProp.enum) && strProp.enum.length > 0) {
      return strProp.enum.map((v) => ({ value: v, label: v }));
    }
  }
  if (prop.type === 'array') {
    const arrProp = prop as Extract<ElicitationPropertySchema, { type: 'array' }>;
    const items = arrProp.items as { anyOf?: ElicitationEnumOption[]; enum?: string[] } | undefined;
    if (items && Array.isArray(items.anyOf) && items.anyOf.length > 0) {
      return items.anyOf.map((o) => ({
        value: o.const,
        label: o.title || o.const,
        description: o.description ?? null,
      }));
    }
    if (items && Array.isArray(items.enum) && items.enum.length > 0) {
      return items.enum.map((v) => ({ value: v, label: v }));
    }
  }
  return [];
}

function isSafeHttpUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

const ElicitationCard: React.FC<{
  elicit: PendingElicitationRecord;
  clientId: string;
  onResolved: (elicit: PendingElicitationRecord) => void;
}> = React.memo(({ elicit, clientId, onResolved }) => {
  const schema = elicit.requestedSchema;
  const fieldEntries = useMemo(
    () => Object.entries(schema?.properties ?? {}),
    [schema]
  );
  const requiredSet = useMemo(
    () => new Set(schema?.required ?? []),
    [schema]
  );

  const [formValues, setFormValues] = useState<Record<string, string | boolean | string[]>>(() => {
    const init: Record<string, string | boolean | string[]> = {};
    for (const [key, prop] of Object.entries(elicit.requestedSchema?.properties ?? {})) {
      if (prop.type === 'boolean') {
        if (typeof prop.default === 'boolean') init[key] = prop.default;
      } else if (prop.type === 'array') {
        const hasEnumChoices = normalizeElicitationChoices(prop).length > 0;
        if (hasEnumChoices) {
          init[key] = Array.isArray(prop.default) ? prop.default.map(String) : [];
        } else {
          init[key] = Array.isArray(prop.default) ? prop.default.map(String).join('\n') : '';
        }
      } else if (prop.type === 'number' || prop.type === 'integer') {
        if (typeof prop.default === 'number' && Number.isFinite(prop.default)) {
          init[key] = String(prop.default);
        }
      } else if (prop.type === 'string') {
        if (typeof prop.default === 'string') {
          init[key] = prop.default;
        }
      }
    }
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submitAction = async (
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, ElicitationContentValue> | null
  ) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.resolveElicitation(elicit.chatId, elicit.id, {
        action,
        ...(content !== undefined ? { content } : {}),
        clientId,
      });
      onResolved(res.elicitation);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_RESOLVED') {
        const already = (err.data as { elicitation?: PendingElicitationRecord } | undefined)?.elicitation;
        if (already) {
          onResolved(already);
        } else {
          onResolved({ ...elicit, status: 'resolved' });
        }
        setNotice('別の端末または直前の操作で既に処理されました。');
      } else {
        setNotice(err instanceof ApiError ? err.message : '送信に失敗しました。');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const content: Record<string, ElicitationContentValue> = {};

    for (const [key, prop] of fieldEntries) {
      const label = (typeof prop.title === 'string' && prop.title) || key;
      const isReq = requiredSet.has(key);
      const rawVal = formValues[key];

      if (prop.type === 'boolean') {
        const hasExplicit = typeof rawVal === 'boolean';
        if (isReq && !hasExplicit) {
          setNotice(`「${label}」を選択してください。`);
          return;
        }
        if (hasExplicit) {
          content[key] = rawVal;
        }
        continue;
      }

      if (prop.type === 'array') {
        const arr = Array.isArray(rawVal)
          ? rawVal
          : typeof rawVal === 'string'
            ? rawVal
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
        const arrProp = prop as Extract<ElicitationPropertySchema, { type: 'array' }>;
        if (isReq && arr.length === 0) {
          setNotice(`「${label}」を1つ以上入力または選択してください。`);
          return;
        }
        if (arrProp.minItems != null && arr.length > 0 && arr.length < arrProp.minItems) {
          setNotice(`「${label}」は${arrProp.minItems}件以上にしてください。`);
          return;
        }
        if (arrProp.maxItems != null && arr.length > arrProp.maxItems) {
          setNotice(`「${label}」は${arrProp.maxItems}件以内にしてください。`);
          return;
        }
        if (arr.length > 0 || isReq) {
          content[key] = arr;
        }
        continue;
      }

      if (prop.type === 'number' || prop.type === 'integer') {
        const str = typeof rawVal === 'string' ? rawVal.trim() : '';
        if (!str) {
          if (isReq) {
            setNotice(`「${label}」を入力してください。`);
            return;
          }
          continue;
        }
        const num = Number(str);
        if (!Number.isFinite(num)) {
          setNotice(`「${label}」には数値を入力してください。`);
          return;
        }
        if (prop.type === 'integer' && !Number.isInteger(num)) {
          setNotice(`「${label}」には整数を入力してください。`);
          return;
        }
        const numProp = prop as Extract<ElicitationPropertySchema, { type: 'number' | 'integer' }>;
        if (numProp.minimum != null && num < numProp.minimum) {
          setNotice(`「${label}」は ${numProp.minimum} 以上にしてください。`);
          return;
        }
        if (numProp.maximum != null && num > numProp.maximum) {
          setNotice(`「${label}」は ${numProp.maximum} 以下にしてください。`);
          return;
        }
        content[key] = num;
        continue;
      }

      const text = typeof rawVal === 'string' ? rawVal : '';
      const trimmed = text.trim();
      if (!trimmed) {
        if (isReq) {
          setNotice(`「${label}」を入力または選択してください。`);
          return;
        }
        continue;
      }
      const strProp = prop as Extract<ElicitationPropertySchema, { type: 'string' }>;
      if (strProp.minLength != null && text.length < strProp.minLength) {
        setNotice(`「${label}」は${strProp.minLength}文字以上で入力してください。`);
        return;
      }
      if (strProp.maxLength != null && text.length > strProp.maxLength) {
        setNotice(`「${label}」は${strProp.maxLength}文字以内で入力してください。`);
        return;
      }
      content[key] = text;
    }

    void submitAction('accept', content);
  };

  if (elicit.mode === 'url') {
    const safeUrl = isSafeHttpUrl(elicit.url) ? elicit.url : null;
    return (
      <div className="question-card" role="region" aria-label="エージェントからの外部連携リクエスト">
        <div className="question-head">
          <span className="question-badge" aria-hidden="true">?</span>
          <div className="question-head-text">
            <div className="question-title">エージェントからの確認リクエスト</div>
          </div>
        </div>
        {elicit.message && <div className="question-prompt-text">{elicit.message}</div>}
        {safeUrl ? (
          <div className="question-url-box">
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-sm"
            >
              ページを開く
            </a>
            <code className="question-url-code">{safeUrl}</code>
          </div>
        ) : elicit.url ? (
          <div className="question-notice">安全でない URL 形式のためリンクを開けません。</div>
        ) : null}
        <div className="question-actions">
          <button
            type="button"
            disabled={busy}
            className="btn btn-secondary btn-sm"
            onClick={() => void submitAction('accept', null)}
          >
            完了
          </button>
          <button
            type="button"
            disabled={busy}
            className="btn btn-ghost btn-sm"
            onClick={() => void submitAction('decline')}
          >
            スキップ
          </button>
          <button
            type="button"
            disabled={busy}
            className="btn btn-ghost btn-sm"
            onClick={() => void submitAction('cancel')}
          >
            キャンセル
          </button>
        </div>
        {notice && <div className="question-notice" role="alert">{notice}</div>}
      </div>
    );
  }

  return (
    <form className="question-card" onSubmit={handleFormSubmit} role="region" aria-label="エージェントからの質問">
      <div className="question-head">
        <span className="question-badge" aria-hidden="true">?</span>
        <div className="question-head-text">
          <div className="question-title">{schema?.title || 'エージェントからの質問'}</div>
          {schema?.description && <div className="muted-xs">{schema.description}</div>}
        </div>
      </div>
      {elicit.message && <div className="question-prompt-text">{elicit.message}</div>}

      {fieldEntries.length > 0 && (
        <div className="question-fields">
          {fieldEntries.map(([key, prop]) => {
            const label = (typeof prop.title === 'string' && prop.title) || key;
            const desc = typeof prop.description === 'string' ? prop.description : null;
            const isReq = requiredSet.has(key);
            const choices = normalizeElicitationChoices(prop);

            if (prop.type === 'string' && choices.length > 0) {
              const selected = typeof formValues[key] === 'string' ? (formValues[key] as string) : '';
              return (
                <fieldset key={key} className="question-field">
                  <legend className="question-field-label">
                    <span>{label}</span>
                    {isReq && <span className="question-required-mark">必須</span>}
                  </legend>
                  {desc && <div className="question-field-desc">{desc}</div>}
                  <div className="question-choices-stack">
                    {choices.map((opt) => {
                      const checked = selected === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={busy}
                          aria-pressed={checked}
                          className={`question-choice-card${checked ? ' is-selected' : ''}`}
                          onClick={() => {
                            setFormValues((prev) => {
                              const next = { ...prev };
                              if (checked && !isReq) {
                                delete next[key];
                              } else {
                                next[key] = opt.value;
                              }
                              return next;
                            });
                          }}
                        >
                          <span className={`question-choice-indicator is-radio${checked ? ' is-checked' : ''}`} aria-hidden="true" />
                          <span className="question-choice-body">
                            <span className="question-choice-title">{opt.label}</span>
                            {opt.description && (
                              <span className="question-choice-desc">{opt.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              );
            }

            if (prop.type === 'array') {
              if (choices.length === 0) {
                const textVal = typeof formValues[key] === 'string' ? (formValues[key] as string) : '';
                return (
                  <div key={key} className="question-field">
                    <label className="question-field-label" htmlFor={`elicit-${elicit.id}-${key}`}>
                      <span>{label}</span>
                      {isReq && <span className="question-required-mark">必須</span>}
                    </label>
                    {desc && <div className="question-field-desc">{desc}</div>}
                    <textarea
                      id={`elicit-${elicit.id}-${key}`}
                      rows={3}
                      disabled={busy}
                      className="question-textarea"
                      placeholder="1行に1項目ずつ入力してください"
                      value={textVal}
                      onChange={(e) => setFormValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    />
                  </div>
                );
              }

              const selectedArr = Array.isArray(formValues[key]) ? (formValues[key] as string[]) : [];
              return (
                <fieldset key={key} className="question-field">
                  <legend className="question-field-label">
                    <span>{label}</span>
                    {isReq && <span className="question-required-mark">必須</span>}
                  </legend>
                  {desc && <div className="question-field-desc">{desc}</div>}
                  <div className="question-choices-stack">
                    {choices.map((opt) => {
                      const checked = selectedArr.includes(opt.value);
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={busy}
                          aria-pressed={checked}
                          className={`question-choice-card${checked ? ' is-selected' : ''}`}
                          onClick={() => {
                            setFormValues((prev) => {
                              const cur = Array.isArray(prev[key]) ? (prev[key] as string[]) : [];
                              const nextArr = checked
                                ? cur.filter((v) => v !== opt.value)
                                : [...cur, opt.value];
                              return { ...prev, [key]: nextArr };
                            });
                          }}
                        >
                          <span className={`question-choice-indicator is-check${checked ? ' is-checked' : ''}`} aria-hidden="true">
                            {checked ? <CheckIcon size={12} /> : null}
                          </span>
                          <span className="question-choice-body">
                            <span className="question-choice-title">{opt.label}</span>
                            {opt.description && (
                              <span className="question-choice-desc">{opt.description}</span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              );
            }

            if (prop.type === 'boolean') {
              const checked = Boolean(formValues[key]);
              return (
                <div key={key} className="question-field">
                  <button
                    type="button"
                    disabled={busy}
                    role="switch"
                    aria-checked={checked}
                    className={`question-choice-card question-bool-card${checked ? ' is-selected' : ''}`}
                    onClick={() => setFormValues((prev) => ({ ...prev, [key]: !checked }))}
                  >
                    <span className={`question-choice-indicator is-check${checked ? ' is-checked' : ''}`} aria-hidden="true">
                      {checked ? <CheckIcon size={12} /> : null}
                    </span>
                    <span className="question-choice-body">
                      <span className="question-choice-title">
                        {label}
                        {isReq && <span className="question-required-mark" style={{ marginLeft: 6 }}>必須</span>}
                      </span>
                      {desc && <span className="question-choice-desc">{desc}</span>}
                    </span>
                  </button>
                </div>
              );
            }

            if (prop.type === 'number' || prop.type === 'integer') {
              const numProp = prop as Extract<ElicitationPropertySchema, { type: 'number' | 'integer' }>;
              const val = typeof formValues[key] === 'string' ? (formValues[key] as string) : '';
              return (
                <div key={key} className="question-field">
                  <label className="question-field-label" htmlFor={`elicit-${elicit.id}-${key}`}>
                    <span>{label}</span>
                    {isReq && <span className="question-required-mark">必須</span>}
                  </label>
                  {desc && <div className="question-field-desc">{desc}</div>}
                  <input
                    id={`elicit-${elicit.id}-${key}`}
                    type="number"
                    disabled={busy}
                    className="question-input"
                    step={prop.type === 'integer' ? 1 : 'any'}
                    min={numProp.minimum ?? undefined}
                    max={numProp.maximum ?? undefined}
                    value={val}
                    onChange={(e) => setFormValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              );
            }

            const strProp = prop as Extract<ElicitationPropertySchema, { type: 'string' }>;
            const val = typeof formValues[key] === 'string' ? (formValues[key] as string) : '';
            const useTextarea =
              !strProp.format &&
              ((strProp.maxLength != null && strProp.maxLength > 120) ||
                /detail|note|reason|custom|other|comment|memo|body|desc|free|text|説明|自由|補足|詳細|回答/i.test(key));
            const inputType =
              strProp.format === 'email'
                ? 'email'
                : strProp.format === 'uri'
                  ? 'url'
                  : strProp.format === 'date'
                    ? 'date'
                    : 'text';

            return (
              <div key={key} className="question-field">
                <label className="question-field-label" htmlFor={`elicit-${elicit.id}-${key}`}>
                  <span>{label}</span>
                  {isReq && <span className="question-required-mark">必須</span>}
                </label>
                {desc && <div className="question-field-desc">{desc}</div>}
                {useTextarea ? (
                  <textarea
                    id={`elicit-${elicit.id}-${key}`}
                    rows={3}
                    disabled={busy}
                    className="question-textarea"
                    placeholder={isReq ? '回答を入力...' : '自由記述（任意）'}
                    value={val}
                    onChange={(e) => setFormValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                ) : (
                  <input
                    id={`elicit-${elicit.id}-${key}`}
                    type={inputType}
                    disabled={busy}
                    className="question-input"
                    placeholder={isReq ? '回答を入力...' : '入力（任意）'}
                    value={val}
                    onChange={(e) => setFormValues((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="question-actions">
        <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
          回答を送信
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn btn-secondary btn-sm"
          onClick={() => void submitAction('decline')}
        >
          スキップ
        </button>
        <button
          type="button"
          disabled={busy}
          className="btn btn-ghost btn-sm"
          onClick={() => void submitAction('cancel')}
        >
          キャンセル
        </button>
      </div>
      {notice && <div className="question-notice" role="alert">{notice}</div>}
    </form>
  );
});

const NATIVE_MESSAGE_GESTURE_SELECTOR = 'button, a, input, textarea, select, summary, pre, code, img, [contenteditable]';

const MessageRow: React.FC<{
  msg: ChatViewMessage;
  chatId?: string;
  clientId: string;
  queuePosition: number | null;
  msgPerms: PendingPermissionRecord[];
  msgElicitations: PendingElicitationRecord[];
  msgArtifacts: ArtifactRecord[];
  isCopyTarget: boolean;
  hapticEnabled: boolean;
  onOpenArtifact: (artifact: ArtifactRecord) => void;
  onOpenAttachment: (att: AttachmentRef) => void;
  onPermissionUpdated: (perm: PendingPermissionRecord) => void;
  onElicitationUpdated: (elicit: PendingElicitationRecord) => void;
  onResolveError: (msg: string) => void;
  onOpenLongPressMenu: (menu: LongPressMenuState) => void;
}> = React.memo(
  ({
    msg,
    chatId,
    clientId,
    queuePosition,
    msgPerms,
    msgElicitations,
    msgArtifacts,
    isCopyTarget,
    hapticEnabled,
    onOpenArtifact,
    onOpenAttachment,
    onPermissionUpdated,
    onElicitationUpdated,
    onResolveError,
    onOpenLongPressMenu,
  }) => {
    const [copied, setCopied] = useState(false);
    const [isTouchPress, setIsTouchPress] = useState(false);
    const longPressTimerRef = useRef<number | null>(null);
    const longPressStartRef = useRef<{
      x: number;
      y: number;
      pointerId: number;
      isTouch: boolean;
    } | null>(null);
    const suppressContextUntilRef = useRef<number>(0);

    const { blocks, answer, hasCurrentAnswer } = useMemo(() => getMessageActivity(msg), [msg]);
    const isWorking = msg.status === 'streaming' && !hasCurrentAnswer;
    const messageKey = getMessageKey(msg);
    const isUserMessage = msg.role === 'user';

    const clearLongPress = useCallback(() => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressStartRef.current = null;
    }, []);

    useEffect(() => clearLongPress, [clearLongPress]);

    const finishLongPress = useCallback(() => {
      clearLongPress();
      setIsTouchPress(false);
    }, [clearLongPress]);

    const handleCopy = useCallback(async () => {
      await copyTextToClipboard(answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }, [answer]);

    const createLongPressHandlers = useCallback(
      (textToCopy: string) => ({
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
          if (!textToCopy || (e.pointerType === 'mouse' && e.button !== 0)) return;
          const target = e.target instanceof Element ? e.target : null;
          if (target?.closest(NATIVE_MESSAGE_GESTURE_SELECTOR)) {
            return;
          }
          clearLongPress();
          const source = e.currentTarget;
          const startX = e.clientX;
          const startY = e.clientY;
          const isTouch = e.pointerType === 'touch';
          setIsTouchPress(isTouch);
          longPressStartRef.current = { x: startX, y: startY, pointerId: e.pointerId, isTouch };
          longPressTimerRef.current = window.setTimeout(() => {
            longPressTimerRef.current = null;
            longPressStartRef.current = null;
            setIsTouchPress(false);
            const selection = window.getSelection();
            if (isTouch) {
              selection?.removeAllRanges();
            } else if (selection?.toString().trim()) {
              return;
            }
            suppressContextUntilRef.current = Date.now() + 500;
            triggerHaptic('send', hapticEnabled);
            onOpenLongPressMenu({
              textToCopy,
              messageKey,
              source,
              alignEnd: isUserMessage,
              isTouch,
            });
          }, 420);
        },
        onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
          const start = longPressStartRef.current;
          if (!start || start.pointerId !== e.pointerId) return;
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
            finishLongPress();
          }
        },
        onPointerUp: finishLongPress,
        onPointerCancel: finishLongPress,
        onPointerLeave: finishLongPress,
        onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
          const target = e.target instanceof Element ? e.target : null;
          if (!textToCopy || target?.closest(NATIVE_MESSAGE_GESTURE_SELECTOR)) return;
          const isTouchMenu =
            longPressStartRef.current?.isTouch ||
            ('pointerType' in e.nativeEvent && e.nativeEvent.pointerType === 'touch');
          if (isTouchMenu || Date.now() < suppressContextUntilRef.current) e.preventDefault();
        },
      }),
      [clearLongPress, finishLongPress, hapticEnabled, isUserMessage, messageKey, onOpenLongPressMenu]
    );

    if (isUserMessage) {
      const userLongPress = createLongPressHandlers(msg.contentText);
      return (
        <div className="msg-row user">
          <div
            className={`user-bubble${isTouchPress ? ' is-touch-copy-press' : ''}${msg.optimisticPop ? ' pop-in' : ''}${isCopyTarget ? ' is-copy-target' : ''}`}
            {...userLongPress}
          >
            {msg.attachments.length > 0 && (
              <div className="att-chip-row">
                {msg.attachments.map((att) => (
                  <button
                    key={att.artifactId}
                    type="button"
                    className="att-chip"
                    onClick={() => onOpenAttachment(att)}
                  >
                    <FileIcon size={13} />
                    <span>{att.filename}</span>
                  </button>
                ))}
              </div>
            )}

            {msg.contentText && <div className="user-text">{msg.contentText}</div>}
          </div>
        </div>
      );
    }

    const assistantText = answer || msg.contentText;
    const assistantLongPress = createLongPressHandlers(assistantText);

    return (
      <div className="msg-row assistant">
        <div
          className={`assistant-body${isTouchPress ? ' is-touch-copy-press' : ''}${isCopyTarget ? ' is-copy-target' : ''}`}
          {...assistantLongPress}
        >
          {msg.status === 'queued' && (
            <div className="queue-status-pill">
              待機中
              {queuePosition !== null && queuePosition > 0 ? `（順番 #${queuePosition}）` : '...'}
            </div>
          )}

          {blocks.length > 0 && (
            <details className="message-activity" open={isWorking}>
              <summary className="activity-summary">
                {isWorking ? <span className="owui-tool-spinner" aria-hidden="true" /> : <SparklesIcon size={15} />}
                <span>{isWorking ? '作業中' : '作業の履歴'}</span>
                <ChevronIcon size={13} dir="right" className="activity-chevron" />
              </summary>
              <div className="activity-timeline">
                {blocks.map((block) => {
                  if (block.kind === 'tools') {
                    return (
                      <ToolActivity
                        key={block.key}
                        tools={block.tools}
                        chatId={chatId}
                        onOpenArtifact={onOpenArtifact}
                        onResolveError={onResolveError}
                      />
                    );
                  }
                  return (
                    <div key={block.key} className={block.kind === 'thoughts' ? 'activity-thoughts' : 'activity-commentary'}>
                      <MarkdownContent
                        content={block.text}
                        chatId={chatId}
                        messageStatus={msg.status}
                        onOpenArtifact={onOpenArtifact}
                        onResolveError={onResolveError}
                      />
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {msg.sessionMessages && msg.sessionMessages.length > 0 && (
            <div className="owui-tools-list" aria-label="セッション間メッセージ">
              {msg.sessionMessages.map((sm) => (
                <div key={sm.messageId} className="owui-tool-item">
                  <div className="owui-tool-body" style={{ display: 'block' }}>
                    <div className="muted-xs">
                      セッション間メッセージ{sm.senderSessionId ? ` (${sm.senderSessionId})` : ''}
                      {!sm.done ? ' [受信中]' : ''}
                    </div>
                    {sm.contentText && (
                      <MarkdownContent
                        content={sm.contentText}
                        chatId={chatId}
                        messageStatus={sm.done ? 'completed' : 'streaming'}
                        onOpenArtifact={onOpenArtifact}
                        onResolveError={onResolveError}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {msgPerms.map((perm) => (
            <PermissionCard
              key={perm.id}
              perm={perm}
              clientId={clientId}
              onResolved={onPermissionUpdated}
            />
          ))}

          {msgElicitations.map((elicit) => (
            <ElicitationCard
              key={elicit.id}
              elicit={elicit}
              clientId={clientId}
              onResolved={onElicitationUpdated}
            />
          ))}

          {answer ? (
            <div className="assistant-markdown">
              <MarkdownContent
                content={answer}
                chatId={chatId}
                messageStatus={msg.status}
                onOpenArtifact={onOpenArtifact}
                onResolveError={onResolveError}
              />
              {msg.status === 'streaming' && hasCurrentAnswer && <span className="stream-cursor" />}
            </div>
          ) : msg.status === 'streaming' && blocks.length === 0 ? (
            <div className="streaming-placeholder">
              <span className="pulse-dot" /> 応答を生成中...
            </div>
          ) : msg.status === 'cancelled' ? (
            <div className="muted-sm">（生成がキャンセルされました）</div>
          ) : null}

          {msg.errorMessage && <div className="error-box">{msg.errorMessage}</div>}

          {msgArtifacts.length > 0 && (
            <div className="artifacts-bar">
              {msgArtifacts.map((art) => (
                <button
                  key={art.id}
                  type="button"
                  className="artifact-pill"
                  onClick={() => onOpenArtifact(art)}
                >
                  <FileIcon size={14} />
                  <span>{art.filename}</span>
                  {art.diffPatch && <span className="diff-tag">Diff</span>}
                </button>
              ))}
            </div>
          )}

          {answer && msg.status !== 'streaming' && msg.status !== 'queued' && (
            <div className="msg-actions">
              <button
                type="button"
                className={`msg-action-icon-btn${copied ? ' copied' : ''}`}
                onClick={() => void handleCopy()}
                aria-label="回答をコピー"
                title={copied ? 'コピー済' : '回答をコピー'}
              >
                {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

interface ChatComposerHandle {
  addFiles: (files: File[]) => void;
  showNotice: (msg: string) => void;
  focus: () => void;
}

interface ChatComposerProps {
  chatId?: string;
  isDraftChat?: boolean;
  actionError?: string | null;
  availableCommands: AvailableCommandItem[];
  modelOptions: NonNullable<ParsedSessionOptions['configOptions']>[number]['options'];
  currentModelValue: string;
  effortOptions: NonNullable<ParsedSessionOptions['configOptions']>[number]['options'];
  currentEffortValue: string;
  contextUsage?: { used: number; size: number } | null;
  isRunBusy: boolean;
  activeRunId: string | null;
  draftResetToken: number;
  hapticEnabled: boolean;
  externalDraftCommand?: { slug: string; token: number } | null;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effortValue: string) => void;
  onDraftChange?: (hasDraft: boolean) => void;
  onDismissActionError?: () => void;
  onSendPrompt: (text: string, files: AttachmentRef[]) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<AttachmentRef[]>;
  onCancelRun: (runId: string) => Promise<void>;
  onOpenSkills?: () => void;
  onPromptSubmitting?: () => void;
}

const ChatComposer = React.memo(
  React.forwardRef<ChatComposerHandle, ChatComposerProps>(
    (
      {
        chatId,
        isDraftChat = false,
        actionError,
        availableCommands,
        modelOptions,
        currentModelValue,
        effortOptions,
        currentEffortValue,
        contextUsage,
        isRunBusy,
        activeRunId,
        draftResetToken,
        hapticEnabled,
        externalDraftCommand,
        onChangeModel,
        onChangeEffort,
        onDraftChange,
        onDismissActionError,
        onSendPrompt,
        onUploadFiles,
        onCancelRun,
        onOpenSkills,
        onPromptSubmitting,
      },
      ref
    ) => {
      const [inputText, setInputText] = useState('');
      const [stagedAttachments, setStagedAttachments] = useState<AttachmentRef[]>([]);
      const [uploading, setUploading] = useState(false);
      const [sending, setSending] = useState(false);
      const [uiNotice, setUiNotice] = useState<string | null>(null);
      const [slashDismissed, setSlashDismissed] = useState(false);
      const [slashActiveIdx, setSlashActiveIdx] = useState(0);
      const [contextOpen, setContextOpen] = useState(false);

      const fileInputRef = useRef<HTMLInputElement>(null);
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      const composerInnerRef = useRef<HTMLDivElement>(null);
      const slashListRef = useRef<HTMLDivElement>(null);
      const draftKey = chatId ?? '__new__';
      const prevDraftKeyRef = useRef<string>(draftKey);
      const currentDraftKeyRef = useRef<string>(draftKey);
      currentDraftKeyRef.current = draftKey;
      const isDraftChatRef = useRef<boolean>(isDraftChat);
      isDraftChatRef.current = isDraftChat;
      const inputTextRef = useRef(inputText);
      inputTextRef.current = inputText;
      const stagedAttachmentsRef = useRef(stagedAttachments);
      stagedAttachmentsRef.current = stagedAttachments;
      const draftsByChatRef = useRef<Map<string, { text: string; attachments: AttachmentRef[] }>>(
        new Map()
      );
      const lastDraftRef = useRef<boolean | null>(null);

      useEffect(() => {
        const prevKey = prevDraftKeyRef.current;
        if (prevKey === draftKey) return;
        prevDraftKeyRef.current = draftKey;
        setContextOpen(false);

        // When a brand-new draft chat is materialized on file upload, preserve current draft under the new ID
        if (prevKey === '__new__' && isDraftChat) {
          draftsByChatRef.current.delete('__new__');
          if (inputTextRef.current || stagedAttachmentsRef.current.length > 0) {
            draftsByChatRef.current.set(draftKey, {
              text: inputTextRef.current,
              attachments: stagedAttachmentsRef.current,
            });
          }
          return;
        }

        if (inputTextRef.current || stagedAttachmentsRef.current.length > 0) {
          draftsByChatRef.current.set(prevKey, {
            text: inputTextRef.current,
            attachments: stagedAttachmentsRef.current,
          });
        } else {
          draftsByChatRef.current.delete(prevKey);
        }

        const restored = draftsByChatRef.current.get(draftKey) ?? { text: '', attachments: [] };
        setInputText(restored.text);
        setStagedAttachments(restored.attachments);
        setUiNotice(null);
        setSlashDismissed(false);
      }, [draftKey, isDraftChat]);

      useEffect(() => {
        if (!draftResetToken) return;
        draftsByChatRef.current.delete('__new__');
        setInputText('');
        setStagedAttachments([]);
        setUiNotice(null);
        setContextOpen(false);
        setSlashDismissed(false);
        textareaRef.current?.focus();
      }, [draftResetToken]);

      useEffect(() => {
        if (!externalDraftCommand) return;
        const prefix = `/${externalDraftCommand.slug} `;
        setInputText((prev) => {
          const trimmed = prev.trimStart();
          if (!trimmed || trimmed.startsWith('/')) {
            return prefix;
          }
          return `${prefix}${trimmed}`;
        });
        setSlashDismissed(false);
        window.setTimeout(() => textareaRef.current?.focus(), 30);
      }, [externalDraftCommand?.token, externalDraftCommand?.slug]);

      const hasDraft = inputText.trim().length > 0 || stagedAttachments.length > 0;
      useEffect(() => {
        if (lastDraftRef.current !== hasDraft) {
          lastDraftRef.current = hasDraft;
          onDraftChange?.(hasDraft);
        }
      }, [hasDraft, onDraftChange]);

      // Auto-resize composer textarea (bounded on compact mobile viewports so toolbar stays reachable)
      useLayoutEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        const viewport = window.visualViewport;
        const resizeTextarea = () => {
          const viewportHeight = viewport?.height ?? window.innerHeight;
          const maxHeight = Math.min(180, Math.max(68, Math.floor(viewportHeight * 0.22)));
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
        };
        resizeTextarea();
        window.addEventListener('resize', resizeTextarea);
        viewport?.addEventListener('resize', resizeTextarea);
        return () => {
          window.removeEventListener('resize', resizeTextarea);
          viewport?.removeEventListener('resize', resizeTextarea);
        };
      }, [inputText]);

      const handleFilesSelected = useCallback(
        async (files: File[]) => {
          if (files.length === 0) return;
          const targetKey = currentDraftKeyRef.current;
          setUploading(true);
          setUiNotice(null);
          try {
            const uploaded = await onUploadFiles(files);
            const stillSameTarget =
              currentDraftKeyRef.current === targetKey ||
              (targetKey === '__new__' && isDraftChatRef.current);
            if (stillSameTarget) {
              setStagedAttachments((prev) => [...prev, ...uploaded]);
            } else {
              const saved = draftsByChatRef.current.get(targetKey) ?? { text: '', attachments: [] };
              draftsByChatRef.current.set(targetKey, {
                text: saved.text,
                attachments: [...saved.attachments, ...uploaded],
              });
            }
          } catch (err) {
            setUiNotice(err instanceof ApiError ? err.message : 'ファイル添付に失敗しました。');
          } finally {
            setUploading(false);
          }
        },
        [onUploadFiles]
      );

      useImperativeHandle(
        ref,
        () => ({
          addFiles: (files: File[]) => {
            void handleFilesSelected(files);
          },
          showNotice: (msg: string) => {
            setUiNotice(msg);
          },
          focus: () => {
            textareaRef.current?.focus();
          },
        }),
        [handleFilesSelected]
      );

      const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(inputText.normalize('NFKC'));
      const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : '';
      const slashOpen = !contextOpen && Boolean(slashMatch) && !slashDismissed;

      const closeSlash = useCallback(() => {
        setSlashDismissed(true);
      }, []);

      const handleContextOpenChange = useCallback((open: boolean) => {
        if (open) closeSlash();
        setContextOpen(open);
      }, [closeSlash]);

      const filteredCommands = useMemo(() => {
        if (!slashOpen) return [];
        const list = [...availableCommands];
        if (!slashQuery) return list;
        return list
          .filter(
            (cmd) =>
              cmd.name.toLowerCase().includes(slashQuery) ||
              cmd.description.toLowerCase().includes(slashQuery)
          )
          .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
            const bStarts = b.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;
            return a.name.localeCompare(b.name);
          });
      }, [slashOpen, slashQuery, availableCommands]);

      useEffect(() => {
        setSlashActiveIdx(0);
      }, [slashQuery, slashOpen]);

      useEffect(() => {
        if (!slashOpen) return;
        const onPointerDown = (e: PointerEvent) => {
          if (composerInnerRef.current && !composerInnerRef.current.contains(e.target as Node)) {
            closeSlash();
          }
        };
        window.addEventListener('pointerdown', onPointerDown);
        return () => window.removeEventListener('pointerdown', onPointerDown);
      }, [closeSlash, slashOpen]);

      const acceptSlashCommand = (cmd: AvailableCommandItem) => {
        const token = `/${cmd.name} `;
        setInputText(slashMatch ? token : `${token}${inputText.trimStart()}`);
        setSlashDismissed(false);
        window.setTimeout(() => textareaRef.current?.focus(), 10);
      };

      const configBusy = sending || uploading || isRunBusy;
      const canSend = !(sending || uploading || (!inputText.trim() && stagedAttachments.length === 0));
      const canStopRun = isRunBusy && Boolean(activeRunId);
      const showStopOnly = canStopRun && !hasDraft && !sending;
      const isFollowupSendMode = isRunBusy && (hasDraft || sending);
      const useIosSwitchOverlay = isAppleTouchHapticsFallback() && hapticEnabled;

      const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const trimmed = inputText.trim();
        if ((!trimmed && stagedAttachments.length === 0) || sending || uploading) return;

        // Dismiss the soft keyboard and show the submitted message
        textareaRef.current?.blur();
        if (
          typeof document !== 'undefined' &&
          document.activeElement instanceof HTMLElement &&
          composerInnerRef.current?.contains(document.activeElement)
        ) {
          document.activeElement.blur();
        }
        onPromptSubmitting?.();

        const submitDraftKey = currentDraftKeyRef.current;
        const toSendAttachments = stagedAttachments;
        const savedInput = inputText;
        draftsByChatRef.current.delete(submitDraftKey);
        setSending(true);
        setUiNotice(null);
        setInputText('');
        setStagedAttachments([]);
        setContextOpen(false);
        setSlashDismissed(false);

        try {
          await onSendPrompt(savedInput, toSendAttachments);
        } catch (err) {
          if (currentDraftKeyRef.current === submitDraftKey) {
            setInputText(savedInput);
            setStagedAttachments(toSendAttachments);
            setUiNotice(err instanceof ApiError ? err.message : 'メッセージ送信に失敗しました。');
          } else {
            draftsByChatRef.current.set(submitDraftKey, {
              text: savedInput,
              attachments: toSendAttachments,
            });
          }
        } finally {
          setSending(false);
        }
      };

      const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;

        if (slashOpen) {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeSlash();
            return;
          }
          if (filteredCommands.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              const count = filteredCommands.length;
              const nextIdx = ((slashActiveIdx % count) + step + count) % count;
              const list = slashListRef.current;
              const item = list?.children[nextIdx];
              if (list && item instanceof HTMLElement) {
                const top = item.offsetTop;
                const bottom = top + item.offsetHeight;
                list.scrollTop = Math.max(bottom - list.clientHeight, Math.min(list.scrollTop, top));
              }
              setSlashActiveIdx(nextIdx);
              return;
            }
            if ((e.key === 'Tab' || (e.key === 'Enter' && slashMatch)) && !e.shiftKey) {
              e.preventDefault();
              const chosen = filteredCommands[slashActiveIdx] ?? filteredCommands[0];
              if (chosen) acceptSlashCommand(chosen);
              return;
            }
          }
        }

        if (e.key !== 'Enter') return;
        const isMobileTouch = 'ontouchstart' in window && window.innerWidth <= 860;
        if (isMobileTouch) return;
        if (!e.shiftKey) {
          e.preventDefault();
          void handleSubmit();
        }
      };

      const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData.files ?? []);
        if (files.length > 0) {
          e.preventDefault();
          void handleFilesSelected(files);
        }
      };

      const activeNotice = uiNotice || actionError;

      return (
        <div className="composer-dock">
          <div className="composer-inner" ref={composerInnerRef}>
            <div role={actionError ? 'alert' : 'status'}>
              {activeNotice && (
                <div className={`composer-notice ${actionError && !uiNotice ? 'is-error' : ''}`}>
                  <span>{activeNotice}</span>
                  <button
                    type="button"
                    className="icon-btn-sm"
                    aria-label="通知を閉じる"
                    onClick={() => {
                      if (uiNotice) setUiNotice(null);
                      else onDismissActionError?.();
                    }}
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              )}
            </div>

            {slashOpen && (
              <div className="slash-palette">
                <div className="slash-palette-head">
                  <span className="row-actions">
                    <SparklesIcon size={13} />
                    <span>スキル / コマンド</span>
                  </span>
                  {onOpenSkills && (
                    <button
                      type="button"
                      className="chip-btn"
                      onClick={() => {
                        closeSlash();
                        onOpenSkills();
                      }}
                    >
                      スキル管理
                    </button>
                  )}
                </div>
                {filteredCommands.length === 0 ? (
                  <div className="slash-palette-empty">
                    <span>
                      {availableCommands.length === 0
                        ? '登録されたスキル・コマンドはまだありません'
                        : '一致するコマンドが見つかりません'}
                    </span>
                    {onOpenSkills && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={() => {
                          closeSlash();
                          onOpenSkills();
                        }}
                      >
                        スキルを作成・有効化
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    ref={slashListRef}
                    className="slash-palette-list"
                    role="listbox"
                    aria-label="スキル・スラッシュコマンド候補"
                  >
                    {filteredCommands.map((cmd, idx) => (
                      <button
                        key={`${cmd.name}-${cmd.scope ?? cmd.source ?? 'cmd'}`}
                        type="button"
                        role="option"
                        aria-selected={idx === slashActiveIdx}
                        className={`slash-palette-item ${idx === slashActiveIdx ? 'active' : ''}`}
                        onMouseEnter={() => setSlashActiveIdx(idx)}
                        onClick={() => acceptSlashCommand(cmd)}
                      >
                        <div className="slash-item-top">
                          <span className="slash-item-name">/{cmd.name}</span>
                          <span className="slash-item-badge">
                            {cmd.scope === 'global'
                              ? 'グローバル'
                              : cmd.scope === 'project'
                                ? 'プロジェクト'
                                : cmd.scope === 'workspace'
                                  ? 'このチャット'
                                  : 'ACP'}
                          </span>
                        </div>
                        {cmd.description && (
                          <div className="slash-item-desc">{cmd.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {stagedAttachments.length > 0 && (
              <div className="att-chip-row staged">
                {stagedAttachments.map((att) => (
                  <div key={att.artifactId} className="att-chip staged-item">
                    <FileIcon size={13} />
                    <span title={att.filename}>{att.filename}</span>
                    <button
                      type="button"
                      className="icon-btn-sm"
                      onClick={() =>
                        setStagedAttachments((prev) =>
                          prev.filter((a) => a.artifactId !== att.artifactId)
                        )
                      }
                      aria-label={`${att.filename} を添付から除外`}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleSubmit} className="composer-box">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void handleFilesSelected(list);
                }}
              />

              <textarea
                ref={textareaRef}
                aria-label="メッセージ"
                rows={1}
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  setContextOpen(false);
                  setSlashDismissed(false);
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={
                  uploading
                    ? 'ファイルをアップロード中...'
                    : isRunBusy
                      ? 'フォローアップを入力（/ でスキル呼出）'
                      : 'Antigravity に聞く（/ でスキル呼出）'
                }
                disabled={uploading}
              />

              <div className="composer-toolbar">
                <div className="composer-toolbar-left">
                  <button
                    type="button"
                    className="composer-icon-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title="ファイルを添付（複数・画像ペースト・ドロップ対応）"
                    aria-label="ファイルを添付"
                  >
                    <PlusIcon size={19} />
                  </button>

                  <button
                    type="button"
                    className={`composer-icon-btn ${slashOpen ? 'active' : ''}`}
                    onClick={() => {
                      const el = textareaRef.current;
                      const start =
                        el && typeof el.selectionStart === 'number'
                          ? el.selectionStart
                          : inputText.length;
                      const end =
                        el && typeof el.selectionEnd === 'number'
                          ? el.selectionEnd
                          : inputText.length;
                      const nextText = `${inputText.slice(0, start)}/${inputText.slice(end)}`;
                      setContextOpen(false);
                      setSlashDismissed(false);
                      setInputText(nextText);
                      el?.focus();
                      window.requestAnimationFrame(() => {
                        const target = textareaRef.current;
                        if (!target) return;
                        target.focus();
                        const caret = start + 1;
                        target.setSelectionRange(caret, caret);
                      });
                    }}
                    title="/ を入力（文頭でスキル / コマンド一覧）"
                    aria-label="/ を入力"
                    aria-expanded={slashOpen}
                  >
                    <SlashIcon size={16} />
                  </button>
                </div>

                <div className="composer-toolbar-right">
                  <ContextUsageControl
                    contextUsage={contextUsage}
                    open={contextOpen}
                    onOpenChange={handleContextOpenChange}
                  />

                  {(effortOptions.length > 0 || modelOptions.length > 0) && (
                    <EffortBar
                      options={effortOptions}
                      value={currentEffortValue}
                      modelOptions={modelOptions}
                      selectedModelId={currentModelValue}
                      disabled={configBusy}
                      onChange={onChangeEffort}
                      onChangeModel={onChangeModel}
                    />
                  )}

                  {isFollowupSendMode && (
                    <span className="followup-mode-badge" aria-hidden="true">
                      フォローアップ
                    </span>
                  )}

                  {canStopRun && activeRunId && (
                    <div className="haptic-btn-shell">
                      <button
                        type="button"
                        className="stop-btn"
                        onClick={() => {
                          triggerHaptic('stop', hapticEnabled);
                          void onCancelRun(activeRunId);
                        }}
                        title="生成・キューを停止"
                        aria-label="生成・キューを停止"
                      >
                        <StopIcon size={14} />
                      </button>
                      {useIosSwitchOverlay && (
                        <label className="ios-haptic-switch-overlay" title="生成・キューを停止">
                          <input
                            type="checkbox"
                            {...({ switch: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                            aria-label="生成・キューを停止"
                            onChange={() => void onCancelRun(activeRunId)}
                          />
                        </label>
                      )}
                    </div>
                  )}

                  {!showStopOnly && (
                    <div className="haptic-btn-shell">
                      <button
                        type="submit"
                        className={`send-btn ${isFollowupSendMode ? 'followup-btn' : ''}`}
                        disabled={!canSend}
                        title={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                        aria-label={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                      >
                        <SendIcon size={17} />
                      </button>
                      {useIosSwitchOverlay && canSend && (
                        <label
                          className="ios-haptic-switch-overlay"
                          title={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                        >
                          <input
                            type="checkbox"
                            {...({ switch: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                            aria-label={isFollowupSendMode ? 'フォローアップとして送信' : '送信'}
                            onChange={() => void handleSubmit()}
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </form>

            <div className="composer-hint">
              <span>Enter で送信 / Shift+Enter で改行・別端末ともリアルタイム同期</span>
            </div>
          </div>
        </div>
      );
    }
  )
);

const EMPTY_ELICITATIONS: PendingElicitationRecord[] = [];

export const ChatView: React.FC<ChatViewProps> = React.memo(({
  chat,
  project,
  messages,
  artifacts,
  pendingPermissions,
  pendingElicitations,
  activeRun,
  sessionOptions,
  availableCommands = [],
  selectedModelId,
  selectedEffortValue,
  contextUsage,
  draftResetToken = 0,
  isDraftChat = false,
  chatLoadError,
  actionError,
  clientId,
  hapticEnabled = true,
  onChangeModel,
  onChangeEffort,
  onDraftChange,
  onRetryLoadChat,
  onDismissActionError,
  onSendPrompt,
  onUploadFiles,
  onCancelRun,
  onSyncProject,
  onOpenArtifact,
  onPermissionUpdated,
  onElicitationUpdated,
  onOpenSkills,
  externalDraftCommand,
}) => {
  const [syncingProj, setSyncingProj] = useState(false);
  const [longPressMenu, setLongPressMenu] = useState<LongPressMenuState | null>(null);
  const menuPointerDownRef = useRef(false);
  const releaseTouchCopyGuardRef = useRef<(() => void) | null>(null);
  const copyMenuRef = useRef<HTMLDivElement>(null);

  const chatViewRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesRailRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ChatComposerHandle>(null);

  const isNearBottomRef = useRef(true);
  const scrollRafRef = useRef<number | null>(null);
  const prevScrollChatIdRef = useRef<string | undefined>(chat?.id);

  const artifactsById = useMemo(() => {
    const map = new Map<string, ArtifactRecord>();
    for (const a of artifacts) map.set(a.id, a);
    return map;
  }, [artifacts]);

  const artifactsByIdRef = useRef(artifactsById);
  artifactsByIdRef.current = artifactsById;

  const prevMsgArtifactsCacheRef = useRef<Map<string, ArtifactRecord[]>>(new Map());
  const resolvedArtifactsByMsgId = useMemo(() => {
    const nextCache = new Map<string, ArtifactRecord[]>();
    for (const msg of messages) {
      const ids = msg.artifactIds;
      if (!ids || ids.length === 0) {
        nextCache.set(msg.id, EMPTY_ARTIFACTS);
        continue;
      }
      const list: ArtifactRecord[] = [];
      for (const id of ids) {
        const found = artifactsById.get(id);
        if (found) list.push(found);
      }
      if (list.length === 0) {
        nextCache.set(msg.id, EMPTY_ARTIFACTS);
        continue;
      }
      const prev = prevMsgArtifactsCacheRef.current.get(msg.id);
      if (prev && prev.length === list.length && prev.every((item, idx) => item === list[idx])) {
        nextCache.set(msg.id, prev);
      } else {
        nextCache.set(msg.id, list);
      }
    }
    prevMsgArtifactsCacheRef.current = nextCache;
    return nextCache;
  }, [messages, artifactsById]);

  const prevPermsCacheRef = useRef<Map<string, PendingPermissionRecord[]>>(new Map());
  const pendingPermsByRunId = useMemo(() => {
    const grouped = new Map<string, PendingPermissionRecord[]>();
    for (const p of pendingPermissions) {
      if (p.status !== 'pending') continue;
      let bucket = grouped.get(p.runId);
      if (!bucket) {
        bucket = [];
        grouped.set(p.runId, bucket);
      }
      bucket.push(p);
    }
    for (const [runId, nextList] of grouped.entries()) {
      const prev = prevPermsCacheRef.current.get(runId);
      if (prev && prev.length === nextList.length && prev.every((item, idx) => item === nextList[idx])) {
        grouped.set(runId, prev);
      }
    }
    prevPermsCacheRef.current = grouped;
    return grouped;
  }, [pendingPermissions]);

  const prevElicitationsCacheRef = useRef<Map<string, PendingElicitationRecord[]>>(new Map());
  const pendingElicitationsByRunId = useMemo(() => {
    const grouped = new Map<string, PendingElicitationRecord[]>();
    for (const e of pendingElicitations) {
      if (e.status !== 'pending') continue;
      let bucket = grouped.get(e.runId);
      if (!bucket) {
        bucket = [];
        grouped.set(e.runId, bucket);
      }
      bucket.push(e);
    }
    for (const [runId, nextList] of grouped.entries()) {
      const prev = prevElicitationsCacheRef.current.get(runId);
      if (prev && prev.length === nextList.length && prev.every((item, idx) => item === nextList[idx])) {
        grouped.set(runId, prev);
      }
    }
    prevElicitationsCacheRef.current = grouped;
    return grouped;
  }, [pendingElicitations]);

  const renderedRunIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      if (m.runId) set.add(m.runId);
    }
    return set;
  }, [messages]);

  const unmatchedPermissions = useMemo(
    () => pendingPermissions.filter((p) => p.status === 'pending' && (!p.runId || !renderedRunIds.has(p.runId))),
    [pendingPermissions, renderedRunIds]
  );

  const unmatchedElicitations = useMemo(
    () => pendingElicitations.filter((e) => e.status === 'pending' && (!e.runId || !renderedRunIds.has(e.runId))),
    [pendingElicitations, renderedRunIds]
  );

  const scheduleScrollToBottom = useCallback(() => {
    if (!isNearBottomRef.current) return;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = messagesScrollRef.current;
      if (el && isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, []);

  const handlePromptSubmitting = useCallback(() => {
    isNearBottomRef.current = true;
    const el = messagesScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom]);

  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distance <= 4;
  }, []);

  const lastMsg = messages[messages.length - 1];
  const lastMsgToolSummary = useMemo(
    () => (lastMsg?.toolCalls ?? []).map((t) => `${t.toolCallId}:${t.status}`).join('|'),
    [lastMsg?.toolCalls]
  );

  useEffect(() => {
    const chatChanged = prevScrollChatIdRef.current !== chat?.id;
    prevScrollChatIdRef.current = chat?.id;

    if (chatChanged) {
      isNearBottomRef.current = true;
    }
    scheduleScrollToBottom();
  }, [
    chat?.id,
    messages.length,
    lastMsg?.role,
    lastMsg?.status,
    lastMsg?.contentText.length,
    lastMsg?.thoughtsText.length,
    lastMsg?.artifactIds.length,
    lastMsgToolSummary,
    pendingPermissions.length,
    pendingElicitations.length,
    scheduleScrollToBottom,
  ]);

  useEffect(() => {
    const scrollEl = messagesScrollRef.current;
    const railEl = messagesRailRef.current;
    if (!scrollEl || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      scheduleScrollToBottom();
    });
    ro.observe(scrollEl);
    if (railEl) ro.observe(railEl);

    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const onVvResize = () => {
      scheduleScrollToBottom();
    };
    vv?.addEventListener('resize', onVvResize);

    return () => {
      ro.disconnect();
      vv?.removeEventListener('resize', onVvResize);
    };
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  const openAttachmentRef = useCallback(
    (att: AttachmentRef) => {
      const found = artifactsByIdRef.current.get(att.artifactId);
      if (found) {
        onOpenArtifact(found);
        return;
      }
      void api
        .getArtifact(att.artifactId)
        .then((res) => {
          onOpenArtifact(res.artifact);
        })
        .catch(() => {
          composerRef.current?.showNotice('ファイルが見つかりませんでした。');
        });
    },
    [onOpenArtifact]
  );

  const handleResolveError = useCallback((message: string) => {
    composerRef.current?.showNotice(message);
  }, []);

  useEffect(() => {
    setLongPressMenu(null);
  }, [chat?.id]);

  const isTouchCopyMenuOpen = longPressMenu?.isTouch === true;

  useLayoutEffect(() => {
    if (!isTouchCopyMenuOpen) return;

    const root = document.documentElement;
    const preventNativeSelection = (event: Event) => event.preventDefault();
    const clearSelection = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) selection.removeAllRanges();
    };
    const suppressOriginalRelease = (event: TouchEvent) => {
      if (!menuPointerDownRef.current) event.preventDefault();
    };

    // The browser can start selecting outside the message after the popup appears.
    root.classList.add('is-touch-copy-menu-open');
    clearSelection();
    document.addEventListener('selectstart', preventNativeSelection, true);
    document.addEventListener('contextmenu', preventNativeSelection, true);
    document.addEventListener('selectionchange', clearSelection);
    document.addEventListener('touchend', suppressOriginalRelease, { capture: true, passive: false });

    const release = () => {
      if (releaseTouchCopyGuardRef.current !== release) return;
      releaseTouchCopyGuardRef.current = null;
      root.classList.remove('is-touch-copy-menu-open');
      document.removeEventListener('selectstart', preventNativeSelection, true);
      document.removeEventListener('contextmenu', preventNativeSelection, true);
      document.removeEventListener('selectionchange', clearSelection);
      document.removeEventListener('touchend', suppressOriginalRelease, true);
    };

    releaseTouchCopyGuardRef.current = release;
    return release;
  }, [isTouchCopyMenuOpen]);

  useLayoutEffect(() => {
    const menu = copyMenuRef.current;
    const scroller = messagesScrollRef.current;
    if (!longPressMenu || !menu || !scroller) return;

    const { source, alignEnd } = longPressMenu;
    const viewport = window.visualViewport;
    const updatePosition = () => {
      const rect = source.getBoundingClientRect();
      const frame = scroller.getBoundingClientRect();
      const margin = 12;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const left = alignEnd ? rect.right - menu.offsetWidth : rect.left;
      const gap = 8;
      const below = rect.bottom + gap;
      const above = rect.top - menu.offsetHeight - gap;
      const minTop = Math.max(viewportTop, frame.top) + margin;
      const maxTop = Math.min(viewportBottom, frame.bottom) - menu.offsetHeight - margin;
      const top = below > maxTop && above >= minTop ? above : below;

      const maxLeft = viewportRight - menu.offsetWidth - margin;
      menu.style.left = `${Math.max(viewportLeft + margin, Math.min(left, maxLeft))}px`;
      menu.style.top = `${Math.max(minTop, Math.min(top, maxTop))}px`;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setLongPressMenu(null);
      }
    };

    updatePosition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    observer?.observe(source);
    observer?.observe(scroller);
    observer?.observe(menu);
    scroller.addEventListener('scroll', updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('keydown', onKeyDown);
    viewport?.addEventListener('resize', updatePosition);
    viewport?.addEventListener('scroll', updatePosition);
    return () => {
      observer?.disconnect();
      scroller.removeEventListener('scroll', updatePosition);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('keydown', onKeyDown);
      viewport?.removeEventListener('resize', updatePosition);
      viewport?.removeEventListener('scroll', updatePosition);
    };
  }, [longPressMenu]);

  const handleOpenLongPressMenu = useCallback((menu: LongPressMenuState) => {
    menuPointerDownRef.current = false;
    setLongPressMenu(menu);
  }, []);

  const modelOption = useMemo(
    () =>
      sessionOptions?.configOptions.find(
        (o) => o.id === sessionOptions.modelOptionId || o.category === 'model'
      ),
    [sessionOptions]
  );
  const effortOption = useMemo(
    () =>
      sessionOptions?.configOptions.find(
        (o) => o.id === sessionOptions.effortOptionId || o.category === 'thought_level'
      ),
    [sessionOptions]
  );
  const modelOptions = modelOption?.options ?? EMPTY_SELECT_OPTIONS;
  const effortOptions = effortOption?.options ?? EMPTY_SELECT_OPTIONS;
  const currentModelValue =
    selectedModelId || modelOption?.currentValue || modelOptions[0]?.value || '';
  const currentEffortValue =
    (effortOptions.some((o) => o.value === selectedEffortValue) ? selectedEffortValue : undefined) ||
    effortOption?.currentValue ||
    effortOptions[0]?.value ||
    '';

  const isRunBusy = Boolean(
    activeRun &&
      (activeRun.status === 'running' ||
        activeRun.status === 'queued' ||
        activeRun.status === 'awaiting_permission')
  );

  const isStaleProjectContext =
    Boolean(chat && project && project.contextVersion > chat.projectContextVersion);

  return (
    <div
      ref={chatViewRef}
      className="chat-view"
      onDragOver={(e) => {
        e.preventDefault();
        chatViewRef.current?.classList.add('drag-over');
      }}
      onDragLeave={(e) => {
        const related = e.relatedTarget as Node | null;
        if (!related || !e.currentTarget.contains(related)) {
          chatViewRef.current?.classList.remove('drag-over');
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        chatViewRef.current?.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) composerRef.current?.addFiles(files);
      }}
    >
      {isStaleProjectContext && (
        <div className="stale-banner">
          <div className="row-actions">
            <FolderIcon size={15} />
            <span>
              プロジェクト「{project?.name}」の共有指示または資料が更新されました（現在 Ver.{chat?.projectContextVersion} → 最新 Ver.{project?.contextVersion}）。
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={syncingProj}
            onClick={async () => {
              setSyncingProj(true);
              try {
                await onSyncProject();
              } finally {
                setSyncingProj(false);
              }
            }}
          >
            <RefreshIcon size={13} className={syncingProj ? 'spin' : ''} />
            <span>{syncingProj ? '更新中...' : 'このチャットを最新化'}</span>
          </button>
        </div>
      )}

      <div ref={messagesScrollRef} className="messages-scroll" onScroll={handleMessagesScroll}>
        <div ref={messagesRailRef} className="messages-rail">
          {chatLoadError && (
            <div className="error-box chat-load-error" role="alert">
              <span>{chatLoadError}</span>
              {onRetryLoadChat && (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={onRetryLoadChat}
                >
                  再読み込み
                </button>
              )}
            </div>
          )}
          {messages.length === 0 ? (
            chatLoadError ? null : (
              <div className="welcome-empty">
                {project ? (
                  <>
                    <h2>{project.name}</h2>
                    {(project.description || project.files.length > 0) && (
                      <p className="muted-sm">
                        {project.description || `共有資料 (${project.files.length}件) が参照可能です。`}
                      </p>
                    )}
                  </>
                ) : null}
              </div>
            )
          ) : (
            messages.map((msg) => (
              <MessageRow
                key={getMessageKey(msg)}
                msg={msg}
                chatId={chat?.id}
                clientId={clientId}
                queuePosition={
                  msg.status === 'queued' &&
                  activeRun?.id === msg.runId &&
                  activeRun.queuePosition > 0
                    ? activeRun.queuePosition
                    : null
                }
                msgPerms={msg.runId ? (pendingPermsByRunId.get(msg.runId) ?? EMPTY_PERMS) : EMPTY_PERMS}
                msgElicitations={msg.runId ? (pendingElicitationsByRunId.get(msg.runId) ?? EMPTY_ELICITATIONS) : EMPTY_ELICITATIONS}
                msgArtifacts={resolvedArtifactsByMsgId.get(msg.id) ?? EMPTY_ARTIFACTS}
                isCopyTarget={longPressMenu?.messageKey === getMessageKey(msg)}
                hapticEnabled={hapticEnabled}
                onOpenArtifact={onOpenArtifact}
                onOpenAttachment={openAttachmentRef}
                onPermissionUpdated={onPermissionUpdated}
                onElicitationUpdated={onElicitationUpdated}
                onResolveError={handleResolveError}
                onOpenLongPressMenu={handleOpenLongPressMenu}
              />
            ))
          )}
          {unmatchedPermissions.map((perm) => (
            <div key={perm.id} className="msg-row assistant">
              <div className="assistant-body">
                <PermissionCard perm={perm} clientId={clientId} onResolved={onPermissionUpdated} />
              </div>
            </div>
          ))}
          {unmatchedElicitations.map((elicit) => (
            <div key={elicit.id} className="msg-row assistant">
              <div className="assistant-body">
                <ElicitationCard elicit={elicit} clientId={clientId} onResolved={onElicitationUpdated} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <ChatComposer
        ref={composerRef}
        chatId={chat?.id}
        isDraftChat={isDraftChat}
        actionError={actionError}
        availableCommands={availableCommands}
        modelOptions={modelOptions}
        currentModelValue={currentModelValue}
        effortOptions={effortOptions}
        currentEffortValue={currentEffortValue}
        contextUsage={contextUsage}
        isRunBusy={isRunBusy}
        activeRunId={activeRun?.id ?? null}
        draftResetToken={draftResetToken}
        hapticEnabled={hapticEnabled}
        externalDraftCommand={externalDraftCommand}
        onChangeModel={onChangeModel}
        onChangeEffort={onChangeEffort}
        onDraftChange={onDraftChange}
        onDismissActionError={onDismissActionError}
        onSendPrompt={onSendPrompt}
        onUploadFiles={onUploadFiles}
        onCancelRun={onCancelRun}
        onOpenSkills={onOpenSkills}
        onPromptSubmitting={handlePromptSubmitting}
      />

      {longPressMenu && typeof document !== 'undefined' &&
        createPortal(
          <div
            role="presentation"
            onPointerDown={() => {
              menuPointerDownRef.current = true;
            }}
            onClickCapture={(e) => {
              // Releasing the original touch can click the menu now under the finger.
              if (e.detail > 0 && !menuPointerDownRef.current) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="msg-context-backdrop" onClick={() => setLongPressMenu(null)} />
            <div ref={copyMenuRef} className="msg-context-menu" role="menu" aria-label="メッセージ操作">
              <button
                type="button"
                role="menuitem"
                className="msg-context-item"
                onClick={() => {
                  const text = longPressMenu.textToCopy;
                  // The clipboard fallback selects its own textarea synchronously.
                  releaseTouchCopyGuardRef.current?.();
                  setLongPressMenu(null);
                  void copyTextToClipboard(text);
                }}
              >
                <CopyIcon size={15} />
                <span>コピーする</span>
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});
