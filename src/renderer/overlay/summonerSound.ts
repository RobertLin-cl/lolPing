import { soundLevel, type OverlaySettings } from '../../shared/settings';
import { SUMMONER_SPELL_IDS, type SummonerSpellId } from '../../shared/summonerSpells';
import type { SoundBank } from './soundBank';

export const summonerSoundEntries = SUMMONER_SPELL_IDS.map(spell => ({
  key: `summoner:${spell}`, url: `../summoners/${spell}.wav`,
}));

/** Only a successful local cast reaches here; switches are read at playback time. */
export function playSummonerSound(
  bank: Pick<SoundBank, 'play'>, settings: Pick<OverlaySettings, 'summonerSound' | 'muted' | 'volume'>, spell: SummonerSpellId,
): void {
  const volume = settings.summonerSound ? soundLevel(settings) : 0;
  if (volume > 0) bank.play(`summoner:${spell}`, volume);
}
