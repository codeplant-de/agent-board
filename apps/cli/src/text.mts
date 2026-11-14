export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}

// Fenced block that the content cannot close early.
export function fence(text: string): string {
  return `\`\`\`\n${text.replaceAll('```', "'''")}\n\`\`\``;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
