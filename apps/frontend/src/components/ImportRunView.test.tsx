import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImportRunView } from './ImportRunView';
import type { ImportRun } from './useImportRun';

const done = (totals: Partial<Extract<ImportRun, { status: 'done' }>['totals']>): ImportRun => ({
  status: 'done',
  totals: { inserted: 0, existing: 0, invalid: 0, orphaned: 0, unreadable: 0, ...totals },
});

function show(run: ImportRun, fileOwner: string) {
  render(
    <MantineProvider>
      <ImportRunView run={run} onCancel={() => undefined} owner="new-name" fileOwner={fileOwner} />
    </MantineProvider>,
  );
}

describe('ImportRunView', () => {
  it('says rows may be held by another account on the server', () => {
    show(done({ inserted: 2, existing: 1 }), 'new-name');
    expect(
      screen.getByText('1 already on this board or held by another account on this server, left as they are'),
    ).toBeInTheDocument();
  });

  it('points at the old account when nothing was added, rows existed and the file is of another username', () => {
    show(done({ existing: 3 }), 'old-name');
    expect(screen.getByText(/probably still holds these rows/)).toBeInTheDocument();
    expect(screen.getByText('old-name')).toBeInTheDocument();
  });

  it('gives no hint for the same username, or when something was added', () => {
    show(done({ existing: 3 }), 'new-name');
    expect(screen.queryByText(/probably still holds/)).not.toBeInTheDocument();
  });

  it('gives no hint when rows were added', () => {
    show(done({ inserted: 1, existing: 3 }), 'old-name');
    expect(screen.queryByText(/probably still holds/)).not.toBeInTheDocument();
  });
});
