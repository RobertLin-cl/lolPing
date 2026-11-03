import { describe, expect, it } from 'vitest';
import { strings } from '../../src/shared/i18n';
import { summonerText } from '../../src/shared/summonerText';
import { castSpell, createSpellCooldown } from '../../src/shared/summonerSpells';

describe('summonerText', () => {
  it('uses League Traditional Chinese sentences for own and ally ready and cooldown clicks', () => {
    const t = strings('zh-TW');
    const flash = createSpellCooldown('flash');
    expect(summonerText(t, flash, 0, 'Kim', true)).toBe('閃現 － 就緒');
    expect(summonerText(t, flash, 0, 'Kim', false)).toBe('Kim 閃現 - 準備就緒');
    const cast = castSpell(flash, 0).cooldown;
    expect(summonerText(t, cast, 55000, 'Kim', true)).toBe('閃現 － 245 秒');
    expect(summonerText(t, cast, 55000, 'Kim', false)).toBe('等候Kim閃現：245秒');
    expect(summonerText(t, cast, 299999, 'Kim', true)).toBe('閃現 － 1 秒');
    expect(summonerText(t, cast, 300000, 'Kim', true)).toBe('閃現 － 就緒');
  });

  it('reports Smite charges including during the cast gap and after a recharge', () => {
    const t = strings('zh-TW');
    const first = castSpell(createSpellCooldown('smite'), 0).cooldown;
    expect(summonerText(t, first, 1, 'Kim', true)).toBe('重擊 - 1 個充能');
    const second = castSpell(first, 15000).cooldown;
    expect(summonerText(t, second, 15001, 'Kim', false)).toBe('Kim 重擊 - 0 個充能');
    expect(summonerText(t, second, 90000, 'Kim', true)).toBe('重擊 - 1 個充能');
  });

  it('uses the viewer language for English and Simplified Chinese', () => {
    expect(summonerText(strings('en'), createSpellCooldown('heal'), 0, 'Kim', false)).toBe('Kim Heal - Ready');
    expect(summonerText(strings('zh-CN'), castSpell(createSpellCooldown('flash'), 0).cooldown, 55000, 'Kim', false))
      .toBe('等待Kim 闪现 - 245秒');
  });
});
