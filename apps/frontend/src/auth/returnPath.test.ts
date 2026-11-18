import { beforeEach, describe, expect, it } from 'vitest';
import { isReturnPath, rememberReturnPath, takeReturnPath } from './returnPath';

beforeEach(() => sessionStorage.clear());

describe('the path to return to after signing in', () => {
  it('is kept across the round trip and used once', () => {
    rememberReturnPath('/t/abc?tab=notes#end');
    expect(takeReturnPath()).toBe('/t/abc?tab=notes#end');
    expect(takeReturnPath()).toBe('/');
  });

  it('is the board’s start page when none was kept', () => {
    expect(takeReturnPath()).toBe('/');
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    't/abc',
    '',
    '/login',
    '/login/oidc?code=x',
    '/login?x',
    '/a\nb',
  ])('never keeps %j', (path) => {
    expect(isReturnPath(path)).toBe(false);
    rememberReturnPath('/t/first');
    rememberReturnPath(path);
    expect(takeReturnPath()).toBe('/t/first');
  });

  it('checks again what it reads, as storage may hold anything', () => {
    sessionStorage.setItem('agent-board.login.return', '//evil.example');
    expect(takeReturnPath()).toBe('/');
  });

  it('accepts the board’s own pages', () => {
    for (const path of ['/', '/t/abc', '/settings', '/loginfo']) expect(isReturnPath(path)).toBe(true);
  });
});
