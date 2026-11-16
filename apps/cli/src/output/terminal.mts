// Decrypted text came from whoever wrote the task: an agent, a PR title, the web form. Printed raw it can move the cursor,
// clear a line and write a row of its own, so a title could fake a line of `board tasks`. These put a visible stand-in in
// the place of every character a terminal acts on, and leave everything else (text, code, any other unicode) as it was.
// JSON output does not need them: JSON escapes these characters itself.

// C0 controls, DEL, C1 controls, and the bidirectional controls that reorder what is shown around them.
function isTerminalActive(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function stand(code: number): string {
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  if (code === 0x7f) return '\u2421';
  return '\ufffd';
}

/** A one-line field (a title, a label): every control character is replaced, line breaks and tabs too. */
export function plainLine(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return isTerminalActive(code) ? stand(code) : char;
  }).join('');
}

/** A block of text (a note, a prompt): line breaks and tabs stay, so a CRLF reads as a line break, and the rest is replaced. */
export function plainText(text: string): string {
  return Array.from(text.replaceAll('\r\n', '\n'), (char) => {
    const code = char.codePointAt(0) ?? 0;
    return isTerminalActive(code) && char !== '\n' && char !== '\t' ? stand(code) : char;
  }).join('');
}
