/**
 * Wallet auth: a locally generated (and persisted) private key signs the
 * server nonce — EIP-191 personal_sign via viem — and we exchange it for a JWT.
 */
import { create } from 'zustand';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { apiFetch, setTokenProvider } from './api.js';

export const PK_STORAGE_KEY = 'dex.pk';

export type AuthStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface AuthState {
  address: string | null;
  token: string | null;
  status: AuthStatus;
  login: () => Promise<string>;
  logout: () => void;
}

function loadOrCreatePrivateKey(): `0x${string}` {
  const existing = localStorage.getItem(PK_STORAGE_KEY);
  if (existing !== null && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
    return existing as `0x${string}`;
  }
  const pk = generatePrivateKey();
  localStorage.setItem(PK_STORAGE_KEY, pk);
  return pk;
}

export function hasStoredKey(): boolean {
  try {
    return localStorage.getItem(PK_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export const useAuthStore = create<AuthState>()((set) => ({
  address: null,
  token: null,
  status: 'idle',

  async login(): Promise<string> {
    set({ status: 'connecting' });
    try {
      const account = privateKeyToAccount(loadOrCreatePrivateKey());
      const address = account.address.toLowerCase();
      const { nonce } = await apiFetch<{ nonce: string }>('/auth/nonce', {
        method: 'POST',
        body: { address },
      });
      const signature = await account.signMessage({ message: nonce });
      const { token } = await apiFetch<{ token: string }>('/auth/verify', {
        method: 'POST',
        body: { address, signature },
      });
      set({ address, token, status: 'connected' });
      return token;
    } catch (e) {
      set({ status: 'error' });
      throw e;
    }
  },

  logout(): void {
    set({ address: null, token: null, status: 'idle' });
  },
}));

// Authed fetches read the live token without creating an import cycle.
setTokenProvider(() => useAuthStore.getState().token);
