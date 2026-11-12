// Trello caps a comment at 16384 characters; stay well under it.
export const COMMENT_MAX = 16000;

export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}

// Fenced block that the content cannot close early.
export function fence(text: string): string {
  return `\`\`\`\n${text.replaceAll("```", "'''")}\n\`\`\``;
}

// Splits at line breaks where possible, so each piece fits in one comment.
export function splitText(text: string, max: number = COMMENT_MAX): string[] {
  if (text.length <= max) return [text];
  const room = max - 20;
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > room) {
    const cut = rest.lastIndexOf("\n", room);
    const at = cut > room / 2 ? cut : room;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  pieces.push(rest);
  return pieces.map((piece, i) => `(part ${i + 1}/${pieces.length})\n${piece}`);
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
