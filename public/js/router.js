import { useState, useEffect } from 'preact/hooks';

function parseHash() {
  // The query string (e.g. ?m=-1) is view state, not part of the route.
  return (location.hash.slice(1) || '/').split('?')[0];
}

// Match route pattern like /budget/:id/log/:date against a path
function matchRoute(pattern, path) {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function useRoute() {
  const [path, setPath] = useState(parseHash);

  useEffect(() => {
    const onChange = () => setPath(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  function match(pattern) {
    return matchRoute(pattern, path);
  }

  return { path, match };
}

export function navigate(path) {
  location.hash = path;
}

// Month offset carried across money screens in the URL (?m=-1). Absent = current month.
export function monthQuery(offset) {
  return offset ? '?m=' + offset : '';
}

export function urlMonthOffset() {
  const query = location.hash.split('?')[1];
  return Number(new URLSearchParams(query).get('m')) || 0;
}
