/**
 * Two REAL users in two isolated browsers trade with each other:
 * A rests a bid inside the live spread, B's market sell crosses it.
 * Wallets, signatures, balances, matching — all real, end to end.
 */
import { expect, test } from '@playwright/test';
import { claimFaucet, connectWallet, expectToast, openTab, bestPrices } from './helpers.js';

const TICK = 1000n * 10n ** 8n; // KRW-BTC tick (price > ₩2M)

test('user↔user: A의 지정가 매수를 B의 시장가 매도가 체결한다', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  try {
    await a.goto('/');
    await b.goto('/');
    await connectWallet(a);
    await claimFaucet(a);
    await connectWallet(b);
    await claimFaucet(b);

    // ---- A: limit bid a third of the way into the live spread — far enough
    // above the real best bid that it stays best while B acts, far enough
    // below the real ask that it rests ----
    const { bid, ask } = await bestPrices(a, 'KRW-BTC');
    expect(ask - bid >= 3n * TICK).toBe(true); // healthy spread to sit inside
    const third = ((ask - bid) / 3n / TICK) * TICK;
    const insideUnits = bid + (third > TICK ? third : TICK);
    expect(insideUnits < ask).toBe(true);
    const insidePrice = insideUnits / 10n ** 8n; // integer KRW
    const formA = a.getByTestId('order-form');
    await formA.getByPlaceholder('가격').fill(insidePrice.toString());
    await formA.getByPlaceholder('수량').fill('0.001');
    await formA.getByRole('button', { name: /매수 BTC/ }).click();
    await expectToast(a, '주문이 접수되었습니다');
    await openTab(a, '미체결 주문');
    await expect(a.locator('.data-table tbody tr')).toHaveCount(1);

    // ---- B: buys inventory from the book, then market-sells into A's bid ----
    const formB = b.getByTestId('order-form');
    await formB.getByRole('button', { name: '시장가' }).click();
    await formB.getByPlaceholder('수량').fill('0.001');
    await formB.getByRole('button', { name: /매수 BTC/ }).click();
    await expectToast(b, '주문이 접수되었습니다');

    await formB.getByRole('button', { name: '매도' }).first().click();
    await formB.getByPlaceholder('수량').fill('0.001');
    await formB.getByRole('button', { name: /매도 BTC/ }).click();
    await expectToast(b, '주문이 접수되었습니다');

    // ---- both sides see the fill ----
    await openTab(a, '체결 내역');
    const aFill = a.locator('.data-table tbody tr').first();
    await expect(aFill).toContainText('매수', { timeout: 15_000 });
    await expect(aFill).toContainText('0.001');
    // A bought at A's own resting price (maker fill at the inside price)
    await expect(aFill).toContainText(Number(insidePrice).toLocaleString('ko-KR'));

    await openTab(b, '체결 내역');
    await expect(b.locator('.data-table tbody tr').first()).toContainText('매도');

    // A holds the coin now
    await openTab(a, '잔고');
    await expect(a.locator('.data-table')).toContainText('BTC');
    await expect(a.locator('.data-table')).toContainText('0.001');
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
