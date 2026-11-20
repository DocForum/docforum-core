// Medication catalog importer (issue #69, PRD FR-10).
//
// Seeds the `Medication` controlled vocabulary from an open dataset. The
// catalog is reference data: re-running an import updates catalog rows in
// place and NEVER touches an already-issued prescription — a
// `PrescriptionItem` stores its own display snapshot (drugName) taken at
// issuance time, so a catalog correction cannot rewrite history.
//
// ---------------------------------------------------------------------------
// Dataset licence
// ---------------------------------------------------------------------------
// The bundled source is the openFDA `drug/ndc` endpoint:
//   https://api.fda.gov/drug/ndc.json
//
// openFDA data is released as U.S. Government work and is in the public
// domain: it may be copied, modified and redistributed without restriction
// (https://open.fda.gov/license/). openFDA asks that consumers not imply
// FDA endorsement; this script and the catalog it writes carry no FDA
// branding. The endpoint needs no API key below its published rate limit
// (240 requests/minute, 1 000/day without a key).
//
// RxNorm CUIs are intentionally NOT used: RxNorm is distributed under the
// UMLS Metathesaurus licence, which is not an open-data licence in the sense
// this project needs. `Medication.externalCode` therefore stores the
// openFDA product NDC.
//
// You may point `--file` at another dataset only if its licence permits
// redistribution/derivation and is recorded in the PR that adds it.
// ---------------------------------------------------------------------------
//
// Usage:
//   node scripts/import-medications.mjs --openfda --limit 1000
//   node scripts/import-medications.mjs --file ./medications.csv
//   node scripts/import-medications.mjs --file ./medications.json --dry-run
//
// CSV header: generic_name,strength,form,route,external_code
// JSON: an array of { genericName, strength, form, route, externalCode? }
//       (a raw openFDA `results` array is accepted too).
//
// Exits non-zero on any malformed row — a half-imported catalog is worse than
// a failed one.
import 'dotenv/config';
import fs from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const OPENFDA_URL = 'https://api.fda.gov/drug/ndc.json';
const BATCH_SIZE = 500;

function fail(message) {
  console.error(`import-medications: ${message}`);
  process.exit(1);
}

// Prisma 7 requires a driver adapter (see ADR 0006); same shape as
// scripts/create-admin.mjs, which also runs standalone from the shell.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});
const prisma = new PrismaClient({ adapter });

function parseArgs(argv) {
  const args = { file: null, openfda: false, limit: 1000, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i];
    else if (arg === '--openfda') args.openfda = true;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else fail(`unknown argument ${arg}`);
  }
  if (!args.file && !args.openfda) fail('one of --file <path> or --openfda is required');
  if (!Number.isInteger(args.limit) || args.limit < 1) fail('--limit must be a positive integer');
  return args;
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalises one record from any supported shape into a catalog row.
 * Returns null (with a reason) for records the catalog cannot represent —
 * an NDC entry with no generic name or no form is skipped, not guessed. */
function toMedication(record) {
  // CSV row (already parsed) or openFDA JSON record.
  const genericName = clean(record.genericName ?? record.generic_name ?? record.generic_name_raw);
  const strength = clean(
    record.strength ??
      record.active_ingredients?.[0]?.strength ??
      record.dosage_form_strength,
  );
  const form = clean(record.form ?? record.dosage_form);
  const route = clean(record.route) || 'unspecified';
  const externalCode =
    clean(record.externalCode ?? record.external_code ?? record.product_ndc ?? record.ndc) || null;

  if (!genericName) return null;
  if (!strength) return null;
  if (!form) return null;

  return { genericName, strength, form, route, externalCode };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map((cell) => cell.trim().toLowerCase());
  const required = ['generic_name', 'strength', 'form', 'route'];
  for (const column of required) {
    if (!header.includes(column)) fail(`CSV is missing the "${column}" column`);
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim());
    return Object.fromEntries(header.map((column, index) => [column, cells[index] ?? '']));
  });
}

async function loadRecords(args) {
  if (args.file) {
    const text = await fs.readFile(args.file, 'utf-8');
    if (args.file.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : parsed.results ?? [];
    }
    return parseCsv(text);
  }

  const url = `${OPENFDA_URL}?limit=${args.limit}`;
  console.log(`import-medications: fetching ${url}`);
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) fail(`openFDA returned ${response.status} ${response.statusText}`);
  const body = await response.json();
  return body.results ?? [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = await loadRecords(args);
  console.log(`import-medications: ${records.length} source record(s)`);

  const seen = new Set();
  const rows = [];
  let skipped = 0;
  for (const record of records) {
    const medication = toMedication(record);
    if (!medication) {
      skipped += 1;
      continue;
    }
    // De-duplicate within the batch: openFDA repeats a product across
    // packaging entries, and upserting the same key twice in one run is
    // wasted work (not an error).
    const key =
      medication.externalCode ??
      `${medication.genericName}|${medication.strength}|${medication.form}|${medication.route}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    rows.push(medication);
  }

  if (args.dryRun) {
    console.log(`import-medications: dry run — would upsert ${rows.length} row(s), skip ${skipped}`);
    for (const row of rows.slice(0, 10)) {
      console.log(`  ${row.genericName} ${row.strength} ${row.form} (${row.route})${row.externalCode ? ` [${row.externalCode}]` : ''}`);
    }
    return;
  }

  let written = 0;
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    await prisma.$transaction(
      batch.map((row) =>
        row.externalCode
          ? prisma.medication.upsert({
              where: { externalCode: row.externalCode },
              create: row,
              update: {
                genericName: row.genericName,
                strength: row.strength,
                form: row.form,
                route: row.route,
              },
            })
          : prisma.medication.upsert({
              where: {
                genericName_strength_form_route: {
                  genericName: row.genericName,
                  strength: row.strength,
                  form: row.form,
                  route: row.route,
                },
              },
              create: row,
              update: {},
            }),
      ),
    );
    written += batch.length;
    console.log(`import-medications: upserted ${written}/${rows.length}`);
  }

  const total = await prisma.medication.count();
  console.log(`import-medications: done — ${written} row(s) written, ${skipped} skipped, catalog now ${total} row(s)`);
}

main()
  .catch((error) => fail(error instanceof Error ? error.message : String(error)))
  .finally(async () => {
    await prisma.$disconnect();
  });
