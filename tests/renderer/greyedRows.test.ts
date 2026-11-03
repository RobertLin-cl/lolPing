import { describe, expect, it } from 'vitest';
import { greyedRows } from '../../src/renderer/settings/greyedRows';
import type { AppStatus } from '../../src/shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

const on: AppStatus = { enabled: true, helper: 'running' };
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('greyedRows', () => {
  it('greys only summoner rows while their feature is off by default', () => {
    expect(greyedRows(settings(), on)).toEqual({ paused: false, sound: false, emoteClick: false, roomIncoming: false, summonerSpells: true, summonerSound: true });
  });

  it('enables summoner rows with the feature and greys only their sound under global mute', () => {
    const features = { ...DEFAULT_SETTINGS.features, roomSpells: true };
    const live = greyedRows(settings({ features }), on);
    expect(live.summonerSpells).toBe(false);
    expect(live.summonerSound).toBe(false);
    const muted = greyedRows(settings({ features, muted: true }), on);
    expect(muted.summonerSpells).toBe(false);
    expect(muted.summonerSound).toBe(true);
    expect(greyedRows(settings({ features, roomMuted: true }), on).summonerSound).toBe(false);
    expect(greyedRows(settings({ features: { ...features, rooms: false } }), on).summonerSpells).toBe(true);
    expect(greyedRows(settings({ features }), { enabled: false, helper: 'running' }).summonerSpells).toBe(true);
    expect(greyedRows(settings({ features }), { enabled: true, helper: 'failed' }).summonerSound).toBe(true);
  });

  it('greys every group while lolPing is off', () => {
    expect(greyedRows(settings(), { enabled: false, helper: 'running' }))
      .toEqual({ paused: true, sound: true, emoteClick: true, roomIncoming: true, summonerSpells: true, summonerSound: true });
  });

  it('greys every group while the helper has stopped, even with lolPing on', () => {
    expect(greyedRows(settings(), { enabled: true, helper: 'failed' }).paused).toBe(true);
  });

  it('greys the rest of Sound under Mute all sounds, and nothing else', () => {
    expect(greyedRows(settings({ muted: true }), on)).toEqual({ paused: false, sound: true, emoteClick: false, roomIncoming: false, summonerSpells: true, summonerSound: true });
  });

  it('greys only Ctrl + click without an emote key', () => {
    expect(greyedRows(settings({ emoteTrigger: 'off' }), on))
      .toEqual({ paused: false, sound: false, emoteClick: true, roomIncoming: false, summonerSpells: true, summonerSound: true });
  });

  it('greys the receive limit and friends\' text style under Mute room, and nothing else', () => {
    expect(greyedRows(settings({ roomMuted: true }), on))
      .toEqual({ paused: false, sound: false, emoteClick: false, roomIncoming: true, summonerSpells: true, summonerSound: true });
  });
});
