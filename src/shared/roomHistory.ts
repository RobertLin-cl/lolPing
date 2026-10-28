import type { TagRgb } from './roomColors';

/**
 * A line of this session's room chat. `tag` is who said it, or for a whisper the member at the other end; a vote
 * result and a note have none.
 */
export interface HistoryLine {
  at: number;
  /**
   * 'note' is ours alone and never sent: what a command such as /mute did. 'whisperTo' is a whisper we sent the member
   * in `tag`, 'whisperFrom' one they sent us; nobody else sees either.
   */
  kind: 'text' | 'alive' | 'vote' | 'note' | 'whisperTo' | 'whisperFrom';
  tag: { name: string; color: number; rgb: TagRgb | null } | null;
  text: string;
}
