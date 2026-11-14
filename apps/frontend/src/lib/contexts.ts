import { open, seal, type Field, type Keys } from '@agent-board/shared';

// Every (field, context) pair the frontend seals or opens is built here and nowhere else.
export interface Binding {
  field: Field;
  context: string;
}

export interface FieldBindings {
  title: Binding;
  input: Binding;
  workdir: Binding;
}

export const taskFields = (): FieldBindings => ({
  title: { field: 'title', context: '' },
  input: { field: 'input', context: '' },
  workdir: { field: 'workdir', context: '' },
});

export const scheduleFields = (): FieldBindings => ({
  title: { field: 'title', context: '' },
  input: { field: 'input', context: '' },
  workdir: { field: 'workdir', context: '' },
});

export const noteBody = (taskId: string): Binding => ({ field: 'note.body', context: taskId });
export const notePreviewOf = (taskId: string): Binding => ({ field: 'note.preview', context: taskId });
export const noteQuestions = (taskId: string): Binding => ({ field: 'note.questions', context: taskId });
export const noteAnswers = (taskId: string): Binding => ({ field: 'note.answers', context: taskId });

export const transcriptData = (runId: string, seq: number): Binding => ({
  field: 'tr.data',
  context: `${runId}:${seq}`,
});
export const transcriptOutput = (runId: string, seq: number): Binding => ({
  field: 'tr.output',
  context: `${runId}:${seq}`,
});

export const sealAs = (keys: Keys, { field, context }: Binding, plaintext: string): Promise<string> =>
  seal(keys, field, context, plaintext);

export const openAs = (keys: Keys, { field, context }: Binding, envelope: string): Promise<string> =>
  open(keys, field, context, envelope);
