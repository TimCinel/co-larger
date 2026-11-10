import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // Flat config does not read .gitignore, and a bare 'dist/' only matches the
  // root. Agent worktrees live under .claude/ inside the main checkout, each
  // with its own src/ and dist/, so ignore them and build output at any depth.
  { ignores: ['**/dist/', '**/coverage/', '.claude/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
);
