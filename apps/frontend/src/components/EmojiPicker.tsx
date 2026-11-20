import {
  ActionIcon,
  Button,
  Center,
  Loader,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconMoodPlus, IconSearch } from '@tabler/icons-react';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  loadEmojiGroups,
  readRecentEmojis,
  rememberRecentEmoji,
  searchEmojis,
  type EmojiEntry,
  type EmojiGroup,
} from '../lib/emoji';

interface Props {
  value: string | null;
  onChange: (icon: string | null) => void;
  size?: number;
  label?: string;
  revealOnHover?: boolean;
  disabled?: boolean;
}

const stop = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

function EmojiGrid({ emojis, onPick }: { emojis: readonly EmojiEntry[]; onPick: (emoji: string) => void }) {
  return (
    <div className="emoji-grid">
      {emojis.map(({ emoji, label }) => (
        <UnstyledButton
          key={emoji}
          className="emoji-option"
          aria-label={label}
          title={label}
          onClick={() => onPick(emoji)}
        >
          {emoji}
        </UnstyledButton>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <Text size="xs" fw={600} c="dimmed" mb={4}>
        {title}
      </Text>
      {children}
    </section>
  );
}

export function EmojiPicker({
  value,
  onChange,
  size = 16,
  label = 'Task icon',
  revealOnHover = false,
  disabled,
}: Props) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<EmojiGroup[] | undefined>();
  const [failed, setFailed] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  const open = () => {
    setRecent(readRecentEmojis());
    setOpened(true);
    if (groups !== undefined) return;
    setFailed(false);
    loadEmojiGroups().then(setGroups, () => setFailed(true));
  };
  const close = () => {
    setOpened(false);
    setQuery('');
  };
  const toggle = (event: SyntheticEvent) => {
    stop(event);
    if (opened) close();
    else open();
  };
  const pick = (emoji: string) => {
    setRecent(rememberRecentEmoji(emoji, recent));
    close();
    if (emoji !== value) onChange(emoji);
  };

  const labels = new Map(groups?.flatMap((group) => group.emojis.map((entry) => [entry.emoji, entry.label] as const)));
  const results = groups === undefined ? [] : searchEmojis(groups, query);

  return (
    <Popover
      opened={opened}
      onChange={(next) => (next ? open() : close())}
      position="bottom-start"
      shadow="md"
      width={320}
      trapFocus
      returnFocus
    >
      <Popover.Target>
        {value === null ? (
          <ActionIcon
            size={size + 4}
            variant="subtle"
            color="gray"
            className={revealOnHover ? 'emoji-add' : undefined}
            data-open={opened || undefined}
            aria-label={`Add ${label.toLowerCase()}`}
            disabled={disabled}
            onClick={toggle}
          >
            <IconMoodPlus size={size} />
          </ActionIcon>
        ) : (
          <UnstyledButton
            className="emoji-trigger"
            style={{ fontSize: size, width: size + 4, height: size + 4 }}
            aria-label={`${label}: ${labels.get(value) ?? value}. Change it`}
            disabled={disabled}
            onClick={toggle}
          >
            {value}
          </UnstyledButton>
        )}
      </Popover.Target>
      <Popover.Dropdown p="xs" onClick={(event) => event.stopPropagation()}>
        <Stack gap="xs">
          <TextInput
            data-autofocus
            size="xs"
            placeholder="Search emoji"
            aria-label="Search emoji"
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <ScrollArea.Autosize mah={280} type="auto" offsetScrollbars>
            {groups === undefined ? (
              <Center h={120}>
                {failed ? (
                  <Text size="sm" c="dimmed">
                    The emoji list could not be loaded.
                  </Text>
                ) : (
                  <Loader size="sm" aria-label="Loading emoji" />
                )}
              </Center>
            ) : query.trim() !== '' ? (
              results.length === 0 ? (
                <Text size="sm" c="dimmed" p="xs">
                  No emoji matches “{query.trim()}”.
                </Text>
              ) : (
                <EmojiGrid emojis={results} onPick={pick} />
              )
            ) : (
              <Stack gap="sm">
                {recent.length > 0 && (
                  <Section title="Recently used">
                    <EmojiGrid
                      emojis={recent.map((emoji) => ({ emoji, label: labels.get(emoji) ?? emoji, tags: [] }))}
                      onPick={pick}
                    />
                  </Section>
                )}
                {groups.map((group) => (
                  <Section key={group.key} title={group.label}>
                    <EmojiGrid emojis={group.emojis} onPick={pick} />
                  </Section>
                ))}
              </Stack>
            )}
          </ScrollArea.Autosize>
          {value !== null && (
            <Button
              size="xs"
              variant="subtle"
              color="red"
              onClick={() => {
                close();
                onChange(null);
              }}
            >
              Remove icon
            </Button>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
