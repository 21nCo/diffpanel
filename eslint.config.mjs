import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '.turbo/**', '.opencode/**'],
  },
  {
    files: ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/vscode/browser-tests/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
]);
