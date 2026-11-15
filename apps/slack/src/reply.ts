const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\/[\w/.-]+$/;

/** Sends an ephemeral answer to a command's `response_url`; refuses a URL that is not Slack's. */
export async function replyEphemeral(
  responseUrl: string,
  text: string,
  { fetch: fetchImpl = fetch, timeoutMs = 10_000 }: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  if (!RESPONSE_URL.test(responseUrl)) throw new Error('the response URL is not a Slack URL');
  const response = await fetchImpl(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Slack answered ${response.status} to the response URL`);
}
