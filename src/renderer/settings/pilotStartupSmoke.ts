import type { SettingsApi } from '../../shared/ipc';
import { desktopPilotRuntime } from '../../shared/desktopPilot';
import { PILOT_CH } from '../../shared/settingsChannels';
import type { PilotHost, PilotSnapshot } from '../shared/pilotHost';

export async function runStartupSmoke(api: SettingsApi, host: PilotHost): Promise<void> {
  let failure = '';
  try {
    if (!api.capabilities?.autoStart) throw new Error('Startup control is unavailable');
    const original = await api.getSettings();
    if (original.launchAtStartup) throw new Error('First launch inherited startup registration');
    const on = await api.setSettings({ launchAtStartup: true });
    if (!on.ok || !(await api.getSettings()).launchAtStartup) throw new Error('Startup preference did not save');
    const status = await host.invoke<{ registered: boolean; command: string | null }>(PILOT_CH.startupSmoke, { phase: 'status' });
    if (!status.registered || !status.command?.startsWith('"') || !status.command.endsWith('" --hidden')) throw new Error('Startup command is invalid');
    const before = await host.invoke<PilotSnapshot>(PILOT_CH.snapshot);
    if (!(await api.setSettings({ volume: original.volume === 41 ? 42 : 41 })).ok) throw new Error('Unrelated setting failed');
    const settings = { ...on.settings, launchAtStartup: false };
    const stale = await host.invoke(PILOT_CH.save, { settings, config: desktopPilotRuntime(settings,true,navigator.language).config,
      revision: before.revision }).then(() => false, () => true);
    if (!stale || !(await host.invoke<{ registered: boolean }>(PILOT_CH.startupSmoke, { phase: 'status' })).registered) throw new Error('Stale save changed startup');
    const off = await api.setSettings({ launchAtStartup: false, volume: original.volume });
    if (!off.ok || (await api.getSettings()).launchAtStartup) throw new Error('Startup preference did not clear');
    if ((await host.invoke<{ command: string | null }>(PILOT_CH.startupSmoke, { phase: 'status' })).command !== null) throw new Error('Startup value was not removed');
  } catch (error) { failure = String(error); console.error(error); }
  await host.invoke(PILOT_CH.startupSmoke, { phase: failure ? 'failed' : 'passed', detail: failure });
}
