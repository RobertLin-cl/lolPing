// @vitest-environment jsdom
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SummonerSpellPicker } from '../../src/renderer/settings/components/SummonerSpellPicker';
import type { SummonerSpellSelection } from '../../src/shared/summonerSpells';

let root: Root;
let host: HTMLDivElement;

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<SummonerSpellSelection>({ d: 'heal', f: 'flash' });
  return createElement(FluentProvider, { theme: webDarkTheme },
    createElement(SummonerSpellPicker, { value, onChange: setValue, disabled }));
}

const button = (label: string): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]');
  if (!found) throw new Error('Missing button: ' + label);
  return found;
};
const click = async (label: string): Promise<void> => {
  await act(async () => { button(label).click(); });
};

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(Harness)); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

describe('SummonerSpellPicker', () => {
  it('uses one shared menu and checks both selected spells with their keys', async () => {
    await click('D summoner spell: Heal');
    expect(document.querySelectorAll('.summonerMenu')).toHaveLength(1);
    expect(document.querySelectorAll('.summonerChoice')).toHaveLength(11);
    expect(document.querySelectorAll('.summonerChoice[aria-pressed="true"]')).toHaveLength(2);
    expect(button('Heal').querySelector('kbd')?.textContent).toBe('D');
    expect(button('Flash').querySelector('kbd')?.textContent).toBe('F');
    expect(button('Flash').disabled).toBe(false);

    await click('F summoner spell: Flash');
    expect(document.querySelectorAll('.summonerMenu')).toHaveLength(1);
    expect(document.querySelector('.summonerMenuTitle')?.textContent).toBe('F summoner spell');
    await click('D summoner spell: Heal');
    await click('Flash');
    expect(document.querySelector('.summonerMenu')).toBeNull();
    expect(button('D summoner spell: Flash')).toBe(document.activeElement);
    expect(button('F summoner spell: Heal')).not.toBeNull();

    await click('F summoner spell: Heal');
    expect(document.querySelectorAll('.summonerMenu')).toHaveLength(1);
    expect(button('Flash').querySelector('kbd')?.textContent).toBe('D');
    expect(button('Heal').querySelector('kbd')?.textContent).toBe('F');
    await click('Smite');
    expect(button('D summoner spell: Flash')).not.toBeNull();
    expect(button('F summoner spell: Smite')).not.toBeNull();
  });

  it('closes on Escape or a current pick without changing either spell', async () => {
    await click('D summoner spell: Heal');
    await act(async () => {
      button('Heal').focus();
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.summonerMenu')).toBeNull();
    expect(button('D summoner spell: Heal')).toBe(document.activeElement);
    await click('D summoner spell: Heal');
    await click('Heal');
    expect(document.querySelector('.summonerMenu')).toBeNull();
    expect(button('D summoner spell: Heal')).not.toBeNull();
    expect(button('F summoner spell: Flash')).not.toBeNull();
  });

  it('closes when the row becomes disabled and keeps the selected pair', async () => {
    await click('D summoner spell: Heal');
    expect(document.querySelector('.summonerMenu')).not.toBeNull();
    await act(async () => { root.render(createElement(Harness, { disabled: true })); });
    expect(document.querySelector('.summonerMenu')).toBeNull();
    expect(button('D summoner spell: Heal').disabled).toBe(true);
    expect(button('F summoner spell: Flash').disabled).toBe(true);
    await act(async () => { root.render(createElement(Harness)); });
    expect(document.querySelector('.summonerMenu')).toBeNull();
  });
});
