import React from 'react';
import type { HookConfigStatus, HookSettingsSnapshot } from '@desktop-agent/contracts';

export function hookStatusErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("No handler registered for 'hooks:")) {
    return '应用主进程仍是旧版本。请完整退出并重新启动 Desktop Agent。';
  }
  return message;
}

function userStateLabel(state: HookConfigStatus['state']): string {
  if (state === 'loaded') return '已加载';
  if (state === 'invalid') return '错误';
  return '未配置';
}

function projectStateLabel(state: HookConfigStatus['state']): string {
  if (state === 'loaded') return '已信任';
  if (state === 'untrusted') return '未信任';
  if (state === 'disabled') return '已禁用';
  if (state === 'invalid') return '错误';
  return '未配置';
}

function statusClass(state: HookConfigStatus['state']): string {
  if (state === 'loaded') return 'on';
  if (state === 'untrusted') return 'ask';
  if (state === 'disabled') return 'off';
  if (state === 'invalid') return 'failed';
  return '';
}

function HookSourceCard({
  title,
  kind,
  description,
  status,
  busy,
  fallbackPath,
  onOpen
}: {
  title: string;
  kind: 'user' | 'project';
  description: string;
  status?: HookConfigStatus | undefined;
  busy: boolean;
  fallbackPath: string;
  onOpen: () => void;
}) {
  const state = status?.state ?? 'missing';
  const label = kind === 'project' ? projectStateLabel(state) : userStateLabel(state);
  return <section className="settings-section-card">
    <div className="settings-section-title with-meta">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <span className={`browser-status-pill hook-status-pill ${statusClass(state)}`}>{label}</span>
    </div>
    <div className="hook-source-body">
      <code className="hook-config-path">{status?.path ?? fallbackPath}</code>
      {status?.error && <div className="settings-error" role="alert">{status.error}</div>}
      <div className="hook-source-actions">
        <button type="button" disabled={busy} onClick={onOpen}>打开配置</button>
      </div>
    </div>
  </section>;
}

export function HooksSettingsPage({
  workingDirectory,
  snapshot,
  error,
  busy,
  onReload,
  onOpenConfig,
  onTrust,
  onDisable
}: {
  workingDirectory?: string | undefined;
  snapshot: HookSettingsSnapshot | null;
  error: string;
  busy: boolean;
  onReload: () => void;
  onOpenConfig: (source: 'user' | 'project') => void;
  onTrust: () => void;
  onDisable: () => void;
}) {
  const project = snapshot?.project;
  const canTrust = Boolean(workingDirectory && project?.fingerprint && (project.state === 'untrusted' || project.state === 'disabled'));
  const canDisable = Boolean(workingDirectory && project && project.state !== 'missing' && project.state !== 'disabled');
  return <div className="settings-content model-settings-page hooks-settings-page" aria-labelledby="hooks-settings-title">
    <div className="settings-heading">
      <div>
        <h1 id="hooks-settings-title">Hooks</h1>
        <p>用户 Hooks 始终生效。项目 Hooks 需先信任当前配置；禁用后不会在每轮再询问。</p>
      </div>
      <button type="button" disabled={busy} onClick={onReload}>{busy ? '刷新中…' : '重新加载'}</button>
    </div>
    <HookSourceCard
      title="用户 Hooks"
      kind="user"
      description="保存在本机用户目录，可拦截或改写智能体行为。"
      status={snapshot?.user}
      busy={busy}
      fallbackPath="~/.jojo/hooks.yml"
      onOpen={() => onOpenConfig('user')}
    />
    {workingDirectory
      ? <HookSourceCard
          title="项目 Hooks"
          kind="project"
          description="仅在当前工作区生效。修改配置后需重新信任。"
          status={project}
          busy={busy}
          fallbackPath={`${workingDirectory}/.jojo/hooks.yml`}
          onOpen={() => onOpenConfig('project')}
        />
      : <section className="settings-section-card">
          <div className="settings-section-title">
            <h2>项目 Hooks</h2>
            <p>打开一个会话后，可在此查看并信任当前工作区的项目 Hooks。</p>
          </div>
        </section>}
    {workingDirectory && <section className="settings-section-card">
      <div className="settings-section-title">
        <h2>项目信任</h2>
        <p>信任只对当前文件指纹有效。禁用会跳过项目 Hooks，直到再次信任。</p>
      </div>
      <div className="hook-source-body">
        <div className="hook-source-actions">
          <button type="button" disabled={busy || !canTrust} onClick={onTrust}>信任项目 Hooks</button>
          <button type="button" disabled={busy || !canDisable} onClick={onDisable}>禁用项目 Hooks</button>
        </div>
      </div>
    </section>}
    {error && <div className="settings-error" role="alert">{error}</div>}
  </div>;
}
