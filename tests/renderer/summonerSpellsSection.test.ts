// @vitest-environment jsdom
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SummonerSpellsSection } from '../../src/renderer/settings/components/SummonerSpellsSection';
import { greyedRows } from '../../src/renderer/settings/greyedRows';
import type { Update } from '../../src/renderer/settings/useAppState';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';

function Harness() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const update: Update = async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    return { ok: true, settings: next };
  };
  return createElement(FluentProvider, { theme: webDarkTheme }, createElement(SummonerSpellsSection, {
    settings, update, grey: greyedRows(settings, { enabled: true, helper: 'running' }),
  }));
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('SummonerSpellsSection', () => {
  it('keeps the default-off controls visible and inert until its switch is enabled', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(createElement(Harness)); });
      const rows = host.querySelectorAll('.card');
      expect(rows).toHaveLength(3);
      expect(rows[0].hasAttribute('inert')).toBe(false);
      expect(rows[1].hasAttribute('inert')).toBe(true);
      expect(rows[2].hasAttribute('inert')).toBe(true);
      expect(host.querySelectorAll('.summonerSlot:disabled')).toHaveLength(2);
      const toggle = rows[0].querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!toggle) throw new Error('Missing summoner switch');
      await act(async () => { toggle.click(); });
      expect(rows[1].hasAttribute('inert')).toBe(false);
      expect(rows[2].hasAttribute('inert')).toBe(false);
      expect(host.querySelectorAll('.summonerSlot:disabled')).toHaveLength(0);
      await act(async () => { toggle.click(); });
      expect(rows[1].hasAttribute('inert')).toBe(true);
      expect(rows[2].hasAttribute('inert')).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });
});
