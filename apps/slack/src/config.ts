export interface SlackConfig {
  appToken: string;
  /** The backend's address without a trailing slash, as this container reaches it. */
  apiUrl: string;
  intakeToken: string;
}

/** The secrets are never put in a message: a bad value is reported by its variable's name only. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SlackConfig {
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const appToken = read('SLACK_APP_TOKEN');
  if (!appToken.startsWith('xapp-')) throw new Error('SLACK_APP_TOKEN must be an app-level token (xapp-…)');
  const apiUrl = read('BOARD_API_URL');
  if (!/^https?:\/\/[^/]/.test(apiUrl)) throw new Error('BOARD_API_URL must be an http(s) URL');
  return { appToken, apiUrl: apiUrl.replace(/\/+$/, ''), intakeToken: read('INTAKE_TOKEN') };
}
