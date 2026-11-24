import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFollowUps, createModule, validateModuleName } from '../../scripts/new-module.mjs';

const tempRoots = [];

function freshModulesRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-new-module-'));
  const modulesRoot = path.join(tempRoot, 'src', 'modules');
  fs.mkdirSync(modulesRoot, { recursive: true });
  tempRoots.push(tempRoot);
  return modulesRoot;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe('new module generator', () => {
  it('creates the expected tree in the target root only', () => {
    const modulesRoot = freshModulesRoot();
    const created = createModule('lab-kits', { modulesRoot });

    expect(created.name).toBe('lab-kits');
    expect(created.files).toEqual([
      'controllers/index.ts',
      'mount.ts',
      'repositories/index.ts',
      'routes/index.ts',
      'services/index.ts',
      'validation.ts',
    ]);
    for (const file of created.files) {
      expect(fs.existsSync(path.join(modulesRoot, 'lab-kits', file))).toBe(true);
    }
    expect(fs.existsSync(path.join(modulesRoot, 'lab-kits', 'README.md'))).toBe(false);
  });

  it('writes compilable placeholders using the module alias', () => {
    const modulesRoot = freshModulesRoot();
    createModule('lab-kits', { modulesRoot });
    const base = path.join(modulesRoot, 'lab-kits');

    expect(fs.readFileSync(path.join(base, 'mount.ts'), 'utf8')).toContain('export function mount(app: Express): void');
    expect(fs.readFileSync(path.join(base, 'mount.ts'), 'utf8')).toContain("app.use('/lab-kits', labKitsRouter)");
    expect(fs.readFileSync(path.join(base, 'routes/index.ts'), 'utf8')).toContain('export const labKitsRouter = Router()');
    expect(fs.readFileSync(path.join(base, 'validation.ts'), 'utf8')).toContain("import { z } from 'zod'");
  });

  it('refuses to overwrite an existing module and writes nothing', () => {
    const modulesRoot = freshModulesRoot();
    const existing = path.join(modulesRoot, 'lab-kits');
    fs.mkdirSync(existing);
    const sentinel = path.join(existing, 'hand-written.ts');
    fs.writeFileSync(sentinel, 'export const mine = true;');

    expect(() => createModule('lab-kits', { modulesRoot })).toThrow(/already exists.*refusing to overwrite/i);
    expect(fs.readdirSync(existing)).toEqual(['hand-written.ts']);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('export const mine = true;');
  });

  it('rejects bad names before creating any directory', () => {
    const modulesRoot = freshModulesRoot();
    const badNames = ['', '   ', '../escape', 'foo/bar', 'foo\\bar', '..', 'Foo', 'foo_bar', '-foo', 'foo_bar-baz'];

    for (const name of badNames) {
      expect(() => validateModuleName(name)).toThrow();
      expect(() => createModule(name, { modulesRoot })).toThrow();
    }
    expect(fs.readdirSync(modulesRoot)).toEqual([]);
  });

  it('prints the real manual follow-ups', () => {
    const followUps = buildFollowUps('lab-kits');

    expect(followUps).toContain("export { mount as labKits } from './modules/lab-kits/mount';");
    expect(followUps).toContain("import { labKitsExportSection } from './modules/lab-kits/services';");
    expect(followUps).toContain("import { hasLabKitsRecordsForPatient } from './modules/lab-kits/services';");
    expect(followUps).toContain("{ name: 'lab-kits', holds: hasLabKitsRecordsForPatient },");
    expect(followUps).toContain('file: docs/api/README.md');
    expect(followUps).toContain('section: Lab Kits (/lab-kits) — backend/src/modules/lab-kits');
  });
});
