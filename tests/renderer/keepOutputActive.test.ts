import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('KeepOutputActive', () => {
  it('stays active without reading or writing any audio samples', () => {
    let processor: { process: (...args: unknown[]) => boolean } | undefined;
    runInNewContext(readFileSync('src/renderer/overlay/keepOutputActive.worklet.js', 'utf8'), {
      AudioWorkletProcessor: class {},
      registerProcessor(name: string, Processor: new () => { process: () => boolean }) {
        expect(name).toBe('keep-output-active');
        processor = new Processor();
      },
    });
    expect(processor).toBeDefined();
    const forbiddenAudioAccess = new Proxy([], {
      get() { throw new Error('Keep-alive must not access audio samples'); },
    });
    for (let i = 0; i < 1000; i++) {
      expect(processor?.process(forbiddenAudioAccess, forbiddenAudioAccess, {})).toBe(true);
    }
  });
});
