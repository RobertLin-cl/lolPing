import { customAnimUrl, customHash, customHdUrl, customSoundUrl, isBundledEmote, type EmoteArt } from './emotes';
import { resolveLang, strings } from './i18n';
import { configCommand } from './protocol';
import {
  mergeSettings, normalizeSettings, overlaySettings, patchClashes, rendererPatch, type Settings,
} from './settings';
import type { SetSettingsResult } from './ipc';

/** Keep unavailable features off until their desktop services have been migrated. */
export function desktopPilotSettings(raw: unknown): Settings {
  const settings = normalizeSettings(raw, 'win');
  settings.features = { ...settings.features, teammate: false };
  settings.launchAtStartup = false;
  return settings;
}

export function updateDesktopPilotSettings(current: Settings, raw: unknown, locale: string): SetSettingsResult {
  const patch = rendererPatch(raw);
  const text = strings(resolveLang(current.language, locale), 'win');
  if (patchClashes(current, patch, 'win')) return { ok: false, error: text.emoteKeyClash, settings: current };
  const toggle = patch.toggleHotkey ?? current.toggleHotkey;
  const chat = patch.textHotkey ?? current.textHotkey;
  if (toggle.mods === chat.mods && toggle.vk === chat.vk) {
    return { ok: false, error: text.shortcutClash, settings: current };
  }
  return { ok: true, settings: desktopPilotSettings(mergeSettings(current, patch, 'win')) };
}

export function desktopPilotRuntime(settings: Settings, enabled: boolean, locale: string) {
  return {
    config: configCommand(settings, enabled),
    overlay: overlaySettings(settings, resolveLang(settings.language, locale)),
  };
}

export function desktopPilotArt(settings: Settings, ref: string): EmoteArt {
  if (isBundledEmote(ref)) return { kind: 'bundled', slug: ref };
  const emote = settings.customEmotes.find((c) => c.id === ref);
  if (!emote) return { kind: 'placeholder' };
  const hash = customHash(ref);
  return { kind: 'custom', url: emote.animated ? customAnimUrl(hash) : customHdUrl(hash),
    animated: emote.animated, fx: emote.fx ?? 0, ...(emote.sound ? { sound: customSoundUrl(hash) } : {}) };
}
