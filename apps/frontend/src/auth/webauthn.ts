import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

// The board's options are the library's own JSON, made by its server half. tRPC's type for them is a look-alike that the
// library's types do not accept, so they enter as `unknown`, and a malformed one is the library's error to raise.

/** Asks the user's authenticator to sign in; the answer in the shape the board's procedures take. */
export async function authenticateWithPasskey(options: unknown) {
  const { clientExtensionResults, ...response } = await startAuthentication({
    optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
  });
  return { ...response, clientExtensionResults: { ...clientExtensionResults } };
}

/** Asks the user's authenticator to create a passkey; the answer in the shape the board's procedures take. */
export async function createPasskey(options: unknown) {
  const { clientExtensionResults, ...response } = await startRegistration({
    optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
  });
  return { ...response, clientExtensionResults: { ...clientExtensionResults } };
}
