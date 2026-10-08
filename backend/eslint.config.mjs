// @ts-check
/**
 * ESLint flat config for the DocForum backend (issue #28).
 *
 * Deliberately a modest baseline: eslint:recommended + typescript-eslint's
 * recommended and recommendedTypeChecked sets — correctness rules, not a
 * style war. Every rule turned off or relaxed below carries a justification;
 * reviewers should check those.
 *
 * TS version note: this repo compiles with TypeScript 7 (`@typescript/native`
 * alias → `tsc`), but typescript-eslint only supports the TS 6 API (see
 * typescript-eslint#10940). The `typescript` devDependency is therefore the
 * `@typescript/typescript6` compatibility package, per the TS 7.0 release
 * guidance on running side-by-side:
 * https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0
 */
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // This config file itself isn't in tsconfig.json's include, so the
      // type-aware parser can't build a program for it.
      'eslint.config.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Type-aware rules (no-floating-promises etc.) need the real
        // tsconfig program. projectService is typescript-eslint's
        // recommended approach and picks up tsconfig.json's include
        // (src, tests, vitest.config.mts).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The two rules that motivated this issue (#28): async booking/
      // payment code must not silently drop rejections or misuse promises
      // in void-returning contexts.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],

      // Express error middleware must declare 4 params to be recognized;
      // unused ones are conventionally `_`-prefixed (matches tsc's
      // noUnusedParameters, which already accepts the underscore escape).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // console.warn/error are legitimate (error handler, server logs);
      // console.log/debug in request paths should go through a logger.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Plain-JS helper scripts: outside tsconfig.json's include, so no
    // type-aware rules.
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // …and console output IS their product (CLI scripts).
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Tests: supertest types `res.body` as `any`, so every response-shape
    // access is an `any` access. Tests verify those shapes at runtime via
    // `expect()` and narrow with `as` casts, so the unsafe-* family and
    // explicit-any here are noise, not signal.
    files: ['tests/**/*.ts', 'tests/**/*.mts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // Test helpers sometimes swallow errors intentionally.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
