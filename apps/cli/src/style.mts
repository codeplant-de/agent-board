import { styleText } from 'node:util';

export interface Style {
  bold: (text: string) => string;
  dim: (text: string) => string;
}

// Colour only on a terminal that wants it; piped output and NO_COLOR stay free of escape codes.
export function wantsColor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>): boolean {
  return stream.isTTY === true && !env['NO_COLOR'];
}

export function createStyle(color: boolean): Style {
  const apply = (format: 'bold' | 'dim', text: string): string =>
    color ? styleText(format, text, { validateStream: false }) : text;
  return { bold: (text) => apply('bold', text), dim: (text) => apply('dim', text) };
}
