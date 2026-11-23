import { PILOT_CH } from '../../shared/settingsChannels';
import type { PilotHost, PilotSnapshot } from '../shared/pilotHost';
import type { RoomState } from '../../shared/room';
import type { PilotChatHistory } from '../../shared/pilotChat';

interface Status extends PilotSnapshot { visible?: boolean; focused?: boolean; suspended?: boolean; room: RoomState; history: PilotChatHistory }

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Chat smoke timed out: ${label}`);
}

/** Exercises the unchanged chat page and native bridge without installing global hooks. */
export async function runPilotChatSmoke(host: PilotHost): Promise<void> {
  const status = (): Promise<Status> => host.invoke(PILOT_CH.chatSmoke, { phase: 'status' });
  let passed = false;
  let failure = '';
  try {
    await until(async () => (await status()).visible === true, 'shortcut opens native chat');
    const input = document.getElementById('message');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing chat input');
    await until(async () => {
      const lines = await window.textApi.lines();
      return ['LANPeer', 'RelayPeer'].every((name) => lines.some((line) => line.kind === 'text' && line.tag?.name === name));
    }, 'incoming original text');

    input.focus(); input.value = 'Rust chat smoke';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => input.value === '', 'Enter sends and clears the box');
    if (document.activeElement !== input) throw new Error('Send lost input focus');
    await until(async () => (await window.textApi.lines()).some((line) => line.kind === 'whisperFrom'), 'recipient-only original whispers');
    for (const name of ['LANPeer', 'RelayPeer']) {
      if (await window.textApi.submit(`/w ${name} direct secret`) !== 'sent') throw new Error(`Whisper to ${name} failed`);
    }
    if (await window.textApi.submit('/r reply secret') !== 'sent') throw new Error('Reply failed');
    if (await window.textApi.submit('/mute LANPeer') !== 'sent' || await window.textApi.submit('/mute LANPeer') !== 'sent') throw new Error('Mute toggle failed');
    if (await window.textApi.submit('/ready') !== 'votesOff') throw new Error('Unavailable vote was accepted');

    input.value = '/m';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await until(() => input.value === '/mute ', 'command completion');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await until(() => input.value === '/mute all', 'name completion');
    input.value = '';
    await host.invoke(PILOT_CH.chatSmoke, { phase: 'resize' });
    await until(async () => {
      const s = await status();
      const settings = s.settings as { chatBounds?: { width: number; height: number } };
      return settings.chatBounds?.width === 460 && settings.chatBounds.height === 280;
    }, 'bounds saved');

    await host.invoke(PILOT_CH.chatSmoke, { phase: 'quiet' });
    await until(async () => (await status()).room.members.some((m) => m.self && m.status === 'muted'), 'quiet window phase');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }));
    if (document.activeElement === input || !(await status()).visible) throw new Error('First Esc did not leave only the box');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    if (document.activeElement !== input) throw new Error('Enter did not return to the box');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true, cancelable: true }));
    await until(async () => !(await status()).visible, 'second Esc hides native window');
    await until(async () => !(await status()).suspended, 'hiding releases native input suspension');
    await host.invoke(PILOT_CH.chatSmoke, { phase: 'start' });
    await until(async () => (await status()).visible === true, 'shortcut reopens chat');
    await host.invoke(PILOT_CH.chatSmoke, { phase: 'expire' });
    await until(async () => !(await status()).visible, 'expired timer hides native window');
    passed = true;
  } catch (error) { failure = String(error); console.error(error); }
  finally { await host.invoke(PILOT_CH.chatSmoke, { phase: passed ? 'passed' : 'failed', detail: failure }); }
}
