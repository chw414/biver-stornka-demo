import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../shared/api';
import { BookingApp } from './BookingApp';
import '../styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // nie ponawiaj błędów 4xx (np. 429) — tylko sieć i 5xx
      retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><BookingApp /></QueryClientProvider>
  </StrictMode>,
);
