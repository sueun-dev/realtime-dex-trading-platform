import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { feeOn, mulUnits, toUnits } from '@dex/shared';
import { OrderForm } from '../src/components/OrderForm.js';
import { Toasts } from '../src/components/Toasts.js';
import { formatKRW } from '../src/lib/format.js';
import { useAuthStore } from '../src/lib/auth.js';
import { useBookStore } from '../src/stores/book.js';
import { useMarketStore } from '../src/stores/market.js';
import { useUserStore } from '../src/stores/user.js';
import { PERP_BTC, SPOT_BTC, renderWithQuery, resetStores, seedMarkets } from './helpers.js';

function okJson(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function errJson(status: number, code: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code, message: code } }),
  } as unknown as Response;
}

function seedSpot(): void {
  seedMarkets([SPOT_BTC], 'KRW-BTC');
  useBookStore.setState({
    marketId: 'KRW-BTC',
    bids: [{ price: toUnits('99000'), qty: toUnits('5') }],
    asks: [{ price: toUnits('100000'), qty: toUnits('5') }],
    seq: 1,
    trades: [],
  });
  useUserStore.setState({
    balances: {
      KRW: { available: toUnits('1000000'), locked: 0n },
      BTC: { available: toUnits('2'), locked: 0n },
    },
  });
  useAuthStore.setState({ address: '0xabc', token: 'test-token', status: 'connected' });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetStores();
  fetchMock = vi.fn(async () => okJson({ order: { id: 'o1' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OrderForm validation', () => {
  it('requires a quantity before submitting', async () => {
    seedSpot();
    renderWithQuery(
      <>
        <OrderForm />
        <Toasts />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '매수 BTC' }));
    expect(await screen.findByText('수량을 입력해주세요')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a price for limit orders', async () => {
    seedSpot();
    renderWithQuery(
      <>
        <OrderForm />
        <Toasts />
      </>,
    );
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '매수 BTC' }));
    expect(await screen.findByText('가격을 입력해주세요')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the price input in market mode with 시장가 placeholder', () => {
    seedSpot();
    renderWithQuery(<OrderForm />);
    fireEvent.click(screen.getByRole('button', { name: '시장가' }));
    const priceInput = screen.getByPlaceholderText('시장가');
    expect(priceInput).toBeDisabled();
  });
});

describe('OrderForm percentage buttons', () => {
  it('derives buy quantity from quote balance net of taker fee', () => {
    seedSpot();
    renderWithQuery(<OrderForm />);
    fireEvent.change(screen.getByPlaceholderText('가격'), { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: '50%' }));
    // budget 500,000 KRW / (100,000 + 100 fee) per BTC → 4.99500499 → lot 0.0001 → 4.995
    expect(screen.getByPlaceholderText('수량')).toHaveValue('4.995');
    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(screen.getByPlaceholderText('수량')).toHaveValue('9.99');
  });

  it('derives sell quantity from base balance', () => {
    seedSpot();
    renderWithQuery(<OrderForm />);
    fireEvent.click(screen.getByRole('button', { name: '매도' }));
    fireEvent.click(screen.getByRole('button', { name: '75%' }));
    expect(screen.getByPlaceholderText('수량')).toHaveValue('1.5');
  });
});

describe('OrderForm summary', () => {
  it('shows notional and fee matching shared feeOn math', () => {
    seedSpot();
    renderWithQuery(<OrderForm />);
    fireEvent.change(screen.getByPlaceholderText('가격'), { target: { value: '100000' } });
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '2' } });
    const notional = mulUnits(toUnits('2'), toUnits('100000'));
    const fee = feeOn(notional, SPOT_BTC.takerFeeBps);
    expect(screen.getByTestId('notional-value')).toHaveTextContent(`${formatKRW(notional)} KRW`);
    expect(screen.getByTestId('fee-value')).toHaveTextContent(`${formatKRW(fee)} KRW`);
    expect(screen.getByTestId('notional-value')).toHaveTextContent('200,000 KRW');
    expect(screen.getByTestId('fee-value')).toHaveTextContent('200 KRW');
  });

  it('shows perp required margin = notional / leverage', () => {
    seedMarkets([PERP_BTC], 'BTC-PERP');
    useBookStore.setState({
      marketId: 'BTC-PERP',
      bids: [{ price: toUnits('99'), qty: toUnits('10') }],
      asks: [{ price: toUnits('100'), qty: toUnits('10') }],
      seq: 1,
      trades: [],
    });
    useUserStore.setState({ balances: { USDC: { available: toUnits('10000'), locked: 0n } } });
    useAuthStore.setState({ address: '0xabc', token: 'test-token', status: 'connected' });
    renderWithQuery(<OrderForm />);

    fireEvent.change(screen.getByPlaceholderText('가격'), { target: { value: '100' } });
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '10' } });
    expect(screen.getByTestId('margin-value')).toHaveTextContent('1,000 USDC');

    fireEvent.change(screen.getByLabelText('레버리지'), { target: { value: '4' } });
    expect(screen.getByTestId('margin-value')).toHaveTextContent('250 USDC');
    expect(screen.getByRole('checkbox', { name: 'Reduce Only' })).toBeInTheDocument();
  });
});

describe('OrderForm submission', () => {
  it('POSTs the exact limit order JSON body with Bearer auth', async () => {
    seedSpot();
    renderWithQuery(
      <>
        <OrderForm />
        <Toasts />
      </>,
    );
    fireEvent.change(screen.getByPlaceholderText('가격'), { target: { value: '100000' } });
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: '매수 BTC' }));

    expect(await screen.findByText('주문이 접수되었습니다')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/orders');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-token');
    expect(JSON.parse(init.body as string)).toEqual({
      marketId: 'KRW-BTC',
      side: 'buy',
      type: 'limit',
      price: '100000',
      qty: '1.5',
      tif: 'GTC',
      postOnly: false,
    });
  });

  it('submits market orders as IOC with a best±5% price bound', async () => {
    seedSpot();
    renderWithQuery(
      <>
        <OrderForm />
        <Toasts />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '시장가' }));
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '매수 BTC' }));

    expect(await screen.findByText('주문이 접수되었습니다')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      marketId: 'KRW-BTC',
      side: 'buy',
      type: 'market',
      price: '105000', // best ask 100,000 × 1.05
      qty: '1',
      tif: 'IOC',
    });
  });

  it('maps API error codes to Korean toasts', async () => {
    seedSpot();
    fetchMock.mockResolvedValueOnce(errJson(422, 'INSUFFICIENT_BALANCE'));
    renderWithQuery(
      <>
        <OrderForm />
        <Toasts />
      </>,
    );
    fireEvent.change(screen.getByPlaceholderText('가격'), { target: { value: '100000' } });
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: '매수 BTC' }));
    expect(await screen.findByText('잔고가 부족합니다')).toBeInTheDocument();
  });

  it('requires a connected wallet', async () => {
    seedSpot();
    useAuthStore.setState({ address: null, token: null, status: 'idle' });
    renderWithQuery(
      <>
        <OrderForm />
        <Toasts />
      </>,
    );
    fireEvent.change(screen.getByPlaceholderText('가격'), { target: { value: '100000' } });
    fireEvent.change(screen.getByPlaceholderText('수량'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '매수 BTC' }));
    expect(await screen.findByText('지갑을 먼저 연결해주세요')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
