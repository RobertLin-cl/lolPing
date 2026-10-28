import { BrowserWindow, ipcMain, screen } from 'electron';
import { CHAT_MIN_SIZE, placeChat, type ChatBounds } from '../shared/chatBounds';
import { TEXT_CH, type Point, type TextAnswer, type TextBoxText } from '../shared/ipc';
import type { HistoryLine } from '../shared/roomHistory';
import { ChatAutoHide } from './chatAutoHide';
import { IS_MAC, loadPage, pageUrl, preloadPath } from './paths';

/** How long after the last move or resize the window's bounds are saved. */
const SAVE_BOUNDS_MS = 500;

export interface ChatWindowDeps {
  /** Answers what was typed. `at` is where the pointer was when the window took the keyboard: our line's spot for the room. */
  submit(raw: string, at: Point): TextAnswer;
  strings(): TextBoxText;
  lines(): readonly HistoryLine[];
  /** Where the window was left, or null for its default spot. */
  bounds(): ChatBounds | null;
  saveBounds(b: ChatBounds): void;
  /** How long the window stays up after the last line; 0 = until it is hidden. */
  hideAfterMs(): number;
  /** The window took the keyboard or gave it back: while it has it, the helper passes all input through. */
  typing(on: boolean): void;
}

let deps: ChatWindowDeps | null = null;
let win: BrowserWindow | null = null;
let ready = false;
/** What to do once the page has loaded: the shortcut's focus wins over a line's quiet show. */
let pending: 'show' | 'type' | null = null;
let at: Point = { x: 0, y: 0 };
/** `at` was just set by the shortcut, so the focus that follows doesn't replace it with the pointer. */
let atFromShortcut = false;
let typing = false;
let saveTimer: NodeJS.Timeout | null = null;
const autoHide = new ChatAutoHide({ hideAfterMs: () => deps?.hideAfterMs() ?? 0, hide: () => hideChat() });

/** The room chat window while it exists (shown or hidden). */
export function textWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function registerTextWindow(d: ChatWindowDeps): void {
  deps = d;
  const own = (sender: Electron.WebContents): boolean => textWindow()?.webContents === sender;
  ipcMain.handle(TEXT_CH.submit, (event, raw: unknown): TextAnswer => {
    if (!own(event.sender) || typeof raw !== 'string' || !deps) return 'unknown';
    return deps.submit(raw, at);
  });
  ipcMain.on(TEXT_CH.cancel, (event) => {
    if (own(event.sender)) giveKeyboardBack();
  });
  ipcMain.on(TEXT_CH.hide, (event) => {
    if (own(event.sender)) hideChat();
  });
  ipcMain.handle(TEXT_CH.strings, (event): TextBoxText | null => (own(event.sender) && deps ? deps.strings() : null));
  ipcMain.handle(TEXT_CH.lines, (event): HistoryLine[] => (own(event.sender) && deps ? [...deps.lines()] : []));
  ipcMain.on(TEXT_CH.hover, (event, on: unknown) => {
    if (own(event.sender)) autoHide.setHovered(on === true);
  });
}

/** A line came in: the window shows where it was left, without taking the keyboard, and hides again by itself. */
export function showChat(): void {
  const w = ensureWindow();
  if (!w) return;
  if (!ready) {
    pending ??= 'show';
    return;
  }
  reveal(w, false);
}

/** The shortcut: the window shows and takes the keyboard. `point` is where the pointer was, the spot of what we type. */
export function typeInChat(point: Point): void {
  const w = ensureWindow();
  if (!w) return;
  at = point;
  atFromShortcut = true;
  if (!ready) {
    pending = 'type';
    return;
  }
  reveal(w, true);
}

/** The hide button, or the countdown ran out: the window goes away, and the keyboard back to the app it came from if it had it. */
export function hideChat(): void {
  autoHide.stop();
  pending = null;
  const w = textWindow();
  if (w?.isVisible()) w.hide();
}

/** The room's lines changed: the window shows them at once, or has them ready for when it shows. */
export function chatLinesChanged(): void {
  const w = textWindow();
  if (w && deps && !w.webContents.isLoading()) w.webContents.send(TEXT_CH.linesChanged, [...deps.lines()]);
}

/** The room is gone or room text was switched off: the window closes until the next line or shortcut. */
export function closeTextWindow(): void {
  textWindow()?.close();
}

function reveal(w: BrowserWindow, focus: boolean): void {
  w.setAlwaysOnTop(true, 'screen-saver'); // above the overlay and a game's borderless window, again each time
  if (focus) {
    w.show();
    w.focus();
  } else if (!w.isVisible()) {
    w.showInactive();
  }
  autoHide.restart();
}

/**
 * Esc or an empty Enter: the app underneath gets the keyboard back and the window stays up, hiding by itself later.
 * (Clicking outside does the same through the OS.) Sending a line keeps the keyboard, so several can be typed in a row.
 */
function giveKeyboardBack(): void {
  const w = textWindow();
  if (!w?.isFocused()) return;
  // Hiding hands the keyboard to the window that had it before; showing again without activating keeps it there.
  w.hide();
  w.showInactive();
  autoHide.restart();
}

function setTyping(on: boolean): void {
  if (on === typing) return;
  typing = on;
  deps?.typing(on);
}

function ensureWindow(): BrowserWindow | null {
  const existing = textWindow();
  if (existing || !deps) return existing;
  const bounds = placeChat(deps.bounds(), screen.getAllDisplays().map((d) => d.workArea), screen.getPrimaryDisplay().workArea);
  const w = new BrowserWindow({
    ...bounds,
    minWidth: CHAT_MIN_SIZE.width,
    minHeight: CHAT_MIN_SIZE.height,
    frame: false,
    // Not transparent: Electron can't resize a transparent window.
    backgroundColor: '#07131a',
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // macOS: a non-activating panel takes key focus without making lolPing the active app, so the game stays active.
    ...(IS_MAC ? { type: 'panel' as const } : {}),
    webPreferences: { preload: preloadPath('text'), spellcheck: false },
  });
  win = w;
  ready = false;
  try {
    setup(w);
  } catch (err) {
    w.destroy();
    throw err;
  }
  return w;
}

function setup(w: BrowserWindow): void {
  w.on('closed', () => {
    if (win === w) win = null;
    ready = false;
    pending = null;
    autoHide.stop();
    setTyping(false);
  });
  w.on('focus', () => {
    // Clicked into rather than opened with the shortcut: our next line's spot is where the pointer is now.
    if (!atFromShortcut) at = screen.getCursorScreenPoint();
    atFromShortcut = false;
    setTyping(true);
    autoHide.setFocused(true);
  });
  w.on('blur', () => {
    setTyping(false);
    autoHide.setFocused(false);
  });
  const saveSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!w.isDestroyed()) deps?.saveBounds(w.getBounds());
    }, SAVE_BOUNDS_MS);
  };
  w.on('move', saveSoon);
  w.on('resize', saveSoon);
  w.once('ready-to-show', () => {
    ready = true;
    const next = pending;
    pending = null;
    if (next) reveal(w, next === 'type');
  });
  const closeIfAlive = (): void => {
    if (!w.isDestroyed()) w.close();
  };
  w.webContents.on('did-fail-load', closeIfAlive);
  w.webContents.on('render-process-gone', closeIfAlive);
  const ownUrl = new URL(pageUrl('text'));
  w.webContents.on('will-navigate', (event) => {
    try {
      const target = new URL(event.url);
      if (target.protocol !== ownUrl.protocol || target.host !== ownUrl.host || target.pathname !== ownUrl.pathname) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadPage(w, 'text').catch(closeIfAlive);
}
