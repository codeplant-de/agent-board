import { MAX_SCHEDULE_CONCURRENT } from '@agent-board/shared';
import { NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { RepeatRuleInput } from './RepeatRuleInput';

export const TIMES_PROBLEM = 'A whole number, 1 or more';
export const LIMIT_PROBLEM = `A whole number from 1 to ${MAX_SCHEDULE_CONCURRENT}`;

/** The problem with a number of runs as typed (empty is none), or undefined. */
export function timesError(times: number | string): string | undefined {
  return times !== '' && !(Number.isInteger(times) && Number(times) > 0) ? TIMES_PROBLEM : undefined;
}

/** The problem with the limit of cards at once as typed (empty is none), or undefined. */
export function limitError(limit: number | string): string | undefined {
  return limit !== '' && !(Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= MAX_SCHEDULE_CONCURRENT)
    ? LIMIT_PROBLEM
    : undefined;
}

interface Props {
  /** The schedule to run after, or null for a rule of its own. */
  after: string | null;
  onAfterChange: (value: string | null) => void;
  afterOptions: { value: string; label: string }[];
  ruleLines: readonly string[];
  onRuleLinesChange: (lines: string[]) => void;
  timezone: string;
  /** Shown under the rule, or under the delay when the schedule runs after another. */
  ruleError?: string | undefined;
  delay: string;
  onDelayChange: (value: string) => void;
  delayError?: string | undefined;
  at: string;
  onAtChange: (value: string) => void;
  atError?: string | undefined;
  atDescription: string;
  times: number | string;
  onTimesChange: (value: number | string) => void;
  limit: number | string;
  onLimitChange: (value: number | string) => void;
  /** The server's refusal of the last save, shown by the field it concerns. */
  saveError?: string | undefined;
  /** Something about the repeat was edited. */
  onEdit?: () => void;
}

/** The repeat of a schedule: a rule of its own or running after another schedule, the first run, the number of runs and the limit. */
export function RepeatFields(props: Props) {
  const { after, ruleLines, saveError, onEdit } = props;
  return (
    <Stack gap="xs">
      <Select
        label="Run after"
        placeholder="Not after another schedule"
        clearable
        searchable
        value={after}
        onChange={(value) => {
          onEdit?.();
          props.onAfterChange(value);
        }}
        data={props.afterOptions}
        nothingFoundMessage="No schedule that has not ended"
        description="Instead of a rule: a card is made each time a card of that schedule finishes, in Needs me or Done"
      />
      {after === null ? (
        <>
          <RepeatRuleInput
            lines={ruleLines}
            onChange={(lines) => {
              onEdit?.();
              props.onRuleLinesChange(lines);
            }}
            timezone={props.timezone}
            error={props.ruleError ?? saveError}
          />
          <TextInput
            type="datetime-local"
            label="First run"
            value={props.at}
            onChange={(e) => props.onAtChange(e.currentTarget.value)}
            error={props.atError}
            description={props.atDescription}
          />
        </>
      ) : (
        <TextInput
          label="Delay"
          placeholder="10m"
          value={props.delay}
          onChange={(e) => props.onDelayChange(e.currentTarget.value)}
          error={props.delayError ?? saveError}
          description="How long after that card finished the next one starts. Default: at once"
        />
      )}
      <NumberInput
        label="Number of runs"
        min={1}
        allowDecimal={false}
        allowNegative={false}
        value={props.times}
        onChange={props.onTimesChange}
        error={timesError(props.times)}
        description="Default: it repeats until you delete it"
      />
      <NumberInput
        label="At most at once"
        min={1}
        max={MAX_SCHEDULE_CONCURRENT}
        allowDecimal={false}
        allowNegative={false}
        value={props.limit}
        onChange={props.onLimitChange}
        error={limitError(props.limit)}
        description="Cards of the schedule running or waiting at once. A card over the limit stays in Todo until one finishes. Default: no limit"
      />
      <Text size="xs" c="dimmed">
        {after === null
          ? 'One pending card is on the board at a time; the next appears when it is started, moved or closed.'
          : 'No card is on the board until a card of that schedule finishes; then one waits in Todo for the delay.'}
      </Text>
    </Stack>
  );
}
