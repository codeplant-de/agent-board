import { open, seal, type Binding, type Keys, type Sealer } from '@agent-board/shared';

// Which (field, context) pair a value is sealed under is decided by `@agent-board/shared`, which the CLI uses too; this
// only puts the unlocked keys behind it.
export const sealerFor =
  (keys: Keys): Sealer =>
  (binding, plaintext) =>
    seal(keys, binding.field, binding.context, plaintext);

export const openAs = (keys: Keys, { field, context }: Binding, envelope: string): Promise<string> =>
  open(keys, field, context, envelope);
