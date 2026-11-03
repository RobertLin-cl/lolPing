import { historyVisible, type ChatFilter } from '../shared/chatFilter';
import type { Strings } from '../shared/i18n';
import type { PingId } from '../shared/pings';
import type { RoomTextStyle } from '../shared/settings';
import type { PingTag } from '../shared/ipc';
import type { MemberTag, RemoteText, RemoteWhisper, RoomManager } from './roomManager';
import type { HistoryLine } from '../shared/roomHistory';
import type { RoomHistory } from './roomHistory';

export interface RoomTextDeps {
  room: Pick<RoomManager, 'on' | 'off' | 'state'>;
  /** Shows a line in the chosen style; `visible` decides whether it may bring up chat. */
  show(p: { displayId: number; x: number; y: number; text: string; owner: string; tag?: PingTag }, visible: boolean): void;
  history: RoomHistory;
  text(): Strings;
  filter(): ChatFilter;
  now(): number;
  /** A whisper from the member `peer` is in the history: /r answers them now, and whether it should bring up chat is passed separately. */
  whispered(peer: string, visible: boolean): void;
}

export interface RoomLine {
  kind: HistoryLine['kind'];
  /** 'self', 'vote' or the member's peer ID: the overlay keeps at most 3 lines per owner. */
  owner: string;
  /** Null for a vote result: nobody said it. */
  tag: MemberTag | null;
  displayId: number;
  x: number;
  y: number;
  text: string;
}

/** Shows a line and keeps it in the history: the one path for a member's lines and for ours. */
export function postLine(deps: Pick<RoomTextDeps, 'show' | 'history' | 'now' | 'filter'>, line: RoomLine): void {
  const { kind, tag, text } = line;
  deps.show({
    displayId: line.displayId, x: line.x, y: line.y, text, owner: line.owner, ...(tag ? { tag } : {}),
  }, historyVisible(line, deps.filter()));
  deps.history.push({ at: deps.now(), kind, tag: tag && { name: tag.name, color: tag.color, rgb: tag.rgb }, text });
}

/** Draws the text and alive lines other members send, and keeps their whispers. Returns a function that stops it. */
export function startRoomText(deps: RoomTextDeps): () => void {
  // A whisper has no spot: it only goes to the history, which the chat window shows.
  const onWhisper = (w: RemoteWhisper): void => {
    const { name, color, rgb } = w.tag;
    deps.history.push({ at: deps.now(), kind: 'whisperFrom', tag: { name, color, rgb }, text: w.text });
    deps.whispered(w.peer, historyVisible({ kind: 'whisperFrom' }, deps.filter()));
  };
  const onText = (p: RemoteText): void => {
    const common = { owner: p.peer, tag: p.tag, displayId: p.displayId, x: p.x, y: p.y };
    if (p.kind === 'text') {
      if (p.text !== undefined) postLine(deps, { ...common, kind: 'text', text: p.text });
      return;
    }
    // The line is written here, in our language, with the name of the member they clicked.
    const who = deps.room.state().members.find((m) => m.peer === p.who);
    if (who) postLine(deps, { ...common, kind: 'alive', text: deps.text().aliveLine(who.name) });
  };
  deps.room.on('remoteText', onText);
  deps.room.on('whisper', onWhisper);
  return () => {
    deps.room.off('remoteText', onText);
    deps.room.off('whisper', onWhisper);
  };
}

export interface RoomPingTextDeps {
  history: RoomHistory;
  filter(): ChatFilter;
  text(): Strings;
  now(): number;
  enabled(): boolean;
  style(): RoomTextStyle;
  show(): void;
}

/** Keeps a room ping as League's sentence; only the window style brings up chat. */
export function postPing(deps: RoomPingTextDeps, id: PingId, tag: MemberTag): void {
  if (id === 'generic' || !deps.enabled()) return;
  const { name, color, rgb } = tag;
  deps.history.push({ at: deps.now(), kind: 'ping', tag: { name, color, rgb }, text: deps.text().pingLines[id] });
  if (deps.style() === 'window' && historyVisible({ kind: 'ping' }, deps.filter())) deps.show();
}
