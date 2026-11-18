const MAX_USERNAME_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f]/;

/** Passkey sign-ups pick their own names, so these are tighter than what an identity provider may send. */
export const SIGNUP_USERNAME_RULE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;

/** The board's name for a user an identity provider or the no-login setting reports, or null when it is not a usable name. */
export function parseUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const username = raw.trim().toLowerCase();
  if (username.length < 1 || username.length > MAX_USERNAME_LENGTH) return null;
  return FORBIDDEN_CHARACTERS.test(username) ? null : username;
}

export function parseSignupUsername(raw: string): string | null {
  const username = raw.trim().toLowerCase();
  return SIGNUP_USERNAME_RULE.test(username) ? username : null;
}
