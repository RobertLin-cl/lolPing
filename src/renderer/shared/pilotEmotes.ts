export * from '../../shared/emotes';

// WebView2 routes custom schemes through a localhost origin; Electron keeps its registered scheme.
export const CUSTOM_EMOTE_URL = window.__TAURI__ ? 'http://lolping.localhost/emotes/' : 'lolping://emotes/';
export const customStillUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.webp`;
export const customHdUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.hd`;
export const customAnimUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.anim`;
export const customSoundUrl = (hash: string): string => `${CUSTOM_EMOTE_URL}${hash}.sound`;
