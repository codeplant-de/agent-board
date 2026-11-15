import { describe, expect, it } from 'vitest';
import { describeError } from './errors';

describe('describeError', () => {
  it('prefers the Slack error code', () => {
    expect(describeError({ data: { error: 'invalid_auth' }, message: 'x' })).toBe('invalid_auth');
  });

  it('never repeats a Slack token or a given secret', () => {
    expect(describeError(new Error('failed with xoxb-123-abc and xapp-1-A2-xyz'))).toBe(
      'failed with [token] and [token]',
    );
    expect(describeError(new Error('bearer s3cret rejected'), ['s3cret'])).toBe('bearer [secret] rejected');
  });
});
