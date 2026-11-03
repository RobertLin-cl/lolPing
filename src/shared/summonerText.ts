import type { Strings } from './i18n';
import { spellCooldownView, type SpellCooldown } from './summonerSpells';

/** League's scoreboard sentence without the sender tag, evaluated at the click's timestamp. */
export function summonerText(t: Strings, cooldown: SpellCooldown, at: number, name: string, own: boolean): string {
  const spell = t.summonerNames[cooldown.spell];
  const view = spellCooldownView(cooldown, at);
  if (cooldown.spell === 'smite') return t.summonerLines.charges(own ? '' : name, spell, view.charges);
  if (view.ready) return own ? t.summonerLines.ready(spell) : t.summonerLines.allyReady(name, spell);
  const seconds = Math.ceil(view.remainingMs / 1000);
  return own ? t.summonerLines.cooldown(spell, seconds) : t.summonerLines.wait(name, spell, seconds);
}
