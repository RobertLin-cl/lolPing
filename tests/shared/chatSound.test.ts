import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHAT_MESSAGE_SOUND, shouldPlayChatSound } from '../../src/shared/chatSound';
import { DEFAULT_CHAT_FILTER } from '../../src/shared/chatFilter';
import type { HistoryLine } from '../../src/shared/roomHistory';

describe('chatSound', () => {
  it('shares the bundled game cue across visible text, whispers and scoreboard reports', () => {
    const data = readFileSync('assets/' + CHAT_MESSAGE_SOUND.url.slice(3));
    expect(data.subarray(0, 4).toString()).toBe('RIFF');
    const kinds: HistoryLine['kind'][] = ['text', 'whisperTo', 'whisperFrom', 'ping', 'alive', 'spell', 'vote', 'note'];
    expect(kinds.filter(kind => shouldPlayChatSound({ kind }, DEFAULT_CHAT_FILTER, true)))
      .toEqual(['text', 'whisperTo', 'whisperFrom', 'alive', 'spell']);
  });

  it('silences filtered text, whispers and scoreboard reports even though they remain in history', () => {
    const filter = { ...DEFAULT_CHAT_FILTER, text: false, whisper: false, scoreboard: false };
    for (const kind of ['text', 'whisperTo', 'whisperFrom', 'alive', 'spell', 'note'] as const) {
      expect(shouldPlayChatSound({ kind }, filter, true)).toBe(false);
    }
  });

  it('silences every notification while its switch is off and resumes only for new messages', () => {
    for (const kind of ['text', 'whisperTo', 'whisperFrom', 'alive', 'spell'] as const) {
      expect(shouldPlayChatSound({ kind }, DEFAULT_CHAT_FILTER, false)).toBe(false);
      expect(shouldPlayChatSound({ kind }, DEFAULT_CHAT_FILTER, true)).toBe(true);
    }
  });
});
