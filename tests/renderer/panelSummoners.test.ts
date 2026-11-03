// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animateSummoners, renderSummoners, summonerDisplay } from '../../src/renderer/panel/summoners';
import { strings } from '../../src/shared/i18n';
import type { PanelAction } from '../../src/shared/ipc';
import type { RoomMember } from '../../src/shared/room';
import { castSpell, createSpellCooldown } from '../../src/shared/summonerSpells';

const member = (extra: Partial<RoomMember> = {}): RoomMember => ({
  peer: '0123456789abcdef', name: 'Kim', color: 1, rgb: null, path: 'lan', status: 'on',
  needsUpdate: false, noEmotes: false, noChat: false, textOff: false, votesOff: false, muted: false, self: false, ...extra,
});
const button = (root: HTMLElement, slot: string): HTMLButtonElement => {
  const found = root.querySelector<HTMLButtonElement>('button[data-slot="' + slot + '"]');
  if (!found) throw new Error('Missing spell button');
  return found;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('panel summoners', () => {
  it('shows old peers with ready Heal and Flash, and posts a slot without trusting renderer cooldown data', () => {
    const actions: PanelAction[] = [];
    const view = renderSummoners(member(), true, strings('en'), a => actions.push(a));
    view.update(1000);
    expect(button(view.element, 'd').querySelector('img')?.src).toContain('/summoners/heal.png');
    expect(button(view.element, 'f').querySelector('img')?.src).toContain('/summoners/flash.png');
    expect(view.element.querySelectorAll('.spell-time')[0].textContent).toBe('');
    button(view.element, 'f').click();
    button(view.element, 'f').dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    expect(actions).toEqual([{ t: 'spell', peer: member().peer, slot: 'f' }]);
  });

  it('only clears an own live slot and keeps clear available when room text is off', () => {
    const actions: PanelAction[] = [];
    const view = renderSummoners(member({ self: true, spells: {
      d: createSpellCooldown('heal'), f: castSpell(createSpellCooldown('flash'), 0).cooldown,
    } }), false, strings('en'), a => actions.push(a));
    view.update(0);
    button(view.element, 'f').click();
    button(view.element, 'f').dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    expect(actions).toEqual([{ t: 'clearSpell', peer: member().peer, slot: 'f' }]);
    const old = renderSummoners(member({ self: true }), false, strings('en'), a => actions.push(a));
    expect(button(old.element, 'f').disabled).toBe(true);
  });

  it('shows Smite charges and switches from the cast gap to the charge recharge countdown', () => {
    const smite = castSpell(createSpellCooldown('smite'), 0).cooldown;
    expect(summonerDisplay(smite, 0)).toMatchObject({ seconds: 15, charges: 1, ready: false, sweep: 1 });
    expect(summonerDisplay(smite, 15000)).toMatchObject({ seconds: 75, charges: 1, ready: true });
    expect(summonerDisplay(smite, 90000)).toMatchObject({ seconds: 0, charges: 2, ready: true, sweep: 0 });
  });

  it('animates from timestamps, pauses while hidden and catches up when visible without a network update', () => {
    let hidden = false;
    let now = 0;
    let id = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; });
    vi.stubGlobal('cancelAnimationFrame', (key: number) => { frames.delete(key); });
    const view = renderSummoners(member({ spells: {
      d: castSpell(createSpellCooldown('heal'), 0).cooldown, f: createSpellCooldown('flash'),
    } }), true, strings('en'), () => {});
    const stop = animateSummoners([view], () => now);
    expect(button(view.element, 'd').querySelector('.spell-time')?.textContent).toBe('240');
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    now = 240000;
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(button(view.element, 'd').querySelector('.spell-time')?.textContent).toBe('');
    expect(button(view.element, 'd').classList.contains('cooling')).toBe(false);
    expect(frames.size).toBe(0);
    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
  });
});
