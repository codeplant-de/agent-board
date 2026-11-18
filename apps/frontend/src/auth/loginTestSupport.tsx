import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import type { ReactElement } from 'react';

/** What the mocked board answers to the sign-in procedures; tests set the ones they exercise. */
export const mutations = {
  loginOptions: vi.fn(),
  login: vi.fn(),
  signupOptions: vi.fn(),
  signup: vi.fn(),
  oidcStart: vi.fn(),
  oidcFinish: vi.fn(),
  samlStart: vi.fn(),
  samlFinish: vi.fn(),
};

export type TestConfig =
  | { login: false }
  | {
      login: true;
      passkeys: boolean;
      signup: boolean;
      oidc: { label: string } | null;
      saml: { label: string } | null;
    };

export const authConfig = { current: { login: false } as TestConfig };

export const rawClient = {
  auth: {
    passkey: {
      loginOptions: { mutate: mutations.loginOptions },
      login: { mutate: mutations.login },
      signupOptions: { mutate: mutations.signupOptions },
      signup: { mutate: mutations.signup },
    },
    oidc: { start: { mutate: mutations.oidcStart }, finish: { mutate: mutations.oidcFinish } },
    saml: { start: { mutate: mutations.samlStart }, finish: { mutate: mutations.samlFinish } },
  },
};

export const trpcFacade = {
  auth: { config: { queryOptions: () => ({ queryKey: ['auth.config'], queryFn: async () => authConfig.current }) } },
};

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

/** The element where the router is at `path`, inside what the sign-in code needs, with a probe that shows the route. */
export function renderAt(element: ReactElement, path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const resetQueries = vi.spyOn(queryClient, 'resetQueries');
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          {element}
          <Where />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { queryClient, resetQueries };
}
