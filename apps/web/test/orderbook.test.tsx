import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { toUnits } from '@dex/shared';
import { OrderBook } from '../src/components/OrderBook.js';

const tick = toUnits('1');

// asks ascending (best first), bids descending (best first) — store order
const asks = [
  { price: toUnits('100'), qty: toUnits('1') },
  { price: toUnits('101'), qty: toUnits('2') },
  { price: toUnits('102'), qty: toUnits('3') },
];
const bids = [
  { price: toUnits('99'), qty: toUnits('1.5') },
  { price: toUnits('98'), qty: toUnits('1') },
  { price: toUnits('97'), qty: toUnits('2') },
];

describe('OrderBook', () => {
  it('renders the best ask adjacent to the spread row (asks reversed)', () => {
    render(<OrderBook tickSize={tick} bids={bids} asks={asks} />);
    const askRows = screen.getAllByTestId(/^ask-row-/);
    // visual order: worst ask (102) first, best ask (100) last
    expect(askRows[0]).toHaveTextContent('102');
    expect(askRows[askRows.length - 1]).toHaveTextContent('100');
  });

  it('renders bids best-first below the spread', () => {
    render(<OrderBook tickSize={tick} bids={bids} asks={asks} />);
    const bidRows = screen.getAllByTestId(/^bid-row-/);
    expect(bidRows[0]).toHaveTextContent('99');
    expect(bidRows[bidRows.length - 1]).toHaveTextContent('97');
  });

  it('shows the absolute and percentage spread', () => {
    render(<OrderBook tickSize={tick} bids={bids} asks={asks} />);
    const spread = screen.getByTestId('spread');
    expect(spread).toHaveTextContent('스프레드');
    expect(spread).toHaveTextContent('1');
    expect(spread).toHaveTextContent('1.00%'); // 1 / 100
  });

  it('sizes cumulative depth bars relative to max cumulative qty', () => {
    render(<OrderBook tickSize={tick} bids={bids} asks={asks} />);
    // ask cumulative: 1, 3, 6 → max cum overall = 6
    expect(screen.getByTestId('ask-bar-0')).toHaveStyle({ width: '16.66%' });
    expect(screen.getByTestId('ask-bar-2')).toHaveStyle({ width: '100.00%' });
    // bid cumulative: 1.5, 2.5, 4.5 → 4.5/6 = 75%
    expect(screen.getByTestId('bid-bar-2')).toHaveStyle({ width: '75.00%' });
  });

  it('fires onPriceClick with the clicked bigint price', () => {
    const onPriceClick = vi.fn();
    render(<OrderBook tickSize={tick} bids={bids} asks={asks} onPriceClick={onPriceClick} />);
    fireEvent.click(screen.getByTestId('ask-row-0'));
    expect(onPriceClick).toHaveBeenCalledWith(toUnits('100'));
    fireEvent.click(screen.getByTestId('bid-row-0'));
    expect(onPriceClick).toHaveBeenCalledWith(toUnits('99'));
  });
});
