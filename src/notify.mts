import { ConfigError, readSecretFile } from "./config.mts";

function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function slackText(task: { title: string; url: string }, text: string): string {
  return `<${task.url}|${escapeSlack(task.title)}>\n${escapeSlack(text)}`;
}

// The webhook URL is a secret: it is never printed and errors never carry it.
export async function postSlack(webhookFile: string, text: string): Promise<void> {
  const url = readSecretFile(webhookFile, "Slack webhook file").split("\n")[0]?.trim();
  if (!url) throw new ConfigError(`Slack webhook file is empty: ${webhookFile}`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ConfigError("Slack post failed: network error");
  }
  if (!response.ok) throw new ConfigError(`Slack post failed: ${response.status}`);
}
