import React from 'react';

export function BrowserModeSelector({ enabled, mode, onChange }: { enabled: boolean; mode: 'sandbox' | 'chrome'; onChange: (mode: 'sandbox' | 'chrome') => void }) {
  return <section className="settings-section-card"><div className="settings-section-title"><h2>使用哪种浏览器？</h2></div>
    <div className="browser-mode-grid" role="radiogroup" aria-label="浏览器模式">
      <label className={`browser-mode-option ${mode === 'sandbox' ? 'selected' : ''}`}><input type="radio" name="browser-mode" checked={mode === 'sandbox'} disabled={!enabled} onChange={() => onChange('sandbox')} /><span className="browser-mode-copy"><strong>沙箱浏览器 · 推荐</strong><span>适合查资料、测试网页和访问不熟悉的网站。与电脑上的日常浏览器隔离。</span></span></label>
      <label className={`browser-mode-option ${mode === 'chrome' ? 'selected' : ''}`}><input type="radio" name="browser-mode" checked={mode === 'chrome'} disabled={!enabled} onChange={() => onChange('chrome')} /><span className="browser-mode-copy"><strong>本机浏览器 · 需要登录时使用</strong><span>Jojo 会打开一个独立的 Chrome 窗口。首次需要登录，之后可继续使用登录状态。不会读取你日常 Chrome 的登录状态。</span></span></label>
    </div>
  </section>;
}
