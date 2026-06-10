/**
 * Database client factory. PGlite = embedded real Postgres; in-memory by
 * default, optionally persisted to a data directory.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { runMigrations } from './migrations.js';
import * as schema from './schema.js';

export type Db = PgliteDatabase<typeof schema>;

/** A drizzle transaction over our schema (also accepted everywhere a Db is). */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything that can execute drizzle queries (root db or transaction). */
export type DbExecutor = Db | DbTx;

export interface DbHandle {
  db: Db;
  pglite: PGlite;
  close: () => Promise<void>;
}

/**
 * Create a database handle. `dataDir` undefined -> ephemeral `memory://`
 * instance; otherwise a filesystem directory for durable storage.
 * Migrations are applied before the handle is returned.
 */
export async function createDb(dataDir?: string): Promise<DbHandle> {
  const pglite = new PGlite(dataDir ?? 'memory://');
  await pglite.waitReady;
  await runMigrations(pglite);
  const db = drizzle(pglite, { schema });
  return {
    db,
    pglite,
    close: async () => {
      if (!pglite.closed) await pglite.close();
    },
  };
}
