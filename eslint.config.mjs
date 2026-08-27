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
            '@desktop-agent/agent-runtime/operation',
            '@desktop-agent/agent-runtime/operation/*',
            '@desktop-agent/agent-runtime/src/operation/*',
            '@desktop-agent/agent-runtime/src/store'
          ],
          message: 'Use the AgentRuntime public facade or an explicit preview subpath; runtime kernel imports are internal.'
        }]
      }]
    }
  },
  {
    files: ['packages/orchestration/**/*.ts', 'packages/extensions/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '@desktop-agent/agent-runtime/store',
            '@desktop-agent/agent-runtime/operation',
            '@desktop-agent/agent-runtime/operation/*',
            '@desktop-agent/agent-runtime/src/operation/*',
            '@desktop-agent/agent-runtime/src/store'
          ],
          message: 'Orchestration and extensions must use the AgentRuntime behavior facade, not its storage SPI.'
        }]
      }]
    }
  }
);
