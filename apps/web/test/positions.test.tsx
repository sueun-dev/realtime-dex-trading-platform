import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { toUnits } from '@dex/shared';
import { PositionsTable } from '../src/components/BottomPanel.js';
import { useMarketStore } from '../src/stores/market.js';
import { useUserStore } from '../src/stores/user.js';
import { PERP_BTC, PERP_ETH, renderWithQuery, resetStores, seedMarkets, ticker } from './helpers.js';

beforeEach(() => {
  resetStores();
  seedMarkets([PERP_BTC, PERP_ETH], 'BTC-PERP');
  useMarketStore.setState({
    tickers: {
      'BTC-PERP': ticker('BTC-PERP', '110'),
      'ETH-PERP': ticker('ETH-PERP', '110'),
    },
  });
  useUserStore.setState({
    positions: [
      { marketId: 'BTC-PERP', size: toUnits('2'), entryPrice: toUnits('100'), leverage: 4, margin: toUnits('50'), markPrice: toUnits('110'), unrealizedPnl: toUnits('20'), liquidationPrice: toUnits('77') },
      { marketId: 'ETH-PERP', size: toUnits('-1'), entryPrice: toUnits('100'), leverage: 2, margin: toUnits('50'), markPrice: toUnits('110'), unrealizedPnl: toUnits('-10'), liquidationPrice: toUnits('148') },
    ],
  });
});

describe('PositionsTable uPnL', () => {
  it('colors a profitable long green with signed value and ROE %', () => {
    renderWithQuery(<PositionsTable />);
    const pnl = screen.getByTestId('pnl-BTC-PERP');
    // long 2 @ 100, mark 110 → uPnL +20, ROE = 20 / 50 margin = +40%
    expect(pnl).toHaveClass('pos');
    expect(pnl).toHaveTextContent('+20');
    expect(pnl).toHaveTextContent('+40.00%');
  });

  it('colors a losing short red', () => {
    renderWithQuery(<PositionsTable />);
    const pnl = screen.getByTestId('pnl-ETH-PERP');
    // short 1 @ 100, mark 110 → uPnL -10, ROE -20%
    expect(pnl).toHaveClass('neg');
    expect(pnl).toHaveTextContent('-10');
    expect(pnl).toHaveTextContent('-20.00%');
  });

  it('renders side badges and a market-close action per position', () => {
    renderWithQuery(<PositionsTable />);
    expect(screen.getByText('롱')).toBeInTheDocument();
    expect(screen.getByText('숏')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '시장가 종료' })).toHaveLength(2);
  });

  it('shows the liquidation price from the backend per position (gap #17)', () => {
    renderWithQuery(<PositionsTable />);
    expect(screen.getByTestId('liq-BTC-PERP')).toHaveTextContent('77');
    expect(screen.getByTestId('liq-ETH-PERP')).toHaveTextContent('148');
  });
});
