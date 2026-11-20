import { describe, expect, it } from 'vitest';
import { emoteUpload, imageUpload } from '../../src/shared/emoteUpload';

describe('emoteUpload', () => {
  it('preserves Unicode metadata and exact binary boundaries', () => {
    const packet = imageUpload({ revision: 7 }, { name: '玩家😀', still: new Uint8Array([0, 255]),
      hd: new Uint8Array([3]), anim: new Uint8Array([4, 0, 5]) });
    const size = new DataView(packet.buffer).getUint32(0, true);
    expect(JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + size)))).toEqual({
      live: { revision: 7 }, name: '玩家😀', stillLength: 2, hdLength: 1, animLength: 3,
    });
    expect([...packet.subarray(4 + size)]).toEqual([0, 255, 3, 4, 0, 5]);
  });

  it('keeps missing files distinct from empty files and explicit sound removal', () => {
    for (const file of [{ name: 'x', still: new Uint8Array([1]) }, { name: 'x', still: new Uint8Array([1]), anim: new Uint8Array() }]) {
      const packet = imageUpload({}, file);
      const size = new DataView(packet.buffer).getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(packet.subarray(4, 4 + size))) as { animLength: number | null };
      expect(header.animLength).toBe('anim' in file ? 0 : null);
    }
    const packet = emoteUpload({ id: 'x', length: null }, []);
    expect(packet.length).toBe(4 + new DataView(packet.buffer).getUint32(0, true));
  });
});
