// lab-tests services — controlled lab test catalog (issue #70).
export interface LabTest {
  code: string;
  name: string;
  specimenType: string | null;
  category: string | null;
}

const CATALOG: LabTest[] = [
  { code: 'CBC', name: 'Complete blood count', specimenType: 'blood', category: 'haematology' },
  { code: 'FBC', name: 'Full blood count', specimenType: 'blood', category: 'haematology' },
  { code: 'BMP', name: 'Basic metabolic panel', specimenType: 'blood', category: 'chemistry' },
  { code: 'CMP', name: 'Comprehensive metabolic panel', specimenType: 'blood', category: 'chemistry' },
  { code: 'LIPID', name: 'Lipid panel', specimenType: 'blood', category: 'chemistry' },
  { code: 'HBA1C', name: 'Glycated haemoglobin', specimenType: 'blood', category: 'chemistry' },
  { code: 'UA', name: 'Urinalysis', specimenType: 'urine', category: 'urinalysis' },
  { code: 'PT', name: 'Prothrombin time', specimenType: 'blood', category: 'coagulation' },
  { code: 'INR', name: 'International normalised ratio', specimenType: 'blood', category: 'coagulation' },
  { code: 'COVID19-PCR', name: 'SARS-CoV-2 PCR', specimenType: 'nasopharyngeal swab', category: 'microbiology' },
];

export async function searchLabTests(input: { q?: string; limit?: number }): Promise<LabTest[]> {
  const q = (input.q ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const filtered = q
    ? CATALOG.filter((t) => t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || (t.category ?? '').toLowerCase().includes(q))
    : CATALOG;
  return filtered.slice(0, limit);
}

export function getLabTestByCode(code: string): LabTest | undefined {
  return CATALOG.find((t) => t.code === code);
}
EOF