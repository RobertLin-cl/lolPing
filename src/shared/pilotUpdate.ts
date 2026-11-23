import { resolveLang, strings } from './i18n';
import type { Settings } from './settings';
import { isVersion, updateErrorText, type UpdateState } from './update';

/** Maps native error kinds through the same translations used by the Electron updater. */
export function pilotUpdateState(raw: unknown, settings: Settings, locale: string): UpdateState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const state = raw as Record<string, unknown>;
  const version = isVersion(state.version) ? state.version : null;
  switch (state.phase) {
    case 'idle': return { phase: 'idle', lastCheck: typeof state.lastCheck === 'number' && Number.isFinite(state.lastCheck) && state.lastCheck >= 0 ? state.lastCheck : null };
    case 'checking': return { phase: 'checking', manual: state.manual === true };
    case 'available': return version && typeof state.notesUrl === 'string'
      ? { phase: 'available', version, notesUrl: state.notesUrl } : null;
    case 'downloading': return version && typeof state.percent === 'number' && Number.isFinite(state.percent)
      ? { phase: 'downloading', version, percent: Math.max(0, Math.min(100, Math.floor(state.percent))) } : null;
    case 'installing': return version ? { phase: 'installing', version } : null;
    case 'error': {
      if (state.kind !== 'check' && state.kind !== 'download' && state.kind !== 'damaged' && state.kind !== 'install') return null;
      const t = strings(resolveLang(settings.language, locale), 'win');
      return { phase: 'error', retry: state.retry === 'download' ? 'download' : 'check',
        message: updateErrorText(t, state.kind, typeof state.reason === 'string' ? state.reason : '') };
    }
    default: return null;
  }
}
