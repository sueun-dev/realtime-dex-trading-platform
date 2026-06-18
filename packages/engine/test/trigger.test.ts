import { describe, expect, it } from 'vitest';
import { Exchange } from '../src/index.js';
import { ConservationTracker, PERP, SPOT, acceptedId, newExchange, rejection, req, trades, u } from './helpers.js';

const P = PERP.id;
const S = SPOT.id;
let TS = 900_000;

function perpSetup(lev = 5): { ex: Exchange; t: ConservationTracker } {
  const ex = newExchange();
  const t = new ConservationTracker();
  for (const user of ['alice', 'bob', 'carol']) {
    ex.deposit(user, 'USDC', u(100_000), TS++);
    t.deposit('USDC', u(100_000));
    ex.setLeverage(user, P, lev, TS++);
  }
  return { ex, t };
}
function openLong(ex: Exchange, price: bigint, qty: bigint): void {
  ex.submitOrder('bob', req(P, 'sell', 'limit', price, qty), TS++);
  const e = ex.submitOrder('alice', req(P, 'buy', 'limit', price, qty), TS++);
  if (trades(e).length === 0) throw new Error('openLong did not fill');
}
const pos = (ex: Exchange, u2: string, m: string) => ex.getPosition(u2, m);

describe('conditional (stop / take-profit) orders', () => {
  it('a stop order rests untriggered, locks nothing, and shows in open orders', () => {
    const { ex, t } = perpSetup();
    ex.setMarkPrice(P, u(100), TS++);
    const evts = ex.submitOrder(
      'alice',
      req(P, 'sell', 'market', undefined, u(1), { tif: 'IOC', trigger: { price: u(90), direction: 'below' } }),
      TS++,
    );
    const id = acceptedId(evts);
    const order = ex.getOrder(id)!;
    expect(order.status).toBe('untriggered');
    expect(order.trigger).toEqual({ price: u(90), direction: 'below' });
    // nothing locked while dormant
    expect(ex.getBalances('alice').find((b) => b.asset === 'USDC')!.locked).toBe(0n);
    expect(ex.getOpenOrders('alice').some((o) => o.id === id && o.status === 'untriggered')).toBe(true);
    t.check(ex);
  });

  it('stop-market sells (closes the long) when the mark falls through the trigger', () => {
    const { ex, t } = perpSetup();
    openLong(ex, u(100), u(1)); // alice long 1
    ex.setMarkPrice(P, u(100), TS++);
    // protective stop: sell-market triggered when mark <= 90
    ex.submitOrder(
      'alice',
      req(P, 'sell', 'market', undefined, u(1), { tif: 'IOC', reduceOnly: true, trigger: { price: u(90), direction: 'below' } }),
      TS++,
    );
    expect(pos(ex, 'alice', P)).toBeDefined(); // not yet triggered
    // counterparty bid so the triggered market sell can fill
    ex.submitOrder('carol', req(P, 'buy', 'limit', u(89), u(1)), TS++);
    const evts = ex.setMarkPrice(P, u(89), TS++); // crosses the trigger
    // the conditional was retired (reason 'triggered') and fired a real sell
    expect(evts.some((e) => e.kind === 'orderCancelled' && e.reason === 'triggered')).toBe(true);
    expect(evts.some((e) => e.kind === 'trade')).toBe(true);
    expect(pos(ex, 'alice', P)).toBeUndefined(); // long closed by the stop
    t.check(ex);
  });

  it('take-profit limit rests when triggered (mark rises through the trigger)', () => {
    const { ex, t } = perpSetup();
    openLong(ex, u(100), u(1));
    ex.setMarkPrice(P, u(100), TS++);
    // take profit: sell-limit @120 triggered when mark >= 115
    const id = acceptedId(
      ex.submitOrder(
        'alice',
        req(P, 'sell', 'limit', u(120), u(1), { reduceOnly: true, trigger: { price: u(115), direction: 'above' } }),
        TS++,
      ),
    );
    ex.setMarkPrice(P, u(116), TS++); // triggers
    // the original conditional id is gone; a new resting limit exists
    expect(ex.getOrder(id)!.status).toBe('cancelled'); // conditional retired
    const open = ex.getOpenOrders('alice');
    expect(open.some((o) => o.status === 'open' && o.type === 'limit' && o.price === u(120))).toBe(true);
    t.check(ex);
  });

  it('fires immediately if already in-the-money at placement', () => {
    const { ex, t } = perpSetup();
    openLong(ex, u(100), u(1));
    ex.setMarkPrice(P, u(100), TS++);
    ex.submitOrder('carol', req(P, 'buy', 'limit', u(99), u(1)), TS++);
    // stop below 110 while mark is already 100 -> immediate trigger
    const evts = ex.submitOrder(
      'alice',
      req(P, 'sell', 'market', undefined, u(1), { tif: 'IOC', reduceOnly: true, trigger: { price: u(110), direction: 'below' } }),
      TS++,
    );
    expect(evts.some((e) => e.kind === 'trade')).toBe(true);
    expect(pos(ex, 'alice', P)).toBeUndefined();
    t.check(ex);
  });

  it('cancelling an untriggered order releases nothing and removes it', () => {
    const { ex, t } = perpSetup();
    ex.setMarkPrice(P, u(100), TS++);
    const id = acceptedId(
      ex.submitOrder('alice', req(P, 'buy', 'limit', u(95), u(1), { trigger: { price: u(105), direction: 'above' } }), TS++),
    );
    const cancel = ex.cancelOrder('alice', id, TS++);
    expect(cancel.some((e) => e.kind === 'orderCancelled' && e.orderId === id)).toBe(true);
    expect(ex.getOpenOrders('alice').some((o) => o.id === id)).toBe(false);
    t.check(ex);
  });

  it('spot stop fires on the last trade price (setLastPrice), not a mark', () => {
    const ex = newExchange();
    const t = new ConservationTracker();
    ex.deposit('alice', 'BTC', u(10), TS++);
    t.deposit('BTC', u(10));
    ex.deposit('carol', 'KRW', u(100_000_000), TS++);
    t.deposit('KRW', u(100_000_000));
    // alice places a spot stop-limit sell, triggered when price <= 9000
    const id = acceptedId(
      ex.submitOrder('alice', req(S, 'sell', 'limit', u(9000), u(1), { trigger: { price: u(9000), direction: 'below' } }), TS++),
    );
    expect(ex.getOrder(id)!.status).toBe('untriggered');
    // carol bids to absorb it
    ex.submitOrder('carol', req(S, 'buy', 'limit', u(9000), u(1)), TS++);
    const evts = ex.setLastPrice(S, u(9000), TS++); // price hits the trigger
    expect(evts.some((e) => e.kind === 'orderCancelled' && e.reason === 'triggered')).toBe(true);
    expect(evts.some((e) => e.kind === 'trade')).toBe(true);
    t.check(ex);
  });

  it('validation: trigger price must be a tick multiple; stop-market must be IOC/FOK', () => {
    const { ex } = perpSetup();
    expect(
      rejection(
        ex.submitOrder('alice', req(P, 'sell', 'market', undefined, u(1), { tif: 'IOC', trigger: { price: u(90) + 1n, direction: 'below' } }), TS++),
      )?.code,
    ).toBe('TICK_SIZE');
    expect(
      rejection(
        ex.submitOrder('alice', req(P, 'sell', 'market', undefined, u(1), { tif: 'GTC', trigger: { price: u(90), direction: 'below' } }), TS++),
      )?.code,
    ).toBe('INVALID_ORDER');
  });

  it('restore round-trips an untriggered conditional order', () => {
    const { ex } = perpSetup();
    ex.setMarkPrice(P, u(100), TS++);
    const id = acceptedId(
      ex.submitOrder('alice', req(P, 'sell', 'limit', u(120), u(1), { trigger: { price: u(115), direction: 'above' } }), TS++),
    );
    const order = ex.getOrder(id)!;
    // rebuild a fresh engine and restore just this conditional
    const ex2 = newExchange();
    ex2.restoreState({
      balances: [{ userId: 'alice', asset: 'USDC', available: u(100_000), locked: 0n }],
      positions: [],
      leverages: [{ userId: 'alice', marketId: P, leverage: 5 }],
      openOrders: [],
      conditionalOrders: [order],
      markPrices: [],
      lastSeq: order.seq,
    });
    const restored = ex2.getOrder(id)!;
    expect(restored.status).toBe('untriggered');
    expect(restored.trigger).toEqual({ price: u(115), direction: 'above' });
    expect(ex2.getOpenOrders('alice').some((o) => o.id === id)).toBe(true);
  });
});

describe('trailing-stop orders', () => {
  it('seeds its initial stop `trail` below the ref for a sell-stop, ratchets up, then fires on reversal', () => {
    const { ex, t } = perpSetup();
    openLong(ex, u(100), u(1)); // alice long 1
    ex.setMarkPrice(P, u(100), TS++); // ref = 100
    // trailing sell-stop, trail 10, no explicit price → seeds at 100 - 10 = 90
    const id = acceptedId(
      ex.submitOrder(
        'alice',
        req(P, 'sell', 'market', undefined, u(1), {
          tif: 'IOC',
          reduceOnly: true,
          trigger: { price: 0n, direction: 'below', trail: u(10) },
        }),
        TS++,
      ),
    );
    expect(ex.getOrder(id)!.trigger).toEqual({ price: u(90), direction: 'below', trail: u(10) });

    // ref rises to 130 → stop ratchets to 120, emitting orderTriggerUpdated
    const up = ex.setMarkPrice(P, u(130), TS++);
    expect(up.some((e) => e.kind === 'orderTriggerUpdated' && e.triggerPrice === u(120))).toBe(true);
    expect(ex.getOrder(id)!.trigger!.price).toBe(u(120));

    // small dip to 125 does NOT fire (still above the 120 stop) and does not ratchet down
    ex.submitOrder('carol', req(P, 'buy', 'limit', u(119), u(1)), TS++);
    const dip = ex.setMarkPrice(P, u(125), TS++);
    expect(dip.some((e) => e.kind === 'orderCancelled' && e.reason === 'triggered')).toBe(false);
    expect(ex.getOrder(id)!.trigger!.price).toBe(u(120)); // stop unchanged on adverse move

    // reversal through 120 → fires the protective sell, closing the long
    const fire = ex.setMarkPrice(P, u(118), TS++);
    expect(fire.some((e) => e.kind === 'orderCancelled' && e.reason === 'triggered')).toBe(true);
    expect(pos(ex, 'alice', P)).toBeUndefined();
    t.check(ex);
  });

  it('a trailing buy-stop seeds above the ref and ratchets DOWN as the ref falls', () => {
    const { ex, t } = perpSetup();
    ex.setMarkPrice(P, u(100), TS++); // ref 100
    const id = acceptedId(
      ex.submitOrder(
        'alice',
        req(P, 'buy', 'market', undefined, u(1), {
          tif: 'IOC',
          trigger: { price: 0n, direction: 'above', trail: u(10) },
        }),
        TS++,
      ),
    );
    expect(ex.getOrder(id)!.trigger!.price).toBe(u(110)); // 100 + 10

    const down = ex.setMarkPrice(P, u(70), TS++); // ref falls → stop drops to 80
    expect(down.some((e) => e.kind === 'orderTriggerUpdated' && e.triggerPrice === u(80))).toBe(true);
    expect(ex.getOrder(id)!.trigger!.price).toBe(u(80));
    t.check(ex);
  });

  it('rejects a trailing stop when there is no reference price to seed from', () => {
    const { ex } = perpSetup(); // no mark/last price set yet
    const rej = rejection(
      ex.submitOrder(
        'alice',
        req(P, 'sell', 'market', undefined, u(1), {
          tif: 'IOC',
          trigger: { price: 0n, direction: 'below', trail: u(10) },
        }),
        TS++,
      ),
    );
    expect(rej?.code).toBe('INVALID_ORDER');
  });

  it('persists the ratcheted stop so a restore resumes from the tightened level', () => {
    const { ex } = perpSetup();
    ex.setMarkPrice(P, u(100), TS++);
    const id = acceptedId(
      ex.submitOrder(
        'alice',
        req(P, 'sell', 'market', undefined, u(1), {
          tif: 'IOC',
          reduceOnly: true,
          trigger: { price: 0n, direction: 'below', trail: u(10) },
        }),
        TS++,
      ),
    );
    ex.setMarkPrice(P, u(150), TS++); // ratchet stop up to 140
    const ratcheted = ex.getOrder(id)!;
    expect(ratcheted.trigger).toEqual({ price: u(140), direction: 'below', trail: u(10) });

    const ex2 = newExchange();
    ex2.restoreState({
      balances: [{ userId: 'alice', asset: 'USDC', available: u(100_000), locked: 0n }],
      positions: [],
      leverages: [{ userId: 'alice', marketId: P, leverage: 5 }],
      openOrders: [],
      conditionalOrders: [ratcheted],
      markPrices: [],
      lastSeq: ratcheted.seq,
    });
    expect(ex2.getOrder(id)!.trigger).toEqual({ price: u(140), direction: 'below', trail: u(10) });
  });
});
