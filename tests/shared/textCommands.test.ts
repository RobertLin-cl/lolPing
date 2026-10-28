import { describe, expect, it } from 'vitest';
import { MAX_TEXT } from '../../src/shared/roomProtocol';
import { commandMatches, completeCommand, parseTextInput } from '../../src/shared/textCommands';

describe('parseTextInput', () => {
  it('reads /ff and /surrender, in any case and with spaces around', () => {
    expect(parseTextInput('/ff')).toEqual({ kind: 'ff' });
    expect(parseTextInput(' /FF ')).toEqual({ kind: 'ff' });
    expect(parseTextInput('/surrender')).toEqual({ kind: 'ff' });
  });

  it('reads /noff and /ready', () => {
    expect(parseTextInput('/noff')).toEqual({ kind: 'noff' });
    expect(parseTextInput('/ready')).toEqual({ kind: 'ready' });
  });

  it('calls any other slash word unknown', () => {
    expect(parseTextInput('/remake')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/ff now')).toEqual({ kind: 'unknown' });
  });

  it('calls blank or invisible input empty', () => {
    expect(parseTextInput('   ')).toEqual({ kind: 'empty' });
    expect(parseTextInput('\u200b')).toEqual({ kind: 'empty' });
    expect(parseTextInput('')).toEqual({ kind: 'empty' });
  });

  it('keeps plain words as text, including "ff" without a slash', () => {
    expect(parseTextInput('gg wp')).toEqual({ kind: 'text', text: 'gg wp' });
    expect(parseTextInput('ff')).toEqual({ kind: 'text', text: 'ff' });
  });

  it('cuts long text to the message limit', () => {
    const r = parseTextInput('a'.repeat(130));
    expect(r).toEqual({ kind: 'text', text: 'a'.repeat(MAX_TEXT) });
    expect([...(r.kind === 'text' ? r.text : '')]).toHaveLength(120);
  });
});

describe('commandMatches', () => {
  it('offers the commands that start with what was typed, in any case', () => {
    expect(commandMatches('/r')).toEqual(['/ready']);
    expect(commandMatches('/N')).toEqual(['/noff']);
    expect(commandMatches('/')).toEqual(['/ff', '/noff', '/ready', '/surrender']);
    expect(commandMatches('/ff')).toEqual(['/ff']);
  });

  it('offers nothing for plain text, a second word, or a start no command has', () => {
    expect(commandMatches('ff')).toEqual([]);
    expect(commandMatches('')).toEqual([]);
    expect(commandMatches('/ff now')).toEqual([]);
    expect(commandMatches(' /ff')).toEqual([]);
    expect(commandMatches('/x')).toEqual([]);
  });
});

describe('completeCommand', () => {
  it('completes a start that only one command has', () => {
    expect(completeCommand('/re', null)?.value).toBe('/ready');
    expect(completeCommand('/S', null)?.value).toBe('/surrender');
  });

  it('cycles through the matches on each press while the box shows its last completion, and wraps round', () => {
    let step = completeCommand('/', null);
    const seen: string[] = [];
    for (let i = 0; i < 5 && step; i++) {
      seen.push(step.value);
      step = completeCommand(step.value, step.cycle);
    }
    expect(seen).toEqual(['/ff', '/noff', '/ready', '/surrender', '/ff']);
  });

  it('cycles backwards with Shift+Tab, starting from the last match', () => {
    const first = completeCommand('/', null, true);
    expect(first?.value).toBe('/surrender');
    expect(first && completeCommand(first.value, first.cycle, true)?.value).toBe('/ready');
  });

  it('starts again from the box when it was edited after a completion', () => {
    const first = completeCommand('/', null);
    expect(first?.value).toBe('/ff');
    // The user typed over it: "/n" is completed on its own, not as the next match of "/".
    expect(first && completeCommand('/n', first.cycle)?.value).toBe('/noff');
  });

  it('leaves the box alone when nothing completes', () => {
    expect(completeCommand('gg', null)).toBeNull();
    expect(completeCommand('/x', null)).toBeNull();
    expect(completeCommand('/ff now', null)).toBeNull();
  });
});
