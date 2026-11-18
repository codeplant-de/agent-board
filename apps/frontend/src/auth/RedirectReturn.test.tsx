import { screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_MARKER_KEY } from '../lib/session';
import { authConfig, mutations, rawClient, renderAt, trpcFacade } from './loginTestSupport';
import { RedirectReturn } from './RedirectReturn';

vi.mock('../lib/trpc', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  useRawTRPCClient: () => rawClient,
  useTRPC: () => trpcFacade,
}));
vi.mock('@simplewebauthn/browser', () => ({ browserSupportsWebAuthn: () => true }));

const VERIFIER = 'v'.repeat(43);

/** The browser arriving back from the identity provider at `url`, with the verifier this tab kept when it left. */
function arrive(url: string, verifier: string | null = VERIFIER) {
  window.history.replaceState(null, '', url);
  const method = url.startsWith('/login/saml') ? 'saml' : 'oidc';
  if (verifier !== null) sessionStorage.setItem(`agent-board.login.${method}.verifier`, verifier);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  for (const mock of Object.values(mutations)) mock.mockReset();
  authConfig.current = { login: true, passkeys: true, signup: false, oidc: { label: 'OIDC' }, saml: { label: 'SAML' } };
});

describe('coming back from an OpenID Connect provider', () => {
  it('removes the query from the address bar, finishes with the verifier, and signs in', async () => {
    sessionStorage.setItem('agent-board.login.return', '/t/abc');
    mutations.oidcFinish.mockResolvedValue({ ok: true });
    arrive('/login/oidc?code=the-code&state=the-state&iss=https%3A%2F%2Fidp.example');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/login/oidc');
    await waitFor(() => expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull());
    expect(mutations.oidcFinish).toHaveBeenCalledWith({
      code: 'the-code',
      state: 'the-state',
      verifier: VERIFIER,
      iss: 'https://idp.example',
    });
    expect(sessionStorage.getItem('agent-board.login.oidc.verifier')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/t\/abc$/));
  });

  it('leaves out an issuer the provider did not send, and lands on the board without a remembered path', async () => {
    mutations.oidcFinish.mockResolvedValue({ ok: true });
    arrive('/login/oidc?code=c&state=s');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    await waitFor(() => expect(mutations.oidcFinish).toHaveBeenCalled());
    expect(mutations.oidcFinish.mock.calls[0]?.[0]).toEqual({ code: 'c', state: 's', verifier: VERIFIER });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
  });

  it('finishes once even where the page renders twice', async () => {
    mutations.oidcFinish.mockResolvedValue({ ok: true });
    arrive('/login/oidc?code=c&state=s');
    renderAt(
      <StrictMode>
        <RedirectReturn method="oidc" />
      </StrictMode>,
      '/login/oidc',
    );
    await waitFor(() => expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull());
    expect(mutations.oidcFinish).toHaveBeenCalledTimes(1);
  });

  it('shows the sign-in page with the message when there is no verifier, and asks the board nothing', async () => {
    arrive('/login/oidc?code=c&state=s', null);
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(await screen.findByText(/did not start in this browser tab/)).toBeInTheDocument();
    expect(screen.getByText('Sign in to Agent Board')).toBeInTheDocument();
    expect(mutations.oidcFinish).not.toHaveBeenCalled();
    expect(localStorage.getItem(SESSION_MARKER_KEY)).toBeNull();
  });

  it('shows the provider’s refusal, and does not finish, when it sends an error', async () => {
    arrive('/login/oidc?error=access_denied&error_description=The+user+said+no&state=s');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(await screen.findByText('The sign-in was refused: The user said no')).toBeInTheDocument();
    expect(mutations.oidcFinish).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('agent-board.login.oidc.verifier')).toBeNull();
  });

  it('shows the error code when the provider gave no description', async () => {
    arrive('/login/oidc?error=server_error');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(await screen.findByText('The sign-in was refused: server_error')).toBeInTheDocument();
  });

  it('cuts a long description from the provider', async () => {
    arrive(`/login/oidc?error=x&error_description=${'a'.repeat(500)}`);
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(await screen.findByText(`The sign-in was refused: ${'a'.repeat(200)}`)).toBeInTheDocument();
  });

  it('shows the board’s message when finishing fails', async () => {
    mutations.oidcFinish.mockRejectedValue(new Error('This sign-in has expired. Start again.'));
    arrive('/login/oidc?code=c&state=s');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(await screen.findByText('This sign-in has expired. Start again.')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_MARKER_KEY)).toBeNull();
  });

  it('shows the sign-in page when the answer carries no code', async () => {
    arrive('/login/oidc');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    expect(await screen.findByText('The sign-in answer is incomplete. Start again.')).toBeInTheDocument();
    expect(mutations.oidcFinish).not.toHaveBeenCalled();
  });

  it('never goes to a path from the query, only to the remembered one', async () => {
    mutations.oidcFinish.mockResolvedValue({ ok: true });
    arrive('/login/oidc?code=c&state=s&next=https%3A%2F%2Fevil.example&returnTo=%2F%2Fevil.example');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
  });

  it('ignores a remembered path that is not on this origin', async () => {
    sessionStorage.setItem('agent-board.login.return', 'https://evil.example/');
    mutations.oidcFinish.mockResolvedValue({ ok: true });
    arrive('/login/oidc?code=c&state=s');
    renderAt(<RedirectReturn method="oidc" />, '/login/oidc');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/));
  });
});

describe('coming back from a SAML identity provider', () => {
  it('removes the query, finishes the flow with the verifier, and signs in', async () => {
    mutations.samlFinish.mockResolvedValue({ ok: true });
    arrive('/login/saml?flow=abc_DEF-123');
    renderAt(<RedirectReturn method="saml" />, '/login/saml');
    expect(window.location.search).toBe('');
    await waitFor(() => expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull());
    expect(mutations.samlFinish).toHaveBeenCalledWith({ flow: 'abc_DEF-123', verifier: VERIFIER });
    expect(sessionStorage.getItem('agent-board.login.saml.verifier')).toBeNull();
  });

  it('does not use the other method’s verifier', async () => {
    sessionStorage.setItem('agent-board.login.oidc.verifier', VERIFIER);
    arrive('/login/saml?flow=abc', null);
    renderAt(<RedirectReturn method="saml" />, '/login/saml');
    expect(await screen.findByText(/did not start in this browser tab/)).toBeInTheDocument();
    expect(mutations.samlFinish).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'The sign-in was refused. Start again.'],
    ['no_user', 'The identity provider sent no usable user name.'],
    ['something_new', 'The sign-in failed. Start again.'],
    ['constructor', 'The sign-in failed. Start again.'],
  ])('turns the error code %s into its own sentence', async (code, sentence) => {
    arrive(`/login/saml?error=${code}`);
    renderAt(<RedirectReturn method="saml" />, '/login/saml');
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(code))).not.toBeInTheDocument();
    expect(mutations.samlFinish).not.toHaveBeenCalled();
  });

  it('shows the sign-in page when there is no flow', async () => {
    arrive('/login/saml');
    renderAt(<RedirectReturn method="saml" />, '/login/saml');
    expect(await screen.findByText('The sign-in answer is incomplete. Start again.')).toBeInTheDocument();
  });
});
