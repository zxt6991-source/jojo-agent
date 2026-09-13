import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { legacyModelConfig } from '@desktop-agent/contracts';
import { ModelMetadataSettings } from './ModelMetadataSettings';
it('shows sources, fallback/stale status, per-model overrides and reset controls', () => {
  const model = legacyModelConfig('unknown');
  model.override = { defaultOutputTokens: 4_096 };
  const html = renderToStaticMarkup(React.createElement(ModelMetadataSettings, { model, onChange: () => {} }));
  expect(html).toContain('默认值（请确认服务限制）');
  expect(html).toContain('手动覆盖');
  expect(html).toContain('缓存已过期');
  expect(html).toContain('4,096');
  expect(html).toContain('恢复自动检测');
  expect(html).toContain('<details class="model-advanced">');
});
it('distinguishes provider and builtin discoveries', () => {
  const model = legacyModelConfig('known');
  model.discovered.contextSource = 'provider'; model.discovered.maxOutputSource = 'builtin';
  const html = renderToStaticMarkup(React.createElement(ModelMetadataSettings, { model, onChange: () => {} }));
  expect(html).toContain('Provider 自动检测');
  expect(html).toContain('Jojo 模型库');
});
