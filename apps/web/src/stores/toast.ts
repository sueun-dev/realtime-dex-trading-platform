import { create } from 'zustand';

export type ToastKind = 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const TOAST_TTL_MS = 4000;
let nextId = 1;

export interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, text: string) => void;
  remove: (id: number) => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],

  push: (kind, text) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, TOAST_TTL_MS);
  },

  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (text: string): void => useToastStore.getState().push('success', text),
  error: (text: string): void => useToastStore.getState().push('error', text),
};
