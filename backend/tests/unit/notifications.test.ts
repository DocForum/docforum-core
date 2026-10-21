import { describe, expect, it } from 'vitest';
import { phiFieldNames, renderNotification } from '../../src/modules/notifications/templates';

describe('notification templates', () => {
  it('renders every notification type without clinical details', () => {
    const types = ['booking_confirmed', 'new_booking', 'referral_created', 'referral_decision', 'order_ready', 'results_available'] as const;
    for (const type of types) {
      const rendered = renderNotification(type, { loginUrl: 'https://docforum.example/login' });
      expect(rendered.version).toBe(1);
      expect(rendered.text).toContain('Sign in to DocForum');
      expect(rendered.html).not.toMatch(/diagnos|symptom|prescription|lab result/i);
      for (const field of phiFieldNames) expect(rendered.text.toLowerCase()).not.toContain(field.toLowerCase());
    }
  });

  it('rejects payload fields that could carry PHI', () => {
    expect(() => renderNotification('order_ready', { loginUrl: 'https://docforum.example/login', diagnosis: 'x' })).toThrow();
  });
});
