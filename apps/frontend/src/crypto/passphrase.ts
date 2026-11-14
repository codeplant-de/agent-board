export const MIN_PASSPHRASE_LENGTH = 14;

export const PASSPHRASE_ADVICE =
  'Whoever runs the server holds a copy of your key that is protected only by this passphrase, and can guess at it offline. ' +
  'Length is what stops that: several unrelated words in a row are stronger than a short password with symbols.';

/** Why a passphrase is too weak, or null: a length floor and no composition rules. */
export function passphraseProblem(passphrase: string): string | null {
  return Array.from(passphrase.trim()).length < MIN_PASSPHRASE_LENGTH
    ? `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`
    : null;
}
