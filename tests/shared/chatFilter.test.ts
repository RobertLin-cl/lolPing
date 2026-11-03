import { describe, expect, it } from 'vitest';
import { CHAT_CATEGORIES, DEFAULT_CHAT_FILTER, historyVisible, isChatCategory, normalizeChatFilter } from '../../src/shared/chatFilter';
import type { HistoryLine } from '../../src/shared/roomHistory';

describe('chatFilter', () => {
  it('shows every category for missing or damaged settings', () => {
    for (const raw of [undefined, null, 1, 'no', [], [false]]) expect(normalizeChatFilter(raw)).toEqual(DEFAULT_CHAT_FILTER);
    expect(normalizeChatFilter({ ping: false, text: 0, whisper: true, other: false }))
      .toEqual({ text: true, ping: false, scoreboard: true, vote: true, whisper: true });
  });

  it('only accepts the five category names from IPC', () => {
    for (const category of CHAT_CATEGORIES) expect(isChatCategory(category)).toBe(true);
    for (const raw of ['note', 'alive', '__proto__', '', null, {}, 1]) expect(isChatCategory(raw)).toBe(false);
  });

  it('hides exactly the kinds that belong to the switched-off category', () => {
    const groups = {
      text: ['text'], ping: ['ping'], scoreboard: ['alive'], vote: ['vote'], whisper: ['whisperTo', 'whisperFrom'],
    } as const;
    const kinds: HistoryLine['kind'][] = ['text', 'ping', 'alive', 'vote', 'whisperTo', 'whisperFrom', 'note'];
    for (const category of CHAT_CATEGORIES) {
      const filter = { ...DEFAULT_CHAT_FILTER, [category]: false };
      const hidden = kinds.filter((kind) => !historyVisible({ kind }, filter));
      expect(hidden).toEqual(groups[category]);
    }
  });

  it('always shows command notes when every category is hidden', () => {
    expect(historyVisible({ kind: 'note' }, { text: false, ping: false, scoreboard: false, vote: false, whisper: false }))
      .toBe(true);
  });

  it('does not change defaults when a normalized filter changes', () => {
    const filter = normalizeChatFilter(undefined);
    filter.ping = false;
    expect(DEFAULT_CHAT_FILTER.ping).toBe(true);
    expect(normalizeChatFilter(undefined).ping).toBe(true);
  });
});
