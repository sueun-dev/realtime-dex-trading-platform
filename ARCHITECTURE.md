# dex-exchange — Architecture (BINDING CONTRACT)

Hyperliquid-style DEX. **Spot markets** quoted in KRW with the real Upbit KRW market
universe (BTC, ETH, XRP, … all coins listed in Korea). **Perp markets** quoted in USDC
with the real Hyperliquid perp universe. All market data (prices, candles, tickers,
funding) is REAL, fetched live from Upbit and Hyperliquid public APIs. Order matching
happens on our own engine; users trade with faucet-seeded demo balances.

## Monorepo layout (pnpm workspaces)

| package | name | role |
|---|---|---|
| `packages/shared` | `@dex/shared` | Types, zod schemas, fixed-point bigint math, errors. **The contract — do not change signatures without updating all consumers.** |
| `packages/engine` | `@dex/engine` | Pure in-memory deterministic matching engine + margin/liquidation/funding. No I/O. Emits events. |
| `packages/db` | `@dex/db` | Drizzle ORM + PGlite (embedded real Postgres). Schema, migrations, repositories, event projector. |
| `packages/market-data` | `@dex/market-data` | Upbit REST/WS + Hyperliquid REST/WS connectors (real data), market universe loader, price cache. |
| `apps/api` | `@dex/api` | Fastify 5 REST + WebSocket server. Auth (EIP-191 wallet signature via viem + JWT). Wires market-data → engine → db. |
| `apps/web` | `@dex/web` | Vite + React 19 SPA. Hyperliquid-style dark trading UI. lightweight-charts candles (real data), live orderbook/trades via WS. |
| `e2e` | `@dex/e2e` | Playwright end-to-end tests against real api+web. |

## Core conventions (MUST follow)

1. **All money/qty/price values are `bigint` fixed-point with scale 1e8** (`SCALE = 10n**8n`).
   Use `@dex/shared` `toUnits`/`fromUnits`/`mulDiv`. **Never use JS `number` for money.**
   Over the wire (JSON/API/DB rows) bigint values are serialized as **decimal strings**
   (e.g. `"93130000"` KRW). zod schemas in shared handle the conversion.
2. **ESM everywhere** (`"type": "module"`), TypeScript strict, NodeNext resolution.
   Imports inside packages use relative paths **with `.js` extension**.
3. Engine is **pure & synchronous**: every mutation returns `EngineEvent[]`. The API
   layer persists events to DB (write-behind projection) and broadcasts over WS.
   The engine state is the source of truth at runtime; DB is the durable projection
   reloaded at boot.
4. Market IDs: spot = `KRW-BTC` (Upbit format), perp = `BTC-PERP`.
5. Sequencing: engine assigns a monotonically increasing `seq` to every event.

## Matching engine semantics

- Price-time priority limit order book per market (sorted price levels, FIFO queues).
- Order types: `limit`, `market`. TIF: `GTC`, `IOC`, `FOK`. Flags: `postOnly`, `reduceOnly` (perp only).
- Market orders: spot buys specify quote notional OR base qty (we use base qty + max
  slippage guard vs best price); reject remainder (cancel rest) when book exhausted.
- Self-trade prevention: cancel resting order (cancel-maker) when both sides same user.
- Fees in bps on the quote amount: spot maker 5 / taker 10; perp maker 2 / taker 5.
  Fees deducted from quote proceeds (sell) / charged on top is WRONG — fee is taken
  from received amounts: buyer pays quote, receives base minus nothing (spot fee
  charged in quote currency on notional); implementer: charge fee in quote currency
  for both sides, deducted from quote balance (buyer pays notional+fee, seller
  receives notional-fee). Perp fees deducted from USDC collateral.
- Spot balance model: per-asset `available`/`locked`. Placing a buy locks
  `notional+maxFee` in quote; placing a sell locks base qty. Fills release locks
  proportionally. Cancels release remaining locks. **Invariant: available ≥ 0,
  locked ≥ 0, sum of (available+locked) conserved per asset modulo fees collected
  into the fee account.**
- Perp model: USDC collateral, **isolated margin per position**. Placing a
  non-reduceOnly perp order locks `notional/leverage + worstCaseFee` USDC. On fill,
  the filled portion's locked margin moves into `position.margin` (fee deducted from
  the released lock). Position: signed size, volume-weighted entryPrice, margin.
  Increasing adds margin; reducing releases proportional margin + realized PnL to
  available (negative PnL is deducted from the released margin first). Unrealized
  PnL = size × (mark − entry) / SCALE (signed). Maintenance margin rate =
  1 / (2 × maxLeverage) of notional-at-mark. **Liquidation** (checked on every
  `setMarkPrice` and after funding): when `position.margin + uPnL < MM` the position
  is force-closed at mark price (backstop fill, no book interaction), leftover margin
  after PnL (clamped ≥ 0) returns to available, `liquidation` event emitted.
- Funding: applied per call to `applyFunding(marketId, rate, ts)` (hourly by the api):
  payment = size × markPrice × rate (longs pay when rate > 0), applied to
  `position.margin` (eroded margin can trigger liquidation). Funding is zero-sum
  across users; rounding remainder is absorbed by the fee account. Rates come from
  real Hyperliquid funding data.

## Engine public API (class `Exchange` in `@dex/engine`)

```ts
constructor(opts?: { markets?: MarketConfig[] })
addMarket(config: MarketConfig): void
deposit(userId: string, asset: string, amount: bigint, ts: number): EngineEvent[]
withdraw(userId: string, asset: string, amount: bigint, ts: number): EngineEvent[] // throws DexError(INSUFFICIENT_BALANCE)
/** Never throws for order-level problems — rejections come back as an orderRejected event. */
submitOrder(userId: string, req: OrderRequest, ts: number): EngineEvent[]
cancelOrder(userId: string, orderId: string, ts: number): EngineEvent[] // throws DexError(ORDER_NOT_FOUND / NOT_AUTHORIZED)
setLeverage(userId: string, marketId: string, leverage: number, ts: number): void // throws on open position/orders (LEVERAGE_IN_USE) or > maxLeverage
setMarkPrice(marketId: string, price: bigint, ts: number): EngineEvent[] // markPrice event + liquidations
applyFunding(marketId: string, rate: bigint, ts: number): EngineEvent[] // fundingApplied per holder (+ liquidations)
// read-only queries:
getOrderbook(marketId: string, depth?: number): OrderbookSnapshot
getOpenOrders(userId: string, marketId?: string): Order[]
getOrder(orderId: string): Order | undefined
getBalances(userId: string): Balance[]
getPositions(userId: string): Position[]
getPosition(userId: string, marketId: string): Position | undefined
getMarkPrice(marketId: string): bigint | undefined
getAccountSummary(userId: string): AccountSummary
getMarkets(): MarketConfig[]
getMarket(marketId: string): MarketConfig | undefined
readonly seq: number
/** Boot-time restore from DB projection. Sets state directly, no events, no matching
 * (open orders were resting & non-crossing; reinsert FIFO by seq). */
restoreState(state: {
  balances: { userId: string; asset: string; available: bigint; locked: bigint }[];
  positions: Position[];
  leverages: { userId: string; marketId: string; leverage: number }[];
  openOrders: Order[]; // ascending seq
  markPrices: { marketId: string; price: bigint }[];
  lastSeq: number;
}): void
```

Determinism rules: no `Date.now()`/randomness inside the engine — `ts` always passed
in; ids deterministic: orders `o<seq-at-accept>`, trades `t<seq>`. Market orders MUST
carry `price` as the worst-acceptable-price bound (the api layer defaults it to
best±5%); otherwise rejected INVALID_ORDER. Unfilled market/IOC remainders are
cancelled (reason `ioc`/`slippage`/`bookExhausted`). FOK pre-checks fillability within
the bound and rejects FOK_NOT_FILLED without partial fills. postOnly that would cross
rejects POST_ONLY_WOULD_CROSS. Self-trade: resting own order is cancelled (reason
`selfTrade`), matching continues. Validation order: market exists → qty/price tick&lot
& minNotional → reduceOnly rules → balance/margin lock → postOnly/FOK → match.

## Engine events (emitted, persisted, broadcast)

`orderAccepted, orderRejected, orderFilled (per fill, maker+taker info), orderCancelled,
tradeExecuted, balanceChanged, positionChanged, liquidation, fundingApplied, markPrice`

## REST API (prefix /api)

- `GET /api/health`
- `GET /api/markets` — all markets w/ config + 24h stats
- `GET /api/markets/:id/orderbook?depth=20`
- `GET /api/markets/:id/trades?limit=50`
- `GET /api/markets/:id/candles?interval=1m|5m|15m|1h|4h|1d&limit=200` — REAL candles proxied+cached from Upbit (spot) / Hyperliquid (perp)
- `POST /api/auth/nonce {address}` → `{nonce}`
- `POST /api/auth/verify {address, signature}` → `{token}` (JWT; viem verifyMessage)
- Authed (Bearer): `GET /api/account` (balances, positions, equity),
  `POST /api/account/faucet` (seed demo KRW+USDC, once per account),
  `POST /api/orders` (zod-validated OrderRequest), `DELETE /api/orders/:id`,
  `GET /api/orders?status=open`, `GET /api/fills`, `POST /api/account/leverage {marketId, leverage}`
- Errors: `{error: {code, message}}`, HTTP 400/401/404/409/422.

## WebSocket (path /ws)

JSON messages `{op: 'subscribe'|'unsubscribe', channel, market?}`,
channels: `ticker:<mkt>`, `orderbook:<mkt>` (snapshot then deltas), `trades:<mkt>`,
`allTickers`, and authed `user` (orders/fills/balances/positions) via
`{op:'auth', token}`. Server → `{channel, data, seq}`.

## Real data flow

- Boot: load real Upbit KRW market list (`/v1/market/all`) → spot market configs;
  real Hyperliquid `meta` → perp configs.
- Live: Upbit WS (`wss://api.upbit.com/websocket/v1`, ticker+trade) and Hyperliquid
  WS (`wss://api.hyperliquid.xyz/ws`, allMids) → price cache → engine mark prices
  (perp) + ticker broadcast. REST fallback polling if WS drops. Candles proxied
  with a 5s cache.

## Testing (vitest; brutal by design)

- engine: property-based (fast-check) — fund conservation, book ordering, price-time
  priority, no negative balances, liquidation solvency, idempotent cancels; plus a
  naive reference matcher cross-check over random op sequences.
- db: real PGlite round-trips, projector idempotency (event replay).
- market-data: **live tests against real Upbit/Hyperliquid APIs** (`test:live`).
- api: boot real server (random port) + real PGlite + engine; full lifecycle flows,
  WS subscription correctness, auth attacks (bad sig, replayed nonce, expired JWT),
  validation fuzzing.
- e2e: Playwright — login, trade flow, orderbook updates, chart renders real candles.
