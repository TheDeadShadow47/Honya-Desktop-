import { useEffect, useState } from 'react';

// Minimal hash router: "#/reader/<encoded id>" -> { name: 'reader', param: '<id>' }.
export const parseHash = (hash = window.location.hash) => {
  const [name = 'library', param] = hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'library', param: param ? decodeURIComponent(param) : null };
};
export const go = (name, param) => {
  window.location.hash = param != null ? `#/${name}/${encodeURIComponent(param)}` : `#/${name}`;
};
export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
