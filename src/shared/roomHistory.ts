import type { TagRgb } from './roomColors';

/** A line of this session's room chat. `tag` is who said it; a vote result and a note have none. */
export interface HistoryLine {
  at: number;
  /** 'note' is ours alone and never sent: what a command such as /mute did. */
  kind: 'text' | 'alive' | 'vote' | 'note';
  tag: { name: string; color: number; rgb: TagRgb | null } | null;
  text: string;
}
