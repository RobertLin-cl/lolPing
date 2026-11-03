import { describe, expect, it } from 'vitest';
import { SummonerSession } from '../../src/main/summonerSession';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { spellCooldownView } from '../../src/shared/summonerSpells';

describe('SummonerSession', () => {
  it('ignores casts outside a session and while input is disabled', () => {
    const session = new SummonerSession(() => 1000);
    expect(session.cast('d', true)).toBe(false);
    session.sync(DEFAULT_SETTINGS, 'room');
    expect(session.cast('d', false)).toBe(false);
    expect(session.state()?.d.rechargeEndsAt).toEqual([]);
  });

  it('casts each slot independently and rejects casts until its cooldown ends', () => {
    let now = 1000;
    const session = new SummonerSession(() => now);
    session.sync(DEFAULT_SETTINGS, 'room');
    expect(session.cast('d', true)).toBe(true);
    expect(session.cast('d', true)).toBe(false);
    expect(session.cast('f', true)).toBe(true);
    expect(session.state()?.d.rechargeEndsAt).toEqual([241000]);
    expect(session.state()?.f.rechargeEndsAt).toEqual([301000]);
    now = 241000;
    expect(session.cast('d', true)).toBe(true);
    expect(session.cast('f', true)).toBe(false);
  });

  it('keeps cooldowns across settings refreshes, pauses and helper restarts', () => {
    const session = new SummonerSession(() => 1000);
    session.sync(DEFAULT_SETTINGS, 'room');
    session.cast('d', true);
    const state = session.state();
    session.sync(DEFAULT_SETTINGS, 'room');
    expect(session.state()).toBe(state);
    expect(session.cast('d', false)).toBe(false);
    expect(session.cast('d', true)).toBe(false);
  });

  it('resets both slots when leaving, changing rooms or changing spell choices', () => {
    const session = new SummonerSession(() => 1000);
    session.sync(DEFAULT_SETTINGS, 'room');
    session.cast('d', true);
    session.cast('f', true);
    session.sync(DEFAULT_SETTINGS, 'another-room');
    expect(session.state()?.d.rechargeEndsAt).toEqual([]);
    session.cast('d', true);
    session.sync({ summonerD: 'ignite', summonerF: 'flash' }, 'another-room');
    expect(session.state()?.d.spell).toBe('ignite');
    expect(session.state()?.d.rechargeEndsAt).toEqual([]);
    expect(session.state()?.f.rechargeEndsAt).toEqual([]);
    session.cast('d', true);
    session.sync(DEFAULT_SETTINGS, null);
    expect(session.state()).toBeNull();
    expect(session.cast('d', true)).toBe(false);
    session.sync(DEFAULT_SETTINGS, 'another-room');
    expect(session.cast('d', true)).toBe(true);
    expect(new SummonerSession(() => 1000).state()).toBeNull();
  });

  it('clears only the selected slot and restores both Smite charges', () => {
    const session = new SummonerSession(() => 1000);
    expect(session.clear('d')).toBe(false);
    session.sync({ summonerD: 'smite', summonerF: 'flash' }, 'room');
    session.cast('d', true);
    session.cast('f', true);
    const flash = session.state()?.f;
    expect(session.clear('d')).toBe(true);
    expect(session.state()?.d).toEqual({ spell: 'smite', rechargeEndsAt: [], castEndsAt: 0 });
    expect(session.state()?.f).toBe(flash);
  });

  it('uses sequential Smite recharge times and its separate cast gap', () => {
    let now = 1000;
    const session = new SummonerSession(() => now);
    session.sync({ summonerD: 'smite', summonerF: 'flash' }, 'room');
    expect(session.cast('d', true)).toBe(true);
    now = 15999;
    expect(session.cast('d', true)).toBe(false);
    now = 16000;
    expect(session.cast('d', true)).toBe(true);
    expect(session.state()?.d.rechargeEndsAt).toEqual([91000, 181000]);
    now = 91000;
    const state = session.state();
    if (!state) throw new Error('Missing session');
    expect(spellCooldownView(state.d, now).charges).toBe(1);
    expect(session.cast('d', true)).toBe(true);
  });
});
