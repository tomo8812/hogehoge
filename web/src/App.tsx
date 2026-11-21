import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from './api/client';
import { SyncSocketClient, type WsConnectionStatus } from './api/ws';
import { AgyOnboarding } from './components/AgyOnboarding';
import { AuthScreen } from './components/AuthScreen';

const ArtifactViewerModal = React.lazy(() =>
  import('./components/ArtifactViewerModal').then((m) => ({ default: m.ArtifactViewerModal }))
);
import { ChatView } from './components/ChatView';
import { HeaderBar } from './components/HeaderBar';
import { ProjectModal } from './components/ProjectModal';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { SkillsModal } from './components/SkillsModal';
import { McpModal } from './components/McpModal';
import { triggerHaptic, VIBRATION_PATTERNS } from './utils/haptics';
import {
  ensurePushSubscribed,
  getActivePushSubscription,
  getDevicePushSyncStatus,
  hasDisplayedNotificationTag,
  isNotificationSupported,
  isPushSupported,
  showBrowserNotification,
  unsubscribePushOnDevice,
} from './utils/notifications';
import {
  clearAllViewerCaches,
  invalidateChatViewerCache,
  notifyArtifactUpdated,
  seedChatArtifacts,
  setViewerCacheUser,
} from './utils/viewerCache';
import { newerMessage } from './utils/messageSnapshot';
import type {
  AgyLoginFlowState,
  AgyProfile,
  ArtifactRecord,
  AttachmentRef,
  AvailableCommandItem,
  BootstrapResponse,
  ChatRecord,
  MessageActivity,
  MessageRecord,
  ParsedSessionOptions,
  PendingElicitationRecord,
  PendingPermissionRecord,
  ProjectRecord,
  QuotaSnapshotRecord,
  RunRecord,
  SandboxStatus,
  SkillsListResponse,
  SyncEventEnvelope,
  ToolCallItem,
  UserPreferences,
  WebUser,
  WsIncomingMessage,
} from './types';

function applyThemeToDocument(theme: 'system' | 'light' | 'dark'): void {
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = effective;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', effective === 'dark' ? '#000000' : '#ffffff');
  }
}

function mergeDeltaText(existing: string, offset: number, chunk: string): { next: string; gapDetected: boolean } {
  if (offset === existing.length) {
    return { next: existing + chunk, gapDetected: false };
  }
  if (offset < existing.length) {
    const end = offset + chunk.length;
    if (end <= existing.length) {
      return { next: existing, gapDetected: false };
    }
    return { next: existing + chunk.slice(existing.length - offset), gapDetected: false };
  }
  // If an intermediate delta was missed between snapshot HTTP & WS attach
  return { next: existing, gapDetected: true };
}

type LiveMessage = MessageRecord & { deltaGap?: true; optimisticPop?: true };

function upsertMessage(messages: LiveMessage[], incoming: MessageRecord): LiveMessage[] {
  const idx = messages.findIndex(
    (message) =>
      message.id === incoming.id ||
      (incoming.clientMessageId !== null && message.clientMessageId === incoming.clientMessageId)
  );
  if (idx < 0) {
    return [...messages, incoming];
  }
  const existing = messages[idx];
  const merged: LiveMessage =
    existing.id === incoming.id
      ? newerMessage(existing, incoming)
      : incoming;
  if (existing.optimisticPop) {
    merged.optimisticPop = true;
  }
  const copy = [...messages];
  copy[idx] = merged;
  return copy;
}

export const App: React.FC = () => {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapMeta, setBootstrapMeta] = useState<Pick<
    BootstrapResponse,
    'userCount' | 'allowPublicSignup' | 'agyMode'
  >>({
    userCount: 0,
    allowPublicSignup: false,
    agyMode: 'real',
  });

  const [user, setUser] = useState<WebUser | null>(null);
  const [agyProfile, setAgyProfile] = useState<AgyProfile | null>(null);
  const [loginFlow, setLoginFlow] = useState<AgyLoginFlowState | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatus | null>(null);

  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [draftCreatedChat, setDraftCreatedChat] = useState<ChatRecord | null>(null);
  const [draftResetToken, setDraftResetToken] = useState(0);

  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermissionRecord[]>([]);
  const [pendingElicitations, setPendingElicitations] = useState<PendingElicitationRecord[]>([]);
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null);
  const [sessionOptions, setSessionOptions] = useState<ParsedSessionOptions | null>(null);
  const [userOptions, setUserOptions] = useState<ParsedSessionOptions | null>(null);
  const [contextUsage, setContextUsage] = useState<{ used: number; size: number } | null>(null);

  const [quota, setQuota] = useState<QuotaSnapshotRecord | null>(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [chatLoadError, setChatLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [pendingUpdateBuild, setPendingUpdateBuild] = useState<string | null>(null);
  const [pendingUpdateVersion, setPendingUpdateVersion] = useState<string | null>(null);
  const [appBuildInfo, setAppBuildInfo] = useState<{
    version: string;
    shortSha: string | null;
    buildId: string | null;
    builtAt: string | null;
  }>({
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0',
    shortSha:
      typeof __APP_COMMIT_SHA__ !== 'undefined' && __APP_COMMIT_SHA__ ? __APP_COMMIT_SHA__ : null,
    buildId: null,
    builtAt: null,
  });
  const [hasComposerDraft, setHasComposerDraft] = useState(false);

  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [wsClientId, setWsClientId] = useState<string>('local');
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillsState, setSkillsState] = useState<SkillsListResponse | null>(null);
  const [externalDraftCommand, setExternalDraftCommand] = useState<{ slug: string; token: number } | null>(
    null
  );
  const [projectModalTarget, setProjectModalTarget] = useState<ProjectRecord | null | undefined>(
    undefined
  );
  const [viewerArtifact, setViewerArtifact] = useState<ArtifactRecord | null>(null);

  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  const activeChatRef = useRef<ChatRecord | null>(null);
  const draftProjectIdRef = useRef<string | null>(null);
  draftProjectIdRef.current = draftProjectId;
  const chatsRef = useRef<ChatRecord[]>([]);
  chatsRef.current = chats;
  const messagesRef = useRef<LiveMessage[]>([]);
  messagesRef.current = messages;
  const activeRunRef = useRef<RunRecord | null>(null);
  activeRunRef.current = activeRun;
  const pendingPermissionsRef = useRef<PendingPermissionRecord[]>([]);
  pendingPermissionsRef.current = pendingPermissions;
  const pendingElicitationsRef = useRef<PendingElicitationRecord[]>([]);
  pendingElicitationsRef.current = pendingElicitations;
  const draftCreatedChatRef = useRef<ChatRecord | null>(null);
  draftCreatedChatRef.current = draftCreatedChat;
  const sessionOptionsRef = useRef<ParsedSessionOptions | null>(null);
  sessionOptionsRef.current = sessionOptions;
  const userOptionsRef = useRef<ParsedSessionOptions | null>(null);
  userOptionsRef.current = userOptions;
  const chatSwitchSeqRef = useRef<number>(0);
  const urlHydratedUserIdRef = useRef<string | null>(null);
  const effectiveProjectIdRef = useRef<string | null>(null);
  const selectedModelIdRef = useRef<string>('');
  const selectedEffortValueRef = useRef<string>('');
  const skipNextLoadChatIdRef = useRef<string | null>(null);
  const localNotifiedRunsRef = useRef<Set<string>>(new Set());
  const locallyCancelledRunIdsRef = useRef<Set<string>>(new Set());
  const receivedPushTagsRef = useRef<Set<string>>(new Set());
  const pushServerSyncedRef = useRef<boolean>(false);
  const pushFallbackTimersRef = useRef<Map<string, number>>(new Map());

  const initialBuildIdRef = useRef<string | null>(null);
  const initialVersionRef = useRef<string>(appBuildInfo.version);
  const lastHealthCheckRef = useRef<number>(0);
  const quotaRef = useRef<QuotaSnapshotRecord | null>(null);
  quotaRef.current = quota;
  const quotaRefreshingRef = useRef(false);
  const agyAuthRef = useRef(false);
  agyAuthRef.current = agyProfile?.authStatus === 'authenticated';
  const prevAgyAuthRef = useRef(false);
  const preferencesRef = useRef<UserPreferences | null>(null);
  preferencesRef.current = preferences;
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;

  const wsRef = useRef<SyncSocketClient | null>(null);
  const isReplayingHelloRef = useRef(false);

  const syncPushSubscription = useCallback(async (forceVerify = false) => {
    if (!userIdRef.current || !preferencesRef.current?.notifyOnResponse) {
      pushServerSyncedRef.current = false;
      wsRef.current?.setPushEndpoint(null);
      return;
    }
    if (!isNotificationSupported() || Notification.permission !== 'granted' || !isPushSupported()) {
      pushServerSyncedRef.current = false;
      wsRef.current?.setPushEndpoint(null);
      return;
    }
    try {
      if (forceVerify) {
        const status = await getDevicePushSyncStatus();
        if (status.registeredOnServer) {
          pushServerSyncedRef.current = true;
          wsRef.current?.setPushEndpoint(status.endpoint);
          return;
        }
      }
      const res = await ensurePushSubscribed();
      pushServerSyncedRef.current = res.subscribed;
      wsRef.current?.setPushEndpoint(res.subscribed ? (res.endpoint ?? null) : null);
    } catch {
      pushServerSyncedRef.current = false;
    }
  }, []);

  const notifyDesktopWithPushFallback = useCallback(
    (params: {
      dedupKey: string;
      tag: string;
      title: string;
      body: string;
      chatId: string;
      createdAt: number;
      vibrate?: number[];
    }) => {
      if (isReplayingHelloRef.current) return;
      if (!preferencesRef.current?.notifyOnResponse) return;
      if (Date.now() - params.createdAt >= 30_000) return;
      if (!isNotificationSupported() || Notification.permission !== 'granted') return;
      if (localNotifiedRunsRef.current.has(params.dedupKey)) return;

      // Never show OS/browser notifications while the app itself is open and visible
      if (document.visibilityState === 'visible') return;

      if (localNotifiedRunsRef.current.size > 200) {
        localNotifiedRunsRef.current.clear();
      }
      localNotifiedRunsRef.current.add(params.dedupKey);

      const triggerLocal = () => {
        if (document.visibilityState === 'visible') return;
        void showBrowserNotification({
          title: params.title,
          body: params.body,
          tag: params.tag,
          chatId: params.chatId,
          vibrate: params.vibrate,
        });
      };

      if (!isPushSupported() || !pushServerSyncedRef.current) {
        triggerLocal();
        return;
      }

      if (receivedPushTagsRef.current.has(params.tag)) return;
      const existingTimer = pushFallbackTimersRef.current.get(params.tag);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }

      const timer = window.setTimeout(() => {
        pushFallbackTimersRef.current.delete(params.tag);
        if (receivedPushTagsRef.current.has(params.tag)) return;
        if (document.visibilityState === 'visible') return;
        void hasDisplayedNotificationTag(params.tag).then((shown) => {
          if (!shown && !receivedPushTagsRef.current.has(params.tag) && document.visibilityState !== 'visible') {
            triggerLocal();
          }
        });
      }, 1800);
      pushFallbackTimersRef.current.set(params.tag, timer);
    },
    []
  );

  const cleanupEmptyDraftChat = useCallback(() => {
    const draftChat = draftCreatedChatRef.current;
    if (!draftChat) return;
    draftCreatedChatRef.current = null;
    setDraftCreatedChat(null);
    if (
      activeChatIdRef.current !== draftChat.id ||
      (messagesRef.current.length === 0 && !activeRunRef.current)
    ) {
      invalidateChatViewerCache(draftChat.id);
      void api.deleteChat(draftChat.id).catch(() => {});
    }
  }, []);

  const notifyDetectedBuild = useCallback(
    (nextBuildId?: string | null, nextVersion?: string | null) => {
      if (!nextBuildId) return;
      if (!initialBuildIdRef.current) {
        initialBuildIdRef.current = nextBuildId;
        if (nextVersion) initialVersionRef.current = nextVersion;
        return;
      }
      if (nextBuildId !== initialBuildIdRef.current) {
        setPendingUpdateBuild((prev) => prev || nextBuildId);
        if (nextVersion && nextVersion !== initialVersionRef.current) {
          setPendingUpdateVersion((prev) => prev || nextVersion);
        }
      }
    },
    []
  );

  const triggerQuotaRefresh = useCallback(async (auto: boolean, minAgeMs = 5 * 60 * 1000) => {
    if (quotaRefreshingRef.current) return;
    if (auto) {
      const cur = quotaRef.current;
      if (cur && cur.fetchedAt > 0 && cur.status === 'ok' && Date.now() - cur.fetchedAt < minAgeMs) {
        return;
      }
    }
    quotaRefreshingRef.current = true;
    setQuotaRefreshing(true);
    if (!auto) {
      setQuotaError(null);
    }
    try {
      const res = await api.refreshQuota(auto, auto ? minAgeMs : undefined);
      quotaRef.current = res.quota;
      setQuota(res.quota);
      setQuotaError(null);
    } catch (err) {
      if (!auto) {
        setQuotaError(
          err instanceof ApiError
            ? err.message
            : '利用枠の更新に失敗しました。通信状態を確認して再試行してください。'
        );
      }
    } finally {
      quotaRefreshingRef.current = false;
      setQuotaRefreshing(false);
    }
  }, []);

  const loadSkillsList = useCallback(async (projectId?: string | null, chatId?: string | null) => {
    try {
      const res = await api.listSkills({
        projectId: projectId ?? null,
        chatId: chatId ?? null,
      });
      setSkillsState(res);
    } catch {
      // ignore transient skill fetch failure
    }
  }, []);

  const loadWorkspaceLists = useCallback(async () => {
    const [chatsRes, projRes, quotaRes] = await Promise.all([
      api.listChats(),
      api.listProjects(),
      api.getQuota(),
    ]);
    setChats(chatsRes.chats);
    setProjects(projRes.projects);
    quotaRef.current = quotaRes.quota;
    setQuota(quotaRes.quota);
    if (
      agyAuthRef.current &&
      (!quotaRes.quota.fetchedAt || Date.now() - quotaRes.quota.fetchedAt >= 10_000)
    ) {
      void triggerQuotaRefresh(true, 10_000);
    }
  }, [triggerQuotaRefresh]);

  const loadChatDetail = useCallback(async (chatId: string) => {
    const requestedAt = Date.now();
    if (activeChatIdRef.current === chatId) {
      setChatLoadError(null);
    }
    let detail: Awaited<ReturnType<typeof api.getChat>>;
    try {
      detail = await api.getChat(chatId);
    } catch (err) {
      if (activeChatIdRef.current === chatId) {
        setChatLoadError(
          err instanceof ApiError
            ? err.message
            : '会話履歴の読み込みに失敗しました。通信状態を確認して再試行してください。'
        );
      }
      return;
    }
    if (activeChatIdRef.current !== chatId) return;
    setChatLoadError(null);
    seedChatArtifacts(chatId, detail.artifacts);
    setMessages((prev) => {
      if (prev.length === 0) return detail.messages;
      const prevById = new Map(prev.map((m) => [m.id, m]));
      const merged = detail.messages.map((incoming) => {
        const existing = prevById.get(incoming.id);
        if (!existing) return incoming;
        return newerMessage(existing, incoming);
      });
      const mergedIds = new Set(merged.map((m) => m.id));
      for (const existing of prev) {
        if (!mergedIds.has(existing.id) && existing.chatId === chatId && existing.updatedAt >= requestedAt) {
          merged.push(existing);
        }
      }
      return merged.sort((a, b) => a.createdAt - b.createdAt);
    });
    setArtifacts(detail.artifacts);
    setViewerArtifact((cur) => {
      if (!cur || cur.chatId !== chatId) return cur;
      const latest = detail.artifacts.find((a) => a.id === cur.id);
      if (!latest) return cur;
      if (latest.sha256 === cur.sha256 && latest.updatedAt === cur.updatedAt) return cur;
      return latest;
    });
    setPendingPermissions(detail.pendingPermissions);
    setPendingElicitations(detail.pendingElicitations ?? []);
    setActiveRun((cur) => {
      if (
        cur &&
        detail.activeRun &&
        cur.id === detail.activeRun.id &&
        (cur.status === 'running' || cur.status === 'awaiting_permission') &&
        detail.activeRun.status === 'queued'
      ) {
        return cur;
      }
      return detail.activeRun;
    });
    setSessionOptions(detail.sessionOptions);
    if (
      detail.chat.contextSize !== null &&
      detail.chat.contextSize !== undefined &&
      detail.chat.contextSize > 0 &&
      detail.chat.contextUsed !== null &&
      detail.chat.contextUsed !== undefined
    ) {
      setContextUsage({ used: detail.chat.contextUsed, size: detail.chat.contextSize });
    } else {
      setContextUsage(null);
    }
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...detail.chat, activeRun: detail.activeRun } : c))
    );
  }, []);

  // Isolate viewer caches strictly per authenticated WebUser
  useEffect(() => {
    setViewerCacheUser(user?.id ?? null);
  }, [user?.id]);

  // Sync CSS --app-vh & data-keyboard-open with iPhone / mobile visualViewport
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let baseHeight = Math.max(window.innerHeight, window.visualViewport?.height ?? 0);
    let blurTimer: number | undefined;
    let rafId: number | undefined;
    let lastAppliedVh: number | null = null;
    let lastAppliedVvTop: number | null = null;
    let lastAppliedKeyboardOpen: boolean | null = null;

    const applyViewport = () => {
      rafId = undefined;
      const vv = window.visualViewport;
      const vvHeight = vv ? Math.round(vv.height) : window.innerHeight;
      const vvTop = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
      const activeEl = document.activeElement;
      const isTextFocused =
        activeEl instanceof HTMLElement &&
        (activeEl.tagName === 'TEXTAREA' ||
          (activeEl.tagName === 'INPUT' &&
            !['checkbox', 'radio', 'file', 'button', 'submit', 'reset'].includes(
              (activeEl as HTMLInputElement).type
            )));
      if (!isTextFocused) {
        baseHeight = Math.max(window.innerHeight, vvHeight);
      }
      const vhChanged = lastAppliedVh !== vvHeight;
      if (vhChanged) {
        lastAppliedVh = vvHeight;
        document.documentElement.style.setProperty('--app-vh', `${vvHeight}px`);
      }
      if (lastAppliedVvTop !== vvTop) {
        lastAppliedVvTop = vvTop;
        document.documentElement.style.setProperty('--app-vv-top', `${vvTop}px`);
      }
      const heightDrop = Math.max(window.innerHeight - vvHeight, baseHeight - vvHeight);
      const keyboardOpen = window.innerWidth <= 860 && (heightDrop > 120 || isTextFocused);
      const keyboardStateChanged = lastAppliedKeyboardOpen !== keyboardOpen;
      if (keyboardStateChanged) {
        lastAppliedKeyboardOpen = keyboardOpen;
        if (keyboardOpen) {
          document.documentElement.dataset.keyboardOpen = 'true';
        } else {
          delete document.documentElement.dataset.keyboardOpen;
        }
      }
      if (keyboardOpen && vv && vv.offsetTop > 0) {
        window.scrollTo(0, 0);
      }
      if (
        keyboardOpen &&
        (vhChanged || keyboardStateChanged) &&
        activeEl instanceof HTMLElement &&
        activeEl.closest('.modal-card')
      ) {
        window.requestAnimationFrame(() => {
          if (document.activeElement === activeEl) {
            activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        });
      }
    };

    const scheduleViewportUpdate = () => {
      if (rafId !== undefined) return;
      rafId = window.requestAnimationFrame(applyViewport);
    };

    const onFocusOut = () => {
      if (blurTimer !== undefined) window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(scheduleViewportUpdate, 60);
    };

    applyViewport();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', scheduleViewportUpdate);
    vv?.addEventListener('scroll', scheduleViewportUpdate);
    window.addEventListener('resize', scheduleViewportUpdate);
    window.addEventListener('focusin', scheduleViewportUpdate);
    window.addEventListener('focusout', onFocusOut);

    return () => {
      if (blurTimer !== undefined) window.clearTimeout(blurTimer);
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      vv?.removeEventListener('resize', scheduleViewportUpdate);
      vv?.removeEventListener('scroll', scheduleViewportUpdate);
      window.removeEventListener('resize', scheduleViewportUpdate);
      window.removeEventListener('focusin', scheduleViewportUpdate);
      window.removeEventListener('focusout', onFocusOut);
      document.documentElement.style.removeProperty('--app-vh');
      document.documentElement.style.removeProperty('--app-vv-top');
      delete document.documentElement.dataset.keyboardOpen;
    };
  }, []);

  // Theme sync
  useEffect(() => {
    applyThemeToDocument(preferences?.theme ?? 'system');
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if ((preferences?.theme ?? 'system') === 'system') {
        applyThemeToDocument('system');
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preferences?.theme]);

  // Initial bootstrap
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const res = await api.bootstrap();
        if (!active) return;
        if (res.buildId) {
          initialBuildIdRef.current = res.buildId;
        }
        if (res.version) {
          initialVersionRef.current = res.version;
        }
        setAppBuildInfo((prev) => ({
          version: res.version || prev.version,
          shortSha: res.shortSha ?? prev.shortSha,
          buildId: res.buildId ?? prev.buildId,
          builtAt: res.builtAt ?? prev.builtAt,
        }));
        setBootstrapMeta({
          userCount: res.userCount,
          allowPublicSignup: res.allowPublicSignup,
          agyMode: res.agyMode,
        });
        if (res.authenticated && res.user) {
          setUser(res.user);
          setAgyProfile(res.agyProfile);
          setPreferences(res.preferences);
          setLoginFlow(res.loginFlow);
          setSandboxStatus(res.sandbox ?? null);
        } else {
          setSandboxStatus(null);
        }
      } finally {
        if (active) setBootstrapping(false);
      }
    };
    void init();
    return () => {
      active = false;
    };
  }, []);

  // Periodic + focus-based backend build check & PWA Service Worker update notification
  useEffect(() => {
    const onSwUpdate = () => {
      setPendingUpdateBuild((prev) => prev || 'sw-update');
    };
    window.addEventListener('agy:app-update-detected', onSwUpdate);

    const checkServerBuild = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastHealthCheckRef.current < 60_000) return;
      lastHealthCheckRef.current = now;
      void api
        .getHealth()
        .then((res) => {
          notifyDetectedBuild(res.buildId, res.version);
        })
        .catch(() => {});
    };

    const onVisibility = () => checkServerBuild();
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(checkServerBuild, 5 * 60 * 1000);

    return () => {
      window.removeEventListener('agy:app-update-detected', onSwUpdate);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
  }, [notifyDetectedBuild]);

  // Auto-reload safely when a new build is detected and no work is in progress
  const isSafeToReload =
    !hasComposerDraft &&
    !activeRun &&
    loginFlow?.status !== 'awaiting_url' &&
    loginFlow?.status !== 'awaiting_code' &&
    loginFlow?.status !== 'verifying';

  useEffect(() => {
    if (!pendingUpdateBuild || !isSafeToReload) return;
    try {
      if (pendingUpdateBuild === 'sw-update') {
        const lastSwReload = Number(sessionStorage.getItem('agy_last_sw_reload_ts') || '0');
        if (Date.now() - lastSwReload < 30_000) return;
      } else if (sessionStorage.getItem('agy_reloaded_build') === pendingUpdateBuild) {
        return;
      }
    } catch {
      // continue if sessionStorage unavailable
    }

    const timer = window.setTimeout(() => {
      try {
        if (pendingUpdateBuild === 'sw-update') {
          sessionStorage.setItem('agy_last_sw_reload_ts', String(Date.now()));
        } else {
          sessionStorage.setItem('agy_reloaded_build', pendingUpdateBuild);
        }
      } catch {
        // ignore
      }
      window.location.reload();
    }, 900);

    return () => clearTimeout(timer);
  }, [pendingUpdateBuild, isSafeToReload]);

  // Load chats & projects when authenticated
  useEffect(() => {
    if (!user) return;
    void loadWorkspaceLists();
  }, [user?.id, loadWorkspaceLists]);

  // Open target chat from ?chatId=... query param or notification click events
  useEffect(() => {
    if (!user) {
      urlHydratedUserIdRef.current = null;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const targetChatId = params.get('chatId');
    urlHydratedUserIdRef.current = user.id;
    if (targetChatId) {
      chatSwitchSeqRef.current += 1;
      cleanupEmptyDraftChat();
      setDraftProjectId(null);
      setActiveChatId(targetChatId);
      setSidebarMobileOpen(false);
    }
  }, [user?.id, cleanupEmptyDraftChat]);

  // Keep selected chat reflected in URL (?chatId=...) so page reload restores it
  useEffect(() => {
    if (!user || urlHydratedUserIdRef.current !== user.id) return;
    const url = new URL(window.location.href);
    const isEphemeralDraft = Boolean(activeChatId && draftCreatedChat?.id === activeChatId);
    const desiredChatId = activeChatId && !isEphemeralDraft ? activeChatId : null;
    const currentParam = url.searchParams.get('chatId');
    if (desiredChatId) {
      if (currentParam !== desiredChatId) {
        url.searchParams.set('chatId', desiredChatId);
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } else if (currentParam !== null && !isEphemeralDraft) {
      url.searchParams.delete('chatId');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [user?.id, activeChatId, draftCreatedChat?.id]);

  useEffect(() => {
    const onOpenChat = (e: Event) => {
      const chatId = (e as CustomEvent<{ chatId?: string }>).detail?.chatId;
      if (chatId) {
        chatSwitchSeqRef.current += 1;
        cleanupEmptyDraftChat();
        setDraftProjectId(null);
        setActiveChatId(chatId);
        setSidebarMobileOpen(false);
      }
    };
    window.addEventListener('agy:open-chat', onOpenChat);

    const onPopState = () => {
      if (!userIdRef.current) return;
      const params = new URLSearchParams(window.location.search);
      const nextChatId = params.get('chatId');
      chatSwitchSeqRef.current += 1;
      cleanupEmptyDraftChat();
      setDraftProjectId(null);
      setActiveChatId(nextChatId || null);
      setSidebarMobileOpen(false);
    };
    window.addEventListener('popstate', onPopState);

    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onSwMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'OPEN_CHAT' && typeof event.data.chatId === 'string') {
        chatSwitchSeqRef.current += 1;
        cleanupEmptyDraftChat();
        setDraftProjectId(null);
        setActiveChatId(event.data.chatId);
        setSidebarMobileOpen(false);
      } else if (event.data && event.data.type === 'PUSH_RECEIVED' && typeof event.data.tag === 'string') {
        if (receivedPushTagsRef.current.size > 200) {
          receivedPushTagsRef.current.clear();
        }
        receivedPushTagsRef.current.add(event.data.tag);
        const timer = pushFallbackTimersRef.current.get(event.data.tag);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          pushFallbackTimersRef.current.delete(event.data.tag);
        }
      } else if (event.data && event.data.type === 'PUSH_SUBSCRIPTION_CHANGED') {
        void syncPushSubscription(true);
      }
    };
    sw?.addEventListener('message', onSwMessage);

    return () => {
      window.removeEventListener('agy:open-chat', onOpenChat);
      window.removeEventListener('popstate', onPopState);
      sw?.removeEventListener('message', onSwMessage);
    };
  }, [cleanupEmptyDraftChat, syncPushSubscription]);

  // Automatically sync browser Push subscription if notifyOnResponse is ON and permission is already granted
  useEffect(() => {
    void syncPushSubscription(false);
    void getActivePushSubscription()
      .then((sub) => {
        wsRef.current?.setPushEndpoint(sub?.endpoint ?? null);
      })
      .catch(() => {});

    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onControllerChange = () => {
      void syncPushSubscription(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !pushServerSyncedRef.current) {
        void syncPushSubscription(false);
      }
    };
    const onEndpointChanged = (e: Event) => {
      const endpoint = (e as CustomEvent<string | null>).detail ?? null;
      wsRef.current?.setPushEndpoint(endpoint);
    };
    sw?.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('agy:push-endpoint-changed', onEndpointChanged);
    return () => {
      sw?.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('agy:push-endpoint-changed', onEndpointChanged);
      for (const timer of pushFallbackTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      pushFallbackTimersRef.current.clear();
    };
  }, [user?.id, preferences?.notifyOnResponse, syncPushSubscription]);

  // Probe default model/effort options for welcome screen & run balanced visible quota refresh
  const isAgyAuthenticated = agyProfile?.authStatus === 'authenticated';
  useEffect(() => {
    const justAuthenticated = !prevAgyAuthRef.current && isAgyAuthenticated;
    prevAgyAuthRef.current = isAgyAuthenticated;

    if (!user || !isAgyAuthenticated) {
      setUserOptions(null);
      return;
    }

    let active = true;
    void api
      .getAgyOptions(preferencesRef.current?.defaultModelId ?? null)
      .then((res) => {
        if (active && res.sessionOptions) {
          setUserOptions(res.sessionOptions);
        }
      })
      .catch(() => {});

    if (justAuthenticated) {
      void triggerQuotaRefresh(true, 10_000);
    }

    const onVisibilityOrFocus = () => {
      if (document.visibilityState !== 'visible') return;
      void triggerQuotaRefresh(true, 20_000);
    };

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void triggerQuotaRefresh(true, 55_000);
    }, 60_000);

    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
    };
  }, [user?.id, isAgyAuthenticated, triggerQuotaRefresh]);

  // Load detail when switching active chat
  useEffect(() => {
    if (!user || !activeChatId) {
      setMessages([]);
      setArtifacts([]);
      setPendingPermissions([]);
      setPendingElicitations([]);
      setActiveRun(null);
      setSessionOptions(null);
      setContextUsage(null);
      return;
    }
    if (skipNextLoadChatIdRef.current === activeChatId) {
      skipNextLoadChatIdRef.current = null;
      return;
    }
    setMessages([]);
    setArtifacts([]);
    setPendingPermissions([]);
    setPendingElicitations([]);
    setActiveRun(null);
    setContextUsage(null);
    void loadChatDetail(activeChatId);
  }, [user?.id, activeChatId, loadChatDetail]);

  const hasDeltaGap = messages.some((message) => message.deltaGap);
  useEffect(() => {
    if (!hasDeltaGap || !activeChatId) return;
    const timeout = window.setTimeout(() => {
      void loadChatDetail(activeChatId);
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [hasDeltaGap, activeChatId, loadChatDetail]);

  const handleDurableEvent = useCallback((evt: SyncEventEnvelope) => {
    const p = evt.payload;
    const curChatId = activeChatIdRef.current;

    switch (evt.type) {
      case 'agy.login_progress': {
        const flow = p.loginFlow as AgyLoginFlowState | undefined;
        if (flow) setLoginFlow(flow);
        break;
      }
      case 'agy.auth_changed': {
        const prof = p.profile as AgyProfile | undefined;
        if (prof) setAgyProfile(prof);
        break;
      }
      case 'preferences.updated': {
        const prefs = p.preferences as UserPreferences | undefined;
        if (prefs) setPreferences(prefs);
        break;
      }
      case 'quota.updated': {
        const q = p.quota as QuotaSnapshotRecord | undefined;
        if (q) setQuota(q);
        break;
      }
      case 'project.created':
      case 'project.updated': {
        const proj = p.project as ProjectRecord | undefined;
        if (proj) {
          setProjects((prev) => {
            const idx = prev.findIndex((x) => x.id === proj.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = proj;
              return copy;
            }
            return [proj, ...prev];
          });
        }
        break;
      }
      case 'project.deleted': {
        const projectId = p.projectId as string | undefined;
        if (projectId) {
          setProjects((prev) => prev.filter((x) => x.id !== projectId));
          setChats((prev) =>
            prev.map((c) => (c.projectId === projectId ? { ...c, projectId: null } : c))
          );
          setDraftProjectId((prev) => (prev === projectId ? null : prev));
        }
        break;
      }
      case 'chat.created': {
        // Un-sent 0-message chats stay out of sidebar history until the first message is sent
        break;
      }
      case 'chat.updated': {
        const chat = p.chat as ChatRecord | undefined;
        const opts = p.sessionOptions as ParsedSessionOptions | undefined;
        if (chat) {
          setChats((prev) => prev.map((c) => (c.id === chat.id ? { ...c, ...chat } : c)));
          setDraftCreatedChat((prev) => (prev && prev.id === chat.id ? { ...prev, ...chat } : prev));
          if (evt.chatId === curChatId) {
            if (
              chat.contextSize !== null &&
              chat.contextSize !== undefined &&
              chat.contextSize > 0 &&
              chat.contextUsed !== null &&
              chat.contextUsed !== undefined
            ) {
              setContextUsage({ used: chat.contextUsed, size: chat.contextSize });
            } else if (chat.contextUsed === null && chat.contextSize === null) {
              setContextUsage(null);
            }
          }
        }
        if (opts && evt.chatId === curChatId) {
          setSessionOptions(opts);
        }
        break;
      }
      case 'chat.config_updated': {
        const opts = p.sessionOptions as ParsedSessionOptions | undefined;
        if (opts && evt.chatId === curChatId) {
          setSessionOptions(opts);
        }
        break;
      }
      case 'chat.commands_updated': {
        const nextCmds = p.availableCommands as AvailableCommandItem[] | undefined;
        const opts = p.sessionOptions as ParsedSessionOptions | undefined;
        if (evt.chatId === curChatId) {
          if (opts) {
            setSessionOptions(opts);
          } else if (nextCmds) {
            setSessionOptions((prev) => (prev ? { ...prev, availableCommands: nextCmds } : prev));
          }
        }
        break;
      }
      case 'skills.updated': {
        void loadSkillsList(effectiveProjectIdRef.current, curChatId);
        break;
      }
      case 'mcp.updated': {
        window.dispatchEvent(new CustomEvent('agy:mcp-updated', { detail: p }));
        break;
      }
      case 'chat.deleted': {
        const chatId = p.chatId as string | undefined;
        if (chatId) {
          invalidateChatViewerCache(chatId);
          setViewerArtifact((cur) => (cur?.chatId === chatId ? null : cur));
          setChats((prev) => prev.filter((c) => c.id !== chatId));
          setDraftCreatedChat((prev) => (prev && prev.id === chatId ? null : prev));
          if (curChatId === chatId) setActiveChatId(null);
        }
        break;
      }
      case 'message.created': {
        const msgs = (p.messages as MessageRecord[] | undefined) ?? [];
        const run = p.run as RunRecord | undefined;
        const chat = p.chat as ChatRecord | undefined;
        if (chat) {
          if (draftCreatedChatRef.current?.id === chat.id) {
            draftCreatedChatRef.current = null;
            setDraftCreatedChat(null);
          }
          setChats((prev) => {
            const existing = prev.find((c) => c.id === chat.id);
            const effectiveRun =
              existing?.activeRun &&
              (existing.activeRun.status === 'running' ||
                existing.activeRun.status === 'awaiting_permission') &&
              run?.status === 'queued'
                ? existing.activeRun
                : (run ?? null);
            const others = prev.filter((c) => c.id !== chat.id);
            return [{ ...chat, activeRun: effectiveRun }, ...others];
          });
        }
        if (evt.chatId === curChatId) {
          setMessages((prev) => {
            let next = prev;
            for (const m of msgs) {
              next = upsertMessage(next, m);
            }
            return next;
          });
          if (run) {
            setActiveRun((cur) =>
              cur &&
              (cur.status === 'running' || cur.status === 'awaiting_permission') &&
              run.status === 'queued'
                ? cur
                : run
            );
          }
        }
        break;
      }
      case 'message.updated': {
        const msg = p.message as MessageRecord | undefined;
        if (msg && evt.chatId === curChatId) {
          setMessages((prev) => upsertMessage(prev, msg));
        }
        break;
      }
      case 'run.started': {
        const run = p.run as RunRecord | undefined;
        const msg = p.message as MessageRecord | undefined;
        if (run) {
          setChats((prev) =>
            prev.map((c) => (c.id === run.chatId ? { ...c, activeRun: run } : c))
          );
        }
        if (evt.chatId === curChatId) {
          if (run) setActiveRun(run);
          if (msg) {
            setMessages((prev) => upsertMessage(prev, msg));
          }
        }
        break;
      }
      case 'run.finished': {
        const run = p.run as RunRecord | undefined;
        const msg = p.message as MessageRecord | undefined;
        const nextActiveRun = (p.nextActiveRun as RunRecord | null | undefined) ?? null;
        if (run) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === run.chatId && c.activeRun?.id === run.id
                ? { ...c, activeRun: nextActiveRun }
                : c
            )
          );
        }
        if (evt.chatId === curChatId) {
          if (run) {
            setActiveRun((cur) => (cur?.id === run.id ? nextActiveRun : cur));
            setPendingPermissions((prev) => prev.filter((perm) => perm.runId !== run.id));
          }
          if (msg) {
            setMessages((prev) => upsertMessage(prev, msg));
          }
        }

        const hapticOn = Boolean(preferencesRef.current?.hapticFeedback ?? true);
        const isForegroundLive =
          !isReplayingHelloRef.current &&
          document.visibilityState === 'visible' &&
          Math.abs(Date.now() - evt.createdAt) < 60_000;

        if (run) {
          if (isForegroundLive) {
            if (run.status === 'cancelled') {
              if (!locallyCancelledRunIdsRef.current.has(run.id)) {
                triggerHaptic('stop', hapticOn);
              }
            } else if (run.status === 'error') {
              triggerHaptic('error', hapticOn);
            } else {
              triggerHaptic('complete', hapticOn);
            }
          }
          locallyCancelledRunIdsRef.current.delete(run.id);
        }

        if (run && run.status !== 'cancelled') {
          const chatTitle =
            chatsRef.current.find((c) => c.id === run.chatId)?.title || 'Antigravity Chat';
          const preview = (msg?.contentText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          const body =
            run.status === 'error'
              ? run.errorMessage || '応答の生成中にエラーが発生しました。'
              : preview || '応答が完了しました。';
          const title = run.status === 'error' ? `エラーで終了 — ${chatTitle}` : chatTitle;
          const vibrate = hapticOn
            ? VIBRATION_PATTERNS[run.status === 'error' ? 'error' : 'complete']
            : undefined;

          notifyDesktopWithPushFallback({
            dedupKey: `run-${run.id}`,
            tag: `run-${run.id}`,
            title,
            body,
            chatId: run.chatId,
            createdAt: evt.createdAt,
            vibrate,
          });
          void triggerQuotaRefresh(true, 5_000);
        }
        break;
      }
      case 'run.wakeup_finished': {
        const msg = p.message as MessageRecord | undefined;
        const wakeupStatus = p.status === 'error' ? 'error' : 'completed';
        const previewText = typeof p.previewText === 'string' ? p.previewText : '';
        const notificationTag =
          typeof p.notificationTag === 'string' && p.notificationTag
            ? p.notificationTag
            : `run-${evt.runId ?? evt.eventId}-wakeup`;

        if (msg && evt.chatId === curChatId) {
          setMessages((prev) => upsertMessage(prev, msg));
        }

        const hapticOn = Boolean(preferencesRef.current?.hapticFeedback ?? true);
        if (
          !isReplayingHelloRef.current &&
          document.visibilityState === 'visible' &&
          Math.abs(Date.now() - evt.createdAt) < 60_000
        ) {
          triggerHaptic(wakeupStatus === 'error' ? 'error' : 'complete', hapticOn);
        }

        if (evt.chatId) {
          const chatTitle =
            chatsRef.current.find((c) => c.id === evt.chatId)?.title || 'Antigravity Chat';
          const preview = previewText.replace(/\s+/g, ' ').trim().slice(0, 120);
          const body =
            wakeupStatus === 'error'
              ? preview || 'バックグラウンド処理でエラーが発生しました。'
              : preview || '応答が完了しました。';
          const title = wakeupStatus === 'error' ? `エラーで終了 — ${chatTitle}` : chatTitle;
          const vibrate = hapticOn
            ? VIBRATION_PATTERNS[wakeupStatus === 'error' ? 'error' : 'complete']
            : undefined;

          notifyDesktopWithPushFallback({
            dedupKey: notificationTag,
            tag: notificationTag,
            title,
            body,
            chatId: evt.chatId,
            createdAt: evt.createdAt,
            vibrate,
          });
        }
        void triggerQuotaRefresh(true, 5_000);
        break;
      }
      case 'permission.requested': {
        const perm = p.permission as PendingPermissionRecord | undefined;
        if (perm) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === perm.chatId && c.activeRun
                ? { ...c, activeRun: { ...c.activeRun, status: 'awaiting_permission' } }
                : c
            )
          );
          if (evt.chatId === curChatId) {
            if (!pendingPermissionsRef.current.some((x) => x.id === perm.id)) {
              pendingPermissionsRef.current = [...pendingPermissionsRef.current, perm];
            }
            setPendingPermissions((prev) =>
              prev.some((x) => x.id === perm.id) ? prev : [...prev, perm]
            );
            setActiveRun((cur) =>
              cur && cur.id === perm.runId ? { ...cur, status: 'awaiting_permission' } : cur
            );
          }
          const hapticOn = Boolean(preferencesRef.current?.hapticFeedback ?? true);
          if (
            !isReplayingHelloRef.current &&
            document.visibilityState === 'visible' &&
            Math.abs(Date.now() - evt.createdAt) < 60_000
          ) {
            triggerHaptic('permission', hapticOn);
          }

          const chatTitle =
            chatsRef.current.find((c) => c.id === perm.chatId)?.title || 'Antigravity Chat';
          const isQuestion = perm.toolCall.toolCallId.startsWith('interaction_');
          const toolLabel = (
            perm.toolCall.title || (isQuestion ? 'エージェントからの質問' : 'ツール実行の許可')
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90);
          notifyDesktopWithPushFallback({
            dedupKey: `perm-${perm.id}`,
            tag: `perm-${perm.id}`,
            title: `${isQuestion ? '質問待ち' : '確認待ち'} — ${chatTitle}`,
            body: isQuestion ? toolLabel : `${toolLabel} の承認が必要です。`,
            chatId: perm.chatId,
            createdAt: evt.createdAt,
            vibrate: hapticOn ? VIBRATION_PATTERNS.permission : undefined,
          });
        }
        break;
      }
      case 'permission.resolved': {
        const perm = p.permission as PendingPermissionRecord | undefined;
        if (perm) {
          if (evt.chatId === curChatId) {
            pendingPermissionsRef.current = pendingPermissionsRef.current.filter(
              (x) => x.id !== perm.id
            );
            setPendingPermissions((prev) => prev.filter((x) => x.id !== perm.id));
          }
          const stillPendingForRun =
            Boolean(p.hasPendingForRun) ||
            (evt.chatId === curChatId &&
              (pendingPermissionsRef.current.some((x) => x.runId === perm.runId) ||
                pendingElicitationsRef.current.some((x) => x.runId === perm.runId)));
          if (!stillPendingForRun) {
            setChats((prev) =>
              prev.map((c) =>
                c.id === perm.chatId && c.activeRun?.status === 'awaiting_permission'
                  ? { ...c, activeRun: { ...c.activeRun, status: 'running' } }
                  : c
              )
            );
            if (evt.chatId === curChatId) {
              setActiveRun((cur) =>
                cur && cur.id === perm.runId && cur.status === 'awaiting_permission'
                  ? { ...cur, status: 'running' }
                  : cur
              );
            }
          }
        }
        break;
      }
      case 'elicitation.requested': {
        const elicit = p.elicitation as PendingElicitationRecord | undefined;
        if (elicit) {
          setChats((prev) =>
            prev.map((c) =>
              c.id === elicit.chatId && c.activeRun
                ? { ...c, activeRun: { ...c.activeRun, status: 'awaiting_permission' } }
                : c
            )
          );
          if (evt.chatId === curChatId) {
            if (!pendingElicitationsRef.current.some((x) => x.id === elicit.id)) {
              pendingElicitationsRef.current = [...pendingElicitationsRef.current, elicit];
            }
            setPendingElicitations((prev) =>
              prev.some((x) => x.id === elicit.id) ? prev : [...prev, elicit]
            );
            setActiveRun((cur) =>
              cur && cur.id === elicit.runId ? { ...cur, status: 'awaiting_permission' } : cur
            );
          }
          const hapticOn = Boolean(preferencesRef.current?.hapticFeedback ?? true);
          if (
            !isReplayingHelloRef.current &&
            document.visibilityState === 'visible' &&
            Math.abs(Date.now() - evt.createdAt) < 60_000
          ) {
            triggerHaptic('permission', hapticOn);
          }

          const chatTitle =
            chatsRef.current.find((c) => c.id === elicit.chatId)?.title || 'Antigravity Chat';
          const label = (elicit.message || 'エージェントからの質問')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90);
          notifyDesktopWithPushFallback({
            dedupKey: `elicit-${elicit.id}`,
            tag: `elicit-${elicit.id}`,
            title: `質問待ち — ${chatTitle}`,
            body: label,
            chatId: elicit.chatId,
            createdAt: evt.createdAt,
            vibrate: hapticOn ? VIBRATION_PATTERNS.permission : undefined,
          });
        }
        break;
      }
      case 'elicitation.resolved': {
        const elicit = p.elicitation as PendingElicitationRecord | undefined;
        if (elicit) {
          if (evt.chatId === curChatId) {
            pendingElicitationsRef.current = pendingElicitationsRef.current.filter(
              (x) => x.id !== elicit.id
            );
            setPendingElicitations((prev) => prev.filter((x) => x.id !== elicit.id));
          }
          const stillPendingForRun =
            Boolean(p.hasPendingForRun) ||
            (evt.chatId === curChatId &&
              (pendingPermissionsRef.current.some((x) => x.runId === elicit.runId) ||
                pendingElicitationsRef.current.some((x) => x.runId === elicit.runId)));
          if (!stillPendingForRun) {
            setChats((prev) =>
              prev.map((c) =>
                c.id === elicit.chatId && c.activeRun?.status === 'awaiting_permission'
                  ? { ...c, activeRun: { ...c.activeRun, status: 'running' } }
                  : c
              )
            );
            if (evt.chatId === curChatId) {
              setActiveRun((cur) =>
                cur && cur.id === elicit.runId && cur.status === 'awaiting_permission'
                  ? { ...cur, status: 'running' }
                  : cur
              );
            }
          }
        }
        break;
      }
      case 'artifact.created': {
        const art = p.artifact as ArtifactRecord | undefined;
        if (art) {
          notifyArtifactUpdated(art);
        }
        if (art && evt.chatId === curChatId) {
          setArtifacts((prev) => {
            const idx = prev.findIndex((x) => x.id === art.id);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = art;
              return copy;
            }
            return [art, ...prev];
          });
          setViewerArtifact((cur) => (cur?.id === art.id ? art : cur));
        }
        break;
      }
    }
  }, [triggerQuotaRefresh, loadSkillsList, notifyDesktopWithPushFallback]);

  const handleEphemeralEvent = useCallback(
    (evt: Extract<WsIncomingMessage, { kind: 'ephemeral' }>['event']) => {
      const curChatId = activeChatIdRef.current;
      const p = evt.payload;

      if (evt.type === 'run.queue_position') {
        const runId = p.runId as string | undefined;
        const pos = Number(p.queuePosition ?? 0);
        if (evt.chatId === curChatId && runId) {
          setActiveRun((cur) => (cur?.id === runId ? { ...cur, queuePosition: pos } : cur));
        }
        return;
      }

      if (evt.chatId !== curChatId) return;

      if (evt.type === 'chat.context_usage') {
        setContextUsage({ used: Number(p.used ?? 0), size: Number(p.size ?? 0) });
        return;
      }

      if (evt.type === 'run.delta') {
        const messageId = p.messageId as string;
        const field = p.field as 'content' | 'thoughts';
        const textKey = field === 'content' ? 'contentText' : 'thoughtsText';
        const offset = Number(p.offset ?? 0);
        const chunk = String(p.chunk ?? '');
        const activityIndex = typeof p.activityIndex === 'number' ? p.activityIndex : undefined;

        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            const merged = mergeDeltaText(m[textKey], offset, chunk);
            const entries = m.activity ?? [];
            let activity = m.activity;
            if (activityIndex === entries.length) {
              activity = [...entries, { kind: field, offset }];
            }
            if (m.deltaGap || merged.gapDetected || (activityIndex !== undefined && activityIndex > entries.length)) {
              return m.deltaGap ? m : { ...m, deltaGap: true };
            }
            if (merged.next === m[textKey] && activity === m.activity) return m;
            return { ...m, [textKey]: merged.next, activity, status: 'streaming' };
          })
        );
        return;
      }

      if (evt.type === 'run.tool_update') {
        const messageId = p.messageId as string;
        const toolCalls = (p.toolCalls as ToolCallItem[] | undefined) ?? [];
        const activity = p.activity as MessageActivity[] | undefined;
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, toolCalls, activity: activity ?? m.activity } : m))
        );
      }
    },
    []
  );

  // Manage live WebSocket lifecycle cleanly per authenticated user
  useEffect(() => {
    if (!user) {
      wsRef.current?.stop();
      wsRef.current = null;
      setWsClientId('local');
      return;
    }

    const client = new SyncSocketClient({
      onStatusChange: setWsStatus,
      onHello: (msg) => {
        notifyDetectedBuild(msg.buildId, msg.version);
        void syncPushSubscription(true);
        if (msg.resyncRequired) {
          void loadWorkspaceLists();
          if (activeChatIdRef.current) {
            void loadChatDetail(activeChatIdRef.current);
          }
        } else {
          isReplayingHelloRef.current = true;
          try {
            for (const evt of msg.events) {
              handleDurableEvent(evt);
            }
          } finally {
            isReplayingHelloRef.current = false;
          }
          // If an active chat exists, verify it caught up cleanly across background wake
          if (activeChatIdRef.current && msg.events.length === 0) {
            // noop when cleanly synchronized
          }
        }
      },
      onDurableEvent: handleDurableEvent,
      onEphemeralEvent: handleEphemeralEvent,
      onAuthLost: () => {
        clearAllViewerCaches();
        setViewerArtifact(null);
        setWsClientId('local');
        setUser(null);
        setAgyProfile(null);
        setSandboxStatus(null);
        setUserOptions(null);
        setSessionOptions(null);
        setQuota(null);
        setSkillsState(null);
        setSkillsOpen(false);
        draftCreatedChatRef.current = null;
        setDraftCreatedChat(null);
        setDraftProjectId(null);
        setActiveChatId(null);
        setMessages([]);
        setArtifacts([]);
        setPendingPermissions([]);
        setActiveRun(null);
        setContextUsage(null);
        setChats([]);
        setProjects([]);
      },
    });
    wsRef.current = client;
    setWsClientId(client.getClientId());
    client.start();
    void getActivePushSubscription()
      .then((sub) => {
        if (wsRef.current === client) {
          client.setPushEndpoint(sub?.endpoint ?? null);
        }
      })
      .catch(() => {});

    return () => {
      client.stop();
      if (wsRef.current === client) wsRef.current = null;
    };
  }, [user?.id, loadWorkspaceLists, loadChatDetail, handleDurableEvent, handleEphemeralEvent, notifyDetectedBuild]);

  const activeChat = useMemo(
    () =>
      chats.find((c) => c.id === activeChatId) ??
      (draftCreatedChat?.id === activeChatId ? draftCreatedChat : null),
    [chats, activeChatId, draftCreatedChat]
  );
  activeChatRef.current = activeChat;
  const effectiveProjectId = activeChat ? activeChat.projectId : draftProjectId;
  effectiveProjectIdRef.current = effectiveProjectId;
  const activeProject = useMemo(
    () => (effectiveProjectId ? projects.find((p) => p.id === effectiveProjectId) ?? null : null),
    [effectiveProjectId, projects]
  );

  useEffect(() => {
    if (!user) {
      setSkillsState(null);
      return;
    }
    void loadSkillsList(effectiveProjectId, activeChatId);
  }, [user?.id, effectiveProjectId, activeChatId, loadSkillsList]);

  const effectiveSessionOptions = activeChat ? (sessionOptions ?? userOptions) : userOptions;
  const mergedAvailableCommands = React.useMemo<AvailableCommandItem[]>(() => {
    const rawSessionCmds = effectiveSessionOptions?.availableCommands ?? [];
    const acpCmds = rawSessionCmds.filter((c) => c.source !== 'skill');
    const liveSkillCmds = skillsState
      ? skillsState.commands
      : rawSessionCmds.filter((c) => c.source === 'skill');

    const byName = new Map<string, AvailableCommandItem>();
    for (const cmd of acpCmds) {
      byName.set(cmd.name.toLowerCase(), cmd);
    }
    for (const cmd of liveSkillCmds) {
      const key = cmd.name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, cmd);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [effectiveSessionOptions?.availableCommands, skillsState]);

  const openAndTrackArtifact = useCallback((art: ArtifactRecord) => {
    notifyArtifactUpdated(art);
    setViewerArtifact(art);
    setArtifacts((prev) => {
      const idx = prev.findIndex((x) => x.id === art.id);
      if (idx >= 0) {
        if (prev[idx].sha256 === art.sha256 && prev[idx].updatedAt === art.updatedAt) {
          return prev;
        }
        const copy = [...prev];
        copy[idx] = art;
        return copy;
      }
      return [art, ...prev];
    });
  }, []);

  const activeModelOption = effectiveSessionOptions?.configOptions.find(
    (o) => o.id === effectiveSessionOptions.modelOptionId || o.category === 'model'
  );
  const activeEffortOption = effectiveSessionOptions?.configOptions.find(
    (o) => o.id === effectiveSessionOptions.effortOptionId || o.category === 'thought_level'
  );
  const selectedModelId =
    (activeChat ? activeChat.modelId : preferences?.defaultModelId) ||
    activeModelOption?.currentValue ||
    activeModelOption?.options[0]?.value ||
    '';
  const rawEffortValue =
    (activeChat ? activeChat.effortValue : preferences?.defaultEffortValue) ||
    activeEffortOption?.currentValue ||
    activeEffortOption?.options[0]?.value ||
    '';
  const selectedEffortValue =
    activeEffortOption?.options.some((o) => o.value === rawEffortValue)
      ? rawEffortValue
      : activeEffortOption?.currentValue || activeEffortOption?.options[0]?.value || rawEffortValue;
  selectedModelIdRef.current = selectedModelId;
  selectedEffortValueRef.current = selectedEffortValue;

  const handleStartDraftChat = useCallback((projectId: string | null = null) => {
    chatSwitchSeqRef.current += 1;
    cleanupEmptyDraftChat();
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setDraftProjectId(projectId);
    setMessages([]);
    setArtifacts([]);
    setPendingPermissions([]);
    setActiveRun(null);
    setSessionOptions(null);
    setContextUsage(null);
    setChatLoadError(null);
    setActionError(null);
    setHasComposerDraft(false);
    setDraftResetToken((t) => t + 1);
  }, [cleanupEmptyDraftChat]);

  const createDraftBackedChat = useCallback(async (expectedSwitchSeq?: number): Promise<ChatRecord> => {
    const res = await api.createChat({
      projectId: draftProjectIdRef.current,
      modelId: selectedModelIdRef.current || null,
      effortValue: selectedEffortValueRef.current || null,
    });
    if (expectedSwitchSeq === undefined || chatSwitchSeqRef.current === expectedSwitchSeq) {
      draftCreatedChatRef.current = res.chat;
      setDraftCreatedChat(res.chat);
      setDraftProjectId(null);
      if (res.sessionOptions) setSessionOptions(res.sessionOptions);
      skipNextLoadChatIdRef.current = res.chat.id;
      activeChatIdRef.current = res.chat.id;
      setActiveChatId(res.chat.id);
    }
    return res.chat;
  }, []);

  const optionsByModelRef = useRef<Map<string, ParsedSessionOptions>>(new Map());

  useEffect(() => {
    const activeOpts = activeChat ? sessionOptions : userOptions;
    if (activeOpts?.currentModelId) {
      optionsByModelRef.current.set(activeOpts.currentModelId, activeOpts);
    }
  }, [activeChat, sessionOptions, userOptions]);

  const handleChangeModel = useCallback(async (modelId: string) => {
    const curChat = activeChatRef.current;
    const cachedOpts = optionsByModelRef.current.get(modelId);
    setActionError(null);

    if (curChat) {
      const prevModelId = curChat.modelId;
      const prevSessionOpts = sessionOptionsRef.current;
      setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, modelId } : c)));
      setDraftCreatedChat((prev) =>
        prev && prev.id === curChat.id ? { ...prev, modelId } : prev
      );
      setSessionOptions((prev) => {
        if (cachedOpts) return cachedOpts;
        if (!prev) return prev;
        return {
          ...prev,
          currentModelId: modelId,
          configOptions: prev.configOptions.map((o) =>
            o.id === prev.modelOptionId || o.category === 'model'
              ? { ...o, currentValue: modelId }
              : o
          ),
        };
      });

      try {
        const res = await api.patchChat(curChat.id, { modelId });
        setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, ...res.chat } : c)));
        setDraftCreatedChat((prev) =>
          prev && prev.id === curChat.id ? { ...prev, ...res.chat } : prev
        );
        if (res.sessionOptions) {
          optionsByModelRef.current.set(modelId, res.sessionOptions);
          if (activeChatIdRef.current === curChat.id) {
            setSessionOptions(res.sessionOptions);
          }
        }
      } catch (err) {
        setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, modelId: prevModelId } : c)));
        setDraftCreatedChat((prev) =>
          prev && prev.id === curChat.id ? { ...prev, modelId: prevModelId } : prev
        );
        if (activeChatIdRef.current === curChat.id) {
          setSessionOptions(prevSessionOpts);
        }
        setActionError(
          err instanceof ApiError ? err.message : 'モデルの変更を保存できませんでした。'
        );
      }
      return;
    }

    const prevPrefs = preferencesRef.current;
    const prevUserOpts = userOptionsRef.current;
    setPreferences((prev) => (prev ? { ...prev, defaultModelId: modelId } : prev));
    setUserOptions((prev) => {
      if (cachedOpts) return cachedOpts;
      if (!prev) return prev;
      return {
        ...prev,
        currentModelId: modelId,
        configOptions: prev.configOptions.map((o) =>
          o.id === prev.modelOptionId || o.category === 'model'
            ? { ...o, currentValue: modelId }
            : o
        ),
      };
    });

    try {
      const [prefRes, optRes] = await Promise.all([
        api.updatePreferences({ defaultModelId: modelId }),
        api.getAgyOptions(modelId),
      ]);
      let nextPrefs = prefRes.preferences;
      if (optRes.sessionOptions) {
        optionsByModelRef.current.set(modelId, optRes.sessionOptions);
        setUserOptions(optRes.sessionOptions);
        const nextEffortOpt = optRes.sessionOptions.configOptions.find(
          (o) => o.id === optRes.sessionOptions?.effortOptionId || o.category === 'thought_level'
        );
        if (
          nextEffortOpt &&
          nextPrefs.defaultEffortValue &&
          !nextEffortOpt.options.some((o) => o.value === nextPrefs.defaultEffortValue)
        ) {
          const fallbackEffort =
            nextEffortOpt.currentValue || nextEffortOpt.options[0]?.value || null;
          if (fallbackEffort) {
            nextPrefs = { ...nextPrefs, defaultEffortValue: fallbackEffort };
            setPreferences(nextPrefs);
            void api
              .updatePreferences({ defaultEffortValue: fallbackEffort })
              .then((synced) => {
                setPreferences(synced.preferences);
              })
              .catch(() => {});
            return;
          }
        }
      }
      setPreferences(nextPrefs);
    } catch (err) {
      if (prevPrefs) setPreferences(prevPrefs);
      setUserOptions(prevUserOpts);
      setActionError(
        err instanceof ApiError ? err.message : 'モデルの変更を保存できませんでした。'
      );
    }
  }, []);

  const handleChangeEffort = useCallback(async (effortValue: string) => {
    const curChat = activeChatRef.current;
    setActionError(null);
    if (curChat) {
      const prevEffortValue = curChat.effortValue;
      const prevSessionOpts = sessionOptionsRef.current;
      setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, effortValue } : c)));
      setDraftCreatedChat((prev) =>
        prev && prev.id === curChat.id ? { ...prev, effortValue } : prev
      );
      setSessionOptions((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          currentEffortValue: effortValue,
          configOptions: prev.configOptions.map((o) =>
            o.id === prev.effortOptionId || o.category === 'thought_level'
              ? { ...o, currentValue: effortValue }
              : o
          ),
        };
      });

      try {
        const res = await api.patchChat(curChat.id, { effortValue });
        setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, ...res.chat } : c)));
        setDraftCreatedChat((prev) =>
          prev && prev.id === curChat.id ? { ...prev, ...res.chat } : prev
        );
        if (res.sessionOptions && activeChatIdRef.current === curChat.id) {
          setSessionOptions(res.sessionOptions);
        }
      } catch (err) {
        setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, effortValue: prevEffortValue } : c)));
        setDraftCreatedChat((prev) =>
          prev && prev.id === curChat.id ? { ...prev, effortValue: prevEffortValue } : prev
        );
        if (activeChatIdRef.current === curChat.id) {
          setSessionOptions(prevSessionOpts);
        }
        setActionError(
          err instanceof ApiError ? err.message : '推論レベルの変更を保存できませんでした。'
        );
      }
      return;
    }

    const prevPrefs = preferencesRef.current;
    const prevUserOpts = userOptionsRef.current;
    setPreferences((prev) => (prev ? { ...prev, defaultEffortValue: effortValue } : prev));
    setUserOptions((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        currentEffortValue: effortValue,
        configOptions: prev.configOptions.map((o) =>
          o.id === prev.effortOptionId || o.category === 'thought_level'
            ? { ...o, currentValue: effortValue }
            : o
        ),
      };
    });
    try {
      const res = await api.updatePreferences({ defaultEffortValue: effortValue });
      setPreferences(res.preferences);
    } catch (err) {
      if (prevPrefs) setPreferences(prevPrefs);
      setUserOptions(prevUserOpts);
      setActionError(
        err instanceof ApiError ? err.message : '推論レベルの変更を保存できませんでした。'
      );
    }
  }, []);

  const handleChangeModelCb = useCallback(
    (modelId: string) => {
      void handleChangeModel(modelId);
    },
    [handleChangeModel]
  );

  const handleChangeEffortCb = useCallback(
    (effortValue: string) => {
      void handleChangeEffort(effortValue);
    },
    [handleChangeEffort]
  );

  const handleManualReloadUpdate = () => {
    if (hasComposerDraft) {
      const confirmed = window.confirm(
        '入力中の下書きや添付は再読み込み後に失われます。今すぐ更新しますか？'
      );
      if (!confirmed) return;
    }
    if (pendingUpdateBuild) {
      try {
        if (pendingUpdateBuild === 'sw-update') {
          sessionStorage.setItem('agy_last_sw_reload_ts', String(Date.now()));
        } else {
          sessionStorage.setItem('agy_reloaded_build', pendingUpdateBuild);
        }
      } catch {
        // ignore
      }
    }
    window.location.reload();
  };

  const ensureActiveChatForAction = useCallback(async (): Promise<string> => {
    if (activeChatIdRef.current) return activeChatIdRef.current;
    const switchSeq = chatSwitchSeqRef.current;
    const created = await createDraftBackedChat(switchSeq);
    return created.id;
  }, [createDraftBackedChat]);

  const handleUploadFiles = useCallback(
    async (files: File[]): Promise<AttachmentRef[]> => {
      const chatId = await ensureActiveChatForAction();
      const res = await api.uploadChatAttachments(chatId, files);
      return res.attachments;
    },
    [ensureActiveChatForAction]
  );

  const handleSendPrompt = useCallback(
    async (text: string, files: AttachmentRef[]): Promise<void> => {
      triggerHaptic('send', Boolean(preferencesRef.current?.hapticFeedback ?? true));
      const switchSeq = chatSwitchSeqRef.current;
      const existingId = activeChatIdRef.current;
      const wasDraft = !existingId || draftCreatedChatRef.current?.id === existingId;
      const clientMessageId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = Date.now();
      const optimisticUserMsg: LiveMessage = {
        id: `optimistic-${clientMessageId}`,
        chatId: existingId ?? 'draft',
        userId: user?.id ?? '',
        clientMessageId,
        role: 'user',
        contentText: text,
        thoughtsText: '',
        toolCalls: [],
        attachments: files,
        artifactIds: [],
        status: 'completed',
        runId: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        optimisticPop: true,
      };

      setMessages((prev) => [...prev, optimisticUserMsg]);

      let chatId: string;
      let res: Awaited<ReturnType<typeof api.sendMessage>>;
      try {
        chatId = existingId || (await createDraftBackedChat(switchSeq)).id;
        res = await api.sendMessage(chatId, {
          text,
          attachmentIds: files.map((f) => f.artifactId),
          clientMessageId,
        });
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
        throw err;
      }

      const draftSnap = draftCreatedChatRef.current;
      if (draftSnap?.id === chatId) {
        draftCreatedChatRef.current = null;
        setDraftCreatedChat(null);
      }
      const promotedChat = res.chat ?? (wasDraft && draftSnap?.id === chatId ? draftSnap : undefined);
      if (promotedChat) {
        setChats((prev) => {
          const existing = prev.find((c) => c.id === promotedChat.id);
          const effectiveRun =
            existing?.activeRun &&
            (existing.activeRun.status === 'running' ||
              existing.activeRun.status === 'awaiting_permission') &&
            res.run.status === 'queued'
              ? existing.activeRun
              : res.run;
          return [
            { ...promotedChat, activeRun: effectiveRun },
            ...prev.filter((c) => c.id !== promotedChat.id),
          ];
        });
      }

      if (activeChatIdRef.current === chatId) {
        setMessages((prev) => {
          let next = upsertMessage(prev, res.userMessage);
          next = upsertMessage(next, res.assistantMessage);
          return next;
        });
        setActiveRun((cur) =>
          cur &&
          (cur.status === 'running' || cur.status === 'awaiting_permission') &&
          res.run.status === 'queued'
            ? cur
            : res.run
        );
      }
      void triggerQuotaRefresh(true, 5_000);
    },
    [user?.id, createDraftBackedChat, triggerQuotaRefresh]
  );

  const handleCancelRun = useCallback(async (runId: string) => {
    const chatId = activeChatIdRef.current;
    if (!chatId) return;
    if (locallyCancelledRunIdsRef.current.size > 200) {
      locallyCancelledRunIdsRef.current.clear();
    }
    locallyCancelledRunIdsRef.current.add(runId);
    await api.cancelRun(chatId, runId);
  }, []);

  const handleSelectChat = useCallback(
    (id: string) => {
      chatSwitchSeqRef.current += 1;
      if (draftCreatedChatRef.current?.id !== id) {
        cleanupEmptyDraftChat();
      }
      setActionError(null);
      setChatLoadError(null);
      setDraftProjectId(null);
      setActiveChatId(id);
    },
    [cleanupEmptyDraftChat]
  );

  const handleRenameChat = useCallback(async (chatId: string, title: string) => {
    const res = await api.patchChat(chatId, { title });
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, ...res.chat } : c)));
    setDraftCreatedChat((prev) => (prev && prev.id === chatId ? { ...prev, ...res.chat } : prev));
  }, []);

  const handleDeleteChat = useCallback(async (chatId: string) => {
    await api.deleteChat(chatId);
    invalidateChatViewerCache(chatId);
    setViewerArtifact((cur) => (cur?.chatId === chatId ? null : cur));
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    setDraftCreatedChat((prev) => (prev && prev.id === chatId ? null : prev));
    if (activeChatIdRef.current === chatId) {
      chatSwitchSeqRef.current += 1;
      activeChatIdRef.current = null;
      setActiveChatId(null);
    }
  }, []);

  const handleSyncProject = useCallback(async () => {
    const curChat = activeChatRef.current;
    if (!curChat) return;
    const res = await api.syncChatProject(curChat.id);
    setChats((prev) => prev.map((c) => (c.id === curChat.id ? { ...c, ...res.chat } : c)));
    setDraftCreatedChat((prev) =>
      prev && prev.id === curChat.id ? { ...prev, ...res.chat } : prev
    );
    await loadChatDetail(curChat.id);
  }, [loadChatDetail]);

  const handlePermissionUpdated = useCallback((perm: PendingPermissionRecord) => {
    setPendingPermissions((prev) => prev.filter((x) => x.id !== perm.id));
  }, []);

  const handleElicitationUpdated = useCallback((elicit: PendingElicitationRecord) => {
    setPendingElicitations((prev) => prev.filter((x) => x.id !== elicit.id));
  }, []);

  const handleNewChatForProject = useCallback(
    (projId?: string | null) => {
      handleStartDraftChat(projId ?? null);
    },
    [handleStartDraftChat]
  );

  const handleHeaderNewChat = useCallback(() => {
    handleStartDraftChat(null);
  }, [handleStartDraftChat]);

  const handleCloseSidebarMobile = useCallback(() => setSidebarMobileOpen(false), []);
  const handleOpenSidebar = useCallback(() => setSidebarMobileOpen(true), []);
  const handleOpenProjectModal = useCallback((proj: ProjectRecord | null) => setProjectModalTarget(proj), []);
  const handleOpenSkills = useCallback(() => setSkillsOpen(true), []);
  const handleOpenMcp = useCallback(() => setMcpOpen(true), []);
  const handleOpenSettings = useCallback(() => setSettingsOpen(true), []);
  const handleRefreshQuota = useCallback(() => {
    void triggerQuotaRefresh(false);
  }, [triggerQuotaRefresh]);
  const handleOpenQuotaPopover = useCallback(() => {
    void triggerQuotaRefresh(true, 10_000);
  }, [triggerQuotaRefresh]);
  const handleCloseViewer = useCallback(() => setViewerArtifact(null), []);
  const handleCopiedToProject = useCallback((updatedProj: ProjectRecord) => {
    setProjects((prev) => prev.map((p) => (p.id === updatedProj.id ? updatedProj : p)));
  }, []);

  const handleLogout = async (allDevices = false) => {
    try {
      await unsubscribePushOnDevice().catch(() => {});
      if (allDevices) await api.logoutAll();
      else await api.logout();
    } catch {
      // clear UI even if already expired
    }
    wsRef.current?.stop();
    clearAllViewerCaches();
    setViewerArtifact(null);
    setWsClientId('local');
    setUser(null);
    setAgyProfile(null);
    setSandboxStatus(null);
    setUserOptions(null);
    setSessionOptions(null);
    setQuota(null);
    setSkillsState(null);
    setSkillsOpen(false);
    setHasComposerDraft(false);
    draftCreatedChatRef.current = null;
    setDraftCreatedChat(null);
    setDraftProjectId(null);
    setActiveChatId(null);
    setMessages([]);
    setArtifacts([]);
    setPendingPermissions([]);
    setPendingElicitations([]);
    setActiveRun(null);
    setContextUsage(null);
    setChats([]);
    setProjects([]);
    setSettingsOpen(false);
    const refreshed = await api.bootstrap().catch(() => null);
    if (refreshed) {
      setBootstrapMeta({
        userCount: refreshed.userCount,
        allowPublicSignup: refreshed.allowPublicSignup,
        agyMode: refreshed.agyMode,
      });
    }
  };

  if (bootstrapping) {
    return (
      <div className="splash-shell">
        <div className="muted-sm">起動中...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        userCount={bootstrapMeta.userCount}
        allowPublicSignup={bootstrapMeta.allowPublicSignup}
        onAuthenticated={(payload) => {
          setUser(payload.user);
          setAgyProfile(payload.agyProfile);
          setPreferences(payload.preferences);
          setLoginFlow(payload.loginFlow);
          setSandboxStatus(payload.sandbox ?? null);
        }}
      />
    );
  }

  // Strictly enforce initial / unauthenticated Antigravity account binding before chat UI
  if (!agyProfile || agyProfile.authStatus !== 'authenticated') {
    return (
      <AgyOnboarding
        user={user}
        profile={agyProfile}
        loginFlow={loginFlow}
        agyMode={bootstrapMeta.agyMode}
        onUpdated={({ profile, loginFlow: nextFlow }) => {
          setAgyProfile(profile);
          if (nextFlow !== undefined) setLoginFlow(nextFlow);
        }}
        onLogout={() => void handleLogout(false)}
      />
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        openMobile={sidebarMobileOpen}
        user={user}
        agyProfile={agyProfile}
        chats={chats}
        projects={projects}
        activeChatId={activeChatId}
        skillCount={skillsState?.commands.length ?? 0}
        onCloseMobile={handleCloseSidebarMobile}
        onNewChat={handleNewChatForProject}
        onSelectChat={handleSelectChat}
        onRenameChat={handleRenameChat}
        onDeleteChat={handleDeleteChat}
        onOpenProjectModal={handleOpenProjectModal}
        onOpenSkills={handleOpenSkills}
        onOpenMcp={user.role === 'admin' ? handleOpenMcp : undefined}
        onOpenSettings={handleOpenSettings}
      />

      <main className="main-pane">
        <HeaderBar
          activeChat={activeChat}
          selectedModelId={selectedModelId}
          agyProfile={agyProfile}
          quota={quota}
          quotaRefreshing={quotaRefreshing}
          quotaError={quotaError}
          wsStatus={wsStatus}
          onOpenSidebar={handleOpenSidebar}
          onNewChat={handleHeaderNewChat}
          onRefreshQuota={handleRefreshQuota}
          onOpenQuotaPopover={handleOpenQuotaPopover}
        />

        {pendingUpdateBuild && (
          <div className="update-banner" role="status">
            <span>
              {isSafeToReload
                ? `新しいバージョン${pendingUpdateVersion ? ` (v${pendingUpdateVersion})` : ''}を検知しました。自動的に最新画面へ更新します...`
                : `新しいバージョン${pendingUpdateVersion ? ` (v${pendingUpdateVersion})` : ''}が利用可能です（送信中・入力中の作業完了後に自動更新されます）`}
            </span>
            <button type="button" className="btn btn-secondary btn-xs" onClick={handleManualReloadUpdate}>
              今すぐ更新
            </button>
          </div>
        )}

        <div className="content-stage">
          <ChatView
            chat={activeChat}
            project={activeProject}
            messages={messages}
            artifacts={artifacts}
            pendingPermissions={pendingPermissions}
            pendingElicitations={pendingElicitations}
            activeRun={activeRun}
            sessionOptions={effectiveSessionOptions}
            availableCommands={mergedAvailableCommands}
            selectedModelId={selectedModelId}
            selectedEffortValue={selectedEffortValue}
            contextUsage={contextUsage}
            draftResetToken={draftResetToken}
            isDraftChat={Boolean(draftCreatedChat && activeChat?.id === draftCreatedChat.id)}
            chatLoadError={chatLoadError}
            actionError={actionError}
            clientId={wsClientId}
            hapticEnabled={preferences?.hapticFeedback ?? true}
            onChangeModel={handleChangeModelCb}
            onChangeEffort={handleChangeEffortCb}
            onDraftChange={setHasComposerDraft}
            onRetryLoadChat={activeChatId ? () => void loadChatDetail(activeChatId) : undefined}
            onDismissActionError={() => setActionError(null)}
            onSendPrompt={handleSendPrompt}
            onUploadFiles={handleUploadFiles}
            onCancelRun={handleCancelRun}
            onSyncProject={handleSyncProject}
            onOpenArtifact={openAndTrackArtifact}
            onPermissionUpdated={handlePermissionUpdated}
            onElicitationUpdated={handleElicitationUpdated}
            onOpenSkills={handleOpenSkills}
            externalDraftCommand={externalDraftCommand}
          />

        </div>
      </main>

      {settingsOpen && preferences && (
        <SettingsModal
          user={user}
          agyProfile={agyProfile}
          loginFlow={loginFlow}
          preferences={preferences}
          agyMode={bootstrapMeta.agyMode}
          sandbox={sandboxStatus}
          appInfo={appBuildInfo}
          onClose={() => setSettingsOpen(false)}
          onUpdatePreferences={(next) => setPreferences(next)}
          onUpdateAgy={({ profile, loginFlow: nextFlow }) => {
            setAgyProfile(profile);
            if (nextFlow !== undefined) setLoginFlow(nextFlow);
          }}
          onLogout={(all) => void handleLogout(all)}
          onOpenMcp={user.role === 'admin' ? handleOpenMcp : undefined}
        />
      )}

      {mcpOpen && user.role === 'admin' && (
        <McpModal onClose={() => setMcpOpen(false)} />
      )}

      {skillsOpen && (
        <SkillsModal
          activeChatId={activeChatId}
          activeProjectId={effectiveProjectId}
          projects={projects}
          onClose={() => setSkillsOpen(false)}
          onSkillsChanged={() => {
            void loadSkillsList(effectiveProjectIdRef.current, activeChatIdRef.current);
          }}
          onInsertSlashCommand={(slug) => {
            setExternalDraftCommand({ slug, token: Date.now() });
          }}
        />
      )}

      {projectModalTarget !== undefined && (
        <ProjectModal
          project={projectModalTarget}
          onClose={() => setProjectModalTarget(undefined)}
          onSaved={(saved) => {
            setProjects((prev) => {
              const idx = prev.findIndex((p) => p.id === saved.id);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = saved;
                return copy;
              }
              return [saved, ...prev];
            });
          }}
          onDeleted={(projectId) => {
            setProjects((prev) => prev.filter((p) => p.id !== projectId));
          }}
          onStartChatInProject={(projectId) => {
            handleStartDraftChat(projectId);
          }}
        />
      )}

      {viewerArtifact && (
        <Suspense
          fallback={
            <div className="modal-backdrop">
              <div className="modal-card modal-md" style={{ padding: 24, textAlign: 'center' }}>
                ビューアを読込中...
              </div>
            </div>
          }
        >
          <ArtifactViewerModal
            artifact={viewerArtifact}
            projects={projects}
            onClose={handleCloseViewer}
            onCopiedToProject={handleCopiedToProject}
            onOpenArtifact={openAndTrackArtifact}
          />
        </Suspense>
      )}
    </div>
  );
};
