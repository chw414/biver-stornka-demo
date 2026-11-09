import { useEffect, useState } from 'react';

/** Minimalny router na hash (#/kalendarz?d=...) — bez zależności, działa ze statycznym hostingiem. */
export interface Route { path: string; params: URLSearchParams }

function parse(): Route {
  const raw = location.hash.replace(/^#/, '') || '/kalendarz';
  const [path, query] = raw.split('?');
  return { path: path || '/kalendarz', params: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path: string, params?: Record<string, string>, replace = false) {
  const q = params ? `?${new URLSearchParams(params)}` : '';
  const url = `#${path}${q}`;
  if (replace) history.replaceState(null, '', url); else location.hash = url;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}
