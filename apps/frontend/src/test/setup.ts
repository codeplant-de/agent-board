import { webcrypto } from 'node:crypto';
import '@testing-library/jest-dom/vitest';

// The board's encryption runs on Web Crypto, which jsdom lacks.
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

// Files that run in the node environment (the Caddyfile's) have no DOM to patch.
if (typeof window !== 'undefined') {
  // jsdom lacks these; Mantine components query them on mount.
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Mantine's Select scrolls its active option into view.
  Element.prototype.scrollIntoView ??= () => {};
  // Mantine's autosizing Textarea listens for web fonts loading.
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      value: { addEventListener: () => {}, removeEventListener: () => {}, ready: Promise.resolve() },
    });
  }
}
