import { AGENT_NAME_RULE, isAgentName, PRIORITIES, type Priority } from '@agent-board/shared';
import { Checkbox, SegmentedControl, Select, Text, TextInput } from '@mantine/core';
import { PRIORITY_LABEL } from '../lib/priority';
import type { ModelChoices } from './useModelOptions';

/** The problem with an agent name as typed, or undefined when it is empty (no agent) or valid. */
export function agentNameError(name: string): string | undefined {
  return name.trim() !== '' && !isAgentName(name.trim()) ? `Use ${AGENT_NAME_RULE}` : undefined;
}

export function AgentField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <TextInput
      label="Agent"
      placeholder="Runs as you, with your permissions"
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      error={agentNameError(value)}
      description="The name of an agent in the config.json of the machine that runs it: only its tools and lists, never asking. A machine without it does not run the task. The board cannot read the name."
    />
  );
}

export function PriorityField({ value, onChange }: { value: Priority; onChange: (value: Priority) => void }) {
  return (
    <div>
      <Text size="sm" fw={500} mb={4}>
        Priority
      </Text>
      <SegmentedControl
        fullWidth
        value={value}
        onChange={(next) => onChange(next as Priority)}
        data={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
      />
    </div>
  );
}

/** The model as a select value: `DEFAULT_MODEL` is claude's default. */
export function ModelField({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (value: string) => void;
  models: ModelChoices;
}) {
  return (
    <Select
      label="Model"
      allowDeselect={false}
      value={value}
      onChange={(next) => next && onChange(next)}
      data={models.options}
      description={
        models.fromCatalog
          ? 'The models claude lists on the chosen machine, or on any machine. Default is the model claude picks on the machine that runs it'
          : 'Default is the model claude picks on the machine that runs it'
      }
    />
  );
}

export function AutoDoneField({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Checkbox
      label="Agent may mark it done"
      description="When it judges every acceptance criterion met and nothing is left for you, the agent moves the task to Done instead of Needs me. A repeat gives this to each task it makes."
      checked={value}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}
