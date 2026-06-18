import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { toUnits } from '@dex/shared';
import { TopBar } from '../src/components/TopBar.js';
import { useMarketStore } from '../src/stores/market.js';
import { PERP_BTC, renderWithQuery, resetStores, seedMarkets, ticker } from './helpers.js';

beforeEach(() => {
  resetStores();
  seedMarkets([PERP_BTC], 'BTC-PERP');
  useMarketStore.setState({ tickers: { 'BTC-PERP': ticker('BTC-PERP', '65000') } });
});

describe('TopBar funding display (gap #16)', () => {
  it('renders the perp funding rate (4-dp signed %) and a mm:ss countdown', () => {
    useMarketStore.setState({
      funding: {
        'BTC-PERP': {
          marketId: 'BTC-PERP',
          rate: toUnits('0.0001'), // +0.01% / hr
          intervalMs: 3_600_000,
          nextFundingTs: Date.now() + 90_000, // ~1:30 out
          ts: Date.now(),
        },
      },
    });
    renderWithQuery(<TopBar />);

    const stat = screen.getByTestId('funding-stat');
    expect(stat).toBeInTheDocument();
    const rate = screen.getByTestId('funding-rate');
    expect(rate).toHaveTextContent('+0.0100%');
    expect(rate).toHaveClass('neg'); // positive rate → longs pay (red)
    expect(stat).toHaveTextContent(/0[01]:\d\d/); // a live mm:ss countdown
  });

  it('shows no funding stat on a market with no funding data', () => {
    renderWithQuery(<TopBar />);
    expect(screen.queryByTestId('funding-stat')).toBeNull();
  });
});
