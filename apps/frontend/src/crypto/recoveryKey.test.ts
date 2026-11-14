import { describe, expect, it } from 'vitest';
import { KeyError } from './kdf';
import { formatRecoveryKey, parseRecoveryKey, recoveryGroups, sameRecoveryText } from './recoveryKey';

const bytes = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

describe('recovery key', () => {
  it('is 14 groups of four from an alphabet without look-alikes', async () => {
    const text = await formatRecoveryKey(bytes());
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(recoveryGroups(text)).toHaveLength(14);
  });

  it('reads back to the same bytes, in any case and with or without dashes', async () => {
    const key = bytes();
    const text = await formatRecoveryKey(key);
    expect(await parseRecoveryKey(text)).toEqual(key);
    expect(await parseRecoveryKey(text.toLowerCase().replaceAll('-', ' '))).toEqual(key);
    expect(await parseRecoveryKey(text.replaceAll('-', ''))).toEqual(key);
  });

  it('reads O, I and L as 0 and 1', async () => {
    const key = new Uint8Array(32);
    const text = await formatRecoveryKey(key);
    expect(text.startsWith('0000-0000')).toBe(true);
    expect(await parseRecoveryKey(text.replaceAll('0', 'O'))).toEqual(key);
  });

  it('catches a mistyped character by its checksum', async () => {
    const text = await formatRecoveryKey(bytes());
    const wrong = text[0] === '2' ? '3' : '2';
    await expect(parseRecoveryKey(wrong + text.slice(1))).rejects.toBeInstanceOf(KeyError);
  });

  it('refuses text of the wrong length or alphabet', async () => {
    await expect(parseRecoveryKey('')).rejects.toBeInstanceOf(KeyError);
    await expect(parseRecoveryKey('ABCD-EFGH')).rejects.toBeInstanceOf(KeyError);
    await expect(parseRecoveryKey('U'.repeat(56))).rejects.toBeInstanceOf(KeyError);
  });

  it('compares a typed group to the shown one', () => {
    expect(sameRecoveryText(' ab12 ', 'AB12')).toBe(true);
    expect(sameRecoveryText('AB13', 'AB12')).toBe(false);
    expect(sameRecoveryText('', '')).toBe(false);
  });
});
