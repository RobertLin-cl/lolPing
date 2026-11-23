import { describe, expect, it } from 'vitest';
import { desktopPilotSettings } from '../../src/shared/desktopPilot';
import { pilotUpdateState } from '../../src/shared/pilotUpdate';
import { strings } from '../../src/shared/i18n';

describe('pilotUpdate', () => {
  const settings = desktopPilotSettings({ language: 'en' });
  it('keeps unsupported builds empty and rejects malformed update states', () => {
    expect(pilotUpdateState(null, settings, 'en')).toBeNull();
    expect(pilotUpdateState({ phase: 'available', version: 'bad', notesUrl: 'https://github.com' }, settings, 'en')).toBeNull();
    expect(pilotUpdateState({ phase: 'downloading', version: '0.6.8', percent: Number.NaN }, settings, 'en')).toBeNull();
    expect(pilotUpdateState({ phase: 'downloading', version: '0.6.8', percent: 105 }, settings, 'en')).toEqual({ phase: 'downloading', version: '0.6.8', percent: 100 });
  });
  it('translates verification errors without exposing native error details', () => {
    const state = { phase: 'error', kind: 'damaged', reason: 'internal details', retry: 'download' };
    expect(pilotUpdateState(state, settings, 'en')).toEqual({ phase: 'error', retry: 'download', message: strings('en', 'win').updateErrDamaged });
    const chinese = desktopPilotSettings({ language: 'zh-TW' });
    expect(pilotUpdateState(state, chinese, 'en')?.phase).toBe('error');
    expect(pilotUpdateState(state, chinese, 'en')).toMatchObject({ message: strings('zh-TW', 'win').updateErrDamaged });
  });
});
