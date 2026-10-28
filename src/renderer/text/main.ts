import type { TextAnswer, TextBoxText } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import type { HistoryLine } from '../../shared/roomHistory';
import { MAX_TEXT } from '../../shared/roomProtocol';

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

/** Names and lines come from other members: they only ever go in as text. */
function showLines(lines: readonly HistoryLine[]): void {
  // Someone reading older lines keeps their place; otherwise the newest line stays in view.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  log.replaceChildren(...lines.map((line) => {
    const item = document.createElement('li');
    if (!line.tag) {
      item.className = 'vote';
      item.textContent = line.text;
      return item;
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.style.color = tagColorCss(line.tag.color, line.tag.rgb);
    name.textContent = `${line.tag.name}: `;
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
  } else if (answer === 'unknown') showHint(words?.unknown ?? '', true);
  else if (answer === 'votesOff') showHint(words?.votesOff ?? '', true);
}

// While an input method is composing, the box holds a draft: cutting it would break the composition, and Enter confirms it.
input.addEventListener('input', (event) => {
  if (!(event as InputEvent).isComposing) clamp();
  if (words) showHint(words.hint, false);
});
input.addEventListener('compositionend', clamp);
input.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    // Enter on an empty box gives the keyboard back, as in League.
    if (input.value.trim() === '') window.textApi.cancel();
    else void send();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    window.textApi.cancel();
  } else if (event.key === 'Tab') {
    event.preventDefault(); // focus leaving the box would leave Enter and Esc with nothing to hear them
  }
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
});
let pushed = false; // a pushed list is newer than a lines() reply that arrives after it
window.textApi.onLines((lines) => {
  pushed = true;
  showLines(lines);
});
void window.textApi.lines().then((lines) => {
  if (!pushed) showLines(lines);
});
