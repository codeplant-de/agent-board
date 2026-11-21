import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECENT_EMOJIS_KEY, type EmojiGroup } from '../lib/emoji';
import { EmojiPicker } from './EmojiPicker';

const GROUPS: EmojiGroup[] = [
  {
    key: 'smileys-emotion',
    label: 'Smileys & emotion',
    emojis: [{ emoji: '😀', label: 'grinning face', tags: ['smile'] }],
  },
  {
    key: 'travel-places',
    label: 'Travel & places',
    emojis: [{ emoji: '🚀', label: 'rocket', tags: ['space'] }],
  },
  { key: 'animals-nature', label: 'Animals & nature', emojis: [{ emoji: '🐛', label: 'bug', tags: ['insect'] }] },
  { key: 'flags', label: 'Flags', emojis: [{ emoji: '🇵🇹', label: 'flag: Portugal', tags: ['PT'] }] },
];

vi.mock('../lib/emoji', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/emoji')>()),
  loadEmojiGroups: async () => GROUPS,
}));

function Harness({ initial = null, onChange }: { initial?: string | null; onChange: (icon: string | null) => void }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <MantineProvider>
      <EmojiPicker
        value={value}
        onChange={(icon) => {
          setValue(icon);
          onChange(icon);
        }}
      />
    </MantineProvider>
  );
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const dropdown = async () =>
  (await screen.findByRole('textbox', { name: 'Search emoji', hidden: true })).closest(
    '.mantine-Popover-dropdown',
  ) as HTMLElement;

describe('EmojiPicker', () => {
  it('opens the full list by group, finds an emoji by search, and picks it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add task icon' }));
    await screen.findByRole('region', { name: 'Smileys & emotion', hidden: true });
    expect(screen.getByRole('region', { name: 'Flags', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Recently used', hidden: true })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji', hidden: true }), {
      target: { value: 'rocket' },
    });
    expect(screen.queryByRole('region', { name: 'Smileys & emotion', hidden: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'rocket', hidden: true }));
    expect(onChange).toHaveBeenCalledWith('🚀');
    expect(screen.getByRole('button', { name: 'Task icon: rocket. Change it' })).toHaveTextContent('🚀');
    expect(JSON.parse(localStorage.getItem(RECENT_EMOJIS_KEY) ?? '[]')).toEqual(['🚀']);
  });

  it('shows the recently used ones on top, and removes the icon', async () => {
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(['🐛', '🚀']));
    const onChange = vi.fn();
    render(<Harness initial="🚀" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /^Task icon: .*Change it$/ }));
    const recent = await screen.findByRole('region', { name: 'Recently used', hidden: true });
    expect(
      within(recent)
        .getAllByRole('button', { hidden: true })
        .map((button) => button.textContent),
    ).toEqual(['🐛', '🚀']);
    await userEvent.click(within(await dropdown()).getByRole('button', { name: 'Remove icon', hidden: true }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole('button', { name: 'Add task icon' })).toBeInTheDocument();
  });

  it('says when nothing matches, and offers no Remove icon without an icon', async () => {
    render(<Harness onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add task icon' }));
    await screen.findByRole('region', { name: 'Smileys & emotion', hidden: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search emoji', hidden: true }), {
      target: { value: 'zzqqxx' },
    });
    expect(screen.queryByRole('region', { name: 'Smileys & emotion', hidden: true })).not.toBeInTheDocument();
    expect(screen.getByText('No emoji matches “zzqqxx”.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove icon', hidden: true })).not.toBeInTheDocument();
  });

  it('picks without storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add task icon' }));
    await screen.findByRole('region', { name: 'Smileys & emotion', hidden: true });
    await userEvent.click(screen.getByRole('button', { name: 'grinning face', hidden: true }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('😀'));
  });
});
