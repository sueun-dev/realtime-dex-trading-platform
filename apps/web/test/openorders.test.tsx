import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { toUnits } from '@dex/shared';
import { OpenOrdersTable } from '../src/components/BottomPanel.js';
import type { OrderData } from '../src/lib/api.js';
import { useUserStore } from '../src/stores/user.js';
import { SPOT_BTC, renderWithQuery, resetStores, seedMarkets } from './helpers.js';

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function order(overrides: Partial<OrderData> = {}): OrderData {
  return {
    id: 'o1',
    marketId: 'BTC-USDC',
    side: 'sell',
    type: 'market',
    price: null,
    qty: toUnits('0.5'),
    filledQty: 0n,
    status: 'untriggered',
    tif: 'IOC',
    postOnly: false,
    reduceOnly: false,
    trigger: { price: toUnits('90000'), direction: 'below' },
    ts: Date.now(),
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetStores();
  seedMarkets([SPOT_BTC], 'BTC-USDC');
  fetchMock = vi.fn(async () => okJson({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenOrdersTable trigger orders', () => {
  it('renders an untriggered stop-market order with a 트리거 badge and 시장가-less condition', () => {
    useUserStore.setState({ openOrders: [order()] });
    renderWithQuery(<OpenOrdersTable />);

    expect(screen.getByTestId('trigger-badge-o1')).toHaveTextContent('트리거');
    // below → ≤ 90,000 (grouped, tick of 1)
    expect(screen.getByTestId('trigger-cond-o1')).toHaveTextContent('≤ 90,000');
  });

  it('renders an above trigger as ≥', () => {
    useUserStore.setState({
      openOrders: [order({ trigger: { price: toUnits('120000'), direction: 'above' } })],
    });
    renderWithQuery(<OpenOrdersTable />);
    expect(screen.getByTestId('trigger-cond-o1')).toHaveTextContent('≥ 120,000');
  });

  it('cancels an untriggered order via DELETE /api/orders/:id', async () => {
    useUserStore.setState({ openOrders: [order()] });
    renderWithQuery(<OpenOrdersTable />);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orders/o1');
    expect(init.method).toBe('DELETE');
  });
});

function restingLimit(overrides: Partial<OrderData> = {}): OrderData {
  return order({
    type: 'limit',
    price: toUnits('40'),
    qty: toUnits('1'),
    status: 'open',
    tif: 'GTC',
    trigger: null,
    ...overrides,
  });
}

describe('OpenOrdersTable amend', () => {
  it('shows a 수정 button only for plain resting limit orders, not trigger/market orders', () => {
    useUserStore.setState({ openOrders: [order()] }); // market trigger order
    const { unmount } = renderWithQuery(<OpenOrdersTable />);
    expect(screen.queryByTestId('amend-o1')).toBeNull();
    unmount();

    useUserStore.setState({ openOrders: [restingLimit()] });
    renderWithQuery(<OpenOrdersTable />);
    expect(screen.getByTestId('amend-o1')).toBeInTheDocument();
  });

  it('edits price + qty and PATCHes /api/orders/:id with the new decimal strings', async () => {
    useUserStore.setState({ openOrders: [restingLimit()] });
    renderWithQuery(<OpenOrdersTable />);

    fireEvent.click(screen.getByTestId('amend-o1'));
    // inputs prefill with the current values as clean decimals
    const priceInput = screen.getByLabelText('주문 가격 수정') as HTMLInputElement;
    const qtyInput = screen.getByLabelText('주문 수량 수정') as HTMLInputElement;
    expect(priceInput.value).toBe('40');
    expect(qtyInput.value).toBe('1');

    fireEvent.change(priceInput, { target: { value: '42.5' } });
    fireEvent.change(qtyInput, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '확인' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orders/o1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ price: '42.5', qty: '2' });
  });

  it('되돌리기 cancels the edit without any request', () => {
    useUserStore.setState({ openOrders: [restingLimit()] });
    renderWithQuery(<OpenOrdersTable />);

    fireEvent.click(screen.getByTestId('amend-o1'));
    expect(screen.getByLabelText('주문 가격 수정')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    expect(screen.queryByLabelText('주문 가격 수정')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
