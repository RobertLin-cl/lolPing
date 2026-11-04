import { historyVisible, type ChatFilter } from './chatFilter';
import type { HistoryLine } from './roomHistory';

export const CHAT_MESSAGE_SOUND = { key: 'chat:message', url: '../ui/chat-message.wav' } as const;

/** New visible text, whispers and scoreboard reports share one notification cue. */
export function shouldPlayChatSound(line: Pick<HistoryLine, 'kind'>, filter: ChatFilter, enabled: boolean): boolean {
  return enabled && (line.kind === 'text' || line.kind === 'whisperTo' || line.kind === 'whisperFrom'
    || line.kind === 'alive' || line.kind === 'spell') && historyVisible(line, filter);
}
