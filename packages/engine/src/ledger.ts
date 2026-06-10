/**
 * Per-user per-asset balance ledger with available/locked buckets.
 * Enforces non-negativity on every mutation (the CLEARING_ACCOUNT alone may
 * carry a negative `available`). Violations throw DexError(INTERNAL) — they
 * indicate an engine bug, never a user error.
 */
import { DexError, type Balance } from '@dex/shared';

interface Row {
  available: bigint;
  locked: bigint;
}

export class Ledger {
  private readonly accounts = new Map<string, Map<string, Row>>();

  constructor(private readonly negativeAllowed: ReadonlySet<string>) {}

  private rowOf(userId: string, asset: string): Row {
    let assets = this.accounts.get(userId);
    if (!assets) {
      assets = new Map();
      this.accounts.set(userId, assets);
    }
    let row = assets.get(asset);
    if (!row) {
      row = { available: 0n, locked: 0n };
      assets.set(asset, row);
    }
    return row;
  }

  private check(userId: string, asset: string, row: Row): void {
    if (row.locked < 0n || (row.available < 0n && !this.negativeAllowed.has(userId))) {
      throw new DexError(
        'INTERNAL',
        `ledger invariant violated: ${userId} ${asset} available=${row.available} locked=${row.locked}`,
      );
    }
  }

  get(userId: string, asset: string): { available: bigint; locked: bigint } {
    const row = this.accounts.get(userId)?.get(asset);
    return row ? { available: row.available, locked: row.locked } : { available: 0n, locked: 0n };
  }

  available(userId: string, asset: string): bigint {
    return this.get(userId, asset).available;
  }

  /** available += amount (amount may be negative only for negative-allowed accounts). */
  credit(userId: string, asset: string, amount: bigint): void {
    const row = this.rowOf(userId, asset);
    row.available += amount;
    this.check(userId, asset, row);
  }

  /** available -= amount. */
  debit(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new DexError('INTERNAL', 'debit amount < 0');
    const row = this.rowOf(userId, asset);
    row.available -= amount;
    this.check(userId, asset, row);
  }

  /** available -> locked. */
  lock(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new DexError('INTERNAL', 'lock amount < 0');
    const row = this.rowOf(userId, asset);
    row.available -= amount;
    row.locked += amount;
    this.check(userId, asset, row);
  }

  /** locked -> available. */
  unlock(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new DexError('INTERNAL', 'unlock amount < 0');
    const row = this.rowOf(userId, asset);
    row.locked -= amount;
    row.available += amount;
    this.check(userId, asset, row);
  }

  /** locked -= amount (the money leaves this account). */
  spendLocked(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new DexError('INTERNAL', 'spendLocked amount < 0');
    const row = this.rowOf(userId, asset);
    row.locked -= amount;
    this.check(userId, asset, row);
  }

  /** Direct injection for restoreState. */
  setRow(userId: string, asset: string, available: bigint, locked: bigint): void {
    const row = this.rowOf(userId, asset);
    row.available = available;
    row.locked = locked;
    this.check(userId, asset, row);
  }

  balancesOf(userId: string): Balance[] {
    const assets = this.accounts.get(userId);
    if (!assets) return [];
    return [...assets.entries()]
      .map(([asset, row]) => ({ asset, available: row.available, locked: row.locked }))
      .sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  }

  /** Every balance row in the ledger (deterministic order). */
  allRows(): { userId: string; asset: string; available: bigint; locked: bigint }[] {
    const out: { userId: string; asset: string; available: bigint; locked: bigint }[] = [];
    for (const [userId, assets] of this.accounts) {
      for (const [asset, row] of assets) {
        out.push({ userId, asset, available: row.available, locked: row.locked });
      }
    }
    return out;
  }

  clear(): void {
    this.accounts.clear();
  }
}
