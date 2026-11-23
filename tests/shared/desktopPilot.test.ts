import { describe, expect, it } from 'vitest';
import { desktopPilotArt, desktopPilotRuntime, desktopPilotSettings, updateDesktopPilotSettings } from '../../src/shared/desktopPilot';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

describe('desktopPilot', () => {
  it('repairs old settings while preserving supported ping and emote choices', () => {
    const settings = desktopPilotSettings({ volume: 42, features: { emotes: true, rooms: true }, clickPing: true });
    expect(settings.volume).toBe(42);
    expect(settings.clickPing).toBe(true);
    expect(settings.features.emotes).toBe(true);
    expect(settings.features.rooms).toBe(true);
    expect(settings.features.roomText).toBe(true);
    expect(settings.features.roomPanel).toBe(true);
    expect(settings.features.roomVotes).toBe(true);
    expect(desktopPilotSettings({ features: { roomSpells: true } }).features.roomSpells).toBe(true);
    expect(settings.features.teammate).toBe(false);
    expect(settings.launchAtStartup).toBe(false);
    expect(desktopPilotSettings({ launchAtStartup: true }).launchAtStartup).toBe(true);
    expect(desktopPilotSettings(null).wheel).toEqual(DEFAULT_SETTINGS.wheel);
  });

  it('leaves live chat keys to the host and keeps unmigrated shortcuts off', () => {
    const settings = desktopPilotSettings(DEFAULT_SETTINGS);
    const { config, overlay } = desktopPilotRuntime(settings, false, 'zh-TW');
    expect(config).toMatchObject({ enabled: false, textVk: 0, panelVk: 0, summonerKeys: false, askTrigger: 'off' });
    expect(overlay.lang).toBe('zh-TW');
    expect(config).toHaveProperty('emoteTrigger', settings.emoteTrigger);
  });

  it('rejects conflicting triggers without changing the current settings', () => {
    const current = desktopPilotSettings(DEFAULT_SETTINGS);
    const result = updateDesktopPilotSettings(current, { emoteTrigger: current.trigger }, 'en');
    expect(result.ok).toBe(false);
    expect(result.settings).toBe(current);
  });

  it('normalizes edits and ignores custom entries sent through the regular settings path', () => {
    const current = desktopPilotSettings(DEFAULT_SETTINGS);
    const result = updateDesktopPilotSettings(current, { volume: 900, customEmotes: [{ id: `c:${'a'.repeat(32)}`, name: 'A', animated: false }] }, 'en');
    expect(result.ok).toBe(true);
    expect(result.settings.volume).toBe(100);
    expect(result.settings.customEmotes).toEqual([]);
  });

  it('resolves imported animation and local sound without enabling any room service', () => {
    const id = `c:${'a'.repeat(32)}`;
    const settings = desktopPilotSettings({ customEmotes: [{ id, name: 'A', animated: true, sound: true, fx: 2 }] });
    expect(desktopPilotArt(settings, id)).toMatchObject({ kind: 'custom', animated: true, fx: 2,
      url: `lolping://emotes/${'a'.repeat(32)}.anim`, sound: `lolping://emotes/${'a'.repeat(32)}.sound` });
    expect(desktopPilotArt(settings, `c:${'b'.repeat(32)}`)).toEqual({ kind: 'placeholder' });
  });

  it('repairs the wheel and click emote after an imported image is removed', () => {
    const id = `c:${'a'.repeat(32)}`;
    const settings = desktopPilotSettings({ customEmotes: [{ id, name: 'A', animated: false }],
      emoteWheel: [id, ...DEFAULT_SETTINGS.emoteWheel.slice(1)], clickEmoteId: id });
    const removed = desktopPilotSettings({ ...settings, customEmotes: [] });
    expect(removed.emoteWheel).not.toContain(id);
    expect(removed.clickEmoteId).not.toBe(id);
    expect(new Set(removed.emoteWheel).size).toBe(8);
  });
});
