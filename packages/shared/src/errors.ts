export const ErrorCodes = {
  INVALID_ORDER: 'INVALID_ORDER',
  MARKET_NOT_FOUND: 'MARKET_NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INSUFFICIENT_MARGIN: 'INSUFFICIENT_MARGIN',
  POST_ONLY_WOULD_CROSS: 'POST_ONLY_WOULD_CROSS',
  FOK_NOT_FILLED: 'FOK_NOT_FILLED',
  MIN_NOTIONAL: 'MIN_NOTIONAL',
  TICK_SIZE: 'TICK_SIZE',
  LOT_SIZE: 'LOT_SIZE',
  SLIPPAGE_EXCEEDED: 'SLIPPAGE_EXCEEDED',
  REDUCE_ONLY_VIOLATION: 'REDUCE_ONLY_VIOLATION',
  LEVERAGE_EXCEEDED: 'LEVERAGE_EXCEEDED',
  LEVERAGE_IN_USE: 'LEVERAGE_IN_USE',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED',
  FAUCET_ALREADY_CLAIMED: 'FAUCET_ALREADY_CLAIMED',
  DUPLICATE_CLIENT_ORDER_ID: 'DUPLICATE_CLIENT_ORDER_ID',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class DexError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'DexError';
    this.code = code;
  }
}

export function isDexError(e: unknown): e is DexError {
  return e instanceof DexError;
}
