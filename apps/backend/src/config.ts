const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

/** The Slack companion's access to the board: it needs a token, and the public URL for the links it hands out. */
export interface IntakeConfig {
  token: string;
  /** The board's public URL without a trailing slash. */
  boardUrl: string;
}

export interface Config {
  nodeEnv: string;
  port: number;
  /** Owner/admin connection: bootstrap and migrations only. */
  databaseUrl: string;
  /** The unprivileged `board_app` connection that serves every request. */
  appDatabaseUrl: string;
  /** Owner for rows that predate tenancy; read only by the migration that adds owners. */
  backfillOwner: string | null;
  /** Authelia groups that may use the board. */
  allowedGroups: string[];
  /** Local development only: act as this user instead of reading Authelia headers. */
  devAuthUser: string | null;
  /** Null unless INTAKE_TOKEN is set: the Slack intake API is off then. */
  intake: IntakeConfig | null;
}

function loadIntakeConfig(): IntakeConfig | null {
  const token = process.env.INTAKE_TOKEN?.trim();
  if (!token) return null;
  if (token.length < 32) throw new Error('INTAKE_TOKEN must be at least 32 characters');
  const boardUrl = requireEnv('BOARD_URL').trim();
  if (!/^https?:\/\/[^/]/.test(boardUrl)) throw new Error('BOARD_URL must be an http(s) URL');
  return { token, boardUrl: boardUrl.replace(/\/+$/, '') };
}

export function loadConfig(): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const devAuthUser = process.env.DEV_AUTH_USER?.trim() || null;
  if (devAuthUser && nodeEnv === 'production') {
    throw new Error('DEV_AUTH_USER must not be set in production');
  }
  const backfillOwner = process.env.BACKFILL_OWNER?.trim().toLowerCase() || null;
  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 4000),
    databaseUrl: requireEnv('DATABASE_URL'),
    appDatabaseUrl: requireEnv('APP_DATABASE_URL'),
    backfillOwner,
    allowedGroups: (process.env.ALLOWED_GROUPS ?? 'admins')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean),
    devAuthUser,
    intake: loadIntakeConfig(),
  };
}
