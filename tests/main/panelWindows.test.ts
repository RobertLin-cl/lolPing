import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelState } from '../../src/shared/ipc';

const h = vi.hoisted(() => ({
  windows: [] as Array<{
    opts: Record<string, unknown>;
    calls: string[];
    webContents: { emit: (event: string) => boolean };
  }>,
  isMac: false,
  isLinux: false,
}));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWindow extends Emitter {
    /** What was done to the window that changes where it sits or whether it shows, in order. */
    calls: string[] = [];
    visible = false;
    webContents = Object.assign(new Emitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
    constructor(readonly opts: Record<string, unknown>) {
      super();
      h.windows.push(this);
    }
    setIgnoreMouseEvents(): void {}
    setVisibleOnAllWorkspaces(): void {}
    setBounds(): void {}
    setAlwaysOnTop(on: boolean): void {
      this.calls.push(on ? 'top' : 'untop');
    }
    showInactive(): void {
      this.visible = true;
      this.calls.push('show');
    }
    hide(): void {
      this.visible = false;
      this.calls.push('hide');
    }
    flashFrame(on: boolean): void {
      this.calls.push(on ? 'flash' : 'unflash');
    }
    isVisible(): boolean {
      return this.visible;
    }
    isDestroyed(): boolean {
      return false;
    }
    destroy(): void {}
  }
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const screen = { getPrimaryDisplay: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area }) };
  const ipcMain = { on: vi.fn(), removeListener: vi.fn() };
  return { BrowserWindow: FakeWindow, ipcMain, screen };
});

vi.mock('../../src/main/paths', () => ({
  get IS_MAC() {
    return h.isMac;
  },
  get IS_LINUX() {
    return h.isLinux;
  },
  loadPage: () => Promise.resolve(),
  pageUrl: () => 'http://localhost/panel/index.html',
  preloadPath: () => 'preload.js',
}));

const state = (view: PanelState['view']): PanelState => ({
  view,
  lang: 'en',
  max: 16,
  room: { phase: 'active', code: null, members: [], lan: 'ok', internet: 'off', lonely: false, clockSkew: false },
  history: [],
  vote: view === 'vote' ? { id: 'v1', kind: 'ready', starter: 'a', voters: ['a'], ballots: {}, endsAt: 0 } : null,
  voteOver: false,
  textOn: true,
  votesOn: true,
  volume: 1,
});

type Panels = InstanceType<typeof import('../../src/main/panelWindows').PanelWindows>;
let panels: Panels;

/** Creates the panels with the platform set, as the app does once at startup. */
async function start(platform: 'win' | 'mac' | 'linux'): Promise<void> {
  h.windows.length = 0;
  h.isMac = platform === 'mac';
  h.isLinux = platform === 'linux';
  vi.resetModules();
  const { PanelWindows } = await import('../../src/main/panelWindows');
  panels = new PanelWindows();
}

/** Shows a view and lets its page finish loading, which is when a new window first appears. */
function showLoaded(view: PanelState['view']): (typeof h.windows)[number] {
  if (view === 'vote') panels.showVote(state('vote'));
  else panels.showRoster({ x: 0, y: 0 }, state('roster'));
  const w = h.windows[h.windows.length - 1];
  w.webContents.emit('did-finish-load');
  return w;
}

beforeEach(() => start('win'));

describe('PanelWindows', () => {
  it('makes the vote card an ordinary window on Windows: in Alt+Tab and on the taskbar, not kept on top', () => {
    const w = showLoaded('vote');
    expect(w.opts).toMatchObject({ focusable: true, skipTaskbar: false, alwaysOnTop: false });
    // Shown over the window in front without taking the keyboard, then let go of the top, its taskbar button blinking.
    expect(w.calls).toEqual(['top', 'show', 'untop', 'flash']);
  });

  it('brings the card to the front for a new vote only, not for its ballots or its result', () => {
    const w = showLoaded('vote');
    w.calls.length = 0;
    panels.showVote(state('vote'));
    panels.showVote({ ...state('vote'), voteOver: true });
    expect(w.calls).toEqual([]);
    panels.hideVote();
    panels.showVote(state('vote'));
    expect(w.calls).toEqual(['unflash', 'hide', 'top', 'show', 'untop', 'flash']);
  });

  it('keeps the roster a panel that never takes focus and goes back on top each time it shows', () => {
    const w = showLoaded('roster');
    expect(w.opts).toMatchObject({ focusable: false, skipTaskbar: true, alwaysOnTop: true });
    panels.showRoster({ x: 0, y: 0 }, state('roster'));
    expect(w.calls.filter((c) => c !== 'top')).toEqual(['show', 'show']);
    expect(w.calls).not.toContain('untop');
  });

  it.each(['mac', 'linux'] as const)('keeps the vote card a panel on %s', async (platform) => {
    await start(platform);
    const w = showLoaded('vote');
    expect(w.opts).toMatchObject({ focusable: false, skipTaskbar: true, alwaysOnTop: true });
    expect(w.calls).not.toContain('untop');
    expect(w.calls).not.toContain('flash');
  });
});
