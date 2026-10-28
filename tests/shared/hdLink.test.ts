import { describe, expect, it } from 'vitest';
import { HD_LINK_MAX_BYTES, linkHd, linkedHd } from '../../src/shared/hdLink';
import { isAnimatedWebp, sniffImage, webpSize } from '../../src/shared/imageSniff';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const chunk = (id: string, data: number[]): number[] => [...ascii(id), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
const riff = (...chunks: number[][]): Uint8Array => {
  const body = chunks.flat();
  return Uint8Array.from([...ascii('RIFF'), ...le32(4 + body.length), ...ascii('WEBP'), ...body]);
};
const fill = (n: number, v = 7): number[] => Array<number>(n).fill(v);

/** A lossy still, as the encoder writes an opaque image: one VP8 chunk, the size in its frame header. */
const lossy = (w = 160, h = 120, extra = 40): Uint8Array => riff(chunk('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), ...fill(extra)]));
/** A lossless still; `alpha` sets the header's alpha-is-used bit. */
const lossless = (w: number, h: number, alpha: boolean): Uint8Array =>
  riff(chunk('VP8L', [0x2f, ...le32((w - 1) | ((h - 1) << 14) | (alpha ? 1 << 28 : 0)), ...fill(20)]));
/** An extended still, as the encoder writes one with transparency: VP8X, ALPH, then VP8. */
const extended = (flags = 0x10, w = 160, h = 120): Uint8Array =>
  riff(chunk('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]), chunk('ALPH', fill(9)), chunk('VP8 ', fill(30)));
const HD = '0123456789abcdef0123456789abcdef';

describe('linkHd', () => {
  it('names the HD in a lossy still, which becomes extended at its own size and stays a still to older apps', () => {
    const linked = linkHd(lossy(), HD)!;
    expect(linkedHd(linked)).toBe(HD);
    expect(sniffImage(linked)).toBe('webp');
    expect(String.fromCharCode(...linked.subarray(12, 16))).toBe('VP8X');
    expect(webpSize(linked)).toEqual({ width: 160, height: 120 });
    expect(isAnimatedWebp(linked)).toBe(false);
    expect(linked[20] & 0x10).toBe(0); // a lossy still has no alpha
  });

  it('keeps every chunk of the still as it was, and the file size in the RIFF header true', () => {
    const still = extended(0x10);
    const linked = linkHd(still, HD)!;
    expect(linked.subarray(12, still.length)).toEqual(still.subarray(12)); // the link only comes after
    expect(linked[4] | (linked[5] << 8) | (linked[6] << 16) | (linked[7] << 24)).toBe(linked.length - 8);
    expect(webpSize(linked)).toEqual({ width: 160, height: 120 });
  });

  it('declares alpha for a lossless still that uses it, and not for one that doesn’t', () => {
    expect(linkHd(lossless(100, 80, true), HD)![20] & 0x10).toBe(0x10);
    expect(linkHd(lossless(100, 80, false), HD)![20] & 0x10).toBe(0);
    expect(webpSize(linkHd(lossless(100, 80, true), HD)!)).toEqual({ width: 100, height: 80 });
  });

  it('adds at most HD_LINK_MAX_BYTES', () => {
    for (const still of [lossy(), lossy(160, 160, 41), lossless(10, 10, true), extended()]) {
      expect(linkHd(still, HD)!.length - still.length).toBeLessThanOrEqual(HD_LINK_MAX_BYTES);
    }
  });

  it('pads a last chunk whose pad byte is missing, so the link starts on an even offset', () => {
    const odd = lossy(160, 120, 41); // a 51-byte chunk
    const cut = odd.subarray(0, odd.length - 1); // ... written without its pad byte
    cut.set(le32(cut.length - 8), 4);
    expect(linkedHd(linkHd(cut, HD)!)).toBe(HD);
  });

  it('refuses an animation, a still that links an HD already, something that isn’t a WebP, and a bad hash', () => {
    expect(linkHd(extended(0x12), HD)).toBeNull();
    expect(linkHd(linkHd(lossy(), HD)!, HD)).toBeNull();
    expect(linkHd(Uint8Array.from(ascii('not a webp at all, honest')), HD)).toBeNull();
    for (const bad of [HD.toUpperCase(), HD.slice(1), `${HD}0`, '']) expect(linkHd(lossy(), bad), bad).toBeNull();
  });
});

describe('linkedHd', () => {
  it('is null for a still that names no HD', () => {
    expect(linkedHd(lossy())).toBeNull();
    expect(linkedHd(extended())).toBeNull();
  });

  it('is null for a broken file instead of reading past its end', () => {
    const linked = linkHd(lossy(), HD)!;
    expect(linkedHd(linked.subarray(0, linked.length - 4))).toBeNull(); // the link cut short
    const overrun = riff(chunk('VP8X', fill(10)), [...ascii('LPHD'), ...le32(1000), ...fill(16)]);
    expect(linkedHd(overrun)).toBeNull();
    expect(linkedHd(new Uint8Array())).toBeNull();
  });

  it('reads the chunks that are there when the RIFF header claims more', () => {
    const lying = linkHd(lossy(), HD)!;
    lying.set(le32(lying.length), 4); // 8 bytes past the end of the file
    expect(linkedHd(lying)).toBe(HD);
  });

  it('only reads a link of the right size', () => {
    const short = riff(chunk('VP8X', fill(10)), chunk('LPHD', fill(15, 1)));
    expect(linkedHd(short)).toBeNull();
  });
});
