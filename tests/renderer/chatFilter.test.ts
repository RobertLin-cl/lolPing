// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_FILTER, type ChatFilter } from '../../src/shared/chatFilter';
import { strings } from '../../src/shared/i18n';
import { renderRoster } from '../../src/renderer/panel/roster';
import type { PanelAction, PanelState, TextApi, TextBoxText } from '../../src/shared/ipc';
import type { HistoryLine } from '../../src/shared/roomHistory';

afterEach(() => vi.unstubAllGlobals());

describe('chat filters', () => {
  it('uses panel category choices in both views without adding chat controls', async () => {
    document.body.innerHTML = '<span id="title"></span><button id="hide"></button><div id="panel"></div>'
      + '<ol id="log"></ol><input id="message"><span id="count"></span><small id="hint"></small>';
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const t = strings('zh-TW');
    const words: TextBoxText = {
      lang: t.lang, title: t.chatTitle, hide: t.chatHideButton, placeholder: t.textBoxPlaceholder,
      hint: t.textBoxHint, away: t.chatAway, unknown: t.textBoxUnknown, votesOff: t.textBoxVotesOff,
      noMember: t.textBoxNoMember, noMessage: t.textBoxNoMessage, noReply: t.textBoxNoReply,
      cantWhisper: t.textBoxCantWhisper, whisperTo: t.chatWhisperTo, whisperFrom: t.chatWhisperFrom,
    };
    const kinds: HistoryLine['kind'][] = ['text', 'ping', 'alive', 'vote', 'note', 'whisperTo', 'whisperFrom'];
    const lines: HistoryLine[] = kinds.map((kind) => ({ at: 0, kind, tag: null, text: kind }));
    let resolveFilter: (filter: ChatFilter | null) => void = () => { throw new Error('Filter promise not created'); };
    const saved = new Promise<ChatFilter | null>((resolve) => { resolveFilter = resolve; });
    let receiveFilter: (filter: ChatFilter) => void = () => { throw new Error('Filter listener not registered'); };
    let stored: ChatFilter = { ...DEFAULT_CHAT_FILTER, whisper: false };
    const api: TextApi = {
      submit: async () => 'unknown', hide: () => {}, strings: async () => words, filter: () => saved,
      onFilter: (cb) => { receiveFilter = cb; return () => {}; },
      lines: async () => lines, onLines: () => () => {}, names: async () => [], hover: () => {},
    };
    const panel = document.getElementById('panel');
    if (!panel) throw new Error('Panel missing');
    const state = (): PanelState => ({
      view: 'roster', lang: 'zh-TW', max: 16,
      room: { phase: 'active', code: null, members: [], lan: 'ok', internet: 'off', lonely: false, clockSkew: false },
      history: lines, chatFilter: stored, vote: null, voteOver: false, textOn: true, votesOn: false, volume: 0,
    });
    const act = (action: PanelAction): void => {
      if (action.t !== 'chatCategory') throw new Error('Unexpected panel action');
      stored = { ...stored, [action.category]: action.on };
      receiveFilter(stored);
      renderRoster(panel, state(), act);
    };
    renderRoster(panel, state(), act);
    expect(panel.querySelectorAll('.history-filters button')).toHaveLength(0);
    const historyTab = panel.querySelectorAll<HTMLButtonElement>('.tab')[1];
    if (!historyTab) throw new Error('History tab missing');
    historyTab.click();
    expect(panel.querySelectorAll('.history-filters button')).toHaveLength(5);
    window.textApi = api;
    await import('../../src/renderer/text/main');
    await vi.waitFor(() => expect(document.getElementById('title')?.textContent).toBe(t.chatTitle));
    expect(document.querySelectorAll('#log li')).toHaveLength(0);
    expect(document.querySelector('#filters')).toBeNull();

    resolveFilter(stored);
    await vi.waitFor(() => expect(document.querySelectorAll('#log li')).toHaveLength(5));
    expect([...panel.querySelectorAll('.history-filters button')].map((button) => button.textContent))
      .toEqual(['打字', '信號', '記分板', '投票', '私訊']);
    const whisper = document.querySelector<HTMLButtonElement>('[data-category="whisper"]');
    if (!whisper) throw new Error('Whisper chip missing');
    whisper.click();
    expect(document.querySelectorAll('#log li')).toHaveLength(7);
    expect(stored.whisper).toBe(true);
    expect(panel.querySelector('[data-category="whisper"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(panel.querySelectorAll('.line')).toHaveLength(7);

    for (const category of ['text', 'ping', 'scoreboard', 'vote', 'whisper'] as const) {
      act({ t: 'chatCategory', category, on: false });
    }
    expect([...document.querySelectorAll('#log li')].map((line) => line.textContent)).toEqual([expect.stringContaining('note')]);
    expect(panel.querySelectorAll('.line')).toHaveLength(1);
    expect(panel.querySelector('.line.note')).not.toBeNull();
    expect(lines).toHaveLength(7);
  });
});
