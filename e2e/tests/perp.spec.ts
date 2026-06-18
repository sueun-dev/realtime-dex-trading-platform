/**
 * Perpetual futures through the real UI: leverage, open a long against the
 * REAL mirrored Hyperliquid book, watch the position, close it at market.
 * Plus: proof that the spot orderbook moves by itself (it's the live venue).
 */
import { expect, test, type Page } from '@playwright/test';
import { claimFaucet, connectWallet, expectToast, openTab as openTabIn } from './helpers.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage(); // fresh context → fresh wallet
  await page.goto('/');
});

test.afterAll(async () => {
  await page.close();
});

const openTab = (name: string): Promise<void> => openTabIn(page, name);

test('the BTC-USDC orderbook moves on its own (it is the live venue book)', async () => {
  await expect(page.getByTestId('ask-row-0')).toBeVisible();
  const snapshot = async (): Promise<string> => {
    const parts: string[] = [];
    for (let i = 0; i < 3; i++) {
      parts.push((await page.getByTestId(`ask-row-${i}`).textContent()) ?? '');
      parts.push((await page.getByTestId(`bid-row-${i}`).textContent()) ?? '');
    }
    return parts.join('|');
  };
  const before = await snapshot();
  await expect
    .poll(snapshot, {
      timeout: 60_000,
      message: 'live book should change without any local activity',
    })
    .not.toBe(before);
});

test('switches to BTC-PERP via the selector', async () => {
  await page.getByTestId('market-button').click();
  const selector = page.getByTestId('market-selector');
  await selector.locator('.tabs button', { hasText: 'PERP' }).click();
  await selector.getByPlaceholder(/코인 검색/).fill('BTC');
  await page.getByTestId('market-row').filter({ hasText: 'BTC/USDC' }).first().click();
  await expect(page.getByTestId('market-button')).toContainText('BTC/USDC');
  // real mirrored Hyperliquid depth is live
  await expect(page.getByTestId('ask-row-0')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('spread')).toBeVisible();
  // real Hyperliquid funding rate + next-settlement countdown for the perp
  await expect(page.getByTestId('funding-stat')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('funding-rate')).toContainText('%');
});

test('connects wallet and claims faucet', async () => {
  await connectWallet(page);
  await claimFaucet(page);
  await expect(page.locator('.data-table')).toContainText('USDC');
});

test('opens a 5x long with a market order against the real perp book', async () => {
  const form = page.getByTestId('order-form');
  // leverage slider (debounced POST — give it a beat)
  await form.locator('[aria-label="레버리지"]').fill('5');
  await page.waitForTimeout(700);

  await form.getByRole('button', { name: '시장가' }).click();
  await form.getByPlaceholder('수량').fill('0.01');
  await expect(page.getByTestId('margin-value')).not.toContainText('–');
  await form.getByRole('button', { name: /매수 BTC/ }).click();
  await expectToast(page, '주문이 접수되었습니다');

  await openTab('포지션');
  const row = page.locator('.data-table tbody tr').filter({ hasText: 'BTC-PERP' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('롱');
  await expect(row).toContainText('0.01');
  await expect(row).toContainText('5x');
  // backend-computed liquidation price shows for the open position (gap #17)
  await expect(page.getByTestId('liq-BTC-PERP')).toContainText(/[0-9]/, { timeout: 10_000 });
});

test('closes the position at market (reduce-only)', async () => {
  await openTab('포지션');
  await page.getByRole('button', { name: '시장가 종료' }).click();
  await expect(
    page.locator('.data-table tbody tr').filter({ hasText: 'BTC-PERP' }),
  ).toHaveCount(0, { timeout: 15_000 });

  // both fills (open + close) are in the history
  await openTab('체결 내역');
  const fills = page.locator('.data-table tbody tr').filter({ hasText: 'BTC-PERP' });
  expect(await fills.count()).toBeGreaterThanOrEqual(2);
});

test('places a stop / trigger order and sees it in open orders, then cancels it', async () => {
  const form = page.getByTestId('order-form');
  // a breakout buy stop: dormant until the mark rises through 90,000 (well above
  // the live ~$65k mark), using the default buy direction (이상/above) so it
  // rests UNtriggered without depending on the direction toggle.
  await form.getByRole('button', { name: '지정가' }).click();
  await form.getByPlaceholder('가격').fill('90000');
  await form.getByPlaceholder('수량').fill('0.001');
  await form.getByText(/트리거 주문/).click();
  await expect(form.getByLabel('트리거 가격')).toBeVisible(); // section opened
  await form.getByLabel('트리거 가격').fill('90000');
  await form.getByRole('button', { name: /매수 BTC/ }).click();
  await expectToast(page, '주문이 접수되었습니다');

  // it shows in 미체결 주문 with a 트리거 badge
  await openTab('미체결 주문');
  const badge = page.locator('[data-testid^="trigger-badge-"]').first();
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect(badge).toContainText('트리거');

  // cancel it
  const row = page.locator('.data-table tbody tr').filter({ has: badge });
  await row.getByRole('button', { name: '취소' }).click();
  await expect(page.locator('[data-testid^="trigger-badge-"]')).toHaveCount(0, { timeout: 10_000 });
});
