import { sanitizeText } from './roomProtocol';

/** What the text box produced: a message to show, one of the vote commands, or nothing usable. */
export type TextInput =
  | { kind: 'text'; text: string }
  | { kind: 'ff' }
  | { kind: 'noff' }
  | { kind: 'ready' }
  | { kind: 'unknown' }
  | { kind: 'empty' };

/** The commands Tab completes, in the order it offers them: the short /ff before its long form. */
export const COMMANDS: readonly string[] = ['/ff', '/noff', '/ready', '/surrender'];

/** Where Tab cycling stands: the text it started from, and which of its matches the box shows. */
export interface CompletionCycle {
  from: string;
  index: number;
}

/** The commands that start with `typed`, in any case: only while it is a slash and the start of one word. */
export function commandMatches(typed: string): string[] {
  if (!typed.startsWith('/') || /\s/.test(typed)) return [];
  const prefix = typed.toLowerCase();
  return COMMANDS.filter((c) => c.startsWith(prefix));
}

/**
 * One press of Tab, or Shift+Tab with `back`. `cycle` is the previous press's: while the box still shows what it put
 * there, the next press moves on to the next match of the same start, wrapping round. Null when nothing completes.
 */
export function completeCommand(
  value: string,
  cycle: CompletionCycle | null,
  back = false,
): { value: string; cycle: CompletionCycle } | null {
  const step = back ? -1 : 1;
  if (cycle) {
    const matches = commandMatches(cycle.from);
    if (matches[cycle.index] === value) {
      const index = (cycle.index + step + matches.length) % matches.length;
      return { value: matches[index], cycle: { from: cycle.from, index } };
    }
  }
  const matches = commandMatches(value);
  if (matches.length === 0) return null;
  const index = back ? matches.length - 1 : 0;
  return { value: matches[index], cycle: { from: value, index } };
}

/** Commands start with a slash and match as a whole word; /surrender is the long form of /ff. */
export function parseTextInput(raw: string): TextInput {
  const text = sanitizeText(raw);
  if (text === '') return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'text', text };
  switch (text.toLowerCase()) {
    case '/ff':
    case '/surrender':
      return { kind: 'ff' };
    case '/noff':
      return { kind: 'noff' };
    case '/ready':
      return { kind: 'ready' };
    default:
      return { kind: 'unknown' };
  }
}
