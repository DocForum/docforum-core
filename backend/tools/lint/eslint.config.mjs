// ESLint flat config (Phase 9, issue #28).
//
// This file lives in tools/lint because typescript-eslint cannot load the
// application's TypeScript 7 (TS 7 ships no compiler API). tools/lint pins
// `typescript` to the TypeScript 6 compatibility package
// (@typescript/typescript6), so ESLint parses with the 6.x API while `tsc`
// in backend/ stays on 7. Run it through `npm run lint` in backend/.
//
// Goal: a *useful baseline*, not a style war. `tsc --noEmit` is the real type
// checker; this adds the async/correctness rules TS can't express, above all
// `no-floating-promises` — an unawaited promise in a payment or booking path
// is exactly the kind of bug this repo's review rules exist to prevent.
//
// Deliberately disabled, with reasons (the issue asks for these to be
// justified in the PR):
//   • @typescript-eslint/no-explicit-any — the Prisma 7 / Express typings and
//     the escrow-SDK dynamic import still need a handful of escapes; a
//     baseline that fails on those isn't adoptable. Tighten later.
//   • no-console — the structured-logger migration (Phase 9, issue #341) has
//     not converted every call site yet; failing CI on them would block
//     unrelated PRs. #341 removes the need.
//   • @typescript-eslint/no-unused-expressions — used deliberately by the
//     SDK-compat `void x` patterns.
import path from 'node:path';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const backendRoot = path.resolve(import.meta.dirname, '../..');

export default tseslint.config(
  {
    // Unused `eslint-disable` comments are expected right now: `no-console`
    // stays off until the structured-logger migration (#341) lands, which
    // leaves its disable comments unused. Reported as warnings otherwise.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tools/**',
      'prisma/migrations/**',
      'coverage/**',
      '.stryker-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting is what makes `no-floating-promises` possible.
        projectService: { allowDefaultProject: ['prisma.config.ts', 'prisma/seed.ts'] },
        tsconfigRootDir: backendRoot,
      },
    },
    rules: {
      // The rule issue #28 explicitly asks for.
      '@typescript-eslint/no-floating-promises': 'error',
      // See the header: adoptable baseline first, tightening later.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      // Unused arguments/vars are real dead code; the `_` prefix is the
      // existing convention for deliberately unused parameters.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // k6 load scripts are not Node programmes: they run inside the k6 runtime
    // and use its injected globals.
    files: ['tests/load/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },
);
