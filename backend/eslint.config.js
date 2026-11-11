const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', 'tests/load/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,mts}', 'tests/**/*.{ts,mts}', 'vitest.config.mts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.{ts,mts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'warn',
    },
  },
  {
    files: ['*.js', '*.mjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
