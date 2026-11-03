import type { Strings } from '../../shared/i18n';
import type { PanelAction } from '../../shared/ipc';
import type { RoomMember } from '../../shared/room';
import { DEFAULT_SUMMONER_STATE, SMITE_CAST_GAP_MS, spellCooldownView, SUMMONER_COOLDOWN_MS,
  type SpellCooldown } from '../../shared/summonerSpells';
import { summonerText } from '../../shared/summonerText';
import { el } from './vote';

export function summonerDisplay(cooldown: SpellCooldown, now: number) {
  const view = spellCooldownView(cooldown, now);
  const remaining = view.remainingMs || view.rechargeRemainingMs;
  const duration = cooldown.spell === 'smite' && view.charges > 0 && view.remainingMs > 0
    ? SMITE_CAST_GAP_MS : SUMMONER_COOLDOWN_MS[cooldown.spell];
  return { ...view, seconds: Math.ceil(remaining / 1000), sweep: Math.min(1, remaining / duration) };
}

export interface SummonerButtons {
  element: HTMLElement;
  update(now: number): boolean;
}

export function renderSummoners(m: RoomMember, textOn: boolean, t: Strings, act: (a: PanelAction) => void): SummonerButtons {
  const element = el('div', 'panel-spells');
  const spells = m.spells ?? DEFAULT_SUMMONER_STATE;
  const clear = m.self && m.spells !== undefined;
  const updates: ((now: number) => boolean)[] = [];
  for (const slot of ['d', 'f'] as const) {
    const cooldown = spells[slot];
    const button = el('button', 'panel-spell');
    button.type = 'button';
    button.dataset.slot = slot;
    button.disabled = !textOn && !clear;
    const image = el('img', '');
    image.src = `../summoners/${cooldown.spell}.png`;
    image.alt = '';
    const sweep = el('span', 'spell-sweep');
    const time = el('span', 'spell-time');
    const charges = el('span', 'spell-charges');
    button.append(image, sweep, el('kbd', '', slot.toUpperCase()), time, charges);
    button.addEventListener('click', () => { if (textOn) act({ t: 'spell', peer: m.peer, slot }); });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (clear) act({ t: 'clearSpell', peer: m.peer, slot });
    });
    updates.push((now) => {
      const view = summonerDisplay(cooldown, now);
      button.classList.toggle('cooling', !view.ready);
      sweep.style.setProperty('--sweep', `${view.sweep * 360}deg`);
      const seconds = view.seconds > 0 ? String(view.seconds) : '';
      if (time.textContent !== seconds) time.textContent = seconds;
      const count = cooldown.spell === 'smite' ? String(view.charges) : '';
      if (charges.textContent !== count) charges.textContent = count;
      const line = summonerText(t, cooldown, now, m.name, m.self);
      const title = [line, ...(textOn ? [t.summonerReportHint] : []), ...(clear ? [t.summonerClearHint] : [])].join('\n');
      if (button.title !== title) {
        button.title = title;
        button.setAttribute('aria-label', `${slot.toUpperCase()} ${line}`);
      }
      return view.seconds > 0;
    });
    element.append(button);
  }
  return { element, update: (now) => updates.map(update => update(now)).some(Boolean) };
}

/** One local animation loop for all rows; hidden panels stop it and catch up from end times when shown again. */
export function animateSummoners(views: readonly SummonerButtons[], now: () => number = Date.now): () => void {
  let frame: number | undefined;
  let stopped = false;
  const cancel = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; };
  const tick = () => {
    frame = undefined;
    if (stopped) return;
    const at = now();
    const moving = views.map(view => view.update(at)).some(Boolean);
    if (moving && !document.hidden) frame = requestAnimationFrame(tick);
  };
  const visibility = () => { cancel(); if (!document.hidden) tick(); };
  if (views.length) { document.addEventListener('visibilitychange', visibility); tick(); }
  return () => { stopped = true; cancel(); document.removeEventListener('visibilitychange', visibility); };
}
