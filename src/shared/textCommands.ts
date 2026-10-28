import type { RoomMember } from './room';
import { sanitizeText } from './roomProtocol';

/** What the text box produced: a message to show, one of the commands, or nothing usable. */
export type TextInput =
  | { kind: 'text'; text: string }
  | { kind: 'ff' }
  | { kind: 'noff' }
  | { kind: 'ready' }
  /** `name` is everything after the command, trimmed: '' when nobody was named. */
  | { kind: 'mute'; name: string }
  /** `rest` is everything after /w, trimmed: a member's name, then the message. */
  | { kind: 'whisper'; rest: string }
  /** /r: `text` ('' when there is none) goes to the member who whispered us last. */
  | { kind: 'reply'; text: string }
  | { kind: 'unknown' }
  | { kind: 'empty' };

/**
 * The commands Tab completes, in the order it offers them: the short /ff before its long form. One that takes more
 * completes with its space, so the next Tab goes on to the names, or the message can follow.
 */
export const COMMANDS: readonly string[] = ['/ff', '/mute ', '/noff', '/r ', '/ready', '/surrender', '/w '];

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

/** A command that takes a name, a space, and the start of the name. */
const NAMED = /^\/(mute|w)\s+(.*)$/i;
/** `/mute all`: every other member. It wins over a member who is really called "all". */
export const MUTE_ALL = 'all';

/**
 * What Tab can make of `typed`: a command, or after /mute or /w and a space, that command and a member's name that
 * starts there. /mute offers `all` first; /w adds a space after the name, for the message.
 */
function completions(typed: string, names: readonly string[]): string[] {
  const named = NAMED.exec(typed);
  if (!named) return commandMatches(typed);
  const start = named[2].toLowerCase();
  const starts = (n: string): boolean => n.toLowerCase().startsWith(start);
  if (named[1].toLowerCase() === 'w') return [...new Set(names)].filter(starts).map((n) => `/w ${n} `);
  // A member called "all" can't be named here (the keyword wins), so offering their name would mislead.
  const offered = [MUTE_ALL, ...new Set(names.filter((n) => n.toLowerCase() !== MUTE_ALL))];
  return offered.filter(starts).map((n) => `/mute ${n}`);
}

/**
 * One press of Tab, or Shift+Tab with `back`. `names` are the other members', for /mute. `cycle` is the previous press's:
 * while the box still shows what it put there, the next press moves on to the next match of the same start, wrapping
 * round. A start with a single match has nothing to cycle, so the next press completes on from the box (`/m` to
 * `/mute `, then to a name). Null when nothing completes.
 */
export function completeCommand(
  value: string,
  cycle: CompletionCycle | null,
  back = false,
  names: readonly string[] = [],
): { value: string; cycle: CompletionCycle } | null {
  const step = back ? -1 : 1;
  if (cycle) {
    const matches = completions(cycle.from, names);
    if (matches.length > 1 && matches[cycle.index] === value) {
      const index = (cycle.index + step + matches.length) % matches.length;
      return { value: matches[index], cycle: { from: cycle.from, index } };
    }
  }
  const matches = completions(value, names);
  if (matches.length === 0) return null;
  const index = back ? matches.length - 1 : 0;
  return { value: matches[index], cycle: { from: value, index } };
}

/**
 * /mute <name>: the other members with that name, in any case, and whether they end up muted. It toggles, as in League:
 * muted unless every one of them already is. `/mute all` takes every other member, and its `name` is null. Null when
 * nobody but us has that name, or for all when we are alone.
 */
export function muteToggle(
  members: readonly RoomMember[],
  name: string,
): { peers: string[]; on: boolean; name: string | null } | null {
  const wanted = name.toLowerCase();
  const all = wanted === MUTE_ALL;
  const targets = members.filter((m) => !m.self && (all || m.name.toLowerCase() === wanted));
  if (wanted === '' || targets.length === 0) return null;
  return { peers: targets.map((m) => m.peer), on: !targets.every((m) => m.muted), name: all ? null : targets[0].name };
}

/**
 * /w <name> <message>: the other members called by the longest name `rest` starts with, in any case, and the message
 * after it ('' when there is none). Names can hold spaces, so the longest one that fits wins. Null when no other
 * member's name starts `rest`.
 */
export function whisperTarget(members: readonly RoomMember[], rest: string): { to: RoomMember[]; text: string } | null {
  const others = members.filter((m) => !m.self);
  // The name, in any case, and then a space or nothing.
  const starts = (name: string): boolean =>
    rest.slice(0, name.length).toLowerCase() === name.toLowerCase() && !/\S/.test(rest.charAt(name.length));
  const name = others.map((m) => m.name).filter(starts).sort((a, b) => b.length - a.length)[0];
  if (name === undefined) return null;
  const wanted = name.toLowerCase();
  return { to: others.filter((m) => m.name.toLowerCase() === wanted), text: rest.slice(name.length).trim() };
}

/**
 * Commands start with a slash and match as a whole word; /surrender is the long form of /ff, /mute takes a name, /w a
 * name and a message, and /r a message.
 */
export function parseTextInput(raw: string): TextInput {
  const text = sanitizeText(raw);
  if (text === '') return { kind: 'empty' };
  if (!text.startsWith('/')) return { kind: 'text', text };
  const mute = /^\/mute(?:\s+(.*))?$/i.exec(text);
  if (mute) return { kind: 'mute', name: (mute[1] ?? '').trim() };
  const whisper = /^\/w(?:\s+(.*))?$/i.exec(text);
  if (whisper) return { kind: 'whisper', rest: (whisper[1] ?? '').trim() };
  const reply = /^\/r(?:\s+(.*))?$/i.exec(text);
  if (reply) return { kind: 'reply', text: (reply[1] ?? '').trim() };
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
