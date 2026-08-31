import React, { useEffect, useMemo, useState } from 'react';
import type {
  ChannelSettingsSnapshot,
  DesktopApi,
  DesktopChannelMutation
} from '@desktop-agent/contracts';

type InstanceDraft = Extract<DesktopChannelMutation, { action: 'instance.save' }>['instance'];
type BindingDraft = Extract<DesktopChannelMutation, { action: 'binding.save' }>['binding'];
type ChannelTab = 'instances' | 'bindings' | 'pairings' | 'activity' | 'security';

export function createChannelInstanceDraft(kind: InstanceDraft['kind'] = 'telegram'): InstanceDraft {
  const suffix = crypto.randomUUID().slice(0, 8);
  return kind === 'telegram'
    ? {
        id: `telegram-${suffix}`,
        kind,
        name: 'Telegram',
        enabled: false,
        config: { pollingTimeoutSeconds: 30 },
        secretRefs: { botToken: 'secret://env/JOJO_TELEGRAM_BOT_TOKEN' }
      }
    : {
        id: `feishu-${suffix}`,
        kind,
        name: 'Feishu',
        enabled: false,
        config: { appId: '' },
        secretRefs: {
          appSecret: 'secret://env/JOJO_FEISHU_APP_SECRET',
          verificationToken: 'secret://env/JOJO_FEISHU_VERIFICATION_TOKEN'
        }
      };
}

export function channelInstanceDraft(
  instance: ChannelSettingsSnapshot['instances'][number]
): InstanceDraft {
  if (instance.kind !== 'telegram' && instance.kind !== 'feishu') {
    throw new Error(`Unsupported desktop channel kind: ${instance.kind}`);
  }
  return {
    id: instance.id,
    kind: instance.kind === 'telegram' ? 'telegram' : 'feishu',
    name: instance.name,
    enabled: instance.enabled,
    config: instance.config as InstanceDraft['config'],
    secretRefs: instance.secretRefs
  };
}

export function createChannelBindingDraft(instanceId: string): BindingDraft {
  return {
    id: `binding-${crypto.randomUUID().slice(0, 8)}`,
    instanceId,
    conversation: { id: '', type: 'direct' },
    routing: { sessionMode: 'persistent' },
    policy: {
      enabled: true,
      requireMention: false,
      queueMode: 'queue',
      allowAttachments: false
    }
  };
}

export function channelBindingDraft(
  binding: ChannelSettingsSnapshot['bindings'][number]
): BindingDraft {
  return {
    id: binding.id,
    instanceId: binding.instanceId,
    conversation: { ...binding.conversation },
    routing: { ...binding.routing },
    policy: { ...binding.policy }
  };
}

function healthLabel(status: string): string {
  return ({ connected: '已连接', starting: '启动中', degraded: '降级', stopped: '已停止', failed: '失败' } as Record<string, string>)[status] ?? status;
}

function timestamp(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ChannelsSettingsPage({ api }: { api: DesktopApi }) {
  const [snapshot, setSnapshot] = useState<ChannelSettingsSnapshot | null>(null);
  const [tab, setTab] = useState<ChannelTab>('instances');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [instanceEditor, setInstanceEditor] = useState<InstanceDraft | null>(null);
  const [bindingEditor, setBindingEditor] = useState<BindingDraft | null>(null);
  const [testText, setTestText] = useState('Jojo Channel 连接测试');

  const refresh = async () => {
    setBusy(true);
    setError('');
    try { setSnapshot(await api.getChannelSettings()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  useEffect(() => { void refresh(); }, []);

  const mutate = async (input: DesktopChannelMutation): Promise<boolean> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.mutateChannel(input);
      if ('instances' in result) setSnapshot(result);
      else setNotice(`测试消息已进入投递队列：${result.status}`);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally { setBusy(false); }
  };

  const healthByInstance = useMemo(() => new Map(
    (snapshot?.health ?? []).map((item) => [item.instanceId, item.health])
  ), [snapshot]);

  const saveInstance = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!instanceEditor) return;
    const current = snapshot?.instances.find((item) => item.id === instanceEditor.id);
    const saved = await mutate({
      action: 'instance.save',
      instance: instanceEditor,
      ...(current ? { expectedRevision: current.revision } : {})
    });
    if (saved) setInstanceEditor(null);
  };

  const saveBinding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!bindingEditor) return;
    const current = snapshot?.bindings.find((item) => item.id === bindingEditor.id);
    const saved = await mutate({
      action: 'binding.save',
      binding: bindingEditor,
      ...(current ? { expectedRevision: current.revision } : {})
    });
    if (saved) setBindingEditor(null);
  };

  return <div className="settings-content channels-settings-page">
    <div className="settings-heading channel-heading">
      <div><h1>Channels</h1><p>连接 Telegram 与飞书，把外部会话安全地路由到 Jojo，并查看投递状态。</p></div>
      <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '刷新中…' : '刷新'}</button>
    </div>

    <nav className="channel-tabs" aria-label="Channel 设置分类">
      {([
        ['instances', '实例'], ['bindings', '绑定'], ['pairings', '配对'], ['activity', '投递与健康'], ['security', '安全']
      ] as Array<[ChannelTab, string]>).map(([id, label]) =>
        <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
      )}
    </nav>

    {error && <div className="settings-error channel-message" role="alert">{error}</div>}
    {notice && <div className="channel-notice channel-message" role="status">{notice}</div>}

    {tab === 'instances' && <section className="channel-panel">
      <header><div><h2>Channel 实例</h2><p>一个实例对应一个平台机器人身份。</p></div><button className="primary" type="button" onClick={() => setInstanceEditor(createChannelInstanceDraft())}>添加实例</button></header>
      {!snapshot?.instances.length && <div className="channel-empty">尚未配置 Channel 实例。</div>}
      <div className="channel-card-list">
        {snapshot?.instances.map((instance) => {
          const health = healthByInstance.get(instance.id);
          return <article className="channel-card" key={instance.id}>
            <div className={`channel-kind-icon ${instance.kind}`}>{instance.kind === 'telegram' ? 'T' : '飞'}</div>
            <div className="channel-card-copy">
              <strong>{instance.name}</strong><span>{instance.kind} · {instance.id}</span>
              {health?.lastError && <small className="channel-error-detail">{health.lastError}</small>}
            </div>
            <span className={`channel-status ${health?.status ?? 'stopped'}`}>{healthLabel(health?.status ?? 'stopped')}</span>
            <div className="channel-card-actions">
              <button type="button" disabled={busy} onClick={() => void mutate({
                action: 'instance.save', instance: { ...channelInstanceDraft(instance), enabled: !instance.enabled }, expectedRevision: instance.revision
              })}>{instance.enabled ? '停用' : '启用'}</button>
              <button type="button" onClick={() => setInstanceEditor(channelInstanceDraft(instance))}>编辑</button>
              <button className="danger" type="button" disabled={busy} onClick={() => {
                if (!window.confirm(`删除 Channel 实例 ${instance.name}？`)) return;
                void mutate({ action: 'instance.delete', instanceId: instance.id, expectedRevision: instance.revision });
              }}>删除</button>
            </div>
          </article>;
        })}
      </div>
    </section>}

    {tab === 'bindings' && <section className="channel-panel">
      <header><div><h2>会话绑定</h2><p>定义外部会话如何复用 Session、工作区与模型。</p></div><button className="primary" type="button" disabled={!snapshot?.instances.length} onClick={() => setBindingEditor(createChannelBindingDraft(snapshot!.instances[0]!.id))}>添加绑定</button></header>
      {!snapshot?.bindings.length && <div className="channel-empty">尚未建立会话绑定。陌生私聊也可先发消息生成配对请求。</div>}
      <div className="channel-card-list">
        {snapshot?.bindings.map((binding) => <article className="channel-card channel-binding-card" key={binding.id}>
          <div className="channel-kind-icon binding">↔</div>
          <div className="channel-card-copy">
            <strong>{binding.conversation.type === 'direct' ? '私聊' : '群聊'} · {binding.conversation.id}</strong>
            <span>{binding.instanceId} → {binding.routing.sessionId ? `Session ${binding.routing.sessionId}` : binding.routing.sessionMode}</span>
            <small>{binding.policy.requireMention ? '需要 @Jojo' : '无需提及'} · {binding.policy.allowAttachments ? '允许附件' : '禁用附件'} · {binding.policy.queueMode}</small>
          </div>
          <span className={`channel-status ${binding.policy.enabled ? 'connected' : 'stopped'}`}>{binding.policy.enabled ? '已启用' : '已停用'}</span>
          <div className="channel-card-actions">
            <button type="button" disabled={busy} onClick={() => void mutate({ action: 'channel.test', instanceId: binding.instanceId, bindingId: binding.id, text: testText })}>测试</button>
            <button type="button" onClick={() => setBindingEditor(channelBindingDraft(binding))}>编辑</button>
            <button className="danger" type="button" disabled={busy} onClick={() => {
              if (!window.confirm(`删除绑定 ${binding.id}？`)) return;
              void mutate({ action: 'binding.delete', bindingId: binding.id, expectedRevision: binding.revision });
            }}>删除</button>
          </div>
        </article>)}
      </div>
      {!!snapshot?.bindings.length && <label className="channel-test-input">测试消息<input value={testText} onChange={(event) => setTestText(event.target.value)} /></label>}
    </section>}

    {tab === 'pairings' && <section className="channel-panel">
      <header><div><h2>配对请求</h2><p>陌生私聊默认不能执行 Agent；批准后才会创建绑定与发送者白名单。</p></div></header>
      {!snapshot?.pairings.filter((item) => item.status === 'pending').length && <div className="channel-empty">没有待处理的配对请求。</div>}
      <div className="channel-card-list">
        {snapshot?.pairings.map((pairing) => <article className="channel-card" key={pairing.id}>
          <div className="channel-kind-icon pairing">⌁</div>
          <div className="channel-card-copy"><strong>{pairing.senderId}</strong><span>{pairing.instanceId} · {pairing.conversationId}</span><small>到期：{timestamp(pairing.expiresAt)}</small></div>
          <span className={`channel-status ${pairing.status === 'approved' ? 'connected' : pairing.status === 'pending' ? 'starting' : 'stopped'}`}>{pairing.status}</span>
          {pairing.status === 'pending' && <div className="channel-card-actions">
            <button className="primary" type="button" disabled={busy} onClick={() => void mutate({
              action: 'pairing.approve', pairingId: pairing.id,
              binding: {
                ...createChannelBindingDraft(pairing.instanceId),
                id: `binding-${pairing.id}`,
                conversation: { id: pairing.conversationId, type: 'direct' }
              }
            })}>批准</button>
            <button className="danger" type="button" disabled={busy} onClick={() => void mutate({ action: 'pairing.reject', pairingId: pairing.id })}>拒绝</button>
          </div>}
        </article>)}
      </div>
    </section>}

    {tab === 'activity' && <section className="channel-panel channel-activity">
      <header><div><h2>健康状态</h2><p>Adapter 连接状态与最近的收发时间。</p></div></header>
      <div className="channel-health-grid">
        {snapshot?.health.map(({ instanceId, health }) => <article key={instanceId}>
          <div><strong>{snapshot.instances.find((item) => item.id === instanceId)?.name ?? instanceId}</strong><span className={`channel-status ${health.status}`}>{healthLabel(health.status)}</span></div>
          <dl><dt>最近接收</dt><dd>{timestamp(health.lastInboundAt)}</dd><dt>最近发送</dt><dd>{timestamp(health.lastOutboundAt)}</dd><dt>重连次数</dt><dd>{health.reconnectCount}</dd></dl>
          {health.lastError && <small className="channel-error-detail">{health.lastError}</small>}
        </article>)}
      </div>
      <header className="channel-subheader"><div><h2>最近投递</h2><p>仅展示投递元数据，不暴露消息正文。</p></div></header>
      <div className="channel-delivery-table">
        <div className="channel-delivery-head"><span>状态</span><span>目标</span><span>尝试</span><span>时间</span></div>
        {snapshot?.deliveries.map((delivery) => <div key={delivery.id}>
          <span><i className={`channel-delivery-dot ${delivery.status}`} />{delivery.status}</span>
          <span>{delivery.instanceId} / {delivery.conversationId}</span><span>{delivery.attemptCount}</span><time>{timestamp(delivery.deliveredAt ?? delivery.createdAt)}</time>
          {delivery.lastError && <small>{delivery.lastError}</small>}
        </div>)}
        {!snapshot?.deliveries.length && <div className="channel-empty">暂无投递记录。</div>}
      </div>
    </section>}

    {tab === 'security' && <section className="channel-panel channel-security">
      <header><div><h2>安全边界</h2><p>Channel 默认采用拒绝陌生用户、最小授权和密钥隔离。</p></div></header>
      <div className="channel-security-grid">
        <article><strong>只保存密钥引用</strong><p>实例仅接受 <code>secret://env/VARIABLE_NAME</code>，明文 Token 不会写入 SQLite、普通配置、日志或模型上下文。</p></article>
        <article><strong>陌生私聊必须配对</strong><p>未绑定的私聊只生成短期 Pairing 请求；Owner 批准后才创建允许发送者的 Binding。</p></article>
        <article><strong>群聊显式绑定</strong><p>群聊不会自动配对。建议开启“需要提及”，并限制允许发送者与附件。</p></article>
        <article><strong>持久化去重与 Outbox</strong><p>入站消息按平台消息 ID 去重，出站消息通过 durable outbox 重试并记录状态。</p></article>
      </div>
    </section>}

    {instanceEditor && <div className="channel-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInstanceEditor(null); }}>
      <form className="channel-editor" onSubmit={(event) => void saveInstance(event)}>
        <header><div><h2>{snapshot?.instances.some((item) => item.id === instanceEditor.id) ? '编辑实例' : '添加实例'}</h2><p>密钥字段必须填写环境变量引用。</p></div><button type="button" onClick={() => setInstanceEditor(null)}>×</button></header>
        <div className="channel-editor-fields">
          <label>平台<select value={instanceEditor.kind} onChange={(event) => {
            const next = createChannelInstanceDraft(event.target.value as InstanceDraft['kind']);
            setInstanceEditor({ ...next, id: instanceEditor.id, name: instanceEditor.name, enabled: instanceEditor.enabled });
          }}><option value="telegram">Telegram</option><option value="feishu">飞书</option></select></label>
          <label>实例 ID<input required value={instanceEditor.id} disabled={Boolean(snapshot?.instances.some((item) => item.id === instanceEditor.id))} onChange={(event) => setInstanceEditor({ ...instanceEditor, id: event.target.value })} /></label>
          <label>显示名称<input required value={instanceEditor.name} onChange={(event) => setInstanceEditor({ ...instanceEditor, name: event.target.value })} /></label>
          {instanceEditor.kind === 'telegram' ? <>
            <label>Bot Token 引用<input type="password" autoComplete="off" spellCheck={false} required pattern="secret://env/[A-Z_][A-Z0-9_]*" value={instanceEditor.secretRefs.botToken ?? ''} onChange={(event) => setInstanceEditor({ ...instanceEditor, secretRefs: { botToken: event.target.value } })} /></label>
            <label>Polling 超时（秒）<input type="number" min="1" max="50" value={String(instanceEditor.config.pollingTimeoutSeconds ?? 30)} onChange={(event) => setInstanceEditor({ ...instanceEditor, config: { ...instanceEditor.config, pollingTimeoutSeconds: Number(event.target.value) } })} /></label>
          </> : <>
            <label>App ID<input required value={String(instanceEditor.config.appId ?? '')} onChange={(event) => setInstanceEditor({ ...instanceEditor, config: { ...instanceEditor.config, appId: event.target.value } })} /></label>
            <label>App Secret 引用<input type="password" autoComplete="off" spellCheck={false} required pattern="secret://env/[A-Z_][A-Z0-9_]*" value={instanceEditor.secretRefs.appSecret ?? ''} onChange={(event) => setInstanceEditor({ ...instanceEditor, secretRefs: { ...instanceEditor.secretRefs, appSecret: event.target.value } })} /></label>
            <label>Verification Token 引用<input type="password" autoComplete="off" spellCheck={false} required pattern="secret://env/[A-Z_][A-Z0-9_]*" value={instanceEditor.secretRefs.verificationToken ?? ''} onChange={(event) => setInstanceEditor({ ...instanceEditor, secretRefs: { ...instanceEditor.secretRefs, verificationToken: event.target.value } })} /></label>
            <label>Encrypt Key 引用（可选）<input type="password" autoComplete="off" spellCheck={false} pattern="secret://env/[A-Z_][A-Z0-9_]*" value={instanceEditor.secretRefs.encryptKey ?? ''} onChange={(event) => {
              const rest = { ...instanceEditor.secretRefs };
              delete rest.encryptKey;
              setInstanceEditor({ ...instanceEditor, secretRefs: event.target.value ? { ...rest, encryptKey: event.target.value } : rest });
            }} /></label>
          </>}
          <label className="channel-checkbox"><input type="checkbox" checked={instanceEditor.enabled} onChange={(event) => setInstanceEditor({ ...instanceEditor, enabled: event.target.checked })} /> 保存后立即启用</label>
        </div>
        <footer><button type="button" onClick={() => setInstanceEditor(null)}>取消</button><button className="primary" type="submit" disabled={busy}>保存实例</button></footer>
      </form>
    </div>}

    {bindingEditor && <div className="channel-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setBindingEditor(null); }}>
      <form className="channel-editor" onSubmit={(event) => void saveBinding(event)}>
        <header><div><h2>{snapshot?.bindings.some((item) => item.id === bindingEditor.id) ? '编辑绑定' : '添加绑定'}</h2><p>将平台 conversation ID 映射到 Jojo Session。</p></div><button type="button" onClick={() => setBindingEditor(null)}>×</button></header>
        <div className="channel-editor-fields">
          <label>绑定 ID<input required value={bindingEditor.id} disabled={Boolean(snapshot?.bindings.some((item) => item.id === bindingEditor.id))} onChange={(event) => setBindingEditor({ ...bindingEditor, id: event.target.value })} /></label>
          <label>Channel 实例<select value={bindingEditor.instanceId} onChange={(event) => setBindingEditor({ ...bindingEditor, instanceId: event.target.value })}>{snapshot?.instances.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Conversation ID<input required value={bindingEditor.conversation.id} onChange={(event) => setBindingEditor({ ...bindingEditor, conversation: { ...bindingEditor.conversation, id: event.target.value } })} /></label>
          <label>会话类型<select value={bindingEditor.conversation.type} onChange={(event) => {
            const type = event.target.value as 'direct' | 'group';
            setBindingEditor({
              ...bindingEditor,
              conversation: { ...bindingEditor.conversation, type },
              policy: { ...bindingEditor.policy, requireMention: type === 'group' ? true : bindingEditor.policy.requireMention }
            });
          }}><option value="direct">私聊</option><option value="group">群聊</option></select></label>
          <label>Session 模式<select value={bindingEditor.routing.sessionMode} onChange={(event) => setBindingEditor({ ...bindingEditor, routing: { ...bindingEditor.routing, sessionMode: event.target.value as BindingDraft['routing']['sessionMode'] } })}><option value="persistent">持久 Session</option><option value="per_thread">每个 Thread</option><option value="stateless">无状态</option></select></label>
          <label>工作区（可选）<input value={bindingEditor.routing.workspaceRoot ?? ''} onChange={(event) => {
            const rest = { ...bindingEditor.routing };
            delete rest.workspaceRoot;
            setBindingEditor({ ...bindingEditor, routing: event.target.value ? { ...rest, workspaceRoot: event.target.value } : rest });
          }} /></label>
          <label>Provider ID（可选）<input value={bindingEditor.routing.providerId ?? ''} onChange={(event) => {
            const rest = { ...bindingEditor.routing };
            delete rest.providerId;
            setBindingEditor({ ...bindingEditor, routing: event.target.value ? { ...rest, providerId: event.target.value } : rest });
          }} /></label>
          <label>模型（可选）<input value={bindingEditor.routing.model ?? ''} onChange={(event) => {
            const rest = { ...bindingEditor.routing };
            delete rest.model;
            setBindingEditor({ ...bindingEditor, routing: event.target.value ? { ...rest, model: event.target.value } : rest });
          }} /></label>
          <label>队列策略<select value={bindingEditor.policy.queueMode} onChange={(event) => setBindingEditor({ ...bindingEditor, policy: { ...bindingEditor.policy, queueMode: event.target.value as BindingDraft['policy']['queueMode'] } })}><option value="queue">排队</option><option value="reject">忙时拒绝</option><option value="interrupt">中断当前任务</option></select></label>
          <label className="channel-checkbox"><input type="checkbox" checked={bindingEditor.policy.enabled} onChange={(event) => setBindingEditor({ ...bindingEditor, policy: { ...bindingEditor.policy, enabled: event.target.checked } })} /> 启用绑定</label>
          <label className="channel-checkbox"><input type="checkbox" checked={bindingEditor.policy.requireMention} onChange={(event) => setBindingEditor({ ...bindingEditor, policy: { ...bindingEditor.policy, requireMention: event.target.checked } })} /> 群聊需要 @Jojo</label>
          <label className="channel-checkbox"><input type="checkbox" checked={bindingEditor.policy.allowAttachments} onChange={(event) => setBindingEditor({ ...bindingEditor, policy: { ...bindingEditor.policy, allowAttachments: event.target.checked } })} /> 允许附件</label>
        </div>
        <footer><button type="button" onClick={() => setBindingEditor(null)}>取消</button><button className="primary" type="submit" disabled={busy}>保存绑定</button></footer>
      </form>
    </div>}
  </div>;
}
