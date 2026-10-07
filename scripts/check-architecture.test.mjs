import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArchitecture } from './check-architecture.mjs';

function fixture(t, definitions) {
  const root = mkdtempSync(path.join(tmpdir(), 'jojo-architecture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'apps'));
  mkdirSync(path.join(root, 'packages'));
  for (const [name, definition] of Object.entries(definitions)) {
    const directory = path.join(root, 'packages', name);
    mkdirSync(path.join(directory, 'src'), { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
      name: `@desktop-agent/${name}`, exports: './src/index.ts', ...definition.manifest
    }));
    for (const [file, content] of Object.entries(definition.files ?? { 'src/index.ts': '' })) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), content);
    }
  }
  return root;
}

test('accepts public root and explicit public subpaths, including type-only imports', (t) => {
  const root = fixture(t, {
    contracts: { manifest: { exports: { '.': './src/index.ts', './application': './src/application.ts' } } },
    'app-service': {
      manifest: { dependencies: { '@desktop-agent/contracts': 'workspace:*' } },
      files: { 'src/index.ts': "import type { Input } from '@desktop-agent/contracts/application';" }
    }
  });
  assert.deepEqual(checkArchitecture(root), []);
});

test('rejects forbidden manifest edges even without a source import', (t) => {
  const root = fixture(t, {
    'app-service': { manifest: { dependencies: { '@desktop-agent/server-protocol': 'workspace:*' } } },
    'server-protocol': {}
  });
  assert.match(checkArchitecture(root).join('\n'), /forbidden dependency.*app-service.*server-protocol/);
});

test('rejects hidden dependency edges, internal paths and re-exports', (t) => {
  const root = fixture(t, {
    contracts: {},
    'app-service': { files: { 'src/index.ts': "export * from '@desktop-agent/contracts/src/private';" } }
  });
  const errors = checkArchitecture(root).join('\n');
  assert.match(errors, /non-public workspace import/);
  assert.match(errors, /undeclared production dependency/);
});

test('finds cycles from source-only dynamic imports and require', (t) => {
  const root = fixture(t, {
    alpha: { files: { 'src/index.ts': "const b = import('@desktop-agent/beta');" } },
    beta: { files: { 'src/index.ts': "const a = require('@desktop-agent/alpha');" } }
  });
  assert.match(checkArchitecture(root).join('\n'), /package cycle:.*alpha.*beta.*alpha/);
});

test('rejects host coupling, renderer Node access and relative package bypasses', (t) => {
  const root = fixture(t, {
    'agent-runtime': { files: {
      'src/index.ts': "import { app } from 'electron'; export * from '../../storage/src/index';"
    } },
    desktop: { files: { 'src/renderer/index.ts': "import fs from 'node:fs';" } },
    storage: {}
  });
  const errors = checkArchitecture(root).join('\n');
  assert.match(errors, /host\/transport dependency/);
  assert.match(errors, /cross-package relative import/);
  assert.match(errors, /renderer imports Node/);
});

test('permits integration test dependencies without introducing production cycles', (t) => {
  const root = fixture(t, {
    'agent-runtime': { files: { 'test/runtime.test.ts': "import { store } from '@desktop-agent/storage';" } },
    storage: { manifest: { dependencies: { '@desktop-agent/agent-runtime': 'workspace:*' } } }
  });
  assert.deepEqual(checkArchitecture(root), []);
});

test('rejects Desktop conversation JSONL regressions', (t) => {
  const root = fixture(t, {
    desktop: { files: { 'src/main/index.ts': "sessionStore.messages('s'); store.appendMessage('s', message);" } }
  });
  assert.match(checkArchitecture(root).join('\n'), /Desktop conversation must use Runtime/);
});
