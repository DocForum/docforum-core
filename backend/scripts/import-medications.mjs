#!/usr/bin/env node
// scripts/import-medications.mjs
// Import medications from an open dataset (e.g., RxNorm or local formulary)
// Licence: This script imports from a dataset that must have a compatible licence.
// See LICENSE-DATASET.md for the dataset licence details.

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

interface MedicationRow {
  genericName: string;
  strength?: string;
  form?: string;
  route?: string;
  externalCode?: string;
  externalSystem?: string;
}

async function importFromCSV(filePath: string): Promise<MedicationRow[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  const rows: MedicationRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: MedicationRow = {};
    headers.forEach((header, index) => {
      const value = values[index];
      if (value && value !== '') {
        switch (header.toLowerCase()) {
          case 'genericname':
          case 'generic_name':
          case 'name':
            row.genericName = value;
            break;
          case 'strength':
            row.strength = value;
            break;
          case 'form':
            row.form = value;
            break;
          case 'route':
            row.route = value;
            break;
          case 'externalcode':
          case 'external_code':
          case 'rxnorm':
          case 'code':
            row.externalCode = value;
            break;
          case 'externalsystem':
          case 'external_system':
          case 'system':
            row.externalSystem = value;
            break;
        }
      }
    });
    if (row.genericName) rows.push(row);
  }
  return rows;
}

async function importFromJSON(filePath: string): Promise<MedicationRow[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content);
  
  // Handle different JSON structures
  if (Array.isArray(data)) {
    return data.map((item: Record<string, unknown>) => ({
      genericName: String(item.genericName || item.name || ''),
      strength: item.strength ? String(item.strength) : undefined,
      form: item.form ? String(item.form) : undefined,
      route: item.route ? String(item.route) : undefined,
      externalCode: item.externalCode || item.code ? String(item.externalCode || item.code) : undefined,
      externalSystem: item.externalSystem || item.system ? String(item.externalSystem || item.system) : undefined,
    })).filter(r => r.genericName);
  }
  
  // Handle RxNorm-like structure
  if (data.rxnorm || data.medications) {
    const items = data.rxnorm || data.medications;
    return items.map((item: Record<string, unknown>) => ({
      genericName: String(item.name || item.genericName || ''),
      strength: item.strength ? String(item.strength) : undefined,
      form: item.form ? String(item.form) : undefined,
      route: item.route ? String(item.route) : undefined,
      externalCode: item.rxcui || item.code ? String(item.rxcui || item.code) : undefined,
      externalSystem: 'rxnorm',
    })).filter(r => r.genericName);
  }
  
  throw new Error('Unrecognized JSON structure');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node import-medications.mjs <csv|json> <file-path>');
    console.error('Example: node import-medications.mjs csv ./data/medications.csv');
    console.error('Example: node import-medications.mjs json ./data/medications.json');
    process.exit(1);
  }

  const format = args[0];
  const filePath = args[1];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Importing medications from ${filePath} (${format})...`);

  let rows: MedicationRow[];
  if (format === 'csv') {
    rows = await importFromCSV(filePath);
  } else if (format === 'json') {
    rows = await importFromJSON(filePath);
  } else {
    console.error('Format must be "csv" or "json"');
    process.exit(1);
  }

  console.log(`Found ${rows.length} medications to import`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      // Check if medication already exists by externalCode
      let existing = null;
      if (row.externalCode) {
        existing = await prisma.medication.findUnique({
          where: { externalCode: row.externalCode },
        });
      }

      if (existing) {
        // Update existing
        await prisma.medication.update({
          where: { id: existing.id },
          data: {
            genericName: row.genericName,
            strength: row.strength,
            form: row.form,
            route: row.route,
            externalSystem: row.externalSystem,
          },
        });
        skipped++;
      } else {
        // Create new
        await prisma.medication.create({
          data: {
            genericName: row.genericName,
            strength: row.strength,
            form: row.form,
            route: row.route,
            externalCode: row.externalCode,
            externalSystem: row.externalSystem || 'local',
          },
        });
        imported++;
      }

      if ((imported + skipped) % 100 === 0) {
        console.log(`Progress: ${imported + skipped}/${rows.length} (imported: ${imported}, skipped: ${skipped})`);
      }
    } catch (error) {
      console.error(`Error importing ${row.genericName}:`, error);
      errors++;
    }
  }

  console.log('\nImport complete!');
  console.log(`Imported: ${imported}`);
  console.log(`Skipped (updated): ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total processed: ${imported + skipped + errors}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());