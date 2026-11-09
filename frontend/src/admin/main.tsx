import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../shared/api';
import { AdminApp } from './AdminApp';
import '../styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => n < 2 && (!(e instanceof ApiError) || e.status === 0 || e.status >= 500), refetchOnWindowFocus: true },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><AdminApp /></QueryClientProvider></StrictMode>,
);
