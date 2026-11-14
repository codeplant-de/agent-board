const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

export interface Config {
  nodeEnv: string;
  port: number;
  /** Owner/admin connection: bootstrap and migrations only. */
  databaseUrl: string;
  /** The unprivileged `board_app` connection that serves every request. */
  appDatabaseUrl: string;
  /** Where people open the board; task URLs are <publicUrl>/t/<id>. */
  publicUrl: string;
  /** Authelia groups that may use the board. */
  allowedGroups: string[];
  /** Local development only: act as this user instead of reading Authelia headers. */
  devAuthUser: string | null;
}

export function loadConfig(): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const devAuthUser = process.env.DEV_AUTH_USER?.trim() || null;
  if (devAuthUser && nodeEnv === 'production') {
    throw new Error('DEV_AUTH_USER must not be set in production');
  }
  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s<>|]+$/.test(publicUrl)) throw new Error('PUBLIC_URL must be an http(s) URL');
  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 4000),
    databaseUrl: requireEnv('DATABASE_URL'),
    appDatabaseUrl: requireEnv('APP_DATABASE_URL'),
    publicUrl,
    allowedGroups: (process.env.ALLOWED_GROUPS ?? 'admins')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
    devAuthUser,
  };
}
