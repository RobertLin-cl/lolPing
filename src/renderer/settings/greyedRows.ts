import type { AppStatus } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';

/** The groups of settings rows that grey out, and so can't be used. A row greys out only while it does nothing. */
export interface GreyedRows {
  /** lolPing is off or its helper stopped: Sound, Wheel, Pings, Emotes and most of Room do nothing. */
  paused: boolean;
  /** Volume, emote sound and the wheel's tick: nothing plays under Mute all sounds. */
  sound: boolean;
  /** Ctrl + click needs an emote key. */
  emoteClick: boolean;
  /** The receive limit and how friends' text shows: Mute room drops everything others send. */
  roomIncoming: boolean;
}

export function greyedRows(s: Pick<Settings, 'muted' | 'roomMuted' | 'emoteTrigger'>, status: AppStatus): GreyedRows {
  const paused = !status.enabled || status.helper === 'failed';
  return {
    paused,
    sound: paused || s.muted,
    emoteClick: paused || s.emoteTrigger === 'off',
    roomIncoming: paused || s.roomMuted,
  };
}
