import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const env = {
  SLACK_APP_TOKEN: 'xapp-1-A-2',
  BOARD_API_URL: 'http://agent-board-backend:4000/',
  INTAKE_TOKEN: 'secret-token',
};

describe('loadConfig', () => {
  it('reads the three settings and drops a trailing slash', () => {
    expect(loadConfig(env)).toEqual({
      appToken: 'xapp-1-A-2',
      apiUrl: 'http://agent-board-backend:4000',
      intakeToken: 'secret-token',
    });
  });

  it('names a missing setting', () => {
    for (const name of Object.keys(env))
      expect(() => loadConfig({ ...env, [name]: ' ' })).toThrow(`Missing required environment variable ${name}`);
  });

  it('rejects a bot token where the app-level token belongs, without echoing it', () => {
    expect(() => loadConfig({ ...env, SLACK_APP_TOKEN: 'xoxb-1-2' })).toThrow(/SLACK_APP_TOKEN must be/);
    expect(() => loadConfig({ ...env, SLACK_APP_TOKEN: 'xoxb-1-2' })).not.toThrow(/xoxb-1-2/);
  });

  it('rejects an address that is not http(s)', () => {
    expect(() => loadConfig({ ...env, BOARD_API_URL: 'agent-board-backend:4000' })).toThrow(/BOARD_API_URL/);
  });
});
