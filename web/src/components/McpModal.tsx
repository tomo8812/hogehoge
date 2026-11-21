import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  McpAuthType,
  McpDiscoveredTool,
  McpScope,
  McpServerRecord,
  McpTestResult,
  McpTransport,
} from '../types';
import { isStandalonePwa } from '../utils/notifications';
import { CheckIcon, ChevronIcon, CloseIcon, ExternalLinkIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons';
import { ModalDialog } from './ModalDialog';
import { ToggleSwitch } from './ToggleSwitch';

interface McpModalProps {
  onClose: () => void;
}

interface EditableKeyValue {
  id: string;
  name: string;
  value: string;
  keepExisting: boolean;
  maskedValue?: string;
}

type EditorViewMode = 'idle' | 'connect' | 'auth' | 'configure' | 'import';

const SCOPE_LABELS: Record<McpScope, string> = {
  shared: '共有',
  profile: '個人',
};

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  http: 'HTTP',
  sse: 'SSE',
  stdio: 'ローカル (stdio)',
};

const AUTH_LABELS: Record<McpAuthType, string> = {
  oauth: 'OAuth 2.0',
  bearer: 'Bearer トークン',
  api_key: 'API キー',
  headers: 'カスタムヘッダー',
  none: '認証なし',
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function formatServerStatusBadge(server: McpServerRecord): { label: string; tone: 'ok' | 'warn' | 'err' | 'muted' } {
  if (server.transport === 'stdio') {
    return { label: 'ローカル', tone: 'muted' };
  }
  if (server.authType === 'oauth') {
    const st = server.oauth?.status ?? 'disconnected';
    if (st === 'connected') return { label: '認証済', tone: 'ok' };
    if (st === 'expired') return { label: '期限切れ', tone: 'warn' };
    if (st === 'error') return { label: '認証エラー', tone: 'err' };
    return { label: '未認証', tone: 'warn' };
  }
  if (server.authType === 'bearer') return { label: 'Bearer', tone: 'ok' };
  if (server.authType === 'api_key') return { label: 'APIキー', tone: 'ok' };
  if (server.authType === 'headers') return { label: 'ヘッダー', tone: 'ok' };
  return { label: '認証なし', tone: 'muted' };
}

export const McpModal: React.FC<McpModalProps> = ({ onClose }) => {
  const [scopeTab, setScopeTab] = useState<McpScope>('shared');
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [callbackUrl, setCallbackUrl] = useState<string>(
    `${window.location.origin}/api/mcp/oauth/callback`
  );
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolSavingName, setToolSavingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [oauthPendingUrl, setOAuthPendingUrl] = useState<string | null>(null);
  const [oauthPendingState, setOAuthPendingState] = useState<string | null>(null);
  const [oauthManualInput, setOAuthManualInput] = useState('');
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const [mobileShowEditor, setMobileShowEditor] = useState(false);
  const [viewMode, setViewMode] = useState<EditorViewMode>('idle');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSetupFlow, setIsSetupFlow] = useState(false);

  // Connection fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<McpTransport>('http');
  const [enabled, setEnabled] = useState(true);

  // Local (stdio)
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EditableKeyValue[]>([]);

  // Remote (http / sse)
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<McpAuthType>('oauth');
  const [bearerToken, setBearerToken] = useState('');
  const [keepExistingBearer, setKeepExistingBearer] = useState(false);
  const [existingBearerMask, setExistingBearerMask] = useState('');
  const [apiKeyHeaderName, setApiKeyHeaderName] = useState('X-API-Key');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [keepExistingApiKey, setKeepExistingApiKey] = useState(false);
  const [existingApiKeyMask, setExistingApiKeyMask] = useState('');
  const [headerRows, setHeaderRows] = useState<EditableKeyValue[]>([]);

  // OAuth client fields
  const [oauthClientId, setOAuthClientId] = useState('');
  const [oauthClientSecret, setOAuthClientSecret] = useState('');
  const [clearClientSecret, setClearClientSecret] = useState(false);
  const [oauthAuthUrl, setOAuthAuthUrl] = useState('');
  const [oauthTokenUrl, setOAuthTokenUrl] = useState('');
  const [oauthScopes, setOAuthScopes] = useState('');
  const [oauthExtraParamsText, setOAuthExtraParamsText] = useState('');

  // Post-connection tool settings
  const [discoveredTools, setDiscoveredTools] = useState<McpDiscoveredTool[]>([]);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [disabledTools, setDisabledTools] = useState<string[]>([]);
  const [alwaysAllowTools, setAlwaysAllowTools] = useState<string[]>([]);
  const [expandedToolDescs, setExpandedToolDescs] = useState<Record<string, boolean>>({});
  const [toolInputDraft, setToolInputDraft] = useState('');

  // JSON import state
  const [importJsonText, setImportJsonText] = useState('');
  const [importOverwrite, setImportOverwrite] = useState(false);

  const autoProbedServerIdRef = useRef<string | null>(null);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await api.listMcpServers();
      setServers(res.servers);
      if (res.callbackUrl) setCallbackUrl(res.callbackUrl);
      return res.servers;
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'サーバー一覧を読み込めませんでした。');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const populateServerState = useCallback(
    (srv: McpServerRecord, nextMode: 'auth' | 'configure', opts?: { setupFlow?: boolean; keepNotice?: boolean }) => {
      setSelectedId(srv.id);
      setViewMode(nextMode);
      setIsSetupFlow(Boolean(opts?.setupFlow));
      setName(srv.name);
      setDescription(srv.description);
      setTransport(srv.transport);
      setEnabled(srv.enabled);
      setDiscoveredTools(srv.discoveredTools ?? []);
      setAllowedTools(srv.allowedTools ?? []);
      setDisabledTools(srv.disabledTools ?? []);
      setAlwaysAllowTools(srv.alwaysAllowTools ?? []);
      setExpandedToolDescs({});
      setToolInputDraft('');

      setCommand(srv.command ?? '');
      setArgsText(srv.args.join('\n'));
      setEnvRows(
        srv.env.map((e) => ({
          id: uid(),
          name: e.name,
          value: '',
          keepExisting: e.hasValue,
          maskedValue: e.maskedValue,
        }))
      );
      setUrl(srv.url ?? '');
      setAuthType(srv.authType);

      const authHeader = srv.headers.find((h) => h.name.toLowerCase() === 'authorization');
      if (srv.authType === 'bearer' && authHeader) {
        setKeepExistingBearer(authHeader.hasValue);
        setExistingBearerMask(authHeader.maskedValue);
        setBearerToken('');
        setHeaderRows(
          srv.headers
            .filter((h) => h.name.toLowerCase() !== 'authorization')
            .map((h) => ({
              id: uid(),
              name: h.name,
              value: '',
              keepExisting: h.hasValue,
              maskedValue: h.maskedValue,
            }))
        );
        setApiKeyHeaderName('X-API-Key');
        setApiKeyValue('');
        setKeepExistingApiKey(false);
        setExistingApiKeyMask('');
      } else if (srv.authType === 'api_key' && srv.headers.length > 0) {
        const primary = srv.headers[0];
        setApiKeyHeaderName(primary.name);
        setKeepExistingApiKey(primary.hasValue);
        setExistingApiKeyMask(primary.maskedValue);
        setApiKeyValue('');
        setHeaderRows(
          srv.headers.slice(1).map((h) => ({
            id: uid(),
            name: h.name,
            value: '',
            keepExisting: h.hasValue,
            maskedValue: h.maskedValue,
          }))
        );
        setBearerToken('');
        setKeepExistingBearer(false);
        setExistingBearerMask('');
      } else {
        setBearerToken('');
        setKeepExistingBearer(false);
        setExistingBearerMask('');
        setApiKeyHeaderName('X-API-Key');
        setApiKeyValue('');
        setKeepExistingApiKey(false);
        setExistingApiKeyMask('');
        setHeaderRows(
          srv.headers.map((h) => ({
            id: uid(),
            name: h.name,
            value: '',
            keepExisting: h.hasValue,
            maskedValue: h.maskedValue,
          }))
        );
      }

      setOAuthClientId(srv.oauth?.clientId ?? '');
      setOAuthClientSecret('');
      setClearClientSecret(false);
      setOAuthAuthUrl(srv.oauth?.authorizationUrl ?? '');
      setOAuthTokenUrl(srv.oauth?.tokenUrl ?? '');
      setOAuthScopes(srv.oauth?.scopes ?? '');
      const extraPairs = Object.entries(srv.oauth?.extraAuthParams ?? {}).map(([k, v]) => `${k}=${v}`);
      setOAuthExtraParamsText(extraPairs.join('\n'));

      if (!opts?.keepNotice) {
        setTestResult(null);
        setError(null);
        setStatusNote(null);
      }
      setOAuthPendingUrl(null);
      setOAuthPendingState(null);
      setOAuthManualInput('');
      setMobileShowEditor(true);
    },
    []
  );

  const transitionToConfigureWithToolDiscovery = useCallback(
    async (srv: McpServerRecord, opts?: { setupFlow?: boolean; statusMsg?: string }) => {
      populateServerState(srv, 'configure', {
        setupFlow: opts?.setupFlow,
        keepNotice: true,
      });
      setStatusNote(opts?.statusMsg ?? 'ツール一覧を取得しています...');
      setError(null);
      try {
        const res = await api.testMcpServer(srv.id);
        setTestResult(res.result);
        if (res.server) {
          setDiscoveredTools(res.server.discoveredTools ?? []);
          setServers((prev) => prev.map((s) => (s.id === res.server!.id ? res.server! : s)));
        } else if (res.result.tools) {
          setDiscoveredTools(res.result.tools);
        }
        if (res.result.ok) {
          const count = res.result.tools?.length ?? res.server?.discoveredTools?.length ?? 0;
          setStatusNote(
            count > 0
              ? `接続を確認しました。${count} 件のツールを利用できます。`
              : opts?.statusMsg ?? '接続を確認しました。'
          );
        } else {
          setStatusNote(null);
          setError(res.result.message);
        }
      } catch (err) {
        setStatusNote(opts?.statusMsg ?? null);
        setError(err instanceof ApiError ? err.message : 'ツール一覧の取得に失敗しました。');
      }
    },
    [populateServerState]
  );

  // Listen for OAuth completion across postMessage, BroadcastChannel, localStorage, SyncHub WS, and PWA focus
  useEffect(() => {
    const handleOAuthSuccess = (targetServerId: string | null | undefined, message?: string) => {
      setOAuthPendingUrl(null);
      setOAuthPendingState(null);
      setOAuthManualInput('');
      void loadServers().then((latest) => {
        if (!latest) return;
        const target =
          (targetServerId ? latest.find((s) => s.id === targetServerId) : null) ??
          (selectedId ? latest.find((s) => s.id === selectedId) : null);
        if (target && target.oauth?.status === 'connected') {
          void transitionToConfigureWithToolDiscovery(target, {
            setupFlow: isSetupFlow || viewMode === 'auth',
            statusMsg: message || `「${target.name}」の認証が完了しました。`,
          });
        } else if (message) {
          setStatusNote(message);
          setError(null);
        }
      });
    };

    const handleCompletePayload = (
      data: {
        type?: string;
        ok?: boolean;
        serverId?: string;
        message?: string;
      } | null
    ) => {
      if (!data || data.type !== 'agy-mcp-oauth-complete') return;
      if (data.ok) {
        handleOAuthSuccess(data.serverId, data.message || '認証が完了しました。');
      } else {
        setOAuthPendingUrl(null);
        setOAuthPendingState(null);
        setError(data.message || '認証を完了できませんでした。');
      }
    };

    const onMessage = (evt: MessageEvent) => {
      if (evt.origin !== window.location.origin) return;
      handleCompletePayload(evt.data);
    };

    const onStorage = (evt: StorageEvent) => {
      if (evt.key !== 'agy_mcp_oauth_complete' || !evt.newValue) return;
      try {
        handleCompletePayload(JSON.parse(evt.newValue));
      } catch {
        // ignore
      }
    };

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel('agy_mcp_oauth');
        bc.onmessage = (evt) => handleCompletePayload(evt.data);
      }
    } catch {
      bc = null;
    }

    const refreshAndDetectConnection = () => {
      void loadServers().then((latest) => {
        if (!latest || !selectedId) return;
        const target = latest.find((s) => s.id === selectedId);
        if (!target || target.authType !== 'oauth') return;
        if (target.oauth?.status === 'connected' && (oauthPendingUrl || viewMode === 'auth')) {
          handleOAuthSuccess(target.id, `「${target.name}」の認証が完了しました。`);
        } else if (target.oauth?.status === 'error' && target.oauth?.error && oauthPendingUrl) {
          setError(target.oauth.error);
        }
      });
    };

    const onMcpUpdated = () => {
      refreshAndDetectConnection();
    };

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible' && (oauthPendingUrl || viewMode === 'auth')) {
        refreshAndDetectConnection();
      }
    };

    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    window.addEventListener('agy:mcp-updated', onMcpUpdated);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('agy:mcp-updated', onMcpUpdated);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
      try {
        bc?.close();
      } catch {
        // ignore
      }
    };
  }, [loadServers, selectedId, oauthPendingUrl, viewMode, isSetupFlow, transitionToConfigureWithToolDiscovery]);

  const filteredServers = useMemo(
    () => servers.filter((s) => s.scope === scopeTab),
    [servers, scopeTab]
  );

  const selectedServer = useMemo(
    () => (selectedId ? servers.find((s) => s.id === selectedId) ?? null : null),
    [servers, selectedId]
  );

  // Auto-discover tools once when opening configure view for a connected server that has no cached tools yet
  useEffect(() => {
    if (viewMode !== 'configure' || !selectedServer) return;
    if (selectedServer.discoveredTools.length > 0) return;
    if (selectedServer.authType === 'oauth' && selectedServer.oauth?.status !== 'connected') return;
    if (autoProbedServerIdRef.current === selectedServer.id) return;
    autoProbedServerIdRef.current = selectedServer.id;
    void (async () => {
      try {
        const res = await api.testMcpServer(selectedServer.id);
        if (res.server) {
          setDiscoveredTools(res.server.discoveredTools ?? []);
          setServers((prev) => prev.map((s) => (s.id === res.server!.id ? res.server! : s)));
        } else if (res.result.tools) {
          setDiscoveredTools(res.result.tools);
        }
      } catch {
        // Keep manual refresh button available
      }
    })();
  }, [viewMode, selectedServer]);

  const openConnectScreen = (initialTransport: McpTransport = 'http') => {
    setSelectedId(null);
    setViewMode('connect');
    setIsSetupFlow(true);
    setName('');
    setDescription('');
    setTransport(initialTransport);
    setEnabled(true);
    setDiscoveredTools([]);
    setAllowedTools([]);
    setDisabledTools([]);
    setAlwaysAllowTools([]);
    setExpandedToolDescs({});
    setCommand('');
    setArgsText('');
    setEnvRows([]);
    setUrl('');
    setAuthType(initialTransport === 'stdio' ? 'none' : 'oauth');
    setBearerToken('');
    setKeepExistingBearer(false);
    setExistingBearerMask('');
    setApiKeyHeaderName('X-API-Key');
    setApiKeyValue('');
    setKeepExistingApiKey(false);
    setExistingApiKeyMask('');
    setHeaderRows([]);
    setOAuthClientId('');
    setOAuthClientSecret('');
    setClearClientSecret(false);
    setOAuthAuthUrl('');
    setOAuthTokenUrl('');
    setOAuthScopes('');
    setOAuthExtraParamsText('');
    setTestResult(null);
    setOAuthPendingUrl(null);
    setOAuthPendingState(null);
    setOAuthManualInput('');
    setError(null);
    setStatusNote(null);
    setMobileShowEditor(true);
  };

  const openImportForm = () => {
    setSelectedId(null);
    setViewMode('import');
    setIsSetupFlow(false);
    setImportJsonText('');
    setImportOverwrite(false);
    setError(null);
    setStatusNote(null);
    setOAuthPendingUrl(null);
    setTestResult(null);
    setMobileShowEditor(true);
  };

  const buildHeadersPayload = (): Array<{ name: string; value?: string; keepExisting?: boolean }> => {
    const out: Array<{ name: string; value?: string; keepExisting?: boolean }> = [];
    if (authType === 'bearer') {
      if (bearerToken.trim()) {
        const val = bearerToken.trim();
        out.push({
          name: 'Authorization',
          value: /^bearer\s+/i.test(val) ? val : `Bearer ${val}`,
        });
      } else if (keepExistingBearer) {
        out.push({ name: 'Authorization', keepExisting: true });
      }
    } else if (authType === 'api_key') {
      const hName = apiKeyHeaderName.trim() || 'X-API-Key';
      if (apiKeyValue.trim()) {
        out.push({ name: hName, value: apiKeyValue.trim() });
      } else if (keepExistingApiKey) {
        out.push({ name: hName, keepExisting: true });
      }
    }
    for (const row of headerRows) {
      const k = row.name.trim();
      if (!k) continue;
      if (row.keepExisting && !row.value) {
        out.push({ name: k, keepExisting: true });
      } else {
        out.push({ name: k, value: row.value });
      }
    }
    return out;
  };

  const parseExtraParams = (): Record<string, string> | null => {
    const out: Record<string, string> = {};
    for (const line of oauthExtraParamsText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k && v) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const buildConnectionPayload = () => {
    const args = argsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const env = envRows
      .filter((r) => r.name.trim().length > 0)
      .map((r) =>
        r.keepExisting && !r.value
          ? { name: r.name.trim(), keepExisting: true }
          : { name: r.name.trim(), value: r.value }
      );
    const headers = transport === 'stdio' ? undefined : buildHeadersPayload();
    const oauthConfig =
      transport !== 'stdio' && authType === 'oauth'
        ? {
            clientId: oauthClientId.trim() || null,
            ...(clearClientSecret
              ? { clearClientSecret: true }
              : oauthClientSecret.trim()
                ? { clientSecret: oauthClientSecret.trim() }
                : {}),
            authorizationUrl: oauthAuthUrl.trim() || null,
            tokenUrl: oauthTokenUrl.trim() || null,
            scopes: oauthScopes.trim() || null,
            extraAuthParams: parseExtraParams(),
          }
        : null;

    return {
      name: name.trim(),
      description: description.trim(),
      transport,
      command: transport === 'stdio' ? command.trim() : null,
      args: transport === 'stdio' ? args : [],
      env: transport === 'stdio' ? env : [],
      url: transport === 'stdio' ? null : url.trim(),
      authType: transport === 'stdio' ? ('none' as McpAuthType) : authType,
      headers,
      oauthConfig,
    };
  };

  // Step 1: Submit initial connection screen
  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatusNote(null);
    setTestResult(null);

    try {
      const payload = buildConnectionPayload();
      const res = await api.createMcpServer({
        ...payload,
        scope: scopeTab,
        enabled: true,
      });
      const saved = res.server;
      setScopeTab(saved.scope);
      await loadServers();

      if (saved.transport !== 'stdio' && saved.authType === 'oauth') {
        populateServerState(saved, 'auth', { setupFlow: true });
        return;
      }

      await transitionToConfigureWithToolDiscovery(saved, { setupFlow: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '接続の作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  // Save edited connection details from Auth or Configure view
  const handleSaveConnectionSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedServer) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);

    try {
      const payload = buildConnectionPayload();
      const res = await api.updateMcpServer(selectedServer.id, payload);
      const saved = res.server;
      await loadServers();

      if (viewMode === 'auth' && saved.authType === 'oauth') {
        populateServerState(saved, 'auth', { setupFlow: isSetupFlow, keepNotice: true });
        setStatusNote('クライアント設定を更新しました。');
      } else {
        populateServerState(saved, 'configure', { setupFlow: isSetupFlow, keepNotice: true });
        setStatusNote('接続設定を保存しました。');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '設定を保存できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleEnabled = async (srv: McpServerRecord, next: boolean) => {
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.updateMcpServer(srv.id, { enabled: next });
      setServers((prev) => prev.map((s) => (s.id === res.server.id ? res.server : s)));
      if (selectedId === srv.id) {
        setEnabled(res.server.enabled);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '有効状態の切り替えに失敗しました。');
    }
  };

  const handleDelete = async () => {
    if (!selectedServer) return;
    if (!window.confirm(`「${selectedServer.name}」を削除しますか？`)) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      await api.deleteMcpServer(selectedServer.id);
      setSelectedId(null);
      setViewMode('idle');
      setMobileShowEditor(false);
      await loadServers();
      setStatusNote(`「${selectedServer.name}」を削除しました。`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleTestAndRefreshTools = async () => {
    if (!selectedServer) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await api.testMcpServer(selectedServer.id);
      setTestResult(res.result);
      if (res.server) {
        setDiscoveredTools(res.server.discoveredTools ?? []);
        setServers((prev) => prev.map((s) => (s.id === res.server!.id ? res.server! : s)));
      } else if (res.result.tools) {
        setDiscoveredTools(res.result.tools);
      }
      if (res.result.ok) {
        const count = res.result.tools?.length ?? res.server?.discoveredTools?.length ?? 0;
        setStatusNote(count > 0 ? `${count} 件のツールを取得しました。` : res.result.message);
      } else {
        setError(res.result.message);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '接続確認に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleStartOAuth = async () => {
    if (!selectedServer) return;
    const standalone = isStandalonePwa();
    const popup = !standalone
      ? window.open('about:blank', 'agy_mcp_oauth', 'width=620,height=760')
      : null;

    setBusy(true);
    setError(null);
    setStatusNote(null);
    setOAuthPendingUrl(null);
    setOAuthPendingState(null);
    try {
      const res = await api.startMcpOAuth(selectedServer.id);
      setOAuthPendingUrl(res.authorizationUrl);
      setOAuthPendingState(res.state);

      if (popup && !popup.closed) {
        popup.location.replace(res.authorizationUrl);
        setStatusNote(
          res.mode === 'code_paste'
            ? '別ウィンドウでログインしてください。完了後のURLまたはコードを下に貼り付けて完了できます。'
            : '別ウィンドウでログインと権限の許可を完了してください。完了すると自動で次の画面へ進みます。'
        );
      } else if (standalone) {
        window.location.assign(res.launchUrl || res.authorizationUrl);
        setStatusNote('認証ページへ移動しました。完了すると自動で戻ります。');
      } else {
        setStatusNote('下の「認証ページを開く」からログインを完了してください。');
      }
    } catch (err) {
      if (popup && !popup.closed) {
        try {
          popup.close();
        } catch {
          // ignore
        }
      }
      setError(err instanceof ApiError ? err.message : '認証ページを開けませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteOAuthManual = async () => {
    if (!selectedServer || !oauthManualInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.completeMcpOAuth(selectedServer.id, {
        codeOrUrl: oauthManualInput.trim(),
        state: oauthPendingState,
      });
      setOAuthPendingUrl(null);
      setOAuthPendingState(null);
      setOAuthManualInput('');
      await loadServers();
      await transitionToConfigureWithToolDiscovery(res.server, {
        setupFlow: isSetupFlow || viewMode === 'auth',
        statusMsg: `「${res.server.name}」の認証が完了しました。`,
      });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'コードまたは URL の検証に失敗しました。'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnectOAuth = async () => {
    if (!selectedServer) return;
    setBusy(true);
    setError(null);
    setStatusNote(null);
    setOAuthPendingUrl(null);
    setOAuthPendingState(null);
    setOAuthManualInput('');
    try {
      const res = await api.disconnectMcpOAuth(selectedServer.id);
      await loadServers();
      populateServerState(res.server, 'configure', { setupFlow: false, keepNotice: true });
      setStatusNote('認証を解除しました。');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '認証解除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleImportJson = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.importMcpJson({
        scope: scopeTab,
        rawJson: importJsonText,
        overwrite: importOverwrite,
      });
      await loadServers();
      const first = res.imported[0];
      if (first) {
        if (first.transport !== 'stdio' && first.authType === 'oauth' && first.oauth?.status !== 'connected') {
          populateServerState(first, 'auth', { setupFlow: true, keepNotice: true });
        } else {
          await transitionToConfigureWithToolDiscovery(first, { setupFlow: false });
        }
      } else {
        setViewMode('idle');
      }
      const skippedMsg = res.skipped.length > 0 ? `（スキップ: ${res.skipped.join(', ')}）` : '';
      setStatusNote(`${res.imported.length} 件を取り込みました${skippedMsg}。`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'JSON の取り込みに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const copyCallbackUrl = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setStatusNote('コールバック URL をコピーしました。');
    } catch {
      setStatusNote(callbackUrl);
    }
  };

  // Unified tool list for Configure view
  const mergedTools = useMemo(() => {
    const map = new Map<string, McpDiscoveredTool>();
    for (const t of discoveredTools) {
      map.set(t.name, t);
    }
    for (const nameItem of [...allowedTools, ...disabledTools, ...alwaysAllowTools]) {
      if (!map.has(nameItem)) {
        map.set(nameItem, { name: nameItem });
      }
    }
    return [...map.values()];
  }, [discoveredTools, allowedTools, disabledTools, alwaysAllowTools]);

  const isToolEnabled = useCallback(
    (toolName: string): boolean => {
      if (disabledTools.includes(toolName)) return false;
      if (allowedTools.length > 0) return allowedTools.includes(toolName);
      return true;
    },
    [allowedTools, disabledTools]
  );

  const persistToolPolicies = async (
    nextAllowed: string[],
    nextDisabled: string[],
    nextAlwaysAllow: string[],
    savingKey: string
  ) => {
    if (!selectedServer) return;
    const prevAllowed = allowedTools;
    const prevDisabled = disabledTools;
    const prevAlways = alwaysAllowTools;

    setAllowedTools(nextAllowed);
    setDisabledTools(nextDisabled);
    setAlwaysAllowTools(nextAlwaysAllow);
    setToolSavingName(savingKey);
    setError(null);
    try {
      const res = await api.updateMcpServer(selectedServer.id, {
        allowedTools: nextAllowed,
        disabledTools: nextDisabled,
        alwaysAllowTools: nextAlwaysAllow,
      });
      setServers((prev) => prev.map((s) => (s.id === res.server.id ? res.server : s)));
      setAllowedTools(res.server.allowedTools);
      setDisabledTools(res.server.disabledTools);
      setAlwaysAllowTools(res.server.alwaysAllowTools);
    } catch (err) {
      setAllowedTools(prevAllowed);
      setDisabledTools(prevDisabled);
      setAlwaysAllowTools(prevAlways);
      setError(err instanceof ApiError ? err.message : 'ツール設定の更新に失敗しました。');
    } finally {
      setToolSavingName(null);
    }
  };

  const handleToggleToolEnabled = (toolName: string, nextEnabled: boolean) => {
    const allNames = mergedTools.map((t) => t.name);
    let nextAllowed = [...allowedTools];
    let nextDisabled = [...disabledTools];
    let nextAlways = [...alwaysAllowTools];

    if (discoveredTools.length > 0) {
      // Transition cleanly from legacy allowedTools-only restriction to explicit disabledTools list
      const currentlyEnabled = new Set(allNames.filter((n) => isToolEnabled(n)));
      if (nextEnabled) currentlyEnabled.add(toolName);
      else currentlyEnabled.delete(toolName);
      nextAllowed = [];
      nextDisabled = allNames.filter((n) => !currentlyEnabled.has(n));
    } else {
      if (nextEnabled) {
        nextDisabled = nextDisabled.filter((n) => n !== toolName);
        if (nextAllowed.length > 0 && !nextAllowed.includes(toolName)) {
          nextAllowed.push(toolName);
        }
      } else {
        if (!nextDisabled.includes(toolName)) nextDisabled.push(toolName);
        nextAllowed = nextAllowed.filter((n) => n !== toolName);
      }
    }

    if (!nextEnabled) {
      nextAlways = nextAlways.filter((n) => n !== toolName);
    }

    void persistToolPolicies(nextAllowed, nextDisabled, nextAlways, toolName);
  };

  const handleSetToolPolicy = (toolName: string, policy: 'ask' | 'always') => {
    const nextAlways =
      policy === 'always'
        ? alwaysAllowTools.includes(toolName)
          ? alwaysAllowTools
          : [...alwaysAllowTools, toolName]
        : alwaysAllowTools.filter((n) => n !== toolName);
    void persistToolPolicies(allowedTools, disabledTools, nextAlways, toolName);
  };

  const handleEnableAllTools = () => {
    void persistToolPolicies([], [], alwaysAllowTools, '__bulk__');
  };

  const handleResetAllToAsk = () => {
    void persistToolPolicies(allowedTools, disabledTools, [], '__bulk__');
  };

  const handleAddManualTools = () => {
    const tokens = toolInputDraft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tokens.length === 0) return;

    const nextDisabled = disabledTools.filter((n) => !tokens.includes(n));
    let nextAllowed = [...allowedTools];
    if (discoveredTools.length === 0) {
      const seen = new Set(nextAllowed);
      for (const tok of tokens) {
        if (!seen.has(tok)) {
          seen.add(tok);
          nextAllowed.push(tok);
        }
      }
    } else {
      nextAllowed = [];
      // Keep manual tools visible even if not in discoveredTools by updating local state + allowedTools if needed
      setDiscoveredTools((prev) => {
        const next = [...prev];
        for (const tok of tokens) {
          if (!next.some((t) => t.name === tok)) next.push({ name: tok });
        }
        return next;
      });
    }
    setToolInputDraft('');
    void persistToolPolicies(nextAllowed, nextDisabled, alwaysAllowTools, '__bulk__');
  };

  const toggleToolDescription = (toolName: string) => {
    setExpandedToolDescs((prev) => ({
      ...prev,
      [toolName]: !prev[toolName],
    }));
  };

  const enabledToolsCount = useMemo(
    () => mergedTools.filter((t) => isToolEnabled(t.name)).length,
    [mergedTools, isToolEnabled]
  );
  const effectiveAlwaysCount = useMemo(
    () => mergedTools.filter((t) => isToolEnabled(t.name) && alwaysAllowTools.includes(t.name)).length,
    [mergedTools, isToolEnabled, alwaysAllowTools]
  );

  const renderConnectionFields = (idPrefix: string, includeDescription: boolean) => (
    <>
      <div className="mcp-grid-2">
        <div className="form-group">
          <label htmlFor={`${idPrefix}-name`}>サーバー名 *</label>
          <input
            id={`${idPrefix}-name`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: linear / github"
            pattern="^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor={`${idPrefix}-transport`}>接続方法</label>
          <select
            id={`${idPrefix}-transport`}
            value={transport}
            onChange={(e) => {
              const next = e.target.value as McpTransport;
              setTransport(next);
              if (next === 'stdio') setAuthType('none');
              else if (authType === 'none' && transport === 'stdio') setAuthType('oauth');
            }}
          >
            <option value="http">{TRANSPORT_LABELS.http}</option>
            <option value="sse">{TRANSPORT_LABELS.sse}</option>
            <option value="stdio">{TRANSPORT_LABELS.stdio}</option>
          </select>
        </div>
      </div>

      {includeDescription && (
        <div className="form-group">
          <label htmlFor={`${idPrefix}-desc`}>メモ（任意）</label>
          <input
            id={`${idPrefix}-desc`}
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="用途や補足"
          />
        </div>
      )}

      {transport === 'stdio' ? (
        <>
          <div className="form-group">
            <label htmlFor={`${idPrefix}-cmd`}>コマンド *</label>
            <input
              id={`${idPrefix}-cmd`}
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="例: npx / uvx / node"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor={`${idPrefix}-args`}>引数（1行に1つ）</label>
            <textarea
              id={`${idPrefix}-args`}
              rows={3}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir'}
            />
          </div>

          <div className="form-group">
            <div className="mcp-kv-header">
              <span className="mcp-kv-label">環境変数</span>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={() =>
                  setEnvRows((prev) => [
                    ...prev,
                    { id: uid(), name: '', value: '', keepExisting: false },
                  ])
                }
              >
                <PlusIcon size={12} /> 追加
              </button>
            </div>
            {envRows.map((row) => (
              <div key={row.id} className="mcp-kv-row">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) =>
                    setEnvRows((prev) =>
                      prev.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r))
                    )
                  }
                  placeholder="変数名"
                  aria-label="環境変数名"
                />
                <input
                  type="password"
                  value={row.value}
                  onChange={(e) =>
                    setEnvRows((prev) =>
                      prev.map((r) =>
                        r.id === row.id
                          ? { ...r, value: e.target.value, keepExisting: false }
                          : r
                      )
                    )
                  }
                  placeholder={row.keepExisting ? `設定済 (${row.maskedValue}) — 変更時のみ入力` : '値'}
                  aria-label="環境変数の値"
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="環境変数を削除"
                  onClick={() => setEnvRows((prev) => prev.filter((r) => r.id !== row.id))}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mcp-grid-2">
            <div className="form-group">
              <label htmlFor={`${idPrefix}-url`}>サーバー URL *</label>
              <input
                id={`${idPrefix}-url`}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor={`${idPrefix}-auth`}>認証方法</label>
              <select
                id={`${idPrefix}-auth`}
                value={authType}
                onChange={(e) => setAuthType(e.target.value as McpAuthType)}
              >
                <option value="oauth">{AUTH_LABELS.oauth}</option>
                <option value="bearer">{AUTH_LABELS.bearer}</option>
                <option value="api_key">{AUTH_LABELS.api_key}</option>
                <option value="headers">{AUTH_LABELS.headers}</option>
                <option value="none">{AUTH_LABELS.none}</option>
              </select>
            </div>
          </div>

          {authType === 'bearer' && (
            <div className="form-group">
              <label htmlFor={`${idPrefix}-bearer`}>Bearer トークン</label>
              <input
                id={`${idPrefix}-bearer`}
                type="password"
                value={bearerToken}
                onChange={(e) => {
                  setBearerToken(e.target.value);
                  if (e.target.value) setKeepExistingBearer(false);
                }}
                placeholder={keepExistingBearer ? `設定済 (${existingBearerMask}) — 変更時のみ入力` : 'トークンを入力'}
              />
            </div>
          )}

          {authType === 'api_key' && (
            <div className="mcp-grid-2">
              <div className="form-group">
                <label htmlFor={`${idPrefix}-apikey-name`}>ヘッダー名</label>
                <input
                  id={`${idPrefix}-apikey-name`}
                  type="text"
                  value={apiKeyHeaderName}
                  onChange={(e) => setApiKeyHeaderName(e.target.value)}
                  placeholder="X-API-Key"
                />
              </div>
              <div className="form-group">
                <label htmlFor={`${idPrefix}-apikey-val`}>API キー</label>
                <input
                  id={`${idPrefix}-apikey-val`}
                  type="password"
                  value={apiKeyValue}
                  onChange={(e) => {
                    setApiKeyValue(e.target.value);
                    if (e.target.value) setKeepExistingApiKey(false);
                  }}
                  placeholder={keepExistingApiKey ? `設定済 (${existingApiKeyMask}) — 変更時のみ入力` : 'API キーを入力'}
                />
              </div>
            </div>
          )}

          {(authType === 'headers' || authType === 'bearer' || authType === 'api_key') && (
            <div className="form-group">
              <div className="mcp-kv-header">
                <span className="mcp-kv-label">
                  {authType === 'headers' ? 'HTTP ヘッダー' : '追加ヘッダー（任意）'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() =>
                    setHeaderRows((prev) => [
                      ...prev,
                      { id: uid(), name: '', value: '', keepExisting: false },
                    ])
                  }
                >
                  <PlusIcon size={12} /> 追加
                </button>
              </div>
              {headerRows.map((row) => (
                <div key={row.id} className="mcp-kv-row">
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) =>
                      setHeaderRows((prev) =>
                        prev.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r))
                      )
                    }
                    placeholder="ヘッダー名"
                    aria-label="HTTPヘッダー名"
                  />
                  <input
                    type="password"
                    value={row.value}
                    onChange={(e) =>
                      setHeaderRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id
                            ? { ...r, value: e.target.value, keepExisting: false }
                            : r
                        )
                      )
                    }
                    placeholder={row.keepExisting ? `設定済 (${row.maskedValue}) — 変更時のみ入力` : '値'}
                    aria-label="HTTPヘッダー値"
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="ヘッダーを削除"
                    onClick={() => setHeaderRows((prev) => prev.filter((r) => r.id !== row.id))}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {authType === 'oauth' && (
            <details className="mcp-oauth-disclosure">
              <summary>OAuth クライアント情報（必要な場合のみ）</summary>
              <div className="mcp-oauth-advanced">
                <p className="muted-xs" style={{ margin: 0 }}>
                  通常は空欄のまま自動で設定されます。手動登録が必要な場合のみ入力してください。
                </p>
                <div className="mcp-grid-2">
                  <div className="form-group">
                    <label htmlFor={`${idPrefix}-oauth-cid`}>Client ID</label>
                    <input
                      id={`${idPrefix}-oauth-cid`}
                      type="text"
                      value={oauthClientId}
                      onChange={(e) => setOAuthClientId(e.target.value)}
                      placeholder="自動取得"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`${idPrefix}-oauth-csec`}>Client Secret</label>
                    <input
                      id={`${idPrefix}-oauth-csec`}
                      type="password"
                      value={oauthClientSecret}
                      onChange={(e) => {
                        setOAuthClientSecret(e.target.value);
                        if (e.target.value) setClearClientSecret(false);
                      }}
                      placeholder={selectedServer?.oauth?.hasClientSecret ? '設定済 — 変更時のみ入力' : '任意'}
                    />
                  </div>
                </div>
                <div className="mcp-grid-2">
                  <div className="form-group">
                    <label htmlFor={`${idPrefix}-oauth-authurl`}>Authorization URL</label>
                    <input
                      id={`${idPrefix}-oauth-authurl`}
                      type="url"
                      value={oauthAuthUrl}
                      onChange={(e) => setOAuthAuthUrl(e.target.value)}
                      placeholder="自動取得"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor={`${idPrefix}-oauth-tokurl`}>Token URL</label>
                    <input
                      id={`${idPrefix}-oauth-tokurl`}
                      type="url"
                      value={oauthTokenUrl}
                      onChange={(e) => setOAuthTokenUrl(e.target.value)}
                      placeholder="自動取得"
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor={`${idPrefix}-oauth-scopes`}>スコープ</label>
                  <input
                    id={`${idPrefix}-oauth-scopes`}
                    type="text"
                    value={oauthScopes}
                    onChange={(e) => setOAuthScopes(e.target.value)}
                    placeholder="例: mcp:tools"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor={`${idPrefix}-oauth-extra`}>追加パラメータ（key=value）</label>
                  <textarea
                    id={`${idPrefix}-oauth-extra`}
                    rows={2}
                    value={oauthExtraParamsText}
                    onChange={(e) => setOAuthExtraParamsText(e.target.value)}
                    placeholder="resource=https://example.com"
                  />
                </div>
              </div>
            </details>
          )}
        </>
      )}
    </>
  );

  return (
    <ModalDialog label="MCP サーバー" size="modal-xl" onClose={onClose}>
      <div className="modal-head">
        <div className="modal-head-title-wrap">
          <h3>MCP サーバー</h3>
          <p className="muted-xs" style={{ marginTop: 2 }}>
            外部ツールやサービスをチャットに接続します
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
          <CloseIcon size={18} />
        </button>
      </div>

      <div className="skills-scope-tabs" role="tablist" aria-label="適用範囲">
        {(['shared', 'profile'] as McpScope[]).map((sc) => {
          const count = servers.filter((s) => s.scope === sc).length;
          return (
            <button
              key={sc}
              type="button"
              role="tab"
              aria-selected={scopeTab === sc}
              className={`skills-scope-tab ${scopeTab === sc ? 'active' : ''}`}
              onClick={() => {
                setScopeTab(sc);
                setSelectedId(null);
                setViewMode('idle');
                setIsSetupFlow(false);
                setTestResult(null);
                setOAuthPendingUrl(null);
                setError(null);
                setStatusNote(null);
                setMobileShowEditor(false);
              }}
            >
              <span>{SCOPE_LABELS[sc]}</span>
              <span className="skills-tab-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className={`skills-body ${mobileShowEditor ? 'mobile-editor' : ''}`}>
        {/* Left pane: Server list */}
        <div className="skills-list-pane">
          <div className="skills-list-toolbar">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => openConnectScreen('http')}
            >
              <PlusIcon size={13} /> サーバーを追加
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={openImportForm}
            >
              JSON 取込
            </button>
          </div>

          <div className="muted-xs" style={{ padding: '0 12px 8px' }}>
            {scopeTab === 'shared'
              ? '全ユーザーのチャットで利用できるサーバーを管理します。'
              : '自分のアカウントのチャットでのみ利用できるサーバーを管理します。'}
          </div>

          {loading ? (
            <div className="muted-xs" style={{ padding: 16 }}>読み込み中...</div>
          ) : listError ? (
            <div className="error-box" role="alert" style={{ margin: '0 12px 12px' }}>
              <div>{listError}</div>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                style={{ marginTop: 8 }}
                onClick={() => void loadServers()}
              >
                再読み込み
              </button>
            </div>
          ) : filteredServers.length === 0 ? (
            <div className="skills-empty-list">
              <p className="muted-xs">登録されたサーバーはありません。</p>
              <div className="row-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={() => openConnectScreen('http')}
                >
                  サーバーを接続
                </button>
              </div>
            </div>
          ) : (
            <div className="skills-list">
              {filteredServers.map((srv) => {
                const badge = formatServerStatusBadge(srv);
                const isSelected = selectedId === srv.id && (viewMode === 'configure' || viewMode === 'auth');
                return (
                  <div
                    key={srv.id}
                    className={`skill-list-item ${isSelected ? 'selected' : ''} ${!srv.enabled ? 'disabled' : ''}`}
                  >
                    <button
                      type="button"
                      className="skill-list-item-btn"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => {
                        const targetView =
                          srv.transport !== 'stdio' &&
                          srv.authType === 'oauth' &&
                          srv.oauth?.status !== 'connected'
                            ? 'auth'
                            : 'configure';
                        populateServerState(srv, targetView, { setupFlow: false });
                      }}
                    >
                      <div className="skill-list-main">
                        <div className="skill-list-title">
                          <strong>{srv.name}</strong>
                          <span className="mcp-badge mcp-badge-transport">{srv.transport.toUpperCase()}</span>
                          <span className={`mcp-badge mcp-badge-${badge.tone}`}>{badge.label}</span>
                        </div>
                        <div className="muted-xs skill-list-desc">
                          {srv.description || (srv.transport === 'stdio' ? srv.command : srv.url) || ''}
                        </div>
                      </div>
                    </button>
                    <div className="skill-list-toggle">
                      <ToggleSwitch
                        checked={srv.enabled}
                        label=""
                        ariaLabel={`${srv.name} を有効にする`}
                        onChange={(next) => void handleToggleEnabled(srv, next)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right pane */}
        <div className="skills-editor-pane">
          {mobileShowEditor && (
            <div className="skills-mobile-back mcp-mobile-back">
              <button
                type="button"
                className="btn btn-secondary btn-xs mobile-back-btn"
                onClick={() => setMobileShowEditor(false)}
              >
                ← 一覧へ戻る
              </button>
            </div>
          )}

          {error && <div className="error-box" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
          {statusNote && (
            <div className="success-box" role="status" style={{ marginBottom: 12 }}>
              <div>{statusNote}</div>
            </div>
          )}

          {viewMode === 'idle' && (
            <div className="skills-editor-idle">
              <h4>MCP サーバーを追加または選択</h4>
              <p className="muted-xs">
                「共有」は全ユーザーに適用され、「個人」は自分のアカウントのみに適用されます。
              </p>
              <div className="row-actions" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => openConnectScreen('http')}
                >
                  <PlusIcon size={14} /> 新しいサーバーを接続
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={openImportForm}
                >
                  JSON から取り込む
                </button>
              </div>
            </div>
          )}

          {viewMode === 'import' && (
            <form onSubmit={handleImportJson} className="mcp-form">
              <h4>JSON から追加（{SCOPE_LABELS[scopeTab]}）</h4>
              <p className="muted-xs">
                <code>mcpServers</code> 形式の設定 JSON を貼り付けてまとめて登録できます。
              </p>

              <div className="form-group">
                <label htmlFor="mcp-import-json">JSON 設定</label>
                <textarea
                  id="mcp-import-json"
                  rows={10}
                  value={importJsonText}
                  onChange={(e) => setImportJsonText(e.target.value)}
                  placeholder={`{\n  "mcpServers": {\n    "linear": {\n      "url": "https://mcp.linear.app/mcp"\n    }\n  }\n}`}
                  required
                />
              </div>

              <ToggleSwitch
                checked={importOverwrite}
                label="同名のサーバーがある場合は上書きする"
                onChange={setImportOverwrite}
              />

              <div className="row-actions mcp-form-actions" style={{ marginTop: 10 }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                  取り込む
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setViewMode('idle');
                    setMobileShowEditor(false);
                  }}
                >
                  キャンセル
                </button>
              </div>
            </form>
          )}

          {/* Step 1: Connect Screen — ONLY connection essentials */}
          {viewMode === 'connect' && (
            <form onSubmit={handleConnectSubmit} className="mcp-form">
              <div className="mcp-stepper" aria-label="設定手順">
                <span className="mcp-step is-active">1. 接続情報</span>
                {transport !== 'stdio' && authType === 'oauth' && (
                  <>
                    <span className="mcp-step-sep">→</span>
                    <span className="mcp-step">2. 認証</span>
                  </>
                )}
                <span className="mcp-step-sep">→</span>
                <span className="mcp-step">
                  {transport !== 'stdio' && authType === 'oauth' ? '3. ツール設定' : '2. ツール設定'}
                </span>
              </div>

              <div className="mcp-form-header">
                <h4>サーバーを接続（{SCOPE_LABELS[scopeTab]}）</h4>
              </div>

              {renderConnectionFields('mcp-connect', false)}

              <div className="row-actions mcp-form-actions" style={{ marginTop: 6 }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                  {busy
                    ? '処理中...'
                    : transport !== 'stdio' && authType === 'oauth'
                      ? '次へ：認証へ進む'
                      : '接続してツール設定へ'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setViewMode('idle');
                    setMobileShowEditor(false);
                  }}
                >
                  キャンセル
                </button>
              </div>
            </form>
          )}

          {/* Step 2: Dedicated Auth UI (OAuth) */}
          {viewMode === 'auth' && selectedServer && (
            <div className="mcp-form">
              {isSetupFlow && (
                <div className="mcp-stepper" aria-label="設定手順">
                  <span className="mcp-step is-done">
                    <CheckIcon size={12} /> 1. 接続情報
                  </span>
                  <span className="mcp-step-sep">→</span>
                  <span className="mcp-step is-active">2. 認証</span>
                  <span className="mcp-step-sep">→</span>
                  <span className="mcp-step">3. ツール設定</span>
                </div>
              )}

              <div className="mcp-auth-card">
                <div className="mcp-auth-card-head">
                  <div>
                    <div className="mcp-auth-title">
                      <strong>{selectedServer.name}</strong>
                      <span className="mcp-badge mcp-badge-transport">
                        {selectedServer.transport.toUpperCase()}
                      </span>
                      <span className={`mcp-badge mcp-badge-${formatServerStatusBadge(selectedServer).tone}`}>
                        {formatServerStatusBadge(selectedServer).label}
                      </span>
                    </div>
                    {selectedServer.url && (
                      <div className="muted-xs" style={{ marginTop: 4, wordBreak: 'break-all' }}>
                        {selectedServer.url}
                      </div>
                    )}
                  </div>
                </div>

                <p className="muted-sm" style={{ margin: 0 }}>
                  {selectedServer.oauth?.status === 'connected'
                    ? '認証は完了しています。ツール設定へ進むか、必要に応じて再認証できます。'
                    : 'アカウントでログインして接続を許可してください。認証が完了するとツール設定へ進みます。'}
                </p>

                {selectedServer.oauth?.error && (
                  <div className="error-box" role="alert">
                    {selectedServer.oauth.error}
                  </div>
                )}

                <div className="row-actions" style={{ flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busy}
                    onClick={() => void handleStartOAuth()}
                  >
                    <ExternalLinkIcon size={14} />
                    <span>
                      {selectedServer.oauth?.status === 'connected' ? '再認証する' : '認証ページを開く'}
                    </span>
                  </button>

                  {oauthPendingUrl && (
                    <a
                      href={oauthPendingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-sm"
                    >
                      <span>ページをもう一度開く</span>
                      <ExternalLinkIcon size={13} />
                    </a>
                  )}

                  {selectedServer.oauth?.status === 'connected' && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() =>
                        void transitionToConfigureWithToolDiscovery(selectedServer, {
                          setupFlow: isSetupFlow,
                        })
                      }
                    >
                      ツール設定へ進む
                    </button>
                  )}
                </div>

                <div className="mcp-auth-manual">
                  <label htmlFor="mcp-oauth-manual" className="mcp-kv-label">
                    リダイレクト後の URL または認可コード（自動反映されない場合）
                  </label>
                  <div className="mcp-tools-add-row">
                    <input
                      id="mcp-oauth-manual"
                      type="text"
                      value={oauthManualInput}
                      onChange={(e) => setOAuthManualInput(e.target.value)}
                      placeholder="https://... または code を貼り付け"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy || !oauthManualInput.trim()}
                      onClick={() => void handleCompleteOAuthManual()}
                    >
                      認証を完了
                    </button>
                  </div>
                </div>
              </div>

              <details className="mcp-oauth-disclosure">
                <summary>接続先・クライアント詳細を編集</summary>
                <form onSubmit={handleSaveConnectionSettings} className="mcp-oauth-advanced">
                  <div className="mcp-callback-row" style={{ marginTop: 0 }}>
                    <span className="mcp-kv-label">コールバック URL</span>
                    <div className="mcp-callback-copy">
                      <code>{callbackUrl}</code>
                      <button type="button" className="btn btn-secondary btn-xs" onClick={copyCallbackUrl}>
                        コピー
                      </button>
                    </div>
                  </div>
                  {renderConnectionFields('mcp-auth-edit', false)}
                  <div className="row-actions">
                    <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
                      設定を保存
                    </button>
                  </div>
                </form>
              </details>

              <div className="row-actions" style={{ justifyContent: 'space-between' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => populateServerState(selectedServer, 'configure', { setupFlow: false })}
                >
                  あとで認証して設定画面へ
                </button>
                <button
                  type="button"
                  className="btn btn-danger-outline btn-sm"
                  disabled={busy}
                  onClick={() => void handleDelete()}
                >
                  削除
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Post-Connection Settings UI (clearly separated from Connect screen) */}
          {viewMode === 'configure' && selectedServer && (
            <div className="mcp-form">
              {isSetupFlow && (
                <div className="mcp-stepper" aria-label="設定手順">
                  <span className="mcp-step is-done">
                    <CheckIcon size={12} /> 1. 接続情報
                  </span>
                  {selectedServer.transport !== 'stdio' && selectedServer.authType === 'oauth' && (
                    <>
                      <span className="mcp-step-sep">→</span>
                      <span className="mcp-step is-done">
                        <CheckIcon size={12} /> 2. 認証
                      </span>
                    </>
                  )}
                  <span className="mcp-step-sep">→</span>
                  <span className="mcp-step is-active">
                    {selectedServer.transport !== 'stdio' && selectedServer.authType === 'oauth'
                      ? '3. ツール設定'
                      : '2. ツール設定'}
                  </span>
                </div>
              )}

              {/* Server status & enablement header */}
              <div className="mcp-config-header-card">
                <div className="mcp-config-header-main">
                  <div className="mcp-config-title-row">
                    <h4>{selectedServer.name}</h4>
                    <span className="mcp-badge mcp-badge-transport">
                      {selectedServer.transport.toUpperCase()}
                    </span>
                    <span className={`mcp-badge mcp-badge-${formatServerStatusBadge(selectedServer).tone}`}>
                      {formatServerStatusBadge(selectedServer).label}
                    </span>
                  </div>
                  <div className="muted-xs" style={{ wordBreak: 'break-all' }}>
                    {selectedServer.description ||
                      (selectedServer.transport === 'stdio'
                        ? [selectedServer.command, ...selectedServer.args].filter(Boolean).join(' ')
                        : selectedServer.url) ||
                      ''}
                  </div>
                </div>

                <div className="mcp-config-header-actions">
                  <ToggleSwitch
                    checked={enabled}
                    label={enabled ? '有効' : '無効'}
                    ariaLabel={`${selectedServer.name} の有効・無効を切り替え`}
                    onChange={(next) => void handleToggleEnabled(selectedServer, next)}
                  />
                </div>
              </div>

              <div className="row-actions mcp-config-toolbar">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={busy}
                  onClick={() => void handleTestAndRefreshTools()}
                >
                  <RefreshIcon size={13} /> ツール一覧を更新
                </button>
                {selectedServer.transport !== 'stdio' && selectedServer.authType === 'oauth' && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      disabled={busy}
                      onClick={() => populateServerState(selectedServer, 'auth', { setupFlow: false })}
                    >
                      {selectedServer.oauth?.status === 'connected' ? '再認証' : '認証する'}
                    </button>
                    {selectedServer.oauth?.status === 'connected' && (
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-xs"
                        disabled={busy}
                        onClick={() => void handleDisconnectOAuth()}
                      >
                        認証解除
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="btn btn-danger-outline btn-xs"
                  style={{ marginLeft: 'auto' }}
                  disabled={busy}
                  onClick={() => void handleDelete()}
                >
                  <TrashIcon size={13} /> 削除
                </button>
              </div>

              {testResult && !testResult.ok && (
                <div className="error-box" role="alert">
                  <div>{testResult.message}</div>
                  {testResult.status === 'oauth_required' && selectedServer.authType !== 'oauth' && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      style={{ marginTop: 8 }}
                      disabled={busy}
                      onClick={() => {
                        void (async () => {
                          setBusy(true);
                          try {
                            const updated = await api.updateMcpServer(selectedServer.id, { authType: 'oauth' });
                            await loadServers();
                            populateServerState(updated.server, 'auth', { setupFlow: true });
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      OAuth 認証に切り替える
                    </button>
                  )}
                </div>
              )}

              {/* Primary Section: Dynamic Tool List & Per-Tool Permissions */}
              <section className="mcp-tools-panel" aria-label="ツール権限設定">
                <div className="mcp-tools-panel-head">
                  <div>
                    <h5>ツールと実行許可</h5>
                    <div className="muted-xs">
                      {mergedTools.length > 0
                        ? `有効 ${enabledToolsCount} / ${mergedTools.length} 件・常に許可 ${effectiveAlwaysCount} 件`
                        : 'サーバーに接続すると利用可能なツールが表示されます'}
                    </div>
                  </div>
                  {mergedTools.length > 0 && (
                    <div className="row-actions">
                      {enabledToolsCount < mergedTools.length && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          disabled={toolSavingName !== null}
                          onClick={handleEnableAllTools}
                        >
                          すべて有効
                        </button>
                      )}
                      {effectiveAlwaysCount > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          disabled={toolSavingName !== null}
                          onClick={handleResetAllToAsk}
                        >
                          すべて確認に戻す
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {mergedTools.length === 0 ? (
                  <div className="empty-box">
                    <p className="muted-xs" style={{ margin: '0 0 10px' }}>
                      {selectedServer.authType === 'oauth' && selectedServer.oauth?.status !== 'connected'
                        ? 'OAuth 認証を完了するとツール一覧を取得できます。'
                        : 'ツール一覧がまだ読み込まれていません。'}
                    </p>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      disabled={busy}
                      onClick={() => {
                        if (
                          selectedServer.authType === 'oauth' &&
                          selectedServer.oauth?.status !== 'connected'
                        ) {
                          populateServerState(selectedServer, 'auth', { setupFlow: false });
                        } else {
                          void handleTestAndRefreshTools();
                        }
                      }}
                    >
                      {selectedServer.authType === 'oauth' && selectedServer.oauth?.status !== 'connected'
                        ? '認証へ進む'
                        : 'ツール一覧を取得'}
                    </button>
                  </div>
                ) : (
                  <div className="mcp-tool-policy-list">
                    {mergedTools.map((tool) => {
                      const toolEnabled = isToolEnabled(tool.name);
                      const isAlways = toolEnabled && alwaysAllowTools.includes(tool.name);
                      const isExpanded = Boolean(expandedToolDescs[tool.name]);
                      const hasDesc = Boolean(tool.description && tool.description.trim().length > 0);
                      const isSavingThis = toolSavingName === tool.name || toolSavingName === '__bulk__';

                      return (
                        <div
                          key={tool.name}
                          className={`mcp-tool-policy-row ${toolEnabled ? '' : 'is-disabled'}`}
                        >
                          <div className="mcp-tool-policy-top">
                            <div className="mcp-tool-policy-left">
                              <ToggleSwitch
                                checked={toolEnabled}
                                disabled={isSavingThis}
                                label=""
                                ariaLabel={`${tool.name} を有効にする`}
                                onChange={(next) => handleToggleToolEnabled(tool.name, next)}
                              />
                              <div className="mcp-tool-policy-identity">
                                <code className="mcp-tool-policy-name">{tool.name}</code>
                                {hasDesc && (
                                  <button
                                    type="button"
                                    className="mcp-tool-desc-toggle"
                                    aria-expanded={isExpanded}
                                    onClick={() => toggleToolDescription(tool.name)}
                                  >
                                    <span>説明</span>
                                    <ChevronIcon size={12} dir={isExpanded ? 'up' : 'down'} />
                                  </button>
                                )}
                              </div>
                            </div>

                            {toolEnabled ? (
                              <div
                                className="mcp-policy-segmented"
                                role="group"
                                aria-label={`${tool.name} の許可設定`}
                              >
                                <button
                                  type="button"
                                  className={`mcp-policy-btn ${!isAlways ? 'active' : ''}`}
                                  aria-pressed={!isAlways}
                                  disabled={isSavingThis}
                                  onClick={() => handleSetToolPolicy(tool.name, 'ask')}
                                >
                                  確認
                                </button>
                                <button
                                  type="button"
                                  className={`mcp-policy-btn is-always ${isAlways ? 'active' : ''}`}
                                  aria-pressed={isAlways}
                                  disabled={isSavingThis}
                                  onClick={() => handleSetToolPolicy(tool.name, 'always')}
                                >
                                  常に許可
                                </button>
                              </div>
                            ) : (
                              <span className="mcp-tool-disabled-pill">無効</span>
                            )}
                          </div>

                          {hasDesc && isExpanded && (
                            <div className="mcp-tool-desc-panel">
                              {tool.description}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <details className="mcp-manual-tool-disclosure">
                  <summary>ツール名を手動で追加</summary>
                  <div className="mcp-tools-add-row" style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      value={toolInputDraft}
                      onChange={(e) => setToolInputDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddManualTools();
                        }
                      }}
                      placeholder="ツール名（カンマ区切りで複数可）"
                      aria-label="追加するツール名"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      disabled={!toolInputDraft.trim() || toolSavingName !== null}
                      onClick={handleAddManualTools}
                    >
                      追加
                    </button>
                  </div>
                </details>
              </section>

              {/* Secondary Section: Connection & Auth Editing (clearly separated) */}
              <details className="mcp-settings-disclosure">
                <summary>接続・認証設定を編集</summary>
                <form onSubmit={handleSaveConnectionSettings} className="mcp-settings-edit-form">
                  {renderConnectionFields('mcp-edit', true)}
                  <div className="row-actions mcp-form-actions" style={{ marginTop: 6 }}>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                      {busy ? '保存中...' : '接続設定を保存'}
                    </button>
                  </div>
                </form>
              </details>
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  );
};
