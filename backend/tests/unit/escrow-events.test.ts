import { describe, expect, it } from 'vitest';
import { decodeEscrowRpcEvent } from '../../src/modules/payments/services/escrow-event-decoder';

describe('decodeEscrowRpcEvent', () => {
  it('decodes a recorded released event without exposing event data as text', () => {
    const topic = (value: string) => ({ sym: () => value, toXDR: () => `xdr:${value}` });
    const event = {
      id: '0016010972359577600-0000000008',
      ledger: 3730843,
      txHash: 'a5c9247b77eb04c0d857934a2e988c408167976c',
      topic: [topic('escrow'), topic('released'), { u64: () => 42n, toXDR: () => 'AAAAKg==' }],
      value: { toXDR: () => 'AAAAcGF5bG9hZA==' },
    };

    expect(decodeEscrowRpcEvent(event, 'C123')).toEqual({
      eventId: event.id,
      contractId: 'C123',
      ledger: 3730843,
      txHash: event.txHash,
      escrowId: 42n,
      eventType: 'released',
      state: 'pending',
      payload: {
        topics: ['xdr:escrow', 'xdr:released', 'AAAAKg=='],
        value: 'AAAAcGF5bG9hZA==',
      },
    });
  });

  it('keeps malformed or unrelated topic layouts unclassified', () => {
    const event = {
      id: 'event-2',
      ledger: 10,
      txHash: 'hash',
      topic: [],
      value: { toXDR: () => 'AA==' },
    };
    const decoded = decodeEscrowRpcEvent(event, 'C123');
    expect(decoded.escrowId).toBeNull();
    expect(decoded.eventType).toBe('unknown');
  });
});
