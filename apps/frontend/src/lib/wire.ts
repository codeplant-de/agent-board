import type { AppRouter } from '@agent-board/backend/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

/** What the board sends and returns: sealed values still in their envelopes. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
