import fs from 'fs';
import path from 'path';

function walkDir(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && file !== 'coverage') {
        walkDir(filePath, fileList);
      }
    } else if (filePath.endsWith('.ts') || filePath.endsWith('.js')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function main() {
  const srcDir = path.resolve(__dirname, '../src');
  const envExamplePath = path.resolve(__dirname, '../.env.example');

  if (!fs.existsSync(envExamplePath)) {
    console.error('Error: .env.example not found at', envExamplePath);
    process.exit(1);
  }

  const envExampleContent = fs.readFileSync(envExamplePath, 'utf8');
  const definedVars = new Set<string>();

  for (const line of envExampleContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex !== -1) {
      const key = trimmed.slice(0, eqIndex).trim();
      if (key) definedVars.add(key);
    }
  }

  // Also allow some standard Node / testing / build env vars or common ones
  const allowedBuiltins = new Set([
    'NODE_ENV',
    'PORT',
    'DATABASE_URL',
  ]);

  const tsFiles = walkDir(srcDir);
  const envRegex = /process\.env\.([A-Z0-9_]+)/g;
  const missingVars = new Set<string>();

  for (const file of tsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = envRegex.exec(content)) !== null) {
      const varName = match[1];
      if (!definedVars.has(varName) && !allowedBuiltins.has(varName)) {
        missingVars.add(varName);
      }
    }
  }

  if (missingVars.size > 0) {
    console.error('Error: The following environment variables are accessed via process.env in src/ but are missing from .env.example:');
    for (const v of Array.from(missingVars).sort()) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }

  console.log('.env.example parity check passed successfully.');
}

main();
