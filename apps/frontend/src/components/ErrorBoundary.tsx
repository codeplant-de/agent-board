import { Alert, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLock } from '../crypto/KeyContext';

interface Props {
  children: ReactNode;
  // What failed, for the message: "this page", "this run".
  what: string;
  // A change of this value (the page's path, the selected run) clears the error and renders the children again.
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey: string | undefined;
}

function Fallback({ what, error }: { what: string; error: Error }) {
  // Inside the unlocked app the keys stay in memory after a crash, so locking stays one click away.
  const lock = useLock();
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={`Could not show ${what}`}>
      <Text size="sm" mb="xs" style={{ overflowWrap: 'anywhere' }}>
        {error.message || String(error)}
      </Text>
      <Group gap="xs">
        <Button size="xs" variant="default" onClick={() => window.location.reload()}>
          Reload
        </Button>
        {lock && (
          <Button size="xs" variant="default" onClick={() => void lock()}>
            Lock
          </Button>
        )}
      </Group>
    </Alert>
  );
}

/** Keeps a render error to the part that threw: it shows the error with a reload button instead of a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.error ? <Fallback what={this.props.what} error={this.state.error} /> : this.props.children;
  }
}
