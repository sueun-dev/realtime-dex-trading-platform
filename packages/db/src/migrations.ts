/**
 * Hand-written, authoritative DDL for @dex/db. No drizzle-kit at runtime —
 * the drizzle schema in schema.ts MUST mirror this file exactly.
 *
 * Every statement is idempotent (CREATE ... IF NOT EXISTS), so runMigrations
 * may be called any number of times against the same database.
 *
 * Deliberate decision — no FOREIGN KEY constraints: this is a write-behind
 * projection of the engine's event stream, not the system of record. The
 * engine is the runtime source of truth and already enforces referential
 * integrity (an event can only reference users/markets/orders the engine
 * knows about); FKs here would only add insert-ordering constraints between
 * projected tables (e.g. balances before users exist — users are created by
 * the auth path, not by engine events) without catching real corruption,
 * which the projector detects explicitly (seq-cursor + loud failures on
 * missing rows).
 */
import type { PGlite } from '@electric-sql/pglite';

export const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  created_at bigint NOT NULL,
  faucet_claimed_at bigint
);

CREATE TABLE IF NOT EXISTS markets (
  id text PRIMARY KEY,
  type text NOT NULL,
  base text NOT NULL,
  quote text NOT NULL,
  korean_name text,
  english_name text,
  tick_size numeric(38,0) NOT NULL,
  lot_size numeric(38,0) NOT NULL,
  min_notional numeric(38,0) NOT NULL,
  maker_fee_bps integer NOT NULL,
  taker_fee_bps integer NOT NULL,
  max_leverage integer NOT NULL
);

CREATE TABLE IF NOT EXISTS balances (
  user_id text NOT NULL,
  asset text NOT NULL,
  available numeric(38,0) NOT NULL,
  locked numeric(38,0) NOT NULL,
  PRIMARY KEY (user_id, asset)
);

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  market_id text NOT NULL,
  side text NOT NULL,
  type text NOT NULL,
  price numeric(38,0),
  qty numeric(38,0) NOT NULL,
  filled_qty numeric(38,0) NOT NULL,
  status text NOT NULL,
  tif text NOT NULL,
  post_only boolean NOT NULL,
  reduce_only boolean NOT NULL,
  client_order_id text,
  trigger_price numeric(38,0),
  trigger_direction text,
  trigger_trail numeric(38,0),
  seq bigint NOT NULL,
  ts bigint NOT NULL
);
-- additive column migration for DBs created before trailing stops existed
-- (CREATE TABLE IF NOT EXISTS above is a no-op on an existing table)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS trigger_trail numeric(38,0);
CREATE INDEX IF NOT EXISTS orders_user_status_idx ON orders (user_id, status);
CREATE INDEX IF NOT EXISTS orders_market_status_idx ON orders (market_id, status);
CREATE INDEX IF NOT EXISTS orders_market_seq_idx ON orders (market_id, seq);

CREATE TABLE IF NOT EXISTS trades (
  id text PRIMARY KEY,
  market_id text NOT NULL,
  price numeric(38,0) NOT NULL,
  qty numeric(38,0) NOT NULL,
  taker_side text NOT NULL,
  maker_order_id text NOT NULL,
  taker_order_id text NOT NULL,
  maker_user_id text NOT NULL,
  taker_user_id text NOT NULL,
  maker_fee numeric(38,0) NOT NULL,
  taker_fee numeric(38,0) NOT NULL,
  seq bigint NOT NULL,
  ts bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_market_seq_idx ON trades (market_id, seq);

CREATE TABLE IF NOT EXISTS positions (
  user_id text NOT NULL,
  market_id text NOT NULL,
  size numeric(38,0) NOT NULL,
  entry_price numeric(38,0) NOT NULL,
  leverage integer NOT NULL,
  -- engine's exact isolated margin, verbatim from PositionChangedEvent.margin
  margin numeric(38,0) NOT NULL,
  PRIMARY KEY (user_id, market_id)
);

CREATE TABLE IF NOT EXISTS user_market_leverage (
  user_id text NOT NULL,
  market_id text NOT NULL,
  leverage integer NOT NULL,
  PRIMARY KEY (user_id, market_id)
);

CREATE TABLE IF NOT EXISTS funding_payments (
  id bigserial PRIMARY KEY,
  market_id text NOT NULL,
  user_id text NOT NULL,
  rate numeric(38,0) NOT NULL,
  payment numeric(38,0) NOT NULL,
  mark_price numeric(38,0) NOT NULL,
  seq bigint NOT NULL,
  ts bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS liquidations (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  market_id text NOT NULL,
  size numeric(38,0) NOT NULL,
  mark_price numeric(38,0) NOT NULL,
  seq bigint NOT NULL,
  ts bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS realized_pnl_events (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  market_id text NOT NULL,
  amount numeric(38,0) NOT NULL,
  seq bigint NOT NULL,
  ts bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS realized_pnl_user_seq_idx ON realized_pnl_events (user_id, seq);

CREATE TABLE IF NOT EXISTS realized_pnl_carryover (
  user_id text NOT NULL,
  market_id text NOT NULL,
  amount numeric(38,0) NOT NULL,
  PRIMARY KEY (user_id, market_id)
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  address text NOT NULL,
  nonce text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (address, nonce)
);

CREATE TABLE IF NOT EXISTS candles_cache (
  market_id text NOT NULL,
  "interval" text NOT NULL,
  t bigint NOT NULL,
  o numeric(38,0) NOT NULL,
  h numeric(38,0) NOT NULL,
  l numeric(38,0) NOT NULL,
  c numeric(38,0) NOT NULL,
  v numeric(38,0) NOT NULL,
  fetched_at bigint NOT NULL,
  PRIMARY KEY (market_id, "interval", t)
);

CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

-- Seed the projector watermark so its SELECT ... FOR UPDATE always has a row
-- to lock (concurrent projectors on a pooled Postgres serialize on it; a
-- missing row cannot be locked). Idempotent: never resets a live cursor.
INSERT INTO meta (key, value) VALUES ('last_applied_seq', '0')
  ON CONFLICT (key) DO NOTHING;
`;

/** Apply the authoritative DDL. Safe to call repeatedly. */
export async function runMigrations(pglite: PGlite): Promise<void> {
  await pglite.exec(MIGRATIONS_SQL);
}
