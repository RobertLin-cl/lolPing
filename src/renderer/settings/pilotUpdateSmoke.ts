import type { SettingsApi } from '../../shared/ipc';
import { PILOT_CH } from '../../shared/settingsChannels';
import { resolveLang, strings } from '../../shared/i18n';
import type { PilotHost } from '../shared/pilotHost';

async function until(check: () => boolean | Promise<boolean>,label: string): Promise<void> {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve,40));
  }
  throw new Error(`Update smoke timed out: ${label}`);
}

export async function runUpdateSmoke(api: SettingsApi,host: PilotHost): Promise<void> {
  let off: (() => void) | undefined;
  try {
    const phases = new Set<string>();
    const settings = await api.getSettings();
    const t = strings(resolveLang(settings.language,navigator.language),'win');
    const button = (label: string): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>('.card.update button')]
      .find((b) => b.textContent?.trim() === label && !b.disabled);
    off = await host.listen(PILOT_CH.updateChanged,({ payload }) => { phases.add((JSON.parse(payload) as { phase: string }).phase); });
    const fixture = async (scenario: string): Promise<void> => { await host.invoke(PILOT_CH.updateSmoke,{ phase: 'fixture',scenario }); };
    await fixture('empty'); await api.checkForUpdates();
    await until(async () => {
      const state = await api.getUpdate(); return state?.phase === 'idle' && state.lastCheck !== null;
    },'Electron-only releases ignored');
    for (const scenario of ['bad-manifest','redirect']) {
      await fixture(scenario); await api.checkForUpdates();
      await until(async () => (await api.getUpdate())?.phase === 'error','invalid metadata rejected');
    }
    await fixture('bad-installer'); await api.checkForUpdates();
    await until(async () => (await api.getUpdate())?.phase === 'available','Rust update found');
    await until(() => button(t.updateNow) !== undefined,'update button rendered');
    button(t.updateNow)?.click();
    await until(async () => {
      const state = await api.getUpdate(); return state?.phase === 'error' && state.retry === 'download';
    },'damaged installer refused');
    const damaged = await api.getUpdate();
    if (damaged?.phase !== 'error' || damaged.message !== t.updateErrDamaged) throw new Error('Verification error was not translated');
    await until(() => document.querySelector('.card.update')?.textContent?.includes(t.updateErrDamaged) === true,'verification error rendered');
    await fixture('healthy');
    await until(() => button(t.retry) !== undefined,'retry button rendered');
    button(t.retry)?.click();
    await until(async () => (await api.getUpdate())?.phase === 'installing','verified installer ready');
    if (!['checking','available','downloading','error','installing'].every((phase) => phases.has(phase))) throw new Error('Update events are incomplete');
    await host.invoke(PILOT_CH.updateSmoke,{ phase: 'passed' });
  } catch (error) { await host.invoke(PILOT_CH.updateSmoke,{ phase: 'failed',detail: String(error) }); }
  finally { off?.(); }
}
