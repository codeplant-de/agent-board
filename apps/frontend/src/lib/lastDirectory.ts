export const LAST_DIRECTORY_KEY = 'agent-board.lastDirectory';

export const readLastDirectory = (): string | null => {
  try {
    return localStorage.getItem(LAST_DIRECTORY_KEY);
  } catch {
    return null;
  }
};

export function writeLastDirectory(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(LAST_DIRECTORY_KEY);
    else localStorage.setItem(LAST_DIRECTORY_KEY, value);
  } catch {
    // Storage is blocked: the next form opens empty, as it did before.
  }
}
