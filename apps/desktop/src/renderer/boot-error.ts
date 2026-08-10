function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.stack || cause.message;
  return typeof cause === 'string' ? cause : JSON.stringify(cause);
}

function showBootError(cause: unknown): void {
  window.setTimeout(() => {
    const root = document.getElementById('root');
    if (!root || root.childElementCount > 0) return;

    const panel = document.createElement('main');
    Object.assign(panel.style, {
      boxSizing: 'border-box', minHeight: '100vh', padding: '48px', background: '#f5f5f6',
      color: '#25262a', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
    });
    const title = document.createElement('h1');
    title.textContent = 'Desktop Agent 启动失败';
    const hint = document.createElement('p');
    hint.textContent = 'Renderer 未能完成初始化。请复制下方错误用于排查，或重新加载应用。';
    const detail = document.createElement('pre');
    detail.textContent = errorText(cause);
    Object.assign(detail.style, {
      maxHeight: '55vh', overflow: 'auto', padding: '16px', border: '1px solid #d8d9dd',
      borderRadius: '10px', background: '#fff', color: '#9f2d35', whiteSpace: 'pre-wrap'
    });
    const reload = document.createElement('button');
    reload.textContent = '重新加载';
    Object.assign(reload.style, {
      marginTop: '16px', padding: '10px 16px', border: '0', borderRadius: '8px',
      background: '#5269cd', color: '#fff', cursor: 'pointer'
    });
    reload.addEventListener('click', () => window.location.reload());
    panel.append(title, hint, detail, reload);
    root.replaceChildren(panel);
  }, 0);
}

window.addEventListener('error', (event) => showBootError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => showBootError(event.reason));
