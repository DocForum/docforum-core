import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '../../scripts/check-env-parity.mjs');

function run(src: string, envFile: string): { code: number; output: string } {
  try {
    const out = execFileSync(process.execPath, [script, '--src', src, '--env-file', envFile], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output: out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: e.stdout + e.stderr };
  }
}

let dir: string;
function fixture(files: Record<string, string>, envExample: string) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-parity-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, 'src', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.writeFileSync(path.join(dir, '.env.example'), envExample);
  return { src: path.join(dir, 'src'), envFile: path.join(dir, '.env.example') };
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('check-env-parity (issue #344)', () => {
  it('passes on the real backend src/ and .env.example', () => {
    const backend = path.resolve(__dirname, '../..');
    expect(run(path.join(backend, 'src'), path.join(backend, '.env.example')).code).toBe(0);
  });

  it('fails and names a newly added variable that .env.example lacks', () => {
    const { src, envFile } = fixture(
      { 'config/sections/x.ts': 'export const x = process.env.KNOWN_VAR ?? process.env.BRAND_NEW_VAR;' },
      '# comment\nKNOWN_VAR=1\n',
    );
    const result = run(src, envFile);
    expect(result.code).toBe(1);
    expect(result.output).toContain('BRAND_NEW_VAR');
    expect(result.output).not.toContain('KNOWN_VAR ');
  });

  it('detects bracket, requireEnv, env-parameter and zod-schema reads', () => {
    const { src, envFile } = fixture(
      {
        'a.ts': "process.env['BRACKET_VAR']; requireEnv('REQUIRED_VAR'); function f(env: NodeJS.ProcessEnv) { return env.PARAM_VAR; }",
        'config/schema.ts': 'const s = z.object({\n  SCHEMA_VAR: z.string(),\n});\ns.parse(process.env);',
      },
      '',
    );
    const result = run(src, envFile);
    expect(result.code).toBe(1);
    for (const name of ['BRACKET_VAR', 'REQUIRED_VAR', 'PARAM_VAR', 'SCHEMA_VAR']) expect(result.output).toContain(name);
  });

  it('accepts commented-out entries and ignores NODE_ENV', () => {
    const { src, envFile } = fixture(
      { 'a.ts': 'process.env.OPTIONAL_VAR; process.env.NODE_ENV;' },
      '# Optional.\n# OPTIONAL_VAR=\n',
    );
    expect(run(src, envFile).code).toBe(0);
  });
});
