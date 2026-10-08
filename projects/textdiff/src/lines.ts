export interface SplitText {
  lines: string[];
  /** false when the text doesn't end with a newline (shown as "\ No newline at end of file"). */
  finalNewline: boolean;
}

export function splitLines(text: string): SplitText {
  if (text === "") return { lines: [], finalNewline: true };
  const normalized = text.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = (finalNewline ? normalized.slice(0, -1) : normalized).split("\n");
  return { lines, finalNewline };
}

export function joinLines(lines: string[], finalNewline = true): string {
  if (!lines.length) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}
