import { ConfigError, readSecretFile } from './config.mts';

// Slack reads `&`, `<` and `>` as markup; `&` goes first so the others' escapes survive.
function escapeSlack(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// `<`, `>` and `|` end a Slack link, so they are percent-encoded in the URL. The label can hold anything but
// `<` and `>`, which are escaped with the rest.
function slackLink(url: string, label: string): string {
  const safeUrl = url.replace(/[\s<>|]/g, (char) => encodeURIComponent(char));
  return `<${safeUrl}|${escapeSlack(label)}>`;
}

// The link is the CLI's own (`taskLink`), never a url from the board server.
export function slackText(task: { title: string; url: string }, text: string): string {
  return `${slackLink(task.url, task.title)}\n${escapeSlack(text)}`;
}

// The webhook URL is a secret: it is never printed and errors never carry it.
export async function postSlack(webhookFile: string, text: string): Promise<void> {
  const url = readSecretFile(webhookFile, 'Slack webhook file').split('\n')[0]?.trim();
  if (!url) throw new ConfigError(`Slack webhook file is empty: ${webhookFile}`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ConfigError('Slack post failed: network error');
  }
  if (!response.ok) throw new ConfigError(`Slack post failed: ${response.status}`);
}
