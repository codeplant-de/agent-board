import type { AppRouter } from '@agent-board/backend/router';
import { createTRPCContext } from '@trpc/tanstack-react-query';

/** The board's tRPC as it is on the wire: sealed values in, sealed values out. Components use `useTRPC` from `./trpc`. */
export const { TRPCProvider, useTRPC: useRawTRPC, useTRPCClient: useRawTRPCClient } = createTRPCContext<AppRouter>();
