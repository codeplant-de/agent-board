const TOKEN_PATTERN = /xox[a-z]-[\w-]+|xapp-[\w-]+/g;

/**
 * A failure as text that is safe to log. Errors of the Slack client and of fetch can carry a request, and a request carries a
 * token or what a user typed, so only the message is read, with anything that looks like a Slack token cut out.
 */
export function describeError(error: unknown, secrets: readonly string[] = []): string {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  const text = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
  return secrets
    .reduce((safe, secret) => (secret === '' ? safe : safe.replaceAll(secret, '[secret]')), text)
    .replace(TOKEN_PATTERN, '[token]');
}
