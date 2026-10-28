import type { TextAnswer, TextBoxText } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import type { HistoryLine } from '../../shared/roomHistory';
import { MAX_TEXT } from '../../shared/roomProtocol';
import { completeCommand, type CompletionCycle } from '../../shared/textCommands';

const input = document.getElementById('message') as HTMLInputElement;
const count = document.getElementById('count') as HTMLElement;
const hint = document.getElementById('hint') as HTMLElement;
const log = document.getElementById('log') as HTMLOListElement;
const title = document.getElementById('title') as HTMLElement;
const hideButton = document.getElementById('hide') as HTMLButtonElement;
/** The counter shows in the last 20 code points. */
const COUNT_FROM = MAX_TEXT - 20;
let words: TextBoxText | null = null;

const showHint = (message: string, warn: boolean): void => {
  hint.textContent = message;
  hint.classList.toggle('warn', warn);
};

/** A code point is one letter, one Chinese character or one emoji, however many UTF-16 units it takes. */
function clamp(): void {
  const points = [...input.value];
  if (points.length > MAX_TEXT) input.value = points.slice(0, MAX_TEXT).join('');
  const used = Math.min(points.length, MAX_TEXT);
  count.hidden = used < COUNT_FROM;
  count.textContent = `${used}/${MAX_TEXT}`;
  count.classList.toggle('full', used >= MAX_TEXT);
}

/** The lines on show, drawn again once the words for a whisper's "To" and "From" arrive. */
let shown: readonly HistoryLine[] = [];

/** Names and lines come from other members: they only ever go in as text. */
function showLines(lines: readonly HistoryLine[]): void {
  shown = lines;
  // Someone reading older lines keeps their place; otherwise the newest line stays in view.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  log.replaceChildren(...lines.map((line) => {
    const item = document.createElement('li');
    if (!line.tag) {
      item.className = line.kind; // a vote result, or a note of what one of our commands did
      item.textContent = line.text;
      return item;
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = tagColorCss(line.tag.color, line.tag.rgb);
    name.textContent = `${line.tag.name}: `;
    if (line.kind === 'whisperTo' || line.kind === 'whisperFrom') {
      item.className = 'whisper';
      const dir = document.createElement('span');
      dir.className = 'dir';
      dir.textContent = `${(line.kind === 'whisperTo' ? words?.whisperTo : words?.whisperFrom) ?? ''} `;
      item.append(dir);
    }
    item.append(name, line.text);
    return item;
  }));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** A held Enter repeats faster than the answer comes back: one submit at a time, or the text would be sent twice. */
let sending = false;

async function send(): Promise<void> {
  if (sending) return;
  sending = true;
  let answer: TextAnswer;
  try {
    answer = await window.textApi.submit(input.value);
  } finally {
    sending = false;
  }
  if (answer === 'sent') {
    input.value = '';
    clamp();
    if (words) showHint(words.hint, false);
  } else showHint(words?.[answer] ?? '', true); // each other answer has its words under its own name
}

// While an input method is composing, the box holds a draft: cutting it would break the composition, and Enter confirms it.
/** Tab's place among the commands, while the box still shows its last completion. Typing starts it over. */
let cycle: CompletionCycle | null = null;

/** One press of Tab: a command, or after /mute or /w a name. The names are asked for at each press: people come and go. */
async function completeInBox(back: boolean): Promise<void> {
  const typed = input.value;
  const names = await window.textApi.names();
  if (input.value !== typed) return; // typed on while the names came: this press is stale
  const next = completeCommand(typed, cycle, back, names);
  if (!next) return;
  input.value = next.value; // setting the value fires no 'input', so the cycle survives to the next press
  cycle = next.cycle;
  clamp();
}

input.addEventListener('input', (event) => {
  cycle = null;
  if (!(event as InputEvent).isComposing) clamp();
  if (words) showHint(words.hint, false);
});
input.addEventListener('compositionend', clamp);
/**
 * Two steps out, as in League: Esc or an empty Enter only leaves the box, so the window keeps the keyboard and Enter
 * goes back in; Esc again closes the window, on the key's release, so the release doesn't drop into the app that gets
 * the keyboard back.
 */
let closeOnKeyUp = false;

input.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    if (input.value.trim() === '') input.blur();
    else void send();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    input.blur();
  } else if (event.key === 'Tab') {
    event.preventDefault(); // focus leaving the box would leave Enter and Esc with nothing to hear them
    void completeInBox(event.shiftKey);
  }
});
// Out of the box, wherever the keyboard is in the window (after a click on the log, say): Enter goes back in, Esc closes.
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.target === input) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    input.focus();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeOnKeyUp = true;
  }
});
document.addEventListener('keyup', (event) => {
  if (!closeOnKeyUp || event.key !== 'Escape') return;
  event.preventDefault();
  closeOnKeyUp = false;
  window.textApi.hide();
});
// A press whose release came after the keyboard had already gone elsewhere (a click outside) leaves nothing pending.
window.addEventListener('blur', () => {
  closeOnKeyUp = false;
});
// The hint says what the keys do in each step.
input.addEventListener('focus', () => {
  if (words) showHint(words.hint, false);
});
input.addEventListener('blur', () => {
  if (words && document.hasFocus()) showHint(words.away, false);
});
hideButton.addEventListener('click', () => window.textApi.hide());
// Whenever the window gets the keyboard (the shortcut, or a click anywhere on it), the box has it.
window.addEventListener('focus', () => input.focus());
document.documentElement.addEventListener('mouseenter', () => window.textApi.hover(true));
document.documentElement.addEventListener('mouseleave', () => window.textApi.hover(false));

void window.textApi.strings().then((t) => {
  if (!t) return;
  words = t;
  title.textContent = t.title;
  hideButton.title = t.hide;
  hideButton.setAttribute('aria-label', t.hide);
  input.placeholder = t.placeholder;
  showHint(t.hint, false);
  showLines(shown);
});
let pushed = false; // a pushed list is newer than a lines() reply that arrives after it
window.textApi.onLines((lines) => {
  pushed = true;
  showLines(lines);
});
void window.textApi.lines().then((lines) => {
  if (!pushed) showLines(lines);
});
requestAnimationFrame(() => input.focus());
