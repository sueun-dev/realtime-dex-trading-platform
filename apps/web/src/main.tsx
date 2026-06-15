import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Self-hosted Pretendard (bundled by Vite) — no external CDN runtime dependency.
// Dynamic subset: per-glyph-range woff2 so the browser only fetches what's used
// (mirrors the previous CDN's *-dynamic-subset behavior).
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import App from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 2000,
    },
  },
});

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('missing #root element');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
