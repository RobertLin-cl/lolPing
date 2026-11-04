import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SoundBank } from '../../src/renderer/overlay/soundBank';
import { playSummonerSound, summonerSoundEntries } from '../../src/renderer/overlay/summonerSound';
import { DEFAULT_SETTINGS, overlaySettings } from '../../src/shared/settings';

const played: { buffer: unknown; volume: number }[] = [];
class Gain {
  gain = { value: 0 };
  connect() {}
}
class Source {
  buffer: unknown;
  onended: (() => void) | null = null;
  private gain: Gain | null = null;
  connect(gain: Gain): Gain { this.gain = gain; return gain; }
  start(): void { played.push({ buffer: this.buffer, volume: this.gain?.gain.value ?? 0 }); this.onended?.(); }
}
class Context {
  state = 'running';
  destination = {};
  decoded = 0;
  decodeAudioData(_bytes: ArrayBuffer) { return Promise.resolve({ clip: ++this.decoded }); }
  createBufferSource() { return new Source(); }
  createGain() { return new Gain(); }
}
beforeEach(() => {
  played.length = 0;
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3])));
});
afterEach(() => vi.unstubAllGlobals());

describe('summonerSound', () => {
  it('preloads all eleven bundled WAVs and selects the accepted cast at the current volume', async () => {
    expect(summonerSoundEntries).toHaveLength(11);
    for (const entry of summonerSoundEntries) expect(existsSync(resolve('assets', entry.url.slice(3)))).toBe(true);
    const bank = new SoundBank();
    expect(await bank.load(summonerSoundEntries)).toEqual([]);
    playSummonerSound(bank, { ...overlaySettings(DEFAULT_SETTINGS), volume: 35 }, 'flash');
    expect(played).toEqual([{ buffer: { clip: 1 }, volume: 0.35 }]);
  });

  it('honors live mute, zero volume and the separate spell switch without muting other sounds', async () => {
    const bank = new SoundBank();
    await bank.load(summonerSoundEntries);
    const s = overlaySettings(DEFAULT_SETTINGS);
    playSummonerSound(bank, { ...s, muted: true }, 'flash');
    playSummonerSound(bank, { ...s, volume: 0 }, 'flash');
    playSummonerSound(bank, { ...s, summonerSound: false }, 'flash');
    expect(played).toHaveLength(0);
    bank.play('summoner:heal', 0.4);
    expect(played).toHaveLength(1);
    playSummonerSound(bank, { ...s, summonerSound: true, volume: 20 }, 'heal');
    expect(played.at(-1)).toEqual({ buffer: { clip: 4 }, volume: 0.2 });
  });
});
