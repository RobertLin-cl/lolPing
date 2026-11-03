import { Popover, PopoverSurface, PopoverTrigger } from '@fluentui/react-components';
import { Checkmark16Filled } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import {
  selectSummonerSpell, SUMMONER_SPELL_IDS, type SummonerSpellId, type SummonerSpellSelection, type SummonerSpellSlot,
} from '../../../shared/summonerSpells';
import { useText } from '../text';

const SLOTS = ['d', 'f'] as const;
const iconUrl = (spell: SummonerSpellId): string => `../summoners/${spell}.png`;

/** Both spell slots share one League-style grid; selected spells remain available for swapping. */
export function SummonerSpellPicker({ value, onChange, disabled = false }: {
  value: SummonerSpellSelection;
  onChange(value: SummonerSpellSelection): void;
  disabled?: boolean;
}) {
  const t = useText();
  const [active, setActive] = useState<SummonerSpellSlot | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (disabled) setActive(null); }, [disabled]);
  const choose = (spell: SummonerSpellId): void => {
    if (!active || disabled) return;
    const next = selectSummonerSpell(value, active, spell);
    if (next.d !== value.d || next.f !== value.f) onChange(next);
    setActive(null);
    trigger.current?.focus();
  };
  return (
    <Popover open={active !== null && !disabled} positioning={{
      position: 'before', align: 'center', offset: 10, shiftToCoverTarget: true,
      overflowBoundaryPadding: { top: 48, bottom: 8, start: 8, end: 8 },
    }}
      onOpenChange={(event, data) => {
        if (!data.open) {
          setActive(null);
          if (event.type === 'keydown') trigger.current?.focus();
        }
      }}>
      <PopoverTrigger disableButtonEnhancement>
        <div className="summonerSlots" role="group" aria-label={t.featureTitle.roomSpells}>
          {SLOTS.map((slot) => (
            <button key={slot} type="button" className={`summonerSlot${active === slot ? ' active' : ''}`}
              disabled={disabled} aria-haspopup="dialog" aria-expanded={active === slot}
              aria-label={t[slot === 'd' ? 'summonerD' : 'summonerF'] + ': ' + t.summonerNames[value[slot]]}
              title={t.summonerNames[value[slot]]} onClick={(event) => {
                event.stopPropagation();
                trigger.current = event.currentTarget;
                setActive(active === slot ? null : slot);
              }}>
              <img src={iconUrl(value[slot])} alt="" />
              <kbd>{slot.toUpperCase()}</kbd>
            </button>
          ))}
        </div>
      </PopoverTrigger>
      <PopoverSurface className="summonerMenu" role="dialog" aria-label={t.featureTitle.roomSpells}>
        <div className="summonerMenuTitle">{t[active === 'f' ? 'summonerF' : 'summonerD']}</div>
        <div className="summonerGrid">
          {SUMMONER_SPELL_IDS.map((spell) => {
            const selected = SLOTS.find((slot) => value[slot] === spell);
            return (
              <button key={spell} type="button" className="summonerChoice" aria-pressed={selected !== undefined}
                aria-label={t.summonerNames[spell]} onClick={() => choose(spell)}>
                <span className="summonerChoiceArt">
                  <img src={iconUrl(spell)} alt="" />
                  {selected ? <><kbd>{selected.toUpperCase()}</kbd><span className="summonerCheck"><Checkmark16Filled /></span></> : null}
                </span>
                <span className="summonerChoiceName">{t.summonerNames[spell]}</span>
              </button>
            );
          })}
        </div>
        <div className="summonerMenuHint">{t.summonerSwapHint}</div>
      </PopoverSurface>
    </Popover>
  );
}
