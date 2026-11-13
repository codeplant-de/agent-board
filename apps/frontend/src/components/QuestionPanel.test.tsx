import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPanel } from './QuestionPanel';

const questions = [
  {
    header: 'Null sort',
    question: 'Blocking?',
    multiSelect: false,
    options: [
      { label: 'Blocking', description: 'keep it', recommended: true },
      { label: 'Nit', description: 'downgrade' },
    ],
  },
  {
    header: 'Follow-ups',
    question: 'Which ones?',
    multiSelect: true,
    options: [
      { label: 'Audit', description: '' },
      { label: 'Fixtures', description: '' },
    ],
  },
];

const renderPanel = (onSubmit = vi.fn()) => {
  render(
    <MantineProvider>
      <QuestionPanel questions={questions} submitting={false} onSubmit={onSubmit} />
    </MantineProvider>,
  );
  return onSubmit;
};

describe('QuestionPanel', () => {
  it('preselects the recommended option and sends with an empty multi-select', async () => {
    const onSubmit = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ['Blocking'] }, { selected: [] }], '');
  });

  it('number keys pick in the active question, which moves on after a single choice', async () => {
    const onSubmit = renderPanel();
    await userEvent.keyboard('2');
    await userEvent.keyboard('1');
    await userEvent.keyboard('2');
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ['Nit'] }, { selected: ['Audit', 'Fixtures'] }], '');
  });

  it('the Other text goes with the answer', async () => {
    const onSubmit = renderPanel();
    await userEvent.type(screen.getAllByPlaceholderText(/Other…/)[0]!, 'only if cheap');
    await userEvent.click(screen.getByRole('button', { name: /Answer & continue/ }));
    expect(onSubmit.mock.calls[0]?.[0][0]).toEqual({ selected: ['Blocking'], other: 'only if cheap' });
  });
});
