import { describe, expect, it } from 'vitest';
import {
  addAddendumSchema,
  createConsultationSchema,
  updateConsultationSchema,
} from '../../src/modules/consultations/validation';

describe('createConsultationSchema', () => {
  it('accepts notes with a valid outcome', () => {
    expect(createConsultationSchema.safeParse({ notes: 'Seen and discharged', outcome: 'resolved' }).success).toBe(
      true,
    );
  });

  it('accepts an empty body — a consultation can be opened before it is written up', () => {
    expect(createConsultationSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an outcome outside the enum', () => {
    expect(createConsultationSchema.safeParse({ outcome: 'cured' }).success).toBe(false);
  });

  it('rejects a blank note', () => {
    expect(createConsultationSchema.safeParse({ notes: '   ' }).success).toBe(false);
  });
});

describe('updateConsultationSchema', () => {
  it('accepts a partial update', () => {
    expect(updateConsultationSchema.safeParse({ notes: 'updated' }).success).toBe(true);
    expect(updateConsultationSchema.safeParse({ outcome: 'referred' }).success).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(updateConsultationSchema.safeParse({}).success).toBe(false);
  });
});

describe('addAddendumSchema', () => {
  it('requires a non-empty body', () => {
    expect(addAddendumSchema.safeParse({ body: 'Correction' }).success).toBe(true);
    expect(addAddendumSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(addAddendumSchema.safeParse({}).success).toBe(false);
  });
});
