import { expect, type Page } from '@playwright/test';

/** Click a bottom-panel tab (포지션 / 미체결 주문 / 체결 내역 / 잔고). */
export async function openTab(page: Page, name: string): Promise<void> {
  await page.locator('.tabs button', { hasText: name }).first().click();
}

/** Generate a wallet in this context and complete the signature login. */
export async function connectWallet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '지갑 연결' }).click();
  await expect(page.locator('.wallet-btn')).toContainText(/^0x/, { timeout: 15_000 });
}

/** Claim the demo USDC collateral and wait until it shows in the balances table. */
export async function claimFaucet(page: Page): Promise<void> {
  await openTab(page, '잔고');
  await page.getByRole('button', { name: '테스트 자금 받기' }).click();
  await expect(page.locator('.data-table')).toContainText('USDC');
  await expect(page.locator('.data-table')).toContainText('100,000');
}

export async function expectToast(page: Page, text: string): Promise<void> {
  await expect(page.locator('.toast, [class*=toast]').first()).toContainText(text);
}

/** Exact current best bid/ask (1e8-scaled ints as strings) straight from the API. */
export async function bestPrices(
  page: Page,
  marketId: string,
): Promise<{ bid: bigint; ask: bigint }> {
  const res = await page.request.get(`/api/markets/${marketId}/orderbook?depth=1`);
  const body = (await res.json()) as {
    bids: { price: string }[];
    asks: { price: string }[];
  };
  const toUnits = (s: string): bigint => {
    const [i = '0', f = ''] = s.split('.');
    return BigInt(i) * 10n ** 8n + BigInt(f.padEnd(8, '0').slice(0, 8));
  };
  if (!body.bids[0] || !body.asks[0]) throw new Error('book empty');
  return { bid: toUnits(body.bids[0].price), ask: toUnits(body.asks[0].price) };
}
