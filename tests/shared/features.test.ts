import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES, featureGroups, featureOn, featureVisible, liveKeys, normalizeFeatures, roomFeaturesOff } from '../../src/shared/features';

describe('features', () => {
  it('keeps the teammate and summoner spells off by default', () => {
    expect(normalizeFeatures(undefined)).toEqual(DEFAULT_FEATURES);
    expect(Object.entries(DEFAULT_FEATURES).filter(([, v]) => !v).map(([k]) => k)).toEqual(['teammate', 'roomSpells']);
  });

  it('keeps the teammate off by default and never offers it, on any platform', () => {
    expect(DEFAULT_FEATURES.teammate).toBe(false);
    expect(featureOn({ features: DEFAULT_FEATURES }, 'teammate')).toBe(false);
    for (const platform of ['win', 'mac', 'linux'] as const) {
      expect(featureVisible('teammate', platform)).toBe(false);
      expect(featureVisible('rooms', platform)).toBe(true);
    }
  });

  it('groups the room features under Rooms and leaves the others on their own', () => {
    expect(featureGroups('win')).toEqual([
      { id: 'emotes', parts: [] },
      { id: 'rooms', parts: ['roomText', 'roomVotes', 'roomPanel', 'roomSpells'] },
    ]);
    expect(featureGroups('mac').map((g) => g.id)).toEqual(['emotes', 'rooms']);
    expect(featureGroups('linux').map((g) => g.id)).toEqual(['emotes', 'rooms']);
  });

  it('offers summoner spells only on Windows and keeps them off in old settings', () => {
    expect(featureVisible('roomSpells', 'win')).toBe(true);
    for (const platform of ['mac', 'linux'] as const) {
      expect(featureVisible('roomSpells', platform)).toBe(false);
      expect(featureGroups(platform).find((group) => group.id === 'rooms')?.parts)
        .toEqual(['roomText', 'roomVotes', 'roomPanel']);
    }
    expect(normalizeFeatures({ roomPanel: true }).roomSpells).toBe(false);
    expect(normalizeFeatures({ roomSpells: true }).roomSpells).toBe(true);
    expect(normalizeFeatures({ roomSpells: 'yes' }).roomSpells).toBe(false);
  });

  it('repairs a broken value key by key', () => {
    const f = normalizeFeatures({ rooms: false, emotes: 1, extra: true });
    expect(f).toEqual({ ...DEFAULT_FEATURES, rooms: false });
    expect('extra' in f).toBe(false);
    expect(normalizeFeatures('yes')).toEqual(DEFAULT_FEATURES);
    expect(normalizeFeatures([true])).toEqual(DEFAULT_FEATURES);
  });

  it('counts a room feature as off while rooms are off', () => {
    const s = { features: { ...DEFAULT_FEATURES, rooms: false } };
    expect(featureOn(s, 'roomText')).toBe(false);
    expect(featureOn(s, 'roomVotes')).toBe(false);
    expect(featureOn(s, 'roomPanel')).toBe(false);
    expect(featureOn({ features: { ...s.features, roomSpells: true } }, 'roomSpells')).toBe(false);
    expect(featureOn(s, 'rooms')).toBe(false);
    expect(featureOn(s, 'emotes')).toBe(true);
  });

  it('keeps a room feature off by its own switch while rooms are on', () => {
    const s = { features: { ...DEFAULT_FEATURES, roomVotes: false } };
    expect(featureOn(s, 'roomVotes')).toBe(false);
    expect(featureOn(s, 'roomText')).toBe(true);
  });

  it('lists the room features that are off, and all of them when rooms are off', () => {
    expect(roomFeaturesOff({ features: DEFAULT_FEATURES })).toEqual([]);
    expect(roomFeaturesOff({ features: { ...DEFAULT_FEATURES, roomVotes: false } })).toEqual(['votes']);
    expect(roomFeaturesOff({ features: { ...DEFAULT_FEATURES, roomText: false, roomVotes: false } })).toEqual(['text', 'votes']);
    expect(roomFeaturesOff({ features: { ...DEFAULT_FEATURES, rooms: false } })).toEqual(['text', 'votes']);
  });

  it('turns the text key on only in an active room with text on', () => {
    const on = { features: DEFAULT_FEATURES };
    expect(liveKeys(on, { active: true }, true)).toEqual({ text: true, panel: true });
    expect(liveKeys(on, { active: false }, true)).toEqual({ text: false, panel: false });
    expect(liveKeys(on, { active: true }, false)).toEqual({ text: false, panel: false });
    expect(liveKeys({ features: { ...DEFAULT_FEATURES, roomText: false } }, { active: true }, true))
      .toEqual({ text: false, panel: true });
    expect(liveKeys({ features: { ...DEFAULT_FEATURES, roomPanel: false } }, { active: true }, true))
      .toEqual({ text: true, panel: false });
    expect(liveKeys({ features: { ...DEFAULT_FEATURES, rooms: false } }, { active: true }, true))
      .toEqual({ text: false, panel: false });
  });
});
