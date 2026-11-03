import type { RateLimitRecord as RateLimitRecordType, RateLimitStore } from '../types';

/** In-memory rate limit store for tests. */
export class MemoryRateLimitStore implements RateLimitStore {
  private records = new Map<string, RateLimitRecordType[]>();

  private makeRecord(data: {
    id: string;
    key: string;
    scope: 'user' | 'ip';
    cost: number;
    consumedAt: Date;
  }): RateLimitRecordType {
    return {
      id: data.id,
      key: data.key,
      scope: data.scope,
      cost: data.cost,
      consumedAt: data.consumedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async recordConsumption(data: {
    key: string;
    scope: 'user' | 'ip';
    cost: number;
    consumedAt: Date;
  }): Promise<void> {
    const { key, scope, cost, consumedAt } = data;
    const mapKey = `${key}:${scope}`;

    if (!this.records.has(mapKey)) {
      this.records.set(mapKey, []);
    }

    const records = this.records.get(mapKey)!;
    records.push(this.makeRecord({ id: crypto.randomUUID(), key, scope, cost, consumedAt }));
  }

  async countRecords(params: {
    key: string;
    scope: 'user' | 'ip';
    since: Date;
  }): Promise<number> {
    const { key, scope, since } = params;
    const mapKey = `${key}:${scope}`;
    const records = this.records.get(mapKey) || [];
    return records
      .filter((r) => r.consumedAt >= since)
      .reduce((total, record) => total + record.cost, 0);
  }

  async getState(params: {
    key: string;
    scope: 'user' | 'ip';
  }): Promise<{ remaining: number; resetAt: Date }> {
    const { key, scope } = params;
    const windowMs = 60 * 1000;
    const windowStart = new Date(Date.now() - windowMs);

    const mapKey = `${key}:${scope}`;
    const records = this.records.get(mapKey) || [];
    const totalConsumed = records
      .filter((r) => r.consumedAt >= windowStart)
      .reduce((total, record) => total + record.cost, 0);
    const remaining = Math.max(0, 100 - totalConsumed);
    const resetAt = new Date(Date.now() + windowMs);

    return { remaining, resetAt };
  }

  async prune(oldBefore: Date): Promise<number> {
    let count = 0;
    for (const [mapKey, records] of this.records.entries()) {
      const kept = records.filter((r) => r.consumedAt >= oldBefore);
      count += records.length - kept.length;
      this.records.set(mapKey, kept);
    }
    return count;
  }
}
