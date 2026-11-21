import { ModalDialog } from './ModalDialog';
import React, { useEffect, useState } from 'react';
import { ApiError, api, type AgyAgentMode } from '../api/client';
import type {
  AgyLoginFlowState,
  AgyProfile,
  SandboxStatus,
  UserPreferences,
  WebUser,
} from '../types';
import {
  HAPTIC_META,
  isAppleTouchHapticsFallback,
  isVibrationApiSupported,
  triggerHaptic,
} from '../utils/haptics';
import {
  ensurePushSubscribed,
  formatPushFailureReason,
  getActivePushSubscription,
  getDevicePushSyncStatus,
  isAppleMobileBrowser,
  isNotificationSupported,
  isPushSupported,
  isStandalonePwa,
  showBrowserNotification,
  unsubscribePushOnDevice,
} from '../utils/notifications';
import { AgyOnboarding } from './AgyOnboarding';
import { CloseIcon } from './Icons';
import { ToggleSwitch } from './ToggleSwitch';

const AGENT_MODE_OPTIONS: { value: AgyAgentMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '', label: 'Default' },
  { value: 'accept-edits', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan' },
];

interface AppInfoMeta {
  version: string;
  shortSha?: string | null;
  buildId?: string | null;
  builtAt?: string | null;
}

interface SettingsModalProps {
  user: WebUser;
  agyProfile: AgyProfile | null;
  loginFlow: AgyLoginFlowState | null;
  preferences: UserPreferences;
  agyMode: 'real' | 'mock';
  sandbox: SandboxStatus | null;
  appInfo?: AppInfoMeta;
  onClose: () => void;
  onUpdatePreferences: (prefs: UserPreferences) => void;
  onUpdateAgy: (payload: { profile: AgyProfile; loginFlow?: AgyLoginFlowState | null }) => void;
  onLogout: (allDevices: boolean) => void;
  onOpenMcp?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  user,
  agyProfile,
  loginFlow,
  preferences,
  agyMode,
  sandbox,
  appInfo,
  onClose,
  onUpdatePreferences,
  onUpdateAgy,
  onLogout,
  onOpenMcp,
}) => {
  const [showReauth, setShowReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  const [deviceSubscribed, setDeviceSubscribed] = useState<boolean>(false);
  const [subCount, setSubCount] = useState<number>(0);
  const [notifStatusMsg, setNotifStatusMsg] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [hapticError, setHapticError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [adminMsg, setAdminMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<string | null | undefined>(undefined);
  const [agentModeLoading, setAgentModeLoading] = useState(true);
  const [agentModeSaving, setAgentModeSaving] = useState(false);
  const [agentModeError, setAgentModeError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.getAgyAgentMode().then(
      (res) => {
        if (active) {
          setAgentMode(res.agentMode);
          setAgentModeLoading(false);
        }
      },
      (err) => {
        if (active) {
          setAgentModeError(err instanceof ApiError ? err.message : 'エージェントモードの読み込みに失敗しました。');
          setAgentModeLoading(false);
        }
      }
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getDevicePushSyncStatus().then(async (status) => {
      if (!active) return;
      setSubCount(status.subscriptionCount);
      if (
        !status.registeredOnServer &&
        preferences.notifyOnResponse &&
        isNotificationSupported() &&
        Notification.permission === 'granted' &&
        isPushSupported()
      ) {
        const res = await ensurePushSubscribed();
        if (!active) return;
        setDeviceSubscribed(res.subscribed);
        if (typeof res.subscriptionCount === 'number') setSubCount(res.subscriptionCount);
      } else {
        setDeviceSubscribed(status.registeredOnServer);
      }
    });
    return () => {
      active = false;
    };
  }, [preferences.notifyOnResponse]);

  const handleAgentModeChange = async (value: string) => {
    const option = AGENT_MODE_OPTIONS.find((item) => item.value === value);
    if (!option) return;
    setAgentModeSaving(true);
    setAgentModeError(null);
    try {
      const res = await api.updateAgyAgentMode(option.value);
      setAgentMode(res.agentMode);
    } catch (err) {
      setAgentModeError(err instanceof ApiError ? err.message : 'エージェントモードの保存に失敗しました。');
      if (err instanceof ApiError && err.status === 409) {
        const current = await api.getAgyAgentMode().catch(() => null);
        if (current) setAgentMode(current.agentMode);
      }
    } finally {
      setAgentModeSaving(false);
    }
  };

  const handlePrefChange = async (
    patch: Partial<
      Pick<UserPreferences, 'theme' | 'notifyOnResponse' | 'hapticFeedback'>
    >
  ) => {
    if ('theme' in patch) setThemeError(null);
    if ('hapticFeedback' in patch) setHapticError(null);
    try {
      const res = await api.updatePreferences(patch);
      onUpdatePreferences(res.preferences);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '設定更新に失敗しました。';
      if ('theme' in patch) setThemeError(msg);
      else if ('hapticFeedback' in patch) setHapticError(msg);
      else setError(msg);
    }
  };

  const handleToggleNotification = async (next: boolean) => {
    setNotifError(null);
    setNotifStatusMsg(null);

    if (!next) {
      setNotifBusy(true);
      try {
        const res = await api.updatePreferences({ notifyOnResponse: false });
        onUpdatePreferences(res.preferences);
        await unsubscribePushOnDevice();
        setDeviceSubscribed(false);
        const cfg = await api.getNotificationConfig().catch(() => null);
        if (cfg) setSubCount(cfg.subscriptionCount);
      } catch (err) {
        setNotifError(err instanceof ApiError ? err.message : '通知設定の更新に失敗しました。');
      } finally {
        setNotifBusy(false);
      }
      return;
    }

    if (!isNotificationSupported()) {
      if (isAppleMobileBrowser() && !isStandalonePwa()) {
        setNotifError(
          'iPhone/iPadで通知を受け取るには、Safariの共有ボタンから「ホーム画面に追加」し、ホーム画面のアイコンから開いた状態でオンにしてください。'
        );
      } else {
        setNotifError(
          'この環境では通知APIが利用できません。HTTPS（Tailscale Serve）または localhost でアクセスしてください。'
        );
      }
      return;
    }

    if (Notification.permission === 'denied') {
      setNotifError(
        'ブラウザ側で通知がブロックされています。ブラウザまたはOSのサイト設定から通知を「許可」に変更してください。'
      );
      return;
    }

    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setNotifError('通知が許可されなかったため、オンにできませんでした。');
        return;
      }
    }

    setNotifBusy(true);
    try {
      const res = await api.updatePreferences({ notifyOnResponse: true });
      onUpdatePreferences(res.preferences);

      const pushRes = await ensurePushSubscribed();
      setDeviceSubscribed(pushRes.subscribed);
      if (typeof pushRes.subscriptionCount === 'number') {
        setSubCount(pushRes.subscriptionCount);
      }
      if (pushRes.subscribed) {
        setNotifStatusMsg('通知を有効にしました（バックグラウンドでもWeb Pushを受信できます）。');
      } else if (isPushSupported()) {
        setNotifError(
          `設定は有効にしましたが、この端末のバックグラウンドWeb Push登録に失敗しました: ${formatPushFailureReason(pushRes.reason)}`
        );
      } else {
        setNotifStatusMsg('通知を有効にしました（アプリ・ブラウザを開いている間の応答完了を通知します）。');
      }
    } catch (err) {
      setNotifError(err instanceof ApiError ? err.message : '通知設定の更新に失敗しました。');
    } finally {
      setNotifBusy(false);
    }
  };

  const handleEnablePushOnThisDevice = async () => {
    setNotifError(null);
    setNotifStatusMsg(null);
    if (!isNotificationSupported()) {
      if (isAppleMobileBrowser() && !isStandalonePwa()) {
        setNotifError('iPhone/iPadでは「ホーム画面に追加」したPWAから有効化してください。');
      } else {
        setNotifError('このブラウザでは通知がサポートされていません。');
      }
      return;
    }
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setNotifError('通知が許可されませんでした。');
        return;
      }
    } else if (Notification.permission === 'denied') {
      setNotifError('ブラウザ側で通知がブロックされています。サイト設定から許可してください。');
      return;
    }

    setNotifBusy(true);
    try {
      const pushRes = await ensurePushSubscribed();
      setDeviceSubscribed(pushRes.subscribed);
      if (typeof pushRes.subscriptionCount === 'number') {
        setSubCount(pushRes.subscriptionCount);
      }
      if (pushRes.subscribed) {
        setNotifStatusMsg('この端末をWeb Push通知に登録しました。');
      } else if (isPushSupported()) {
        setNotifError(formatPushFailureReason(pushRes.reason));
      } else {
        setNotifStatusMsg('この端末でのブラウザ通知を有効にしました。');
      }
    } finally {
      setNotifBusy(false);
    }
  };

  const handleTestNotification = async () => {
    setNotifError(null);
    setNotifStatusMsg(null);
    setNotifBusy(true);
    try {
      if (isNotificationSupported() && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      if (!isNotificationSupported() || Notification.permission !== 'granted') {
        setNotifError('通知権限が許可されていません。先に「この端末で許可」から許可してください。');
        return;
      }

      if (isPushSupported()) {
        const pushRes = await ensurePushSubscribed();
        setDeviceSubscribed(pushRes.subscribed);
        if (typeof pushRes.subscriptionCount === 'number') {
          setSubCount(pushRes.subscriptionCount);
        }
        if (!pushRes.subscribed) {
          setNotifError(formatPushFailureReason(pushRes.reason));
          return;
        }

        const sub = await getActivePushSubscription();
        const res = await api.sendTestPush(sub?.endpoint);
        const statusAfter = await getDevicePushSyncStatus().catch(() => null);
        if (statusAfter) {
          setDeviceSubscribed(statusAfter.registeredOnServer);
          setSubCount(statusAfter.subscriptionCount);
        }

        if (res.currentDeviceSent) {
          setNotifStatusMsg(
            `この端末へWeb Pushテスト通知を送信しました（配信成功: ${res.sent}/${res.total}台）。`
          );
        } else {
          const detail =
            res.currentDeviceError ||
            res.lastError ||
            'この端末のPush配信に失敗しました。いったん通知をオフにしてオンにし直してください。';
          setNotifError(`この端末へのWeb Pushテスト送信に失敗しました: ${detail}`);
        }
        return;
      }

      // Environment without PushManager (local Notification API only)
      const shown = await showBrowserNotification({
        title: 'Antigravity Chat',
        body: 'テスト通知：応答が完了するとこのように通知が届きます。',
        tag: `test-${Date.now()}`,
      });
      if (shown) {
        setNotifStatusMsg(
          'ローカルテスト通知を表示しました（※この環境はWeb Push非対応のため、アプリ/ブラウザを開いている間のみ通知されます）。'
        );
      } else {
        setNotifError('通知を表示できませんでした。ブラウザの通知設定を確認してください。');
      }
    } catch (err) {
      setNotifError(err instanceof ApiError ? err.message : 'テスト通知の送信に失敗しました。');
    } finally {
      setNotifBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('このWebアカウントに紐づく Antigravity 認証を解除しますか？（チャット履歴は保持されます）')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.disconnectAgy();
      onUpdateAgy({ profile: res.profile });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '解除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleAdminCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminMsg(null);
    setError(null);
    setBusy(true);
    try {
      const res = await api.register({ username: newUsername.trim(), password: newPassword });
      setAdminMsg(`ユーザー "${res.user.username}" を作成しました（初回ログイン時に各自のAntigravity認証が必要です）。`);
      setNewUsername('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ユーザー作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const needsDeviceActivation =
    preferences.notifyOnResponse &&
    (!isNotificationSupported() || Notification.permission !== 'granted' || (isPushSupported() && !deviceSubscribed));

  const selectedAgentMode = AGENT_MODE_OPTIONS.find((option) => option.value === agentMode)?.value;

  return (
    <ModalDialog label="設定" size="modal-md" onClose={onClose}>
        <div className="modal-head">
          <h3>設定</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="modal-body stack-gap">
          <section className="settings-section">
            <h4>外観テーマ</h4>
            <div className="segmented-tabs">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button
                  key={t}
                  aria-pressed={preferences.theme === t}
                  type="button"
                  className={preferences.theme === t ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => handlePrefChange({ theme: t })}
                >
                  {t === 'system' ? 'システム' : t === 'light' ? 'ライト' : 'ダーク'}
                </button>
              ))}
            </div>
            {themeError && <div className="error-box" role="alert" style={{ marginTop: 8 }}>{themeError}</div>}
          </section>

          <details className="settings-section">
            <summary>Antigravity アカウント連携</summary>
            <div className="settings-kv">
              <div>
                <div className="kv-label">接続ステータス</div>
                <div className="kv-value">
                  <span
                    className={`status-dot ${agyProfile?.authStatus === 'authenticated' ? 'ok' : 'warn'}`}
                  />
                  <span>
                    {agyProfile?.authStatus === 'authenticated' ? '認証済み' : '未認証'}
                    {agyProfile?.accountLabel ? ` — ${agyProfile.accountLabel}` : ''}
                  </span>
                </div>
                {agyProfile?.authMethod && (
                  <div className="muted-xs">方式: {agyProfile.authMethod}</div>
                )}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowReauth(true)}
                  disabled={busy}
                >
                  アカウント切替 / 再認証
                </button>
                <button
                  type="button"
                  className="btn btn-danger-outline btn-sm"
                  onClick={handleDisconnect}
                  disabled={busy}
                >
                  連携解除
                </button>
              </div>
            </div>
          </details>

          <section className="settings-section">
            <h4><label htmlFor="agy-agent-mode">Antigravity エージェントモード</label></h4>
            <select
              id="agy-agent-mode"
              className="compact-select"
              value={selectedAgentMode ?? 'current'}
              disabled={agentModeLoading || agentModeSaving}
              aria-describedby="agy-agent-mode-hint"
              onChange={(e) => void handleAgentModeChange(e.target.value)}
            >
              {selectedAgentMode === undefined && (
                <option value="current" disabled>
                  {agentMode === undefined
                    ? (agentModeLoading ? '読み込み中…' : '現在の値を取得できませんでした')
                    : (agentMode === null ? 'CLI の既定モード' : agentMode)}
                </option>
              )}
              {AGENT_MODE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <div id="agy-agent-mode-hint" className="muted-xs">
              {agentMode === null && (
                <div>プロファイルに明示指定がないため、Antigravity が実行モードを決めます。</div>
              )}
              <div>Antigravity が対応するモードは、新しい ACP セッションに反映されます。</div>
            </div>
            {agentModeError && <div className="error-box" role="alert">{agentModeError}</div>}
          </section>

          <section className="settings-section">
            <h4>通知</h4>
            <ToggleSwitch
              checked={preferences.notifyOnResponse}
              disabled={notifBusy}
              label="応答が終了したら通知する"
              onChange={(next) => void handleToggleNotification(next)}
            />

            {preferences.notifyOnResponse && (
              <div className="notif-meta-row">
                <span className="muted-xs">
                  {deviceSubscribed
                    ? `この端末はサーバーにPush登録済み（登録端末: ${Math.max(1, subCount)}台）`
                    : isNotificationSupported() && Notification.permission === 'granted' && isPushSupported()
                      ? 'この端末のWeb Push登録が未完了です（「この端末で許可」を押してください）'
                      : isNotificationSupported() && Notification.permission === 'granted'
                        ? 'この端末のブラウザ通知が有効です（Web Push非対応）'
                        : 'この端末での通知許可が未完了です'}
                </span>
                <div className="row-actions">
                  {needsDeviceActivation && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => void handleEnablePushOnThisDevice()}
                      disabled={notifBusy}
                    >
                      この端末で許可
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={() => void handleTestNotification()}
                    disabled={notifBusy}
                  >
                    テスト通知
                  </button>
                </div>
              </div>
            )}

            <div role="status">{notifStatusMsg && <div className="success-box">{notifStatusMsg}</div>}</div>
            {notifError && <div className="error-box" role="alert" style={{ marginTop: 8 }}>{notifError}</div>}
          </section>

          <details className="settings-section">
            <summary>バイブレーション / 触覚フィードバック</summary>
            <ToggleSwitch
              checked={preferences.hapticFeedback}
              label="操作・応答完了を振動で区別して知らせる"
              onChange={(next) => void handlePrefChange({ hapticFeedback: next })}
            />
            {hapticError && <div className="error-box" role="alert" style={{ marginTop: 8 }}>{hapticError}</div>}

            {preferences.hapticFeedback && isVibrationApiSupported() && (
              <div className="haptic-pattern-grid">
                {HAPTIC_META.map((item) => (
                  <div key={item.type} className="haptic-pattern-row">
                    <div>
                      <div className="haptic-pattern-title">
                        <span>{item.label}</span>
                        <span className="haptic-pattern-badge">{item.patternLabel}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => triggerHaptic(item.type, true)}
                    >
                      試す
                    </button>
                  </div>
                ))}
              </div>
            )}
          </details>

          {sandbox && (
            <details className="settings-section">
              <summary>実行環境サンドボックス</summary>
              <div className="settings-kv">
                <div>
                  <div className="kv-value">
                    <span className={`status-dot ${sandbox.active ? 'ok' : 'warn'}`} />
                    <span>
                      {sandbox.active
                        ? '有効 — 作業フォルダのみ可視'
                        : sandbox.backend === 'mock'
                          ? 'モックモード'
                          : sandbox.mode === 'off'
                            ? '無効'
                            : '未有効化'}
                    </span>
                  </div>
                </div>
              </div>
              {sandbox.reason && !sandbox.active && (
                <div className="notif-meta-row">
                  <div className="muted-xs">
                    <div>{sandbox.reason}</div>
                    {sandbox.remediation && (
                      <div style={{ marginTop: 4 }}>{sandbox.remediation}</div>
                    )}
                  </div>
                </div>
              )}
            </details>
          )}

          {user.role === 'admin' && (
            <>
              {onOpenMcp && (
                <section className="settings-section">
                  <h4>MCP サーバー</h4>
                  <p className="muted-xs" style={{ marginBottom: 10 }}>
                    チャットで利用する外部ツールやサーバーを接続・管理します。
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      onClose();
                      onOpenMcp();
                    }}
                  >
                    MCP 設定を開く
                  </button>
                </section>
              )}

              <details className="settings-section">
                <summary>ユーザー追加（管理者機能）</summary>
                <form onSubmit={handleAdminCreateUser} className="inline-admin-form">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    aria-label="新規ユーザー名"
                    placeholder="新規ユーザー名"
                    minLength={2}
                    required
                  />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    aria-label="新規ユーザーのパスワード"
                    placeholder="パスワード (6文字+)"
                    minLength={6}
                    required
                  />
                  <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>
                    追加
                  </button>
                </form>
                {adminMsg && <div className="success-box">{adminMsg}</div>}
              </details>
            </>
          )}

          <details className="settings-section">
            <summary>Web セッション ({user.username})</summary>
            <div className="row-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onLogout(false)}>
                ログアウト
              </button>
              <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => onLogout(true)}>
                全端末からログアウト
              </button>
            </div>
          </details>

          <details className="settings-section">
            <summary>バージョン情報</summary>
            <div className="settings-kv">
              <div>
                <div className="kv-value">
                  <span>
                    v
                    {appInfo?.version ||
                      (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0')}
                  </span>
                  {(appInfo?.shortSha ||
                    (typeof __APP_COMMIT_SHA__ !== 'undefined' && __APP_COMMIT_SHA__)) && (
                    <span className="muted-xs" style={{ marginLeft: 8 }}>
                      ({appInfo?.shortSha || __APP_COMMIT_SHA__})
                    </span>
                  )}
                </div>
                <div className="muted-xs" style={{ marginTop: 2 }}>
                  {appInfo?.buildId ? `Build ID: ${appInfo.buildId}` : '開発ビルド'}
                  {appInfo?.builtAt
                    ? ` • ${new Date(appInfo.builtAt).toLocaleString('ja-JP')}`
                    : ''}
                </div>
              </div>
            </div>
          </details>

          {error && <div className="error-box" role="alert">{error}</div>}
        </div>
      {showReauth && (
        <ModalDialog label="Antigravity に接続" size="modal-md" onClose={() => setShowReauth(false)}>
          <AgyOnboarding
            user={user}
            profile={agyProfile}
            loginFlow={loginFlow}
            agyMode={agyMode}
            isModal
            onClose={() => setShowReauth(false)}
            onUpdated={(payload) => onUpdateAgy(payload)}
          />
        </ModalDialog>
      )}
    </ModalDialog>
  );
};
