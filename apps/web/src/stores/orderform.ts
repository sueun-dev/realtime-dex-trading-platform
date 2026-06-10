import { create } from 'zustand';

/**
 * Tiny cross-component store: the orderbook fills the order-form price input
 * when a price level is clicked.
 */
export interface OrderFormState {
  priceStr: string;
  setPriceStr: (s: string) => void;
}

export const useOrderFormStore = create<OrderFormState>()((set) => ({
  priceStr: '',
  setPriceStr: (priceStr) => set({ priceStr }),
}));
