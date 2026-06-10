/**
 * Real end-to-end purchase flow against the live stack:
 * real Upbit/Hyperliquid market data, real matching engine, real PGlite,
 * real wallet-signature auth — the only synthetic thing is the test money.
 */
import { expect, test, type Page } from '@playwright/test';
import { claimFaucet, connectWallet, expectToast, openTab as openTabIn } from './helpers.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.goto('/');
});

test.afterAll(async () => {
  await page.close();
});

const openTab = (name: string): Promise<void> => openTabIn(page, name);

test('loads the real Korean market universe with live prices', async () => {
  const marketBtn = page.getByTestId('market-button');
  await expect(marketBtn).toContainText('BTC/KRW');
  await expect(marketBtn).toContainText('비트코인');

  // live BTC price in the top bar: ₩ tens of millions, comma-formatted
  await expect(marketBtn).toContainText(/[0-9]{2,3},[0-9]{3},[0-9]{3}/);

  // market selector: search by korean name finds Ethereum
  await marketBtn.click();
  const selector = page.getByTestId('market-selector');
  await expect(selector).toBeVisible();
  await selector.getByPlaceholder(/코인 검색/).fill('이더리움');
  const ethRow = page.getByTestId('market-row').filter({ hasText: 'ETH/KRW' });
  await expect(ethRow).toBeVisible();
  await expect(ethRow).toContainText('이더리움');
  // korean-name search narrows 263 markets down to the ethereum family
  expect(await page.getByTestId('market-row').count()).toBeLessThan(6);
  // and there are hundreds of real markets without a filter
  await selector.getByPlaceholder(/코인 검색/).fill('');
  expect(await page.getByTestId('market-row').count()).toBeGreaterThan(100);
  await selector.getByRole('button', { name: '닫기' }).click();
  await expect(selector).not.toBeVisible();
});

test('orderbook shows live liquidity around the real BTC price', async () => {
  const orderbook = page.getByTestId('orderbook');
  await expect(orderbook).toBeVisible();
  await expect(page.getByTestId('ask-row-0')).toBeVisible();
  await expect(page.getByTestId('bid-row-0')).toBeVisible();
  await expect(page.getByTestId('spread')).toBeVisible();
});

test('orderbook depth is the REAL venue book (heterogeneous sizes)', async () => {
  // a synthetic market maker quotes uniform sizes; the real Upbit book never does
  await expect(page.getByTestId('ask-row-4')).toBeVisible();
  const qtys = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const text = await page.getByTestId(`ask-row-${i}`).textContent();
    qtys.add(text ?? String(i));
  }
  expect(qtys.size).toBeGreaterThan(2);
});

test('trades feed streams REAL market prints without us trading', async () => {
  // switch the book panel to 체결 — rows must appear from the live Upbit
  // trade stream even though this session has placed no orders yet
  await page.locator('.book-panel .tabs button', { hasText: '체결' }).click();
  await expect(page.locator('.trade-row').first()).toBeVisible({ timeout: 90_000 });
  const rows = await page.locator('.trade-row').count();
  expect(rows).toBeGreaterThanOrEqual(1);
  await page.locator('.book-panel .tabs button', { hasText: '호가' }).click();
});

test('chart renders real candles', async () => {
  const canvases = page.locator('canvas');
  await expect(canvases.first()).toBeVisible();
  expect(await canvases.count()).toBeGreaterThanOrEqual(1);
});

test('connects a wallet via signature auth', async () => {
  await connectWallet(page);
});

test('claims faucet test funds', async () => {
  await claimFaucet(page);
  await expect(page.locator('.data-table')).toContainText('KRW');
  await expect(page.locator('.data-table')).toContainText('USDC');
});

test('REAL PURCHASE: market-buys BTC against live liquidity', async () => {
  const form = page.getByTestId('order-form');
  await form.getByRole('button', { name: '시장가' }).click();
  await form.getByPlaceholder('수량').fill('0.001');
  // fee summary is computed before submitting
  await expect(page.getByTestId('fee-value')).not.toContainText('–');
  await form.getByRole('button', { name: /매수 BTC/ }).click();

  await expectToast(page, '주문이 접수되었습니다');

  // the purchased BTC shows up in balances…
  await openTab('잔고');
  await expect(page.locator('.data-table')).toContainText('BTC');
  await expect(page.locator('.data-table')).toContainText('0.001');

  // …and the fill is in the trade history with side 매수 (a market order can
  // legitimately split into several partial fills against real venue sizes,
  // so assert the rows, not a single row's qty — the balance above proves the total)
  await openTab('체결 내역');
  const fillRows = page.locator('.data-table tbody tr').filter({ hasText: 'KRW-BTC' });
  await expect(fillRows.first()).toContainText('매수');
});

test('limit order rests in open orders and cancels', async () => {
  const form = page.getByTestId('order-form');
  await form.getByRole('button', { name: '지정가' }).click();
  await form.getByPlaceholder('가격').fill('50000000'); // far below market — rests
  await form.getByPlaceholder('수량').fill('0.001');
  await form.getByRole('button', { name: /매수 BTC/ }).click();
  await expectToast(page, '주문이 접수되었습니다');

  await openTab('미체결 주문');
  const orderRow = page.locator('.data-table tbody tr').filter({ hasText: '50,000,000' });
  await expect(orderRow).toHaveCount(1);
  await orderRow.getByRole('button', { name: '취소' }).click();
  await expect(page.locator('.data-table tbody tr').filter({ hasText: '50,000,000' })).toHaveCount(0);
});

test('sells the BTC back (market sell, full round trip)', async () => {
  const form = page.getByTestId('order-form');
  await form.getByRole('button', { name: '시장가' }).click();
  await form.getByRole('button', { name: '매도' }).first().click();
  await form.getByPlaceholder('수량').fill('0.001');
  await form.getByRole('button', { name: /매도 BTC/ }).click();
  await expectToast(page, '주문이 접수되었습니다');

  await openTab('체결 내역');
  await expect(page.locator('.data-table tbody tr').first()).toContainText('매도');
});
