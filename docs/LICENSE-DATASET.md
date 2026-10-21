# Dataset Licence Information

This document records the licence terms for open datasets used to seed the DocForum medication and lab test catalogs.

## Medication Catalog

**Source:** [Specify dataset source, e.g., RxNorm, WHO Essential Medicines List, national formulary]

**Licence:** [Specify licence, e.g., UMLS Metathesaurus License, CC0, CC-BY 4.0, etc.]

**Attribution Required:** [Yes/No and details]

**Commercial Use Permitted:** [Yes/No]

**Modification Permitted:** [Yes/No]

**Notes:** 
- The import script (`scripts/import-medications.mjs`) downloads and processes this dataset.
- Only generic names, strengths, forms, routes, and standard codes (RxNorm, etc.) are imported.
- No proprietary or copyrighted content beyond what the licence permits is stored.
- The dataset is used to provide a controlled vocabulary for prescriptions (FR-10).

---

## Lab Test Catalog

**Source:** [Specify dataset source, e.g., LOINC, national lab test registry]

**Licence:** [Specify licence, e.g., LOINC License Agreement, CC0, CC-BY 4.0, etc.]

**Attribution Required:** [Yes/No and details]

**Commercial Use Permitted:** [Yes/No]

**Modification Permitted:** [Yes/No]

**Notes:**
- The import script (`scripts/import-lab-tests.mjs`) downloads and processes this dataset.
- LOINC codes, test names, specimen types, and categories are imported.
- The dataset is used for capability matching between lab orders and facilities (FR-13).

---

## Verification Checklist

Before merging a PR that adds or updates a dataset import:

- [ ] Dataset source is identified and documented above
- [ ] Licence is compatible with DocForum's Apache 2.0 licence
- [ ] Attribution requirements (if any) are met in the codebase/docs
- [ ] Commercial use is permitted (DocForum is a commercial platform)
- [ ] A copy of the licence is stored in `docs/licences/dataset-[name].txt`
- [ ] The import script only extracts permitted fields
- [ ] No PHI or proprietary data is included in the import

---

## Example: Using RxNorm (US) / dm+d (UK) / AMIS (Australia)

If using a national formulary:
1. Verify the licence permits redistribution and commercial use
2. Document the specific edition/version used
3. Store the licence text in `docs/licences/`
4. Update this file with the details

**IMPORTANT:** Never commit actual dataset files to the repository. The import scripts download/process them at runtime. Only this documentation file and the import scripts are committed.