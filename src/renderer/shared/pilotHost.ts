import type { AppStatus } from '../../shared/ipc';
import type { DisplayMap } from '../../main/coords';

export interface PilotSnapshot {
  settings: unknown;
  revision: number;
  status: AppStatus;
  autoStart?: boolean;
  version?: string;
}

export interface PilotBootstrap extends PilotSnapshot {
  displayId: number;
  displays: DisplayMap[];
  demo: boolean;
}

export interface PilotHost {
  invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T>;
  listen(event: string, cb: (event: { payload: string }) => void): Promise<() => void>;
}

declare global {
  interface Window {
    pilotHost?: PilotHost;
    __TAURI__?: { core: Pick<PilotHost, 'invoke'>; event: Pick<PilotHost, 'listen'> };
  }
}

export function pilotHost(): PilotHost {
  if (window.pilotHost) return window.pilotHost;
  if (window.__TAURI__) return { invoke: window.__TAURI__.core.invoke, listen: window.__TAURI__.event.listen };
  throw new Error('Desktop pilot bridge is unavailable');
}
