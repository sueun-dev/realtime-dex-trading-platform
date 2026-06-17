import { describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import { parseOrder } from '../src/lib/api.js';
import type { OrderWire } from '../src/lib/api.js';

function baseWire(overrides: Partial<OrderWire> = {}): OrderWire {
  return {
    id: 'o1',
    marketId: 'BTC-USDC',
    side: 'sell',
    type: 'market',
    price: null,
    qty: '0.5',
    filledQty: '0',
    status: 'open',
    tif: 'IOC',
    postOnly: false,
    reduceOnly: false,
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

describe('parseOrder trigger handling', () => {
  it('parses an untriggered stop-market order with a below trigger', () => {
    const order = parseOrder(
      baseWire({
        status: 'untriggered',
        price: null,
        trigger: { price: '90000', direction: 'below' },
      }),
    );
    expect(order.status).toBe('untriggered');
    expect(order.price).toBeNull();
    expect(order.trigger).toEqual({ price: toUnits('90000'), direction: 'below' });
  });

  it('parses an untriggered stop-limit order with an above trigger and a price', () => {
    const order = parseOrder(
      baseWire({
        type: 'limit',
        tif: 'GTC',
        status: 'untriggered',
        price: '120000',
        trigger: { price: '119000', direction: 'above' },
      }),
    );
    expect(order.status).toBe('untriggered');
    expect(order.price).toBe(toUnits('120000'));
    expect(order.trigger).toEqual({ price: toUnits('119000'), direction: 'above' });
  });

  it('leaves trigger null for a normal order (missing or null)', () => {
    expect(parseOrder(baseWire({ trigger: null, type: 'limit', price: '100000' })).trigger).toBeNull();
    expect(parseOrder(baseWire({ type: 'limit', price: '100000' })).trigger).toBeNull();
  });
});
