import { featureOn } from '../../shared/features';
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
  /** Local casts need the room sub-feature, but Mute room only affects incoming content. */
  summonerSpells: boolean;
  summonerSound: boolean;
}

export function greyedRows(s: Pick<Settings, 'muted' | 'roomMuted' | 'emoteTrigger' | 'features'>, status: AppStatus): GreyedRows {
  const paused = !status.enabled || status.helper === 'failed';
  const summonerSpells = paused || !featureOn(s, 'roomSpells');
  return {
    paused,
    sound: paused || s.muted,
    emoteClick: paused || s.emoteTrigger === 'off',
    roomIncoming: paused || s.roomMuted,
    summonerSpells,
    summonerSound: summonerSpells || s.muted,
  };
}
