import { Badge, Center, Loader, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { KeyGate } from './crypto/KeyGate';
import { errorMessage, POLL_MS, useTRPC } from './lib/trpc';
import { BoardPage } from './pages/BoardPage';
import { ClosedPage } from './pages/ClosedPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { SettingsPage } from './pages/SettingsPage';
import { SlackLinkPage } from './pages/SlackLinkPage';
import { TaskPage } from './pages/TaskPage';

export function App() {
  const trpc = useTRPC();
  // While the board does not answer, keep asking, so the banner below goes away on its own once it is back.
  const me = useQuery({
    ...trpc.me.queryOptions(),
    refetchInterval: (query) => (query.state.status === 'error' ? POLL_MS : false),
  });
  if (me.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  // Only a sign-in that never answered stops here. A failed background refetch keeps the last good answer, so the
  // unlocked keys and whatever is being typed survive a backend restart.
  if (me.data === undefined) {
    return (
      <Center h="100vh">
        <Text c="red">No access: {errorMessage(me.error)}</Text>
      </Center>
    );
  }
  return (
    <>
      {me.error && (
        <Badge
          color="red"
          variant="filled"
          pos="fixed"
          bottom={16}
          left="50%"
          style={{ zIndex: 1000, transform: 'translateX(-50%)' }}
        >
          Board unreachable, retrying
        </Badge>
      )}
      <KeyGate me={me.data}>
        {/* Inside the gate, so that a crash anywhere in the app still offers Lock. */}
        <ErrorBoundary what="the board">
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<BoardPage />} />
              <Route path="t/:id" element={<TaskPage />} />
              <Route path="schedules" element={<SchedulesPage />} />
              <Route path="closed" element={<ClosedPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="slack/link" element={<SlackLinkPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </KeyGate>
    </>
  );
}
