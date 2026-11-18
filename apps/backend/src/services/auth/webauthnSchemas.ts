import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(16 * 1024);
const clientExtensionResults = z.record(z.string(), z.unknown()).default({});
const attachment = z.enum(['platform', 'cross-platform']).optional();

/** What `navigator.credentials.create()` yields as JSON (`startRegistration()` of @simplewebauthn/browser). */
export const registrationResponse = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal('public-key'),
  authenticatorAttachment: attachment,
  clientExtensionResults,
  response: z.object({
    clientDataJSON: base64url,
    attestationObject: base64url,
    authenticatorData: base64url.optional(),
    transports: z.array(z.string().max(32)).max(8).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url.optional(),
  }),
}) satisfies z.ZodType<unknown>;

/** What `navigator.credentials.get()` yields as JSON (`startAuthentication()`). */
export const authenticationResponse = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal('public-key'),
  authenticatorAttachment: attachment,
  clientExtensionResults,
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.optional(),
  }),
});

export type RegistrationInput = z.output<typeof registrationResponse>;
export type AuthenticationInput = z.output<typeof authenticationResponse>;

/** The zod shapes above are the library's JSON types; these keep them from drifting apart. */
export const asRegistrationJson = (input: RegistrationInput): RegistrationResponseJSON => input;
export const asAuthenticationJson = (input: AuthenticationInput): AuthenticationResponseJSON => input;
