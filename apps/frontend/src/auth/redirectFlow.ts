import { toBase64Url } from '@agent-board/shared';

export type RedirectMethod = 'oidc' | 'saml';

const verifierKey = (method: RedirectMethod): string => `agent-board.login.${method}.verifier`;

/** 32 random bytes as base64url: the secret that only this tab knows until the flow comes back. */
export const newVerifier = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** What the server is given when the flow starts: base64url of the SHA-256 of the verifier's text. */
export async function challengeOf(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Where the identity provider is, if the browser may follow it: https, or http when the page itself is http (local dev). */
export function followableUrl(url: string, page: Pick<Location, 'protocol'> = window.location): string | null {
  try {
    const { protocol, href } = new URL(url);
    return protocol === 'https:' || (protocol === 'http:' && page.protocol === 'http:') ? href : null;
  } catch {
    return null;
  }
}

export function keepVerifier(method: RedirectMethod, verifier: string): void {
  window.sessionStorage.setItem(verifierKey(method), verifier);
}

/** The verifier this tab kept, which is deleted by being read: a flow finishes once. */
export function takeVerifier(method: RedirectMethod): string | null {
  try {
    const verifier = window.sessionStorage.getItem(verifierKey(method));
    window.sessionStorage.removeItem(verifierKey(method));
    return verifier;
  } catch {
    return null;
  }
}
