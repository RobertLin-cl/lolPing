import type { EmoteFile } from './emotes';

/** Prefix bounded metadata to raw bytes so large animations do not become JSON arrays. */
export function emoteUpload(header: Record<string, unknown>, parts: readonly Uint8Array[]): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(header));
  const packet = new Uint8Array(4 + metadata.length + parts.reduce((total, part) => total + part.length, 0));
  new DataView(packet.buffer).setUint32(0, metadata.length, true);
  packet.set(metadata, 4);
  let offset = 4 + metadata.length;
  for (const part of parts) { packet.set(part, offset); offset += part.length; }
  return packet;
}

export function imageUpload(live: Record<string, unknown>, file: EmoteFile): Uint8Array {
  return emoteUpload({ live, name: file.name, stillLength: file.still.length,
    hdLength: file.hd?.length ?? null, animLength: file.anim?.length ?? null },
  [file.still, ...(file.hd ? [file.hd] : []), ...(file.anim ? [file.anim] : [])]);
}
