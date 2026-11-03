import type { HistoryLine } from './roomHistory';

export const CHAT_CATEGORIES = ['text', 'ping', 'scoreboard', 'vote', 'whisper'] as const;
export type ChatCategory = typeof CHAT_CATEGORIES[number];
export type ChatFilter = Record<ChatCategory, boolean>;
export const DEFAULT_CHAT_FILTER: Readonly<ChatFilter> = {
  text: true, ping: true, scoreboard: true, vote: true, whisper: true,
};

const CATEGORY: Record<HistoryLine['kind'], ChatCategory | null> = {
  text: 'text', ping: 'ping', alive: 'scoreboard', spell: 'scoreboard', vote: 'vote', note: null,
  whisperTo: 'whisper', whisperFrom: 'whisper',
};

export const isChatCategory = (value: unknown): value is ChatCategory =>
  typeof value === 'string' && CHAT_CATEGORIES.some((category) => category === value);

/** Missing or damaged entries show their category, including settings from before filters existed. */
export function normalizeChatFilter(raw: unknown): ChatFilter {
  const filter = { ...DEFAULT_CHAT_FILTER };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return filter;
  const entries = raw as Record<string, unknown>;
  for (const category of CHAT_CATEGORIES) {
    if (typeof entries[category] === 'boolean') filter[category] = entries[category];
  }
  return filter;
}

/** Command notes always stay visible; both directions of a whisper share one category. */
export function historyVisible(line: Pick<HistoryLine, 'kind'>, filter: ChatFilter): boolean {
  const category = CATEGORY[line.kind];
  return category === null || filter[category];
}
