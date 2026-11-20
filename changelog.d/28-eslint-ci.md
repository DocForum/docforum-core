Phase 9: ESLint now runs in CI ([issue #28](https://github.com/DocForum/docforum-core/issues/28)).
`backend/tools/lint` holds an isolated ESLint 9 + type-aware
`typescript-eslint` toolchain pinned to the TypeScript 6 compatibility API
(`@typescript/typescript6`), because `typescript-eslint` cannot load
TypeScript 7 — which has no compiler API — while the app stays on `tsc` 7.
`npm run lint` and a CI lint step after `typecheck` use it; the baseline turns
`no-floating-promises` on as an error and leaves `no-explicit-any`,
`no-console` and `no-unused-expressions` off (reasons in the config header).
Adopting it surfaced real defects, now fixed: a literal-backspace regex in
`patients/services` that never matched SQLSTATE 23001, `@ts-ignore` in
`payments/validation.ts` that could hide an unrelated error, an undefined
`iteration`/`__VU_ITER` in the k6 load scripts, and `kf6/*` imports in those
scripts (they were loading nothing). No runtime or schema change.
