import { afterEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type DbHandle } from '../src/index.js';

const EXPECTED_TABLES = [
  'auth_nonces',
  'balances',
  'candles_cache',
  'funding_payments',
  'liquidations',
  'markets',
  'meta',
  'orders',
  'positions',
  'realized_pnl_events',
  'trades',
  'user_market_leverage',
  'users',
];

let handle: DbHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('migrations', () => {
  it('creates all tables and required indexes', async () => {
    handle = await createDb();
    const tables = await handle.pglite.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);

    const indexes = await handle.pglite.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = 'public' and indexname like '%\\_idx' order by indexname`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      'orders_market_seq_idx',
      'orders_market_status_idx',
      'orders_user_status_idx',
      'realized_pnl_user_seq_idx',
      'trades_market_seq_idx',
    ]);
  });

  it('is idempotent: re-running migrations twice neither throws nor drops data', async () => {
    handle = await createDb(); // first run inside createDb
    await handle.pglite.query(`insert into meta (key, value) values ('canary', '42')`);

    await expect(runMigrations(handle.pglite)).resolves.toBeUndefined(); // second run
    await expect(runMigrations(handle.pglite)).resolves.toBeUndefined(); // third run

    const tables = await handle.pglite.query<{ n: number }>(
      `select count(*)::int4 as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(tables.rows[0]?.n).toBe(EXPECTED_TABLES.length);

    const canary = await handle.pglite.query<{ value: string }>(
      `select value from meta where key = 'canary'`,
    );
    expect(canary.rows[0]?.value).toBe('42');
  });

  it('seeds the projector watermark at 0 and re-running never resets a live cursor', async () => {
    handle = await createDb();
    const seeded = await handle.pglite.query<{ value: string }>(
      `select value from meta where key = 'last_applied_seq'`,
    );
    expect(seeded.rows).toEqual([{ value: '0' }]); // row exists → FOR UPDATE can lock it

    await handle.pglite.query(`update meta set value = '123' where key = 'last_applied_seq'`);
    await runMigrations(handle.pglite); // idempotent re-run
    const after = await handle.pglite.query<{ value: string }>(
      `select value from meta where key = 'last_applied_seq'`,
    );
    expect(after.rows).toEqual([{ value: '123' }]); // live cursor untouched
  });

  it('positions.margin is NOT NULL (engine always emits the exact margin)', async () => {
    handle = await createDb();
    const col = await handle.pglite.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
       where table_name = 'positions' and column_name = 'margin'`,
    );
    expect(col.rows[0]?.is_nullable).toBe('NO');
  });

  it('money columns are numeric(38,0)', async () => {
    handle = await createDb();
    const cols = await handle.pglite.query<{
      column_name: string;
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(
      `select column_name, data_type, numeric_precision, numeric_scale
       from information_schema.columns
       where table_name = 'balances' and column_name in ('available', 'locked')
       order by column_name`,
    );
    expect(cols.rows).toHaveLength(2);
    for (const c of cols.rows) {
      expect(c.data_type).toBe('numeric');
      expect(c.numeric_precision).toBe(38);
      expect(c.numeric_scale).toBe(0);
    }
  });
});
