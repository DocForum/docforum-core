import type { RateLimitStore, RateLimitRecord as RateLimitRecordType } from '../types';

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
    return records.filter((r) => r.consumedAt >= since).length;
  }

  async getState(params: {
    key: string;
    scope: 'user' | 'ip';
  }): Promise<{ remaining: number; resetAt: Date }> {
    const { key, scope } = params;
    // Default: 100 requests per 60-second window
    const windowMs = 60 * 1000;
    const windowStart = new Date(Date.now() - windowMs);

    const mapKey = `${key}:${scope}`;
    const records = this.records.get(mapKey) || [];
    const totalConsumed = records.filter((r) => r.consumedAt >= windowStart).length;
    const remaining = Math.max(0, 100 - totalConsumed);
    const resetAt = new Date(Date.now() + (windowMs - (Date.now() - windowStart.getTime())));

    return { remaining, resetAt };
  }

  async prune(oldBefore: Date): Promise<number> {
    let count = 0;
    for (const [mapKey, records] of this.records.entries()) {
      this.records.set(mapKey, records.filter((r) => r.consumedAt >= oldBefore));
      count += records.length - this.records.get(mapKey)!.length;
    }
    return count;
  }
}