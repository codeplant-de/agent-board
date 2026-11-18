import { describe, expect, it } from 'vitest';
import { challengeOf, followableUrl, keepVerifier, newVerifier, takeVerifier } from './redirectFlow';

describe('the verifier of a redirect flow', () => {
  it('is 32 random bytes as base64url, different each time', () => {
    const verifier = newVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newVerifier()).not.toBe(verifier);
  });

  it('has the challenge the server checks: base64url of the SHA-256 of its text', async () => {
    // The SHA-256 of "abc", as base64url.
    expect(await challengeOf('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    expect(await challengeOf(newVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is kept per method and gone once read', () => {
    keepVerifier('oidc', 'one');
    keepVerifier('saml', 'two');
    expect(takeVerifier('oidc')).toBe('one');
    expect(takeVerifier('oidc')).toBeNull();
    expect(takeVerifier('saml')).toBe('two');
  });
});

describe('the address the browser may follow to the identity provider', () => {
  const https = { protocol: 'https:' };
  const http = { protocol: 'http:' };

  it('is an https address', () => {
    expect(followableUrl('https://idp.example/auth?x=1', https)).toBe('https://idp.example/auth?x=1');
    expect(followableUrl('https://idp.example/auth', http)).toBe('https://idp.example/auth');
  });

  it('is an http address only when the page itself is http', () => {
    expect(followableUrl('http://localhost:8080/auth', http)).toBe('http://localhost:8080/auth');
    expect(followableUrl('http://idp.example/auth', https)).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///etc/passwd',
    'blob:https://idp.example/x',
    'ftp://idp.example/',
    '//idp.example/auth',
    '/login/saml',
    'idp.example',
    '',
  ])('is never %s', (url) => {
    expect(followableUrl(url, http)).toBeNull();
    expect(followableUrl(url, https)).toBeNull();
  });
});
