import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * Lint rules are tuned to catch the classes of bug that have actually bitten
 * this project rather than to enforce style for its own sake.
 *
 * react-hooks/exhaustive-deps is the important one: a missing dependency is
 * exactly what caused the upload bug (a memoised callback held a stale
 * onComplete and silently discarded every file) and the PDF viewer's
 * re-render loop. It is a warning, not an error, because a few effects here
 * intentionally omit deps and say so in a comment.
 */
export default tseslint.config(
  { ignores: ['dist', 'src-tauri/target', 'node_modules', 'scripts'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Real-bug rules.
      'react-hooks/exhaustive-deps': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Pragmatic for this codebase: pdf.js and Supabase surface plenty of
      // `any`, and unused args are common in event handlers.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Empty catch blocks are used deliberately for best-effort cleanup.
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Tests read source files as strings and assert on them.
    files: ['src/test/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
