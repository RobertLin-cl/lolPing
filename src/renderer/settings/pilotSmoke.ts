import type { SettingsApi } from '../../shared/ipc';
import type { EmoteRef } from '../../shared/emotes';
import { customHash, customHdUrl, customSoundUrl, customStillUrl } from '../../shared/emotes';
import { desktopPilotSettings } from '../../shared/desktopPilot';
import { soundUrl } from '../../shared/pings';
import { PILOT_CH } from '../../shared/settingsChannels';
import type { PilotHost, PilotSnapshot } from '../shared/pilotHost';
import { prepareEmote, prepareSound } from './emoteImport';

/** Exercises the real WebView codecs and native file commands in the isolated smoke directory. */
export async function runPilotSmoke(api: SettingsApi, host: PilotHost, snapshot: PilotSnapshot): Promise<void> {
  const original = desktopPilotSettings(snapshot.settings);
  let importedId: EmoteRef | null = null;
  let passed = false;
  try {
    await api.setEnabled(false);
    const changed = await api.setSettings({ volume: original.volume === 41 ? 42 : 41 });
    if (!changed.ok || (await api.getSettings()).volume !== changed.settings.volume || (await api.getStatus()).enabled) {
      throw new Error('Settings round trip failed');
    }
    await api.previewPing('danger');
    if (original.customEmotes.length) await checkAsset(customStillUrl(customHash(original.customEmotes[0].id)));

    const canvas = new OffscreenCanvas(320, 240);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#5946b2';
    context.fillRect(0, 0, 320, 240);
    context.fillStyle = '#ffffff';
    context.fillRect(80, 60, 160, 120);
    const prepared = await prepareEmote(new File([await canvas.convertToBlob({ type: 'image/png' })], 'Rust import smoke.png'));
    if (!prepared.ok || !prepared.file.hd) throw new Error('Image preparation failed');
    const imported = await api.importEmote(prepared.file);
    if (!imported.ok) throw new Error(`Import failed: ${imported.error}`);
    importedId = imported.id;
    const hash = customHash(importedId);
    await checkAsset(customStillUrl(hash));
    await checkAsset(customHdUrl(hash));
    const duplicate = await api.importEmote(prepared.file);
    if (duplicate.ok || duplicate.error !== 'duplicate') throw new Error('Duplicate image was accepted');

    const wave = await (await fetch(soundUrl('Base'))).blob();
    const sound = await prepareSound(new File([wave], 'smoke.wav'));
    if (!sound.ok || !(await api.setEmoteSound(importedId, sound.bytes)).ok) throw new Error('Sound import failed');
    await checkAsset(customSoundUrl(hash));
    await api.setEmoteFx(importedId, 2);
    await api.setSettings({ emoteWheel: [importedId, ...original.emoteWheel.slice(1)], clickEmoteId: importedId });
    const stored = await api.getSettings();
    if (stored.customEmotes.find((c) => c.id === importedId)?.fx !== 2 || stored.emoteWheel[0] !== importedId) {
      throw new Error('Imported image settings did not reach the native store');
    }
    await api.previewEmote(importedId);
    if (!(await api.setEmoteSound(importedId, null)).ok || (await fetch(customSoundUrl(hash))).status !== 404) {
      throw new Error('Sound removal failed');
    }
    await api.removeEmote(importedId);
    const removed = await api.getSettings();
    if (removed.customEmotes.some((c) => c.id === importedId) || removed.emoteWheel.includes(importedId)
        || removed.clickEmoteId === importedId || (await fetch(customStillUrl(hash))).status !== 404) {
      throw new Error('Image removal did not repair the wheel or hide its files');
    }
    importedId = null;
    passed = true;
  } catch (error) {
    console.error(error);
  } finally {
    try {
      if (importedId) await api.removeEmote(importedId);
      const restored = await api.setSettings({ volume: original.volume, emoteWheel: original.emoteWheel, clickEmoteId: original.clickEmoteId });
      if (!restored.ok) throw new Error('Could not restore smoke settings');
      await api.setEnabled(snapshot.status.enabled);
    } catch (error) { passed = false; console.error(error); }
    await host.invoke(PILOT_CH.smokeResult, { passed });
  }
}

async function checkAsset(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || (await response.arrayBuffer()).byteLength === 0) throw new Error('Custom asset could not be read');
}
