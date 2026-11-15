import { Paper, Tabs, Text, Textarea } from '@mantine/core';
import { useState, type KeyboardEvent } from 'react';
import { Markdown } from './Markdown';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minRows?: number;
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void;
  autoFocus?: boolean;
  label?: string;
  /** Shown as ghost text while the editor is empty; Tab then fills it in. */
  suggestion?: string;
}

/** Markdown with a preview tab; ⌘/Ctrl+Enter submits. */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  minRows = 3,
  onSubmit,
  autoFocus,
  label,
  suggestion,
}: Props) {
  const [tab, setTab] = useState<string | null>('write');
  const onKeyDown = (event: KeyboardEvent) => {
    if (suggestion !== undefined && value === '' && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      onChange(suggestion);
      return;
    }
    if (onSubmit && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };
  return (
    <div>
      {label && (
        <Text size="sm" fw={500} mb={4}>
          {label}
        </Text>
      )}
      <Tabs value={tab} onChange={setTab} variant="outline" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="write" size="xs">
            Write
          </Tabs.Tab>
          <Tabs.Tab value="preview" disabled={value.trim() === ''}>
            Preview
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="write" pt="xs">
          <Textarea
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder={value === '' ? (suggestion ?? placeholder) : placeholder}
            autosize
            minRows={minRows}
            maxRows={18}
            onKeyDown={onKeyDown}
            autoFocus={autoFocus}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="preview" pt="xs">
          <Paper withBorder p="sm" mih={80}>
            <Markdown>{value}</Markdown>
          </Paper>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}
