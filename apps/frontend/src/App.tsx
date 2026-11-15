import { Center, Loader, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './AppLayout';
import { KeyGate } from './crypto/KeyGate';
import { errorMessage, useTRPC } from './lib/trpc';
import { BoardPage } from './pages/BoardPage';
import { ClosedPage } from './pages/ClosedPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { SettingsPage } from './pages/SettingsPage';
import { SlackLinkPage } from './pages/SlackLinkPage';
import { TaskPage } from './pages/TaskPage';

export function App() {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.queryOptions());
  if (me.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (me.error || !me.data) {
    return (
      <Center h="100vh">
        <Text c="red">No access: {errorMessage(me.error)}</Text>
      </Center>
    );
  }
  return (
    <KeyGate me={me.data}>
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
    </KeyGate>
  );
}
