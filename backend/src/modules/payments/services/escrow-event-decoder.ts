export interface EscrowRpcEvent {
  id: string;
  ledger: number;
  txHash: string;
  topic: any[];
  value: any;
}

function topicValue(value: any): string | null {
  try {
    if (value?.sym) return value.sym().toString();
    if (value?.u64) return value.u64().toString();
  } catch {
    return null;
  }
  return null;
}

export function decodeEscrowRpcEvent(event: EscrowRpcEvent, contractId: string) {
  const topic = event.topic ?? [];
  const escrowId = topicValue(topic[2]);
  return {
    eventId: String(event.id),
    contractId,
    ledger: Number(event.ledger),
    txHash: String(event.txHash),
    escrowId: escrowId === null ? null : BigInt(escrowId),
    eventType: topicValue(topic[1]) ?? 'unknown',
    state: 'pending' as const,
    payload: {
      topics: topic.map((part: any) => part.toXDR('base64')),
      value: event.value?.toXDR ? event.value.toXDR('base64') : null,
    },
  };
}
