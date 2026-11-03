import { describe, expect, it } from 'vitest';
import { parsePositiveMoney, createMoney } from '../money/money.js';
import {
  PAYMENT_INTENT_STATUSES,
  type PaymentIntent,
  type PaymentIntentStatus,
} from './payment-intent.js';

describe('PAYMENT_INTENT_STATUSES', () => {
  it('lists exactly the MVP statuses', () => {
    expect([...PAYMENT_INTENT_STATUSES]).toEqual([
      'CREATED',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'UNKNOWN',
    ]);
  });

  it.each([
    'REQUIRES_ACTION',
    'REQUIRES_CAPTURE',
    'CANCELED',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
  ])('does not include the later status %s', (status) => {
    expect(PAYMENT_INTENT_STATUSES).not.toContain(status);
  });
});

describe('PaymentIntent', () => {
  it('holds a positive amount and a status of the list', () => {
    const parsed = parsePositiveMoney('10000', 'USD');
    if (!parsed.ok) throw new Error('fixture amount must be valid');
    const status: PaymentIntentStatus = 'CREATED';
    const intent: PaymentIntent = {
      id: '0b6f0f0e-6a35-4e27-9d7c-6a4b1f2f3a10',
      merchantId: '5d1c1d52-83f5-4a39-a3ad-0c1e8a1f2b77',
      amount: parsed.money,
      merchantReference: 'order-1001',
      status,
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
      updatedAt: new Date('2026-11-03T10:00:00.000Z'),
    };
    expect(intent.amount.amountMinor).toBe(10000n);
    expect(intent.amount.currency).toBe('USD');
  });

  it('rejects at compile time an unchecked amount and an unknown status', () => {
    const zero = createMoney(0n, 'USD');
    if (!zero.ok) throw new Error('fixture amount must be valid');
    const invalid: PaymentIntent = {
      id: 'id',
      merchantId: 'merchant',
      // @ts-expect-error plain Money may be zero or negative, a payment amount may not
      amount: zero.money,
      merchantReference: 'order',
      // @ts-expect-error REQUIRES_ACTION is not an MVP status
      status: 'REQUIRES_ACTION',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    expect(invalid.id).toBe('id');
  });
});
