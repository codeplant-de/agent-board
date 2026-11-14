import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { polishTask } from '../lib/polish';
import { useTRPC, type BoardTask } from '../lib/trpc';

/** Queues a task that asks an agent to polish a Backlog task's prompt; the rewrite comes back on that task's page. */
export function usePolish(): { polish: (target: BoardTask) => void; isPending: boolean } {
  const trpc = useTRPC();
  const create = useMutation(trpc.tasks.create.mutationOptions());
  return {
    polish: (target) =>
      create.mutate(polishTask(target), {
        onSuccess: () =>
          notifications.show({
            color: 'grape',
            title: 'Polish queued',
            message: 'A worker will write a clearer prompt. Apply it from the new task.',
          }),
      }),
    isPending: create.isPending,
  };
}
