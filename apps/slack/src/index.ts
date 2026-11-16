import { LogLevel, SocketModeClient } from '@slack/socket-mode';
import { startSlackApp, type SocketLike } from './app';
import { loadConfig } from './config';
import { createSlackApi } from './slackApi';
import { createIntakeClient } from './intake';
import { replyEphemeral } from './reply';

const config = loadConfig();

const client = new SocketModeClient({ appToken: config.appToken, logLevel: LogLevel.WARN });
const socket: SocketLike = {
  onCommand: (listener) => void client.on('slash_commands', listener),
  onInteractive: (listener) => void client.on('interactive', listener),
  onError: (listener) => void client.on('error', listener),
  start: () => client.start(),
  disconnect: () => client.disconnect(),
};

const app = startSlackApp({
  socket,
  intake: createIntakeClient({ apiUrl: config.apiUrl, token: config.intakeToken }),
  slackApi: config.botToken ? createSlackApi({ botToken: config.botToken }) : null,
  reply: replyEphemeral,
  log: { info: (message) => console.info(message), error: (message) => console.error(message) },
  secrets: [config.appToken, config.intakeToken, ...(config.botToken ? [config.botToken] : [])],
});

const shutdown = async (): Promise<void> => {
  await app.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
