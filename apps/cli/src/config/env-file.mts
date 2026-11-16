import { ConfigError, readSecretFile } from './config.mts';

// KEY=value lines; `export`, comments, blank lines and one pair of quotes around the value are fine.
export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return env;
}

// The credentials file: mode 600 or 400, or it is refused.
export function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseEnv(readSecretFile(path, 'credentials file'));
  } catch (error) {
    if (error instanceof ConfigError && error.message.startsWith('credentials file missing'))
      throw new ConfigError(`${error.message} (run "board init")`);
    throw error;
  }
}
