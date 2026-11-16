import { ActionIcon, AppShell, Button, Group, Text, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconArchive,
  IconLayoutKanban,
  IconLock,
  IconMoon,
  IconPlus,
  IconRepeat,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useLock } from './crypto/KeyContext';
import { NewTaskModal } from './components/NewTaskModal';
import { useDesktopNotifications } from './components/useDesktopNotifications';

const NAV = [
  { to: '/', label: 'Board', icon: IconLayoutKanban },
  { to: '/schedules', label: 'Schedules', icon: IconRepeat },
  { to: '/closed', label: 'Closed', icon: IconArchive },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function AppLayout() {
  const [creating, setCreating] = useState(false);
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const lock = useLock();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = (to: string) =>
    to === '/' ? pathname === '/' || pathname.startsWith('/t/') : pathname.startsWith(to);
  useHotkeys([['c', () => setCreating(true)]]);
  useDesktopNotifications();

  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="lg" wrap="nowrap">
            <Group gap={8} wrap="nowrap" style={{ cursor: 'pointer' }} onClick={() => navigate('/')}>
              <img src="/favicon.svg" alt="" width={24} height={24} />
              <Text fw={700} visibleFrom="xs">
                Agent Board
              </Text>
            </Group>
            <Group gap={4} wrap="nowrap">
              {NAV.map((item) => (
                <Button
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  end
                  variant={active(item.to) ? 'light' : 'subtle'}
                  size="compact-sm"
                  leftSection={<item.icon size={16} />}
                  styles={{ root: { fontWeight: 500 } }}
                >
                  <Text span size="sm" visibleFrom="sm">
                    {item.label}
                  </Text>
                </Button>
              ))}
            </Group>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Tooltip label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <ActionIcon variant="default" size="lg" onClick={toggleColorScheme} aria-label="Toggle color scheme">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            {lock && (
              <Tooltip label="Lock">
                <ActionIcon variant="default" size="lg" onClick={() => void lock()} aria-label="Lock">
                  <IconLock size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="New task (c)">
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                New task
              </Button>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        {/* A page that throws keeps the header; going to another page tries again. */}
        <ErrorBoundary what="this page" resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </AppShell.Main>
      <NewTaskModal opened={creating} onClose={() => setCreating(false)} />
    </AppShell>
  );
}
