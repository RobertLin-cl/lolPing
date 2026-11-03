import { describe, expect, it } from 'vitest';
import { greyedRows } from '../../src/renderer/settings/greyedRows';
import type { AppStatus } from '../../src/shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings';

const on: AppStatus = { enabled: true, helper: 'running' };
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('greyedRows', () => {
  it('greys nothing while lolPing is on with its defaults', () => {
    expect(greyedRows(settings(), on)).toEqual({ paused: false, sound: false, emoteClick: false, roomIncoming: false });
  });

  it('greys every group while lolPing is off', () => {
    expect(greyedRows(settings(), { enabled: false, helper: 'running' }))
      .toEqual({ paused: true, sound: true, emoteClick: true, roomIncoming: true });
  });

  it('greys every group while the helper has stopped, even with lolPing on', () => {
    expect(greyedRows(settings(), { enabled: true, helper: 'failed' }).paused).toBe(true);
  });

  it('greys the rest of Sound under Mute all sounds, and nothing else', () => {
    expect(greyedRows(settings({ muted: true }), on)).toEqual({ paused: false, sound: true, emoteClick: false, roomIncoming: false });
  });

  it('greys only Ctrl + click without an emote key', () => {
    expect(greyedRows(settings({ emoteTrigger: 'off' }), on))
      .toEqual({ paused: false, sound: false, emoteClick: true, roomIncoming: false });
  });

  it('greys the receive limit and friends\' text style under Mute room, and nothing else', () => {
    expect(greyedRows(settings({ roomMuted: true }), on))
      .toEqual({ paused: false, sound: false, emoteClick: false, roomIncoming: true });
  });
});
