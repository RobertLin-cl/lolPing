import { strings } from '../../shared/i18n';
import type { PanelAction } from '../../shared/ipc';
import { dropReady, renderReady } from './readyCheck';
import { renderRoster } from './roster';
import { renderVote, voteTitle } from './vote';

const root = document.getElementById('root') as HTMLElement;

window.panelApi.on((state) => {
  document.body.dataset.view = state.view;
  document.documentElement.lang = state.lang; // picks the right CJK glyphs
  // On Windows the vote card is in Alt+Tab and on the taskbar, under its window title.
  if (state.view === 'vote' && state.vote) document.title = voteTitle(state.vote, state.room.members, strings(state.lang));
  const act = (action: PanelAction): void => window.panelApi.act(action);
  if (state.view === 'vote' && state.vote?.kind === 'ready') return renderReady(root, state, act);
  dropReady();
  if (state.view === 'vote') renderVote(root, state, act);
  else renderRoster(root, state, act);
});
