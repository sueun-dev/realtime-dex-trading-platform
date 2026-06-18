import type { Order, Side, Trade } from './types.js';

export type CancelReason =
  | 'user'
  | 'ioc'
  | 'selfTrade'
  | 'liquidation'
  | 'slippage'
  | 'bookExhausted'
  | 'triggered'
  | 'oco';

export type BalanceReason =
  | 'deposit'
  | 'withdraw'
  | 'lock'
  | 'unlock'
  | 'trade'
  | 'fee'
  | 'funding'
  | 'pnl'
  | 'liquidation';

interface BaseEvent {
  seq: number;
  ts: number;
}

export interface OrderAcceptedEvent extends BaseEvent {
  kind: 'orderAccepted';
  order: Order;
}

export interface OrderRejectedEvent extends BaseEvent {
  kind: 'orderRejected';
  userId: string;
  marketId: string;
  code: string;
  reason: string;
  clientOrderId: string | null;
}

export interface OrderCancelledEvent extends BaseEvent {
  kind: 'orderCancelled';
  orderId: string;
  userId: string;
  marketId: string;
  remainingQty: bigint;
  reason: CancelReason;
}

export interface TradeEvent extends BaseEvent {
  kind: 'trade';
  trade: Trade;
  /** maker order state after the fill */
  makerOrder: Order;
  /** taker order state after the fill */
  takerOrder: Order;
}

/** Emitted whenever a user's balance row changes; carries the NEW absolute values. */
export interface BalanceChangedEvent extends BaseEvent {
  kind: 'balanceChanged';
  userId: string;
  asset: string;
  available: bigint;
  locked: bigint;
  reason: BalanceReason;
}

/** Carries the NEW absolute position (size 0 = closed). */
export interface PositionChangedEvent extends BaseEvent {
  kind: 'positionChanged';
  userId: string;
  marketId: string;
  size: bigint;
  entryPrice: bigint;
  leverage: number;
  /** engine's exact isolated margin AFTER this change (1e8 USDC units; 0 when closed) */
  margin: bigint;
  /** realized PnL delta from this change (1e8 USDC units) */
  realizedPnl: bigint;
}

export interface LiquidationEvent extends BaseEvent {
  kind: 'liquidation';
  userId: string;
  marketId: string;
  /** position size that was force-closed (signed) */
  size: bigint;
  markPrice: bigint;
  /** 'maintenance' = margin breach; 'adl' = auto-deleveraged to cover bad debt */
  reason: 'maintenance' | 'adl';
}

export interface FundingAppliedEvent extends BaseEvent {
  kind: 'fundingApplied';
  marketId: string;
  userId: string;
  /** signed 1e8 rate, e.g. 0.0001/h → 10_000n */
  rate: bigint;
  /** signed USDC payment applied to the user (negative = paid) */
  payment: bigint;
  markPrice: bigint;
}

export interface MarkPriceEvent extends BaseEvent {
  kind: 'markPrice';
  marketId: string;
  price: bigint;
}

/** A resting trailing-stop ratcheted its stop price to a new (more favorable) level. */
export interface OrderTriggerUpdatedEvent extends BaseEvent {
  kind: 'orderTriggerUpdated';
  orderId: string;
  userId: string;
  marketId: string;
  /** the new stop price (1e8) */
  triggerPrice: bigint;
}

export type EngineEvent =
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderCancelledEvent
  | TradeEvent
  | BalanceChangedEvent
  | PositionChangedEvent
  | LiquidationEvent
  | FundingAppliedEvent
  | MarkPriceEvent
  | OrderTriggerUpdatedEvent;
