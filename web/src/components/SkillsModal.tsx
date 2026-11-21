import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  ProjectRecord,
  SkillDetail,
  SkillScope,
  SkillsListResponse,
  SkillSummary,
  SkillTemplate,
} from '../types';
import { invalidateSkillFileCache, makeSkillFileCacheKey, skillFileCache } from '../utils/viewerCache';
import { CloseIcon, FileIcon, PlusIcon, SparklesIcon, TrashIcon } from './Icons';
import { ModalDialog } from './ModalDialog';
import { ToggleSwitch } from './ToggleSwitch';

interface SkillsModalProps {
  activeChatId: string | null;
  activeProjectId: string | null;
  projects: ProjectRecord[];
  onClose: () => void;
  onSkillsChanged?: () => void;
  onInsertSlashCommand?: (slug: string) => void;
}

const SCOPE_LABELS: Record<SkillScope, string> = {
  global: 'グローバル',
  project: 'プロジェクト',
  workspace: 'このチャット',
};

const RESOURCE_FOLDERS = ['scripts', 'references', 'resources', 'assets'] as const;

function buildRawSkillMd(fields: {
  name: string;
  slug: string;
  description: string;
  instructions: string;
  disableModelInvocation: boolean;
}): string {
  const fmLines = [
    '---',
    `name: ${JSON.stringify(fields.name.trim() || fields.slug.trim() || 'skill-name')}`,
    `description: ${JSON.stringify(fields.description.trim())}`,
  ];
  if (fields.disableModelInvocation) {
    fmLines.push('disable-model-invocation: true');
  }
  fmLines.push('---', '', fields.instructions.trim(), '');
  return fmLines.join('\n');
}

function unquoteYamlScalar(rawVal: string): string {
  const trimmed = rawVal.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return String(JSON.parse(trimmed));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseRawSkillMd(raw: string): {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  instructions: string;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { instructions: normalized.trim() };
  }
  const fmText = match[1];
  const body = match[2].trim();
  let parsedName: string | undefined;
  let parsedDesc: string | undefined;
  let parsedDisable: boolean | undefined;

  for (const line of fmText.split('\n')) {
    const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2];
    if (key === 'name') {
      parsedName = unquoteYamlScalar(val);
    } else if (key === 'description') {
      parsedDesc = unquoteYamlScalar(val);
    } else if (key === 'disable-model-invocation') {
      parsedDisable = unquoteYamlScalar(val).toLowerCase() === 'true';
    }
  }

  return {
    name: parsedName,
    description: parsedDesc,
    disableModelInvocation: parsedDisable,
    instructions: body,
  };
}

export const SkillsModal: React.FC<SkillsModalProps> = ({
  activeChatId,
  activeProjectId,
  projects,
  onClose,
  onSkillsChanged,
  onInsertSlashCommand,
}) => {
  const [scope, setScope] = useState<SkillScope>('global');
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    activeProjectId || projects[0]?.id || ''
  );
  const [skillsData, setSkillsData] = useState<SkillsListResponse | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  // Mobile master/detail toggle
  const [mobileShowEditor, setMobileShowEditor] = useState(false);

  // Selected or draft state
  const [editorMode, setEditorMode] = useState<'new' | 'edit' | 'idle'>('idle');
  const [selectedDetail, setSelectedDetail] = useState<SkillDetail | null>(null);
  const [rawMode, setRawMode] = useState(false);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [disableModelInvocation, setDisableModelInvocation] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [rawSkillMd, setRawSkillMd] = useState('');

  // Resource management
  const [uploadFolder, setUploadFolder] = useState<(typeof RESOURCE_FOLDERS)[number]>('references');
  const [newFileRelPath, setNewFileRelPath] = useState('');
  const [newFileContent, setNewFileContent] = useState('');
  const [showNewFileBox, setShowNewFileBox] = useState(false);
  const [previewResource, setPreviewResource] = useState<{ relPath: string; content: string } | null>(null);
  const resourceInputRef = useRef<HTMLInputElement>(null);

  const effectiveProjectId =
    scope === 'project' ? (selectedProjectId || null) : activeProjectId;

  const refreshSkills = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await api.listSkills({
        projectId: effectiveProjectId || activeProjectId || null,
        chatId: activeChatId,
      });
      setSkillsData(res);
      return res;
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : 'スキル一覧の読込に失敗しました。');
      return null;
    } finally {
      setLoadingList(false);
    }
  }, [effectiveProjectId, activeProjectId, activeChatId]);

  useEffect(() => {
    void refreshSkills();
  }, [refreshSkills]);

  const currentList: SkillSummary[] = useMemo(() => {
    if (!skillsData) return [];
    if (scope === 'global') return skillsData.global;
    if (scope === 'project') return skillsData.project;
    return skillsData.workspace;
  }, [skillsData, scope]);

  const openNewDraft = (tpl?: SkillTemplate) => {
    setError(null);
    setStatusNote(null);
    setSelectedDetail(null);
    setPreviewResource(null);
    setShowNewFileBox(false);
    setEditorMode('new');
    setRawMode(false);
    setSlug(tpl?.slug ?? '');
    setName(tpl?.name ?? '');
    setDescription(tpl?.description ?? '');
    setInstructions(tpl?.instructions ?? '');
    setDisableModelInvocation(false);
    setEnabled(true);
    setRawSkillMd('');
    setMobileShowEditor(true);
  };

  const openSkillDetail = async (item: SkillSummary) => {
    setError(null);
    setStatusNote(null);
    setPreviewResource(null);
    setShowNewFileBox(false);
    setLoadingDetail(true);
    setEditorMode('edit');
    setMobileShowEditor(true);
    try {
      const res = await api.getSkill(item.scope, item.slug, {
        projectId: item.projectId ?? effectiveProjectId,
        chatId: item.chatId ?? activeChatId,
      });
      const d = res.skill;
      setSelectedDetail(d);
      setSlug(d.slug);
      setName(d.name);
      setDescription(d.description);
      setInstructions(d.instructions);
      setDisableModelInvocation(d.disableModelInvocation);
      setEnabled(d.enabled);
      setRawSkillMd(d.rawSkillMd);
      setRawMode(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'スキルの読込に失敗しました。');
    } finally {
      setLoadingDetail(false);
    }
  };

  const isBuiltinReadOnly = editorMode === 'edit' && selectedDetail?.origin === 'builtin';

  const handleSaveSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBuiltinReadOnly) return;
    setError(null);
    setStatusNote(null);

    if (scope === 'project' && !effectiveProjectId) {
      setError('保存先のプロジェクトを選択してください。');
      return;
    }
    if (scope === 'workspace' && !activeChatId) {
      setError('このチャット用スキルを保存するにはチャットを開いてください。');
      return;
    }

    setBusy(true);
    try {
      let saved: SkillDetail;
      if (editorMode === 'new') {
        const res = await api.createSkill({
          scope,
          projectId: scope === 'project' ? effectiveProjectId : null,
          chatId: scope === 'workspace' ? activeChatId : null,
          slug: slug.trim(),
          name: rawMode ? undefined : name.trim() || undefined,
          description: rawMode ? undefined : description.trim(),
          instructions: rawMode ? undefined : instructions,
          rawSkillMd: rawMode ? rawSkillMd : undefined,
          disableModelInvocation: rawMode ? undefined : disableModelInvocation,
          enabled,
        });
        saved = res.skill;
        setStatusNote(`スキル "/${saved.slug}" を作成しました。`);
      } else {
        const targetScope = selectedDetail?.scope ?? scope;
        const targetSlug = selectedDetail?.slug ?? slug.trim();
        const res = await api.saveSkill(targetScope, targetSlug, {
          projectId: targetScope === 'project' ? (selectedDetail?.projectId ?? effectiveProjectId) : null,
          chatId: targetScope === 'workspace' ? (selectedDetail?.chatId ?? activeChatId) : null,
          name: rawMode ? undefined : name.trim() || undefined,
          description: rawMode ? undefined : description.trim(),
          instructions: rawMode ? undefined : instructions,
          rawSkillMd: rawMode ? rawSkillMd : undefined,
          disableModelInvocation: rawMode ? undefined : disableModelInvocation,
          enabled,
        });
        saved = res.skill;
        setStatusNote(`スキル "/${saved.slug}" を保存しました。`);
      }

      invalidateSkillFileCache({
        scope: saved.scope,
        slug: saved.slug,
        projectId: saved.projectId ?? (saved.scope === 'project' ? effectiveProjectId : null),
        chatId: saved.chatId ?? (saved.scope === 'workspace' ? activeChatId : null),
      });
      setEditorMode('edit');
      setSelectedDetail(saved);
      setSlug(saved.slug);
      setName(saved.name);
      setDescription(saved.description);
      setInstructions(saved.instructions);
      setDisableModelInvocation(saved.disableModelInvocation);
      setEnabled(saved.enabled);
      setRawSkillMd(saved.rawSkillMd);
      await refreshSkills();
      onSkillsChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'スキルの保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleItem = async (item: SkillSummary, nextEnabled: boolean) => {
    setError(null);
    setStatusNote(null);
    try {
      const res = await api.toggleSkill(item.scope, item.slug, nextEnabled, {
        projectId: item.projectId ?? effectiveProjectId,
        chatId: item.chatId ?? activeChatId,
      });
      if (selectedDetail && selectedDetail.slug === item.slug && selectedDetail.scope === item.scope) {
        setSelectedDetail(res.skill);
        setEnabled(res.skill.enabled);
      }
      await refreshSkills();
      onSkillsChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '有効/無効の切替に失敗しました。');
    }
  };

  const handleDeleteSkill = async () => {
    if (!selectedDetail) return;
    if (!window.confirm(`スキル "/${selectedDetail.slug}" と同梱ファイルをすべて削除しますか？`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteSkill(selectedDetail.scope, selectedDetail.slug, {
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      invalidateSkillFileCache({
        scope: selectedDetail.scope,
        slug: selectedDetail.slug,
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      setStatusNote(`スキル "/${selectedDetail.slug}" を削除しました。`);
      setSelectedDetail(null);
      setEditorMode('idle');
      setMobileShowEditor(false);
      await refreshSkills();
      onSkillsChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleUploadResource = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!selectedDetail || fileList.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadSkillFiles(selectedDetail.scope, selectedDetail.slug, fileList, {
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
        folder: uploadFolder,
      });
      invalidateSkillFileCache({
        scope: selectedDetail.scope,
        slug: selectedDetail.slug,
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      setSelectedDetail(res.skill);
      setStatusNote(`${fileList.length}件のリソースを追加しました。`);
      await refreshSkills();
      onSkillsChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ファイル追加に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTextResource = async () => {
    if (!selectedDetail || !newFileRelPath.trim()) return;
    const targetRelPath = newFileRelPath.trim();
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveSkillTextFile(selectedDetail.scope, selectedDetail.slug, {
        relPath: targetRelPath,
        content: newFileContent,
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      const cacheKey = makeSkillFileCacheKey({
        scope: selectedDetail.scope,
        slug: selectedDetail.slug,
        relPath: targetRelPath,
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      invalidateSkillFileCache({
        scope: selectedDetail.scope,
        slug: selectedDetail.slug,
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
        relPath: targetRelPath,
      });
      skillFileCache.set(cacheKey, { relPath: targetRelPath, content: newFileContent });
      setSelectedDetail(res.skill);
      setPreviewResource({ relPath: targetRelPath, content: newFileContent });
      setNewFileRelPath('');
      setNewFileContent('');
      setShowNewFileBox(false);
      await refreshSkills();
      onSkillsChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ファイル保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleReadResource = async (relPath: string) => {
    if (!selectedDetail) return;
    setError(null);
    const cacheKey = makeSkillFileCacheKey({
      scope: selectedDetail.scope,
      slug: selectedDetail.slug,
      relPath,
      projectId: selectedDetail.projectId ?? effectiveProjectId,
      chatId: selectedDetail.chatId ?? activeChatId,
    });
    const cached = skillFileCache.get(cacheKey);
    if (cached) {
      setPreviewResource(cached);
      return;
    }
    try {
      const res = await api.readSkillFile(selectedDetail.scope, selectedDetail.slug, relPath, {
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      skillFileCache.set(cacheKey, res);
      setPreviewResource(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ファイルの読込に失敗しました。');
    }
  };

  const handleDeleteResource = async (relPath: string) => {
    if (!selectedDetail) return;
    if (!window.confirm(`リソース "${relPath}" を削除しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.deleteSkillFile(selectedDetail.scope, selectedDetail.slug, relPath, {
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
      });
      invalidateSkillFileCache({
        scope: selectedDetail.scope,
        slug: selectedDetail.slug,
        projectId: selectedDetail.projectId ?? effectiveProjectId,
        chatId: selectedDetail.chatId ?? activeChatId,
        relPath,
      });
      setSelectedDetail(res.skill);
      if (previewResource?.relPath === relPath) setPreviewResource(null);
      await refreshSkills();
      onSkillsChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ファイル削除に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const scopeHint =
    scope === 'global'
      ? 'すべてのチャットで利用可能'
      : scope === 'project'
        ? '選択中のプロジェクト内で利用可能'
        : 'このチャットのみで利用可能';

  const canUseCurrentScope =
    scope === 'global' ||
    (scope === 'project' && Boolean(effectiveProjectId)) ||
    (scope === 'workspace' && Boolean(activeChatId));

  return (
    <ModalDialog label="スキル管理" size="modal-xl" onClose={onClose}>
        <div className="modal-head">
          <div className="row-actions">
            <SparklesIcon size={17} />
            <h3>スキル管理</h3>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="閉じる">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="skills-scope-bar">
          <div className="segmented-tabs" role="tablist" aria-label="スキル適用範囲">
            {(['global', 'project', 'workspace'] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={scope === s}
                className={scope === s ? 'seg-btn active' : 'seg-btn'}
                onClick={() => {
                  setScope(s);
                  setEditorMode('idle');
                  setSelectedDetail(null);
                  setMobileShowEditor(false);
                  setError(null);
                  setStatusNote(null);
                }}
              >
                {SCOPE_LABELS[s]}
              </button>
            ))}
          </div>

          {scope === 'project' && (
            <div className="skills-project-picker">
              <label htmlFor="skills-project-select" className="muted-xs">対象プロジェクト:</label>
              {projects.length === 0 ? (
                <span className="muted-xs">プロジェクトがまだありません</span>
              ) : (
                <select
                  id="skills-project-select"
                  className="compact-select skills-project-select"
                  value={selectedProjectId}
                  onChange={(e) => {
                    setSelectedProjectId(e.target.value);
                    setEditorMode('idle');
                    setSelectedDetail(null);
                    setMobileShowEditor(false);
                  }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="muted-xs">{scopeHint}</div>
        </div>

        <div className={`skills-workspace ${mobileShowEditor ? 'show-editor' : 'show-list'}`}>
          {/* Left pane: Skill list & templates */}
          <div className="skills-list-pane">
            <div className="skills-list-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm btn-block"
                disabled={!canUseCurrentScope}
                onClick={() => openNewDraft()}
              >
                <PlusIcon size={14} /> 新規スキルを作成
              </button>
            </div>

            {!canUseCurrentScope ? (
              <div className="empty-box muted-sm" style={{ margin: 12 }}>
                {scope === 'project'
                  ? '先にサイドバーからプロジェクトを作成してください。'
                  : 'このチャット用のスキルを作成するには、まずチャットを開くかメッセージを送信してください。'}
              </div>
            ) : loadingList ? (
              <div className="muted-sm" style={{ padding: 14 }}>読込中...</div>
            ) : (
              <div className="skills-list-scroll">
                {listError && (
                  <div className="error-box" role="alert" style={{ marginBottom: 12 }}>
                    <div>{listError}</div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      style={{ marginTop: 8 }}
                      onClick={() => void refreshSkills()}
                    >
                      再読み込み
                    </button>
                  </div>
                )}
                {!listError && currentList.length === 0 ? (
                  <div className="empty-box muted-xs" style={{ marginBottom: 12 }}>
                    このスコープにスキルはまだありません
                  </div>
                ) : currentList.length > 0 ? (
                  <div className="skills-items">
                    {currentList.map((item) => {
                      const isSelected =
                        editorMode === 'edit' &&
                        selectedDetail?.slug === item.slug &&
                        selectedDetail?.scope === item.scope;
                      const skillLabel = item.name || item.slug;
                      return (
                        <div
                          key={`${item.scope}:${item.slug}`}
                          className={`skill-list-card ${isSelected ? 'active' : ''} ${!item.enabled ? 'is-disabled' : ''}`}
                        >
                          <div className="skill-list-card-top">
                            <button
                              type="button"
                              className="skill-list-card-btn"
                              aria-current={isSelected ? 'true' : undefined}
                              onClick={() => void openSkillDetail(item)}
                            >
                              <div className="skill-list-card-title">
                                <span className="skill-slug-pill">/{item.slug}</span>
                                <span className={`skill-tag ${item.origin === 'builtin' ? 'builtin' : 'custom'}`}>
                                  {item.origin === 'builtin' ? 'Built-in' : 'Custom'}
                                </span>
                                {item.hasBuiltinConflict && (
                                  <span className="skill-tag conflict">Built-in と同名</span>
                                )}
                                {item.storageKind === 'legacy' && (
                                  <span className="skill-tag legacy">legacy</span>
                                )}
                                {item.disableModelInvocation && (
                                  <span className="skill-tag">手動のみ</span>
                                )}
                              </div>
                              {item.name && item.name !== item.slug && (
                                <div className="skill-list-name truncate">{item.name}</div>
                              )}
                              <div className="skill-list-desc">{item.description || '（説明なし）'}</div>
                              {item.resourceCount > 0 && (
                                <div className="muted-xs">同梱ファイル {item.resourceCount}件</div>
                              )}
                            </button>
                            <div className="skill-list-card-toggle">
                              <ToggleSwitch
                                checked={item.enabled}
                                label=""
                                ariaLabel={`スキル「${skillLabel}」を有効にする`}
                                onChange={(next) => void handleToggleItem(item, next)}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {skillsData && skillsData.templates.length > 0 && (
                  <div className="skills-templates-box">
                    <div className="muted-xs" style={{ fontWeight: 600, marginBottom: 6 }}>
                      テンプレートから追加
                    </div>
                    <div className="skills-template-grid">
                      {skillsData.templates.map((tpl) => (
                        <button
                          key={tpl.slug}
                          type="button"
                          className="chip-btn"
                          onClick={() => openNewDraft(tpl)}
                          title={tpl.description}
                        >
                          <PlusIcon size={12} />
                          <span>{tpl.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right pane: Editor */}
          <div className="skills-editor-pane">
            {mobileShowEditor && (
              <div className="skills-mobile-back">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => setMobileShowEditor(false)}
                >
                  ← スキル一覧に戻る
                </button>
              </div>
            )}

            {error && <div className="error-box" role="alert" style={{ marginBottom: 10 }}>{error}</div>}
            {statusNote && <div className="success-box" role="status" style={{ marginBottom: 10 }}>{statusNote}</div>}

            {editorMode === 'idle' ? (
              <div className="skills-editor-empty">
                <SparklesIcon size={28} />
                <div style={{ fontWeight: 600, marginTop: 6 }}>スキルを選択または新規作成</div>
                <p className="muted-sm" style={{ maxWidth: 420 }}>
                  有効なスキルはチャット欄で <code>/</code> から呼び出せます。
                </p>
              </div>
            ) : loadingDetail ? (
              <div className="muted-sm" style={{ padding: 20 }}>スキル詳細を読込中...</div>
            ) : (
              <form onSubmit={handleSaveSkill} className="stack-gap">
                <div className="row-between">
                  <div className="row-actions">
                    <strong>
                      {editorMode === 'new'
                        ? '新規スキル作成'
                        : isBuiltinReadOnly
                          ? `Built-in: /${slug}`
                          : `編集: /${slug}`}
                    </strong>
                    {editorMode === 'edit' && selectedDetail && (
                      <span className={`skill-tag ${selectedDetail.origin === 'builtin' ? 'builtin' : 'custom'}`}>
                        {selectedDetail.origin === 'builtin' ? 'Built-in' : 'Custom'}
                      </span>
                    )}
                    {editorMode === 'edit' && selectedDetail?.hasBuiltinConflict && (
                      <span className="skill-tag conflict">Built-in と同名</span>
                    )}
                    {editorMode === 'edit' && enabled && onInsertSlashCommand && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={() => {
                          onInsertSlashCommand(slug);
                          onClose();
                        }}
                      >
                        チャットに入力 (/{slug})
                      </button>
                    )}
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className={`chip-btn ${rawMode ? 'active' : ''}`}
                      onClick={() => {
                        if (isBuiltinReadOnly) {
                          setRawMode((v) => !v);
                          return;
                        }
                        if (!rawMode) {
                          setRawSkillMd(
                            buildRawSkillMd({
                              name,
                              slug,
                              description,
                              instructions,
                              disableModelInvocation,
                            })
                          );
                          setRawMode(true);
                        } else {
                          const parsed = parseRawSkillMd(rawSkillMd);
                          if (parsed.name !== undefined) setName(parsed.name);
                          if (parsed.description !== undefined) setDescription(parsed.description);
                          if (parsed.disableModelInvocation !== undefined) {
                            setDisableModelInvocation(parsed.disableModelInvocation);
                          }
                          setInstructions(parsed.instructions);
                          setRawMode(false);
                        }
                      }}
                    >
                      {isBuiltinReadOnly
                        ? (rawMode ? '詳細表示' : 'SKILL.md 原文')
                        : (rawMode ? 'フォーム編集へ' : '直接編集')}
                    </button>
                  </div>
                </div>

                {isBuiltinReadOnly && (
                  <div className="skill-readonly-notice" role="note">
                    このスキルは Built-in（読み取り専用）です。内容・同梱ファイルの編集や削除はできませんが、有効 / 無効の切り替えと内容の閲覧は行えます。
                  </div>
                )}

                {editorMode === 'edit' && selectedDetail?.hasBuiltinConflict && (
                  <div className="skill-conflict-notice" role="note">
                    同名の Built-in スキルが存在しますが、この Custom スキルが優先されています。この Custom スキルを削除すると Built-in スキルが再び利用できるようになります。
                  </div>
                )}

                {editorMode === 'new' && (
                  <label className="field">
                    <span>コマンド名（半角英小文字・数字・ハイフン）</span>
                    <input
                      type="text"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      placeholder="例: code-review / daily-report"
                      required
                    />
                  </label>
                )}

                {rawMode ? (
                  <label className="field">
                    <span>スキル定義</span>
                    <textarea
                      rows={13}
                      className="mono-textarea"
                      value={rawSkillMd}
                      readOnly={isBuiltinReadOnly}
                      onChange={isBuiltinReadOnly ? undefined : (e) => setRawSkillMd(e.target.value)}
                      placeholder={`---\nname: code-review\ndescription: いつ・何に使うかを記述（必須）\n---\n\n# 指示内容\nここに詳細な手順を書きます。`}
                      required={!isBuiltinReadOnly}
                    />
                  </label>
                ) : (
                  <>
                    <label className="field">
                      <span>表示名（任意）</span>
                      <input
                        type="text"
                        value={name}
                        readOnly={isBuiltinReadOnly}
                        onChange={isBuiltinReadOnly ? undefined : (e) => setName(e.target.value)}
                        placeholder="例: コードレビュー"
                      />
                    </label>

                    <label className="field">
                      <span>説明（必須）</span>
                      <input
                        type="text"
                        value={description}
                        readOnly={isBuiltinReadOnly}
                        onChange={isBuiltinReadOnly ? undefined : (e) => setDescription(e.target.value)}
                        placeholder="例: コードやPRをレビューするときに使う"
                        required={!isBuiltinReadOnly}
                      />
                    </label>

                    <label className="field">
                      <span>指示内容</span>
                      <textarea
                        rows={8}
                        value={instructions}
                        readOnly={isBuiltinReadOnly}
                        onChange={isBuiltinReadOnly ? undefined : (e) => setInstructions(e.target.value)}
                        placeholder="従わせたいルール・手順・出力形式などを記述してください。"
                      />
                    </label>

                    <ToggleSwitch
                      checked={disableModelInvocation}
                      disabled={isBuiltinReadOnly || busy}
                      label="/コマンド指定時のみ実行（自動呼び出ししない）"
                      onChange={(next) => {
                        if (!isBuiltinReadOnly) setDisableModelInvocation(next);
                      }}
                    />
                  </>
                )}

                <ToggleSwitch
                  checked={enabled}
                  disabled={busy}
                  label="このスキルを有効にする"
                  onChange={(next) => {
                    if (isBuiltinReadOnly && selectedDetail) {
                      void handleToggleItem(selectedDetail, next);
                    } else {
                      setEnabled(next);
                    }
                  }}
                />

                {!isBuiltinReadOnly && (
                  <div className="row-between">
                    <div>
                      {editorMode === 'edit' && (
                        <button
                          type="button"
                          className="btn btn-danger-outline btn-sm"
                          disabled={busy}
                          onClick={() => void handleDeleteSkill()}
                        >
                          <TrashIcon size={14} /> 削除
                        </button>
                      )}
                    </div>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                      {busy ? '保存中...' : editorMode === 'new' ? 'スキルを作成' : '変更を保存'}
                    </button>
                  </div>
                )}

                {editorMode === 'edit' && selectedDetail && (
                  <section className="settings-section" style={{ marginTop: 4 }}>
                    <div className="row-between" style={{ marginBottom: 8 }}>
                      <div>
                        <h4>添付ファイル・資料</h4>
                      </div>
                      {!isBuiltinReadOnly && (
                        <div className="row-actions">
                          <select
                            className="compact-select"
                            value={uploadFolder}
                            onChange={(e) => setUploadFolder(e.target.value as (typeof RESOURCE_FOLDERS)[number])}
                          >
                            {RESOURCE_FOLDERS.map((f) => (
                              <option key={f} value={f}>{f}/</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            disabled={busy}
                            onClick={() => resourceInputRef.current?.click()}
                          >
                            <PlusIcon size={13} /> ファイル添付
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() => {
                              setShowNewFileBox((v) => !v);
                              if (!newFileRelPath) setNewFileRelPath(`${uploadFolder}/note.md`);
                            }}
                          >
                            新規テキスト
                          </button>
                          <input
                            ref={resourceInputRef}
                            type="file"
                            multiple
                            hidden
                            onChange={handleUploadResource}
                          />
                        </div>
                      )}
                    </div>

                    {!isBuiltinReadOnly && showNewFileBox && (
                      <div className="skill-new-file-box">
                        <input
                          type="text"
                          value={newFileRelPath}
                          onChange={(e) => setNewFileRelPath(e.target.value)}
                          placeholder="例: scripts/lint.sh または references/style.md"
                        />
                        <textarea
                          rows={4}
                          className="mono-textarea"
                          value={newFileContent}
                          onChange={(e) => setNewFileContent(e.target.value)}
                          placeholder="ファイル内容を入力..."
                        />
                        <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => setShowNewFileBox(false)}
                          >
                            キャンセル
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-xs"
                            disabled={busy || !newFileRelPath.trim()}
                            onClick={() => void handleCreateTextResource()}
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    )}

                    {selectedDetail.resources.length === 0 ? (
                      <div className="empty-box muted-xs">同梱ファイルはありません</div>
                    ) : (
                      <div className="project-files-list">
                        {selectedDetail.resources.map((rf) => (
                          <div key={rf.relPath} className="project-file-row">
                            <button
                              type="button"
                              className="skill-resource-link"
                              onClick={() => void handleReadResource(rf.relPath)}
                            >
                              <FileIcon size={14} />
                              <span>{rf.relPath}</span>
                              <span className="muted-xs">({rf.sizeBytes} B)</span>
                            </button>
                            {!isBuiltinReadOnly && (
                              <button
                                type="button"
                                className="icon-btn-sm danger"
                                title="削除"
                                onClick={() => void handleDeleteResource(rf.relPath)}
                              >
                                <TrashIcon size={13} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {previewResource && (
                      <div className="skill-resource-preview">
                        <div className="row-between" style={{ marginBottom: 6 }}>
                          <strong className="muted-xs">{previewResource.relPath}</strong>
                          <button
                            type="button"
                            className="icon-btn-sm"
                            onClick={() => setPreviewResource(null)}
                            aria-label="閉じる"
                          >
                            <CloseIcon size={13} />
                          </button>
                        </div>
                        <pre className="cli-log-box">{previewResource.content}</pre>
                      </div>
                    )}
                  </section>
                )}
              </form>
            )}
          </div>
        </div>
    </ModalDialog>
  );
};
