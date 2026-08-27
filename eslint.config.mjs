import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.vite/**', '**/out/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '@desktop-agent/agent-runtime/compat',
            '@desktop-agent/agent-runtime/operation',
            '@desktop-agent/agent-runtime/operation/*',
            '@desktop-agent/agent-runtime/src/operation/*',
            '@desktop-agent/agent-runtime/src/store'
          ],
          message: 'Apps must use the AgentRuntime public facade; compat and runtime kernel imports are migration-only.'
        }]
      }]
    }
  },
  {
    files: ['packages/agent-runtime/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['electron', 'electron/*', 'apps/desktop/*', 'apps/server/*', 'fastify', 'ws'],
          message: 'Agent Runtime must remain independent of Electron, Desktop, Server, and transport packages.'
        }]
      }]
    }
  },
  {
    files: ['packages/runtime-composition/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            'electron', 'electron/*', 'fastify', 'ws',
            '@desktop-agent/agent-runtime/compat',
            '@desktop-agent/agent-runtime/src/*'
          ],
          message: 'Runtime Composition is Host-independent and may only use public Runtime API or its explicit storage SPI.'
        }]
      }]
    }
  },
  {
    files: [
      'packages/orchestration/**/*.ts',
      'packages/extensions/**/*.ts',
      'packages/app-service/**/*.ts',
      'packages/storage/**/*.ts'
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '@desktop-agent/agent-runtime/compat',
            '@desktop-agent/agent-runtime/store',
            '@desktop-agent/agent-runtime/operation',
            '@desktop-agent/agent-runtime/operation/*',
            '@desktop-agent/agent-runtime/src/operation/*',
            '@desktop-agent/agent-runtime/src/store'
          ],
          message: 'Product packages must use the AgentRuntime facade or explicit storage SPI; compat is migration-only.'
        }]
      }]
    }
  }
);
