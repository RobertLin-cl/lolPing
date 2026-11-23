import type { HistoryLine } from './roomHistory';
import type { RoomState } from './room';
import type { Settings } from './settings';
import type { TextAnswer, TextBoxText } from './ipc';
import { resolveLang, strings } from './i18n';
import { isPingId } from './pings';
import { muteToggle, parseTextInput, whisperTarget } from './textCommands';
import { summonerText } from './summonerText';
import { validateSpellCooldown } from './summonerProtocol';
import type { VoteOutcome } from './voteTally';

export interface PilotChatLine {
  at: number;
  kind: HistoryLine['kind'];
  tag: HistoryLine['tag'];
  text?: string;
  ping?: string;
  note?: { name: string | null; on: boolean };
  whoName?: string;
  peer?: string;
  owner?: string;
  d?: number;
  x?: number;
  y?: number;
  cooldown?: unknown;
  cooldownAt?: number;
  ownWho?: boolean;
  outcome?: VoteOutcome & { names: Record<string, string> };
}

export interface PilotChatHistory { revision: number; lines: PilotChatLine[]; replyTo: string | null }
export type PilotChatCommand = { type: 'text'; text: string }
  | { type: 'mute'; peers: string[]; on: boolean; all: boolean }
  | { type: 'whisper'; peers: string[]; text: string }
  | { type: 'vote'; kind: 'ff' | 'ready' | 'noff' };

export function pilotChatLines(lines: readonly PilotChatLine[], settings: Settings, locale: string): HistoryLine[] {
  const t = strings(resolveLang(settings.language, locale), 'win');
  return lines.map((line) => {
    let text = line.text ?? '';
    if (line.kind === 'ping' && isPingId(line.ping) && line.ping !== 'generic') text = t.pingLines[line.ping];
    if (line.kind === 'alive' && line.whoName) text = t.aliveLine(line.whoName);
    const cooldown = validateSpellCooldown(line.cooldown, line.cooldownAt ?? line.at);
    if (line.kind === 'spell' && cooldown && line.whoName) text = summonerText(t, cooldown, line.cooldownAt ?? line.at, line.whoName, line.ownWho === true);
    if (line.kind === 'vote' && line.outcome) {
      const o = line.outcome;
      if (o.kind === 'ff') text = t.voteResultFf(o.passed, o.yes, o.voters);
      else if (o.kind === 'ready') text = o.passed ? t.readyAll : t.readyMissing([...o.declined, ...o.missing].map((p) => o.names[p] ?? 'Player'));
      else text = t.voteResultKick(o.passed, o.names[o.target ?? ''] ?? 'Player', o.yes, o.voters);
    }
    if (line.kind === 'note' && line.note) {
      const { name, on } = line.note;
      text = name === null ? (on ? t.chatMutedAll : t.chatUnmutedAll) : (on ? t.chatMuted(name) : t.chatUnmuted(name));
    }
    return { at: line.at, kind: line.kind, tag: line.tag, text };
  });
}

export function pilotChatWords(settings: Settings, locale: string): TextBoxText {
  const t = strings(resolveLang(settings.language, locale), 'win');
  return { lang: t.lang, title: t.chatTitle, hide: t.chatHideButton, placeholder: t.textBoxPlaceholder,
    hint: t.textBoxHint, away: t.chatAway, unknown: t.textBoxUnknown, votesOff: t.textBoxVotesOff,
    noMember: t.textBoxNoMember, noMessage: t.textBoxNoMessage, noReply: t.textBoxNoReply,
    cantWhisper: t.textBoxCantWhisper, whisperTo: t.chatWhisperTo, whisperFrom: t.chatWhisperFrom };
}

/** Reuses the fork's command parser and name matching before submitting a native room action. */
export function pilotChatSubmission(raw: string, room: RoomState, replyTo: string | null, votesOn = false): { answer: TextAnswer; command?: PilotChatCommand } {
  const input = parseTextInput(raw);
  const result: { answer: TextAnswer; command?: PilotChatCommand } = { answer: 'sent' };
  switch (input.kind) {
    case 'text': result.command = { type: 'text', text: input.text }; break;
    case 'unknown': result.answer = 'unknown'; break;
    case 'ff': case 'noff': case 'ready':
      if (votesOn) result.command = { type: 'vote', kind: input.kind };
      else result.answer = 'votesOff';
      break;
    case 'mute': {
      const toggle = muteToggle(room.members, input.name);
      if (!toggle) result.answer = 'noMember';
      else result.command = { type: 'mute', peers: toggle.peers, on: toggle.on, all: toggle.name === null };
      break;
    }
    case 'whisper': {
      const target = whisperTarget(room.members, input.rest);
      if (!target) result.answer = 'noMember';
      else if (!target.text) result.answer = 'noMessage';
      else result.command = { type: 'whisper', peers: target.to.map((m) => m.peer), text: target.text };
      break;
    }
    case 'reply': {
      const member = room.members.find((m) => !m.self && m.peer === replyTo);
      if (!input.text) result.answer = 'noMessage';
      else if (!member) result.answer = 'noReply';
      else result.command = { type: 'whisper', peers: [member.peer], text: input.text };
      break;
    }
  }
  return result;
}
