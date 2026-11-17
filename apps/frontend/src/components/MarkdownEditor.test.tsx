import type { CatalogSkill } from '@agent-board/shared';
import { MantineProvider, Modal } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownEditor } from './MarkdownEditor';

const SKILLS: CatalogSkill[] = [
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'review-pr' },
  { name: 'sweep', description: '<b>Sweeps</b> the board' },
];

function Harness({
  skills,
  initial = '',
  onSubmit,
  suggestion,
}: {
  skills?: readonly CatalogSkill[];
  initial?: string;
  onSubmit?: () => void;
  suggestion?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MantineProvider>
      <MarkdownEditor
        value={value}
        onChange={setValue}
        skills={skills}
        onSubmit={onSubmit}
        suggestion={suggestion}
        placeholder="Write"
      />
    </MantineProvider>
  );
}

const field = () => screen.getByRole('textbox');
// The list is open while the field says it controls it; Mantine keeps a closed dropdown in the DOM, hidden.
const isOpen = (): boolean => field().getAttribute('data-expanded') === 'true';
const options = () => screen.queryAllByRole('option', { hidden: true });
const optionNames = () => options().map((option) => option.textContent);

describe('MarkdownEditor skill completion', () => {
  it('opens on a slash at the start and lists every skill, with its hint and description as text', async () => {
    render(<Harness skills={SKILLS} />);
    await userEvent.type(field(), '/');
    await waitFor(() => expect(isOpen()).toBe(true));
    expect(optionNames()).toEqual(['/review<pr>Review a pull request', '/review-pr', '/sweep<b>Sweeps</b> the board']);
    expect(screen.getByText('<b>Sweeps</b> the board')).toBeInTheDocument();
  });

  it('filters by what is typed after the slash', async () => {
    render(<Harness skills={SKILLS} />);
    await userEvent.type(field(), '/SWE');
    await waitFor(() => expect(optionNames()).toEqual(['/sweep<b>Sweeps</b> the board']));
    await userEvent.type(field(), 'zz');
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it('moves with the arrows and accepts with Enter, leaving the caret after the inserted space', async () => {
    render(<Harness skills={SKILLS} />);
    await userEvent.type(field(), '/re');
    await waitFor(() => expect(isOpen()).toBe(true));
    expect(field()).toHaveAttribute('aria-activedescendant', options()[0]?.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect(field()).toHaveValue('/review-pr ');
    expect(field()).toHaveProperty('selectionStart', '/review-pr '.length);
    await waitFor(() => expect(isOpen()).toBe(false));
    await userEvent.keyboard('17');
    expect(field()).toHaveValue('/review-pr 17');
  });

  it('accepts with Tab', async () => {
    render(<Harness skills={SKILLS} />);
    await userEvent.type(field(), '/sw');
    await waitFor(() => expect(isOpen()).toBe(true));
    await userEvent.keyboard('{Tab}');
    expect(field()).toHaveValue('/sweep ');
    expect(field()).toHaveFocus();
  });

  it('accepts with a click, and replaces the whole first token and keeps the rest', async () => {
    render(<Harness skills={SKILLS} initial="/swe 17 and more" />);
    await userEvent.click(field());
    await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    await userEvent.click(await screen.findByRole('option', { name: /sweep/, hidden: true }));
    expect(field()).toHaveValue('/sweep 17 and more');
  });

  it('places the caret at once when accepting a name that is already typed in full', async () => {
    render(<Harness skills={SKILLS} initial="/review 17 more" />);
    await userEvent.click(field());
    await userEvent.keyboard('{Home}{ArrowRight}{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(isOpen()).toBe(true));
    await userEvent.click(await screen.findByRole('option', { name: /\/review<pr>/, hidden: true }));
    expect(field()).toHaveValue('/review 17 more');
    expect(field()).toHaveProperty('selectionStart', '/review '.length);
    await userEvent.keyboard('X');
    expect(field()).toHaveValue('/review X17 more');
  });

  it('closes on Escape without closing the modal around it, and opens again when the token changes', async () => {
    const onClose = vi.fn();
    render(
      <MantineProvider>
        <Modal opened onClose={onClose} title="Modal">
          <Harness skills={SKILLS} />
        </Modal>
      </MantineProvider>,
    );
    await userEvent.type(field(), '/re');
    await waitFor(() => expect(isOpen()).toBe(true));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(isOpen()).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('v');
    await waitFor(() => expect(isOpen()).toBe(true));
    await userEvent.keyboard('{Escape}{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Enter for a new line and does not open when the slash is not at the start', async () => {
    const onSubmit = vi.fn();
    render(<Harness skills={SKILLS} onSubmit={onSubmit} />);
    await userEvent.type(field(), 'see /re');
    expect(isOpen()).toBe(false);
    await userEvent.keyboard('{Enter}');
    expect(field()).toHaveValue('see /re\n');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is off once the caret is past the first token', async () => {
    render(<Harness skills={SKILLS} />);
    await userEvent.type(field(), '/re 17');
    expect(isOpen()).toBe(false);
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await waitFor(() => expect(isOpen()).toBe(true));
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it('still submits with Ctrl+Enter while the list is open', async () => {
    const onSubmit = vi.fn();
    render(<Harness skills={SKILLS} onSubmit={onSubmit} />);
    await userEvent.type(field(), '/re');
    await waitFor(() => expect(isOpen()).toBe(true));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field()).toHaveValue('/re');
  });

  it('still fills the suggestion with Tab while empty', async () => {
    render(<Harness skills={SKILLS} suggestion="/sweep now" />);
    await userEvent.click(field());
    await userEvent.keyboard('{Tab}');
    expect(field()).toHaveValue('/sweep now');
  });

  it.each([
    ['no skills prop', undefined],
    ['an empty list', []],
  ])('is unchanged with %s', async (_, skills) => {
    render(<Harness skills={skills} />);
    await userEvent.type(field(), '/re');
    expect(isOpen()).toBe(false);
    await userEvent.keyboard('{Enter}');
    expect(field()).toHaveValue('/re\n');
  });
});
