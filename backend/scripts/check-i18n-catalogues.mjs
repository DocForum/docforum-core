import { readFile } from 'node:fs/promises';

const source = JSON.parse(await readFile(new URL('../src/i18n/messages/en.json', import.meta.url), 'utf8'));
const locales = ['fr'];
let failed = false;

for (const locale of locales) {
  const catalogue = JSON.parse(await readFile(new URL(`../src/i18n/messages/${locale}.json`, import.meta.url), 'utf8'));
  const missing = Object.keys(source).filter((key) => !(key in catalogue));
  const extra = Object.keys(catalogue).filter((key) => !(key in source));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${locale}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
}

if (failed) process.exitCode = 1;
else console.log('Message catalogues have matching keys.');
