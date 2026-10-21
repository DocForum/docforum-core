#!/usr/bin/env node
// scripts/import-lab-tests.mjs
// Import lab tests from an open dataset (e.g., LOINC or local formulary)
// Licence: This script imports from a dataset that must have a compatible licence.
// See LICENSE-DATASET.md for the dataset licence details.

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

interface LabTestRow {
  code: string;
  name: string;
  specimenType?: string;
  category?: string;
  panelOfCodes?: string[];
}

async function importFromCSV(filePath: string): Promise<LabTestRow[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  const rows: LabTestRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row: LabTestRow = { code: '', name: '' };
    headers.forEach((header, index) => {
      const value = values[index];
      if (value && value !== '') {
        switch (header.toLowerCase()) {
          case 'code':
          case 'loinc':
          case 'testcode':
          case 'test_code':
            row.code = value;
            break;
          case 'name':
          case 'testname':
          case 'test_name':
            row.name = value;
            break;
          case 'specimentype':
          case 'specimen_type':
          case 'specimen':
            row.specimenType = value;
            break;
          case 'category':
          case 'class':
            row.category = value;
            break;
          case 'panelof':
          case 'panel_of':
          case 'components':
            row.panelOfCodes = value.split(';').map(c => c.trim());
            break;
        }
      }
    });
    if (row.code && row.name) rows.push(row);
  }
  return rows;
}

async function importFromJSON(filePath: string): Promise<LabTestRow[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content);
  
  if (Array.isArray(data)) {
    return data.map((item: Record<string, unknown>) => ({
      code: String(item.code || item.loinc || ''),
      name: String(item.name || ''),
      specimenType: item.specimenType || item.specimen_type ? String(item.specimenType || item.specimen_type) : undefined,
      category: item.category || item.class ? String(item.category || item.class) : undefined,
      panelOfCodes: item.panelOfCodes || item.panel_of ? item.panelOfCodes || item.panel_of : undefined,
    })).filter(r => r.code && r.name);
  }
  
  if (data.loinc || data.tests) {
    const items = data.loinc || data.tests;
    return items.map((item: Record<string, unknown>) => ({
      code: String(item.loinc_num || item.code || ''),
      name: String(item.long_common_name || item.name || ''),
      specimenType: item.specimen || item.specimenType ? String(item.specimen || item.specimenType) : undefined,
      category: item.class || item.category ? String(item.class || item.category) : undefined,
    })).filter(r => r.code && r.name);
  }
  
  throw new Error('Unrecognized JSON structure');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node import-lab-tests.mjs <csv|json> <file-path>');
    console.error('Example: node import-lab-tests.mjs csv ./data/lab-tests.csv');
    console.error('Example: node import-lab-tests.mjs json ./data/lab-tests.json');
    process.exit(1);
  }

  const format = args[0];
  const filePath = args[1];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Importing lab tests from ${filePath} (${format})...`);

  let rows: LabTestRow[];
  if (format === 'csv') {
    rows = await importFromCSV(filePath);
  } else if (format === 'json') {
    rows = await importFromJSON(filePath);
  } else {
    console.error('Format must be "csv" or "json"');
    process.exit(1);
  }

  console.log(`Found ${rows.length} lab tests to import`);

  // First pass: create all tests without panel relationships
  const codeToId = new Map<string, string>();
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const existing = await prisma.labTest.findUnique({
        where: { code: row.code },
      });

      if (existing) {
        await prisma.labTest.update({
          where: { id: existing.id },
          data: {
            name: row.name,
            specimenType: row.specimenType,
            category: row.category,
          },
        });
        codeToId.set(row.code, existing.id);
        skipped++;
      } else {
        const created = await prisma.labTest.create({
          data: {
            code: row.code,
            name: row.name,
            specimenType: row.specimenType,
            category: row.category,
          },
        });
        codeToId.set(row.code, created.id);
        imported++;
      }

      if ((imported + skipped) % 100 === 0) {
        console.log(`Progress: ${imported + skipped}/${rows.length} (imported: ${imported}, skipped: ${skipped})`);
      }
    } catch (error) {
      console.error(`Error importing ${row.code} - ${row.name}:`, error);
      errors++;
    }
  }

  // Second pass: link panel components
  console.log('\nLinking panel components...');
  for (const row of rows) {
    if (row.panelOfCodes && row.panelOfCodes.length > 0) {
      const panelId = codeToId.get(row.code);
      if (panelId) {
        const componentIds = row.panelOfCodes
          .map(c => codeToId.get(c))
          .filter((id): id is string => id !== undefined);
        
        if (componentIds.length > 0) {
          try {
            await prisma.labTest.update({
              where: { id: panelId },
              data: { panelOf: { connect: componentIds.map(id => ({ id })) } },
            });
          } catch (error) {
            console.error(`Error linking panel ${row.code}:`, error);
          }
        }
      }
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