// Module boundary check (Phase 9, issue #340)
//
// Fails when a file in modules/A imports modules/B/repositories (or
// controllers/routes) for A != B. Existing violations go on an allowlist
// so the check can be introduced incrementally.

import fs from 'node:fs';
import path from 'node:path';

// The root of the src/modules directory
const MODULES_ROOT = path.resolve('src/modules');

// Protected directories that should never be imported from other modules
const PROTECTED_DIRS = new Set(['repositories', 'controllers', 'routes']);

// Allowlist: module name -> list of file paths that are known violations
const allowlist = new Map();

// Get the module name (e.g., "modules/referrals") from a file path
function getModuleName(filePath) {
  try {
    const rel = path.relative(MODULES_ROOT, filePath);
    const parts = rel.split(path.sep);
    if (parts.length >= 2) {
      return `modules/${parts[0]}/${parts[1]}`;
    }
    if (parts.length >= 1) {
      return `modules/${parts[0]}`;
    }
  } catch {}
  return null;
}

// Resolve a relative import path and determine which module it belongs to
function resolveImportModule(importPath, fileDir) {
  try {
    // Resolve the relative path against the file's directory
    const resolved = path.resolve(fileDir, importPath);
    // Get the relative path from MODULES_ROOT
    const relFromRoot = path.relative(MODULES_ROOT, resolved);
    const parts = relFromRoot.split(path.sep);
    // parts could be: ['doctors', 'repositories', 'some-file.ts']
    // or ['doctors', 'some-file.ts']
    if (parts.length >= 2) {
      return `modules/${parts[0]}/${parts[1]}`;
    }
    if (parts.length >= 1) {
      return `modules/${parts[0]}`;
    }
  } catch {}
  return null;
}

// Check if an import statement targets a protected directory of another module
function checkImportViolation(importPath, filePath) {
  const fileDir = path.dirname(filePath);
  const importingModule = getModuleName(filePath);

  if (importingModule === null) return null;

  // Resolve the import and find its module
  const targetModule = resolveImportModule(importPath, fileDir);

  if (targetModule === null) return null;

  // Check if the target is a protected directory
  for (const protectedDir of PROTECTED_DIRS) {
    // Check if the resolved path ends with /{protectedDir} or contains /{protectedDir}/
    const normalizedImport = importPath.trim();
    // Match patterns like: ../repositories, ../repositories/something,
    // ./repositories, ./repositories/something
    const regex = new RegExp(
      `^\\.\\./?${protectedDir}(/|$)|^\\.\\./?${protectedDir}(/|$)`,
      'i'
    );
    // Also match ./repositories
    const regex2 = new RegExp(
      `^\\./?${protectedDir}(/|$)|^\\./?${protectedDir}(/|$)`,
      'i'
    );

    if (regex.test(normalizedImport) || regex2.test(normalizedImport)) {
      // Make sure the target module is different from the importing module
      if (targetModule && targetModule !== importingModule) {
        return targetModule;
      }
    }
  }
  return null;
}

// Scan all TypeScript files in modules and build the file->module map
function scanModuleFiles() {
  const files = new Map(); // moduleName -> [filePaths]

  function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walkDir(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          const moduleName = getModuleName(fullPath);
          if (moduleName !== null) {
            if (!files.has(moduleName)) {
              files.set(moduleName, []);
            }
            files.get(moduleName).push(fullPath);
          }
        }
      }
    }
  }

  // Walk each top-level module directory
  const moduleEntries = fs.readdirSync(MODULES_ROOT, { withFileTypes: true });
  for (const entry of moduleEntries) {
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      walkDir(path.join(MODULES_ROOT, entry.name));
    }
  }

  return files;
}

// Get all import statements from a file
function getImports(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const imports = new Set();

  // Match import statements: import X from '...' or import { X } from '...'
  // Also match: import * as X from '...'
  const importRegex = /import\s+[^\{]*?from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.add(match[1]);
  }

  return imports;
}

const moduleFiles = scanModuleFiles();

console.log(
  `Scanned ${new Set(Object.values(moduleFiles).flat()).size} files across ${moduleFiles.size} modules`
);

// Check each file for protected imports
let violations = 0;

for (const [moduleName, files] of Object.entries(moduleFiles)) {
  const fileList = Array.isArray(files) ? files : [];
  for (const filePath of fileList) {
    const imports = getImports(filePath);

    for (const importPath of imports) {
      const targetModule = checkImportViolation(importPath, filePath);

      if (targetModule) {
        // Check if it's in the allowlist
        const allowlistedFiles = allowlist.get(targetModule) || [];
        const fileBasename = path.basename(filePath);
        const isAllowlisted = allowlistedFiles.some(
          (allowed) => path.basename(allowed) === fileBasename
        );

        if (!isAllowlisted) {
          console.error(
            `VIOLATION: ${filePath} (module ${moduleName}) imports from ${targetModule} protected directory (import: ${importPath})`
          );
          violations++;
        }
      }
    }
  }
}

// Print the allowlist for review
console.log('\n--- Allowlist ---');
for (const [module, files] of allowlist) {
  console.log(`${module}: ${files.join(', ')}`);
}

console.log(`\nTotal violations: ${violations}`);
process.exit(violations > 0 ? 1 : 0);