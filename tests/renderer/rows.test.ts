import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingRow } from '../../src/renderer/settings/components/rows';

const row = (dim: boolean): string => renderToStaticMarkup(
  createElement(SettingRow, { icon: null, title: 'Volume', dim, children: createElement('input', { type: 'range' }) }),
);

describe('SettingRow', () => {
  it('keeps the keyboard out of a greyed row, not just the mouse', () => {
    expect(row(true)).toMatch(/^<div class="card dim" inert="">/);
  });

  it('leaves a row that is not greyed in reach', () => {
    expect(row(false)).not.toContain('inert');
  });
});
