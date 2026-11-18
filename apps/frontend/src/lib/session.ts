export const SESSION_MARKER_KEY = 'agent-board.session-changed';

/**
 * The session is an HttpOnly cookie that this code never sees. This marker holds no secret: writing it makes the `storage`
 * event fire in the other tabs, which ask `me` again. It sits in localStorage, not sessionStorage, which tabs do not share.
 */
export function markSessionChanged(): void {
  try {
    window.localStorage.setItem(SESSION_MARKER_KEY, String(Date.now()));
  } catch {
    // Storage is blocked: other tabs find out on their next request.
  }
}

/** Calls `onChange` when another tab signs in or out. A change made by this tab is not reported. */
export function subscribeToSession(onChange: () => void): () => void {
  const listener = (event: StorageEvent): void => {
    if (event.storageArea === window.localStorage && (event.key === SESSION_MARKER_KEY || event.key === null))
      onChange();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
