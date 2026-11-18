import type { FastifyInstance } from 'fastify';
import type { AuthEnv } from './services/auth/env';
import { acceptSamlResponse, SAML_ACS_PATH } from './services/auth/saml';

const MAX_FORM_BYTES = 256 * 1024;

const samlResponseOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && 'SAMLResponse' in body ? body.SAMLResponse : undefined;

/**
 * The one route that answers with a redirect: the IdP posts the user's browser here with a form, which only a redirect can
 * turn back into a page of the board, so a refusal is a redirect too (a JSON body would be a download). The redirect
 * carries the flow id or a fixed error code, and nothing that signs anyone in. A request that is no browser sign-in
 * (another content type, a huge body) gets Fastify's 4xx.
 */
export async function registerSamlAcs(app: FastifyInstance, env: AuthEnv): Promise<void> {
  await app.register(async (scope) => {
    // Scoped to this route's plugin: nothing else on the server takes a form.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: MAX_FORM_BYTES },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    scope.post(SAML_ACS_PATH, async (req, reply) => {
      const accepted = await acceptSamlResponse(env, samlResponseOf(req.body));
      const query = 'flow' in accepted ? `flow=${accepted.flow}` : `error=${accepted.error}`;
      return reply.code(303).header('location', `/login/saml?${query}`).send();
    });
  });
}
