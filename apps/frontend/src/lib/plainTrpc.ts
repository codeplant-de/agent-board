import type { AppRouter } from '@agent-board/backend/router';
import { parseKeySetup, type Answer, type Keys, type Question, type TranscriptEventView } from '@agent-board/shared';
import { mutationOptions, queryOptions, type QueryKey } from '@tanstack/react-query';
import type { TRPCClient } from '@trpc/client';
import {
  openBoardTask,
  openEvents,
  openListedTasks,
  openMachines,
  openOutput,
  openRuns,
  openSchedule,
  openSchedules,
  openTaskDetail,
} from './opening';
import type { useRawTRPC } from './rawTrpc';
import { sealAnswer, sealNewTask, sealReply, sealStart, startsProposal, type NewTask, type Proposal } from './sealing';
import { parseMe } from './shapes';

export type RawTRPC = ReturnType<typeof useRawTRPC>;
export type RawClient = TRPCClient<AppRouter>;
type RawMoveInput = Parameters<RawClient['tasks']['move']['mutate']>[0];

export interface ReplyVariables {
  id: string;
  message: string;
  resume: boolean;
}

export interface AnswerVariables {
  id: string;
  questionNoteId: string;
  // The questions the panel showed, which the answers are checked against and sealed with.
  questions: Question[];
  answers: Answer[];
  message: string;
}

export interface MoveVariables {
  id: string;
  status: RawMoveInput['status'];
  beforeId?: string | undefined;
  afterId?: string | undefined;
  // The task as the page shows it. An agent's proposal moved into Todo is started, which seals its prompt again as the user's.
  task?: Proposal | undefined;
}

export type { NewTask };

// The raw keys carry the wire type of their data; the plaintext facade keeps the keys and changes what the data is.
const plainKey = (key: QueryKey): QueryKey => [...key];

/**
 * The board's tRPC with plaintext in and out: queries open what they fetch, mutations seal what they send. Procedures
 * that carry nothing sealed are the raw ones. The query keys are the raw ones too, so the cache and its invalidation work
 * as they would without encryption.
 */
export function createPlainTRPC(raw: RawTRPC, client: RawClient, keys: Keys | null) {
  const need = (): Keys => {
    if (keys === null) throw new Error('The board is locked.');
    return keys;
  };
  return {
    me: {
      queryKey: raw.me.queryKey,
      queryOptions: () =>
        queryOptions({
          queryKey: plainKey(raw.me.queryKey()),
          queryFn: async ({ signal }) => parseMe(await client.me.query(undefined, { signal })),
        }),
    },
    keys: {
      setup: raw.keys.setup,
      replaceSlots: raw.keys.replaceSlots,
      get: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.keys.get.queryKey()),
            queryFn: async ({ signal }) => {
              const stored = await client.keys.get.query(undefined, { signal });
              return stored === null ? null : parseKeySetup(stored);
            },
          }),
      },
    },
    machines: {
      issue: raw.machines.issue,
      revoke: raw.machines.revoke,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.machines.list.queryKey()),
            queryFn: async ({ signal }) => openMachines(await client.machines.list.query(undefined, { signal })),
          }),
      },
    },
    tasks: {
      done: raw.tasks.done,
      rerun: raw.tasks.rerun,
      setPriority: raw.tasks.setPriority,
      setNotBefore: raw.tasks.setNotBefore,
      takeBack: raw.tasks.takeBack,
      setClosed: raw.tasks.setClosed,
      move: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.move.mutationKey(),
            mutationFn: async ({ task, ...variables }: MoveVariables) => {
              const starts = task !== undefined && startsProposal(task, variables.status);
              return client.tasks.move.mutate({
                ...variables,
                ...(starts ? { startInput: await sealStart(need(), task) } : {}),
              });
            },
          }),
      },
      list: {
        queryOptions: (input?: { closed?: boolean }) =>
          queryOptions({
            queryKey: plainKey(raw.tasks.list.queryKey(input)),
            queryFn: async ({ signal }) => openListedTasks(need(), await client.tasks.list.query(input, { signal })),
          }),
      },
      get: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.tasks.get.queryKey(input)),
            queryFn: async ({ signal }) => openTaskDetail(need(), await client.tasks.get.query(input, { signal })),
          }),
      },
      create: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.create.mutationKey(),
            mutationFn: async (task: NewTask) =>
              openBoardTask(need(), await client.tasks.create.mutate(await sealNewTask(need(), task))),
          }),
      },
      reply: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.reply.mutationKey(),
            mutationFn: async ({ id, message, resume }: ReplyVariables) =>
              openBoardTask(
                need(),
                await client.tasks.reply.mutate({ id, message: await sealReply(need(), id, message), resume }),
              ),
          }),
      },
      answer: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.tasks.answer.mutationKey(),
            mutationFn: async (variables: AnswerVariables) =>
              openBoardTask(need(), await client.tasks.answer.mutate(await sealAnswer(need(), variables))),
          }),
      },
    },
    schedules: {
      remove: raw.schedules.remove,
      list: {
        queryOptions: () =>
          queryOptions({
            queryKey: plainKey(raw.schedules.list.queryKey()),
            queryFn: async ({ signal }) =>
              openSchedules(need(), await client.schedules.list.query(undefined, { signal })),
          }),
      },
      setPaused: {
        mutationOptions: () =>
          mutationOptions({
            mutationKey: raw.schedules.setPaused.mutationKey(),
            mutationFn: async (variables: { id: string; paused: boolean }) =>
              openSchedule(need(), await client.schedules.setPaused.mutate(variables)),
          }),
      },
    },
    transcript: {
      runs: {
        queryOptions: (input: { id: string }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.runs.queryKey(input)),
            queryFn: async ({ signal }) => openRuns(await client.transcript.runs.query(input, { signal })),
          }),
      },
      events: {
        queryKey: (input: { taskId: string; runId: string }): QueryKey =>
          plainKey(raw.transcript.events.queryKey({ runId: input.runId })),
        queryOptions: ({ taskId, ...input }: { taskId: string; runId: string; afterSeq?: number }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.events.queryKey(input)),
            queryFn: async ({ signal }) =>
              openEvents(
                need(),
                { taskId, runId: input.runId },
                await client.transcript.events.query(input, { signal }),
              ),
          }),
      },
      output: {
        queryOptions: ({ taskId, ...input }: { taskId: string; runId: string; seq: number }) =>
          queryOptions({
            queryKey: plainKey(raw.transcript.output.queryKey(input)),
            queryFn: async ({ signal }) =>
              openOutput(
                need(),
                { taskId, runId: input.runId },
                input.seq,
                await client.transcript.output.query(input, { signal }),
              ),
          }),
      },
    },
  };
}

export type PlainTRPC = ReturnType<typeof createPlainTRPC>;

export function createPlainClient(client: RawClient, keys: Keys | null) {
  return {
    transcript: {
      events: {
        query: async ({
          taskId,
          ...input
        }: {
          taskId: string;
          runId: string;
          afterSeq?: number;
        }): Promise<TranscriptEventView[]> => {
          if (keys === null) throw new Error('The board is locked.');
          return openEvents(keys, { taskId, runId: input.runId }, await client.transcript.events.query(input));
        },
      },
    },
  };
}
