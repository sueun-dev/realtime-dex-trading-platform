/**
 * zod schemas for the wire format. bigint values travel as decimal strings;
 * these schemas validate + convert to engine-native bigint units.
 */
import { z } from 'zod';
import { fromUnits, toUnits } from './decimal.js';
import type { OrderRequest } from './types.js';

/** positive decimal-string → 1e8 bigint units */
export const zUnits = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string')
  .transform((s) => toUnits(s));

export const zPositiveUnits = zUnits.refine((u) => u > 0n, 'must be > 0');

export const zSide = z.enum(['buy', 'sell']);
export const zOrderType = z.enum(['limit', 'market']);
export const zTif = z.enum(['GTC', 'IOC', 'FOK']);
export const zCandleInterval = z.enum(['1m', '5m', '15m', '1h', '4h', '1d']);

export const zMarketId = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/, 'invalid market id');

export const zEthAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'invalid ethereum address')
  .transform((a) => a.toLowerCase());

export const zOrderRequest = z
  .object({
    marketId: zMarketId,
    side: zSide,
    type: zOrderType,
    price: zPositiveUnits.optional(),
    qty: zPositiveUnits,
    tif: zTif.default('GTC'),
    postOnly: z.boolean().default(false),
    reduceOnly: z.boolean().default(false),
    clientOrderId: z.string().min(1).max(64).optional(),
    triggerPrice: zPositiveUnits.optional(),
    triggerDirection: z.enum(['above', 'below']).optional(),
  })
  .superRefine((o, ctx) => {
    if (o.type === 'limit' && o.price === undefined) {
      ctx.addIssue({ code: 'custom', message: 'limit orders require a price', path: ['price'] });
    }
    if (o.type === 'market' && o.postOnly) {
      ctx.addIssue({ code: 'custom', message: 'market orders cannot be postOnly', path: ['postOnly'] });
    }
    if (o.type === 'market' && o.tif === 'GTC') {
      ctx.addIssue({ code: 'custom', message: 'market orders must be IOC or FOK', path: ['tif'] });
    }
    // a trigger needs both its price and direction together
    if ((o.triggerPrice === undefined) !== (o.triggerDirection === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'triggerPrice and triggerDirection must be provided together',
        path: ['triggerPrice'],
      });
    }
  });

export type OrderRequestInput = z.input<typeof zOrderRequest>;

export function parseOrderRequest(input: unknown): OrderRequest {
  const parsed = zOrderRequest.parse(input);
  const req: OrderRequest = {
    marketId: parsed.marketId,
    side: parsed.side,
    type: parsed.type,
    qty: parsed.qty,
    tif: parsed.tif,
    postOnly: parsed.postOnly,
    reduceOnly: parsed.reduceOnly,
  };
  if (parsed.price !== undefined) req.price = parsed.price;
  if (parsed.clientOrderId !== undefined) req.clientOrderId = parsed.clientOrderId;
  if (parsed.triggerPrice !== undefined && parsed.triggerDirection !== undefined) {
    req.trigger = { price: parsed.triggerPrice, direction: parsed.triggerDirection };
  }
  return req;
}

export const zLeverageRequest = z.object({
  marketId: zMarketId,
  leverage: z.number().int().min(1).max(100),
});

export const zAuthNonceRequest = z.object({ address: zEthAddress });
export const zAuthVerifyRequest = z.object({
  address: zEthAddress,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

/** Recursively converts bigint fields to decimal strings for JSON responses. */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return fromUnits(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}
