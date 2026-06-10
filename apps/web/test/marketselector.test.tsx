import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarketSelector } from '../src/components/MarketSelector.js';
import { useMarketStore } from '../src/stores/market.js';
import { PERP_BTC, SPOT_BTC, SPOT_ETH, resetStores, seedMarkets, ticker } from './helpers.js';

function seedSelector(): void {
  seedMarkets([SPOT_BTC, SPOT_ETH, PERP_BTC], 'KRW-BTC');
  useMarketStore.setState({
    selectorOpen: true,
    tickers: {
      'KRW-BTC': ticker('KRW-BTC', '93130000', '0.05'),
      'KRW-ETH': ticker('KRW-ETH', '5000000', '-0.02'),
      'BTC-PERP': ticker('BTC-PERP', '68000', '0.01'),
    },
  });
}

beforeEach(() => {
  resetStores();
  seedSelector();
});

describe('MarketSelector', () => {
  it('lists all markets with live price and colored 24h change', () => {
    render(<MarketSelector />);
    const rows = screen.getAllByTestId('market-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('비트코인');
    expect(rows[0]).toHaveTextContent('93,130,000');
    expect(rows[0]).toHaveTextContent('+5.00%');
    expect(rows[1]).toHaveTextContent('-2.00%');
  });

  it('searches by korean name', () => {
    render(<MarketSelector />);
    fireEvent.change(screen.getByPlaceholderText('코인 검색 (비트코인, BTC…)'), { target: { value: '비트' } });
    const rows = screen.getAllByTestId('market-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('BTC/KRW');
  });

  it('searches by english name', () => {
    render(<MarketSelector />);
    fireEvent.change(screen.getByPlaceholderText('코인 검색 (비트코인, BTC…)'), { target: { value: 'ethereum' } });
    const rows = screen.getAllByTestId('market-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('ETH/KRW');
  });

  it('searches by symbol across spot and perp', () => {
    render(<MarketSelector />);
    fireEvent.change(screen.getByPlaceholderText('코인 검색 (비트코인, BTC…)'), { target: { value: 'btc' } });
    expect(screen.getAllByTestId('market-row')).toHaveLength(2);
  });

  it('filters by KRW / PERP / 전체 tabs', () => {
    render(<MarketSelector />);
    fireEvent.click(screen.getByRole('button', { name: 'KRW' }));
    expect(screen.getAllByTestId('market-row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'PERP' }));
    expect(screen.getAllByTestId('market-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '전체' }));
    expect(screen.getAllByTestId('market-row')).toHaveLength(3);
  });

  it('selects a market and closes on row click', () => {
    render(<MarketSelector />);
    fireEvent.click(screen.getByRole('button', { name: 'PERP' }));
    fireEvent.click(screen.getAllByTestId('market-row')[0]!);
    expect(useMarketStore.getState().selectedId).toBe('BTC-PERP');
    expect(useMarketStore.getState().selectorOpen).toBe(false);
  });
});
