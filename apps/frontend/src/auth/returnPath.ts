const KEY = 'agent-board.login.return';

const hasControlCharacter = (text: string): boolean =>
  [...text].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);

/** A path on this origin that is not a sign-in page: one slash, then no second slash or backslash and no control character. */
export function isReturnPath(path: string): boolean {
  return /^\/(?![/\\])/.test(path) && !hasControlCharacter(path) && !/^\/login(?:[/?#]|$)/.test(path);
}

/** Keeps where the user first asked to go across the identity provider's round trip. Anything else is ignored. */
export function rememberReturnPath(path: string): void {
  if (!isReturnPath(path)) return;
  try {
    window.sessionStorage.setItem(KEY, path);
  } catch {
    // Without storage, signing in lands on the board.
  }
}

/** The remembered path, once, or the board's start page. Whatever sits in storage is checked again. */
export function takeReturnPath(): string {
  try {
    const path = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return path !== null && isReturnPath(path) ? path : '/';
  } catch {
    return '/';
  }
}
