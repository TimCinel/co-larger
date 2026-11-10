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
    rules: {
      // Conflicts with no-non-null-assertion (from strictTypeChecked) for
      // indexed access under noUncheckedIndexedAccess: one asks for `x!`, the
      // other forbids it. Keep the stricter rule and allow `x as T`.
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
    },
  },
  {
    // The local browser check drives a real page with untyped `evaluate`
    // callbacks, where these rules only add noise.
    files: ['scripts/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
    },
  },
  prettier,
);
