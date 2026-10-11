/** Convert an already downloaded episode into a standalone video, without network access. */
import muxjs from 'mux.js';
import type { OfflineEpisode } from './anime-offline';
import { parseAttributeList } from './hls-local-playlist';

export interface AnimeVideoExportOptions {
  signal?: AbortSignal;
  /** Fraction of cached media processed, from zero to one. */
  onProgress?: (value: number) => void;
}
export interface AnimeVideoExportResult {
  mimeType: string;
  extension: 'mp4' | 'mov';
  bytes: number;
}
type Range = { offset: number; length: number };
type Key = { uri: string; iv?: Uint8Array };
type Resource = { uri: string; range?: Range; key?: Key };
type Segment = Resource & { duration: number; sequence: bigint; period: number; map?: Resource };
const unsupported = (reason: string) => new Error(`This episode cannot be saved as a video: ${reason}`);
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Video export cancelled.', 'AbortError'); };

function ivBytes(value: string): Uint8Array {
  if (!/^0x[0-9a-f]{1,32}$/i.test(value)) throw unsupported('invalid encryption IV.');
  const hex = value.slice(2).padStart(32, '0');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}
function sequenceIv(sequence: bigint): Uint8Array {
  if (sequence < 0n || sequence >= (1n << 128n)) throw unsupported('invalid media sequence.');
  return ivBytes(`0x${sequence.toString(16)}`);
}
function byteRange(value: string, uri: string, previous?: Resource): Range {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw unsupported('invalid byte range.');
  const length = Number(match[1]);
  const offset = match[2] !== undefined ? Number(match[2]) : previous?.uri === uri && previous.range ? previous.range.offset + previous.range.length : NaN;
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) {
    throw unsupported('an incomplete byte range.');
  }
  return { offset, length };
}
function playlistSegments(text: string, base: string): Segment[] {
  if (!/^#EXTM3U\s*$/m.test(text) || !/^#EXT-X-ENDLIST\s*$/m.test(text)) throw unsupported('the saved playlist is incomplete.');
  const segments: Segment[] = [];
  let key: Key | undefined, map: Resource | undefined, range: string | undefined;
  let duration = NaN, sequence = 0n, period = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXT-X-(?:STREAM-INF|MEDIA|I-FRAMES-ONLY|GAP)(?::|$)/.test(line)) throw unsupported('separate renditions or missing media.');
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      if (segments.length || !/^\d+$/.test(line.slice(22))) throw unsupported('invalid media sequence.');
      sequence = BigInt(line.slice(22));
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributeList(line);
      if (attrs.METHOD === 'NONE') key = undefined;
      else {
        if (attrs.METHOD !== 'AES-128' || (attrs.KEYFORMAT && attrs.KEYFORMAT !== 'identity') || !attrs.URI) throw unsupported('this encryption format is not supported.');
        key = { uri: new URL(attrs.URI, base).href, iv: attrs.IV ? ivBytes(attrs.IV) : undefined };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line);
      if (!attrs.URI) throw unsupported('missing initialization media.');
      if (key && !key.iv) throw unsupported('encrypted initialization media requires an explicit IV.');
      const uri = new URL(attrs.URI, base).href;
      map = { uri, key, range: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, uri, map) : undefined };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = line.slice(17);
    else if (line === '#EXT-X-DISCONTINUITY') period++;
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (!line.startsWith('#')) {
      if (!Number.isFinite(duration) || duration <= 0) throw unsupported('invalid segment duration.');
      const uri = new URL(line, base).href;
      segments.push({ uri, key, map, duration, sequence: sequence++, period, range: range ? byteRange(range, uri, segments.at(-1)) : undefined });
      duration = NaN;
      range = undefined;
    }
  }
  if (!segments.length || range || Number.isFinite(duration)) throw unsupported('the saved playlist is incomplete.');
  return segments;
}

/** Reject formats mux.js would otherwise silently omit (for example AC-3 audio). */
function validateTransportStream(bytes: Uint8Array) {
  if (!bytes.length || bytes.length % 188) throw unsupported('invalid transport stream packets.');
  const pmtIds = new Set<number>();
  const pending = new Map<number, Uint8Array>();
  let sawProgram = false;
  const section = (pid: number, data: Uint8Array) => {
    if (pid === 0 && data[0] === 0) {
      for (let at = 8; at + 4 <= data.length - 4; at += 4) {
        if (data[at] || data[at + 1]) pmtIds.add(((data[at + 2] & 31) << 8) | data[at + 3]);
      }
      if (pmtIds.size > 1) throw unsupported('multiple transport stream programs.');
    } else if (pmtIds.has(pid) && data[0] === 2) {
      let video = 0, audio = 0;
      for (let at = 12 + (((data[10] & 15) << 8) | data[11]); at + 5 <= data.length - 4;) {
        const type = data[at];
        if (type === 0x1b) video++;
        else if (type === 0x0f) audio++;
        else if (type !== 0x15) throw unsupported('transport stream codecs other than H.264 and AAC.');
        at += 5 + (((data[at + 3] & 15) << 8) | data[at + 4]);
      }
      if (video > 1 || audio > 1 || !video) throw unsupported('multiple tracks or an unsupported video codec.');
      sawProgram = true;
    }
  };
  for (let at = 0; at < bytes.length; at += 188) {
    if (bytes[at] !== 0x47 || (bytes[at + 1] & 0x80) || (bytes[at + 3] & 0xc0)) throw unsupported('damaged or encrypted transport stream packets.');
    const pid = ((bytes[at + 1] & 31) << 8) | bytes[at + 2];
    if (pid !== 0 && !pmtIds.has(pid)) continue;
    const flags = (bytes[at + 3] >> 4) & 3;
    if (!(flags & 1)) continue;
    let offset = at + 4 + ((flags & 2) ? bytes[at + 4] + 1 : 0);
    if (offset >= at + 188) continue;
    if (bytes[at + 1] & 0x40) { offset += bytes[offset] + 1; pending.delete(pid); }
    const old = pending.get(pid) ?? new Uint8Array();
    const part = bytes.subarray(offset, at + 188);
    const combined = new Uint8Array(old.length + part.length);
    combined.set(old); combined.set(part, old.length);
    if (combined.length < 3) { pending.set(pid, combined); continue; }
    const length = 3 + (((combined[1] & 15) << 8) | combined[2]);
    if (combined.length >= length) { section(pid, combined.subarray(0, length)); pending.delete(pid); }
    else pending.set(pid, combined);
  }
  if (!sawProgram) throw unsupported('missing transport stream program information.');
}

// Box sizes never change: trun data offsets therefore remain valid after timeline edits.
type Box = { type: string; start: number; data: number; end: number };
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Box[] = [];
  while (start < end) {
    if (start + 8 > end) throw unsupported('truncated MP4 media.');
    let length = view.getUint32(start), header = 8;
    if (length === 1) {
      if (start + 16 > end) throw unsupported('truncated MP4 media.');
      const large = view.getBigUint64(start + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported('oversized MP4 box.');
      length = Number(large); header = 16;
    } else if (length === 0) length = end - start;
    if (length < header || start + length > end) throw unsupported('invalid MP4 media.');
    result.push({ type: String.fromCharCode(...bytes.subarray(start + 4, start + 8)), start, data: start + header, end: start + length });
    start += length;
  }
  return result;
}
function child(bytes: Uint8Array, parent: Box, type: string): Box {
  const found = boxes(bytes, parent.data, parent.end).find(b => b.type === type);
  if (!found) throw unsupported(`missing MP4 ${type} data.`);
  return found;
}
function same(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((v, i) => v === b[i]); }
type Track = { scale: number; config: Uint8Array };
function tracksIn(init: Uint8Array): Map<number, Track> {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = boxes(init).find(b => b.type === 'moov');
  if (!moov) throw unsupported('missing MP4 initialization data.');
  const tracks = new Map<number, Track>();
  for (const track of boxes(init, moov.data, moov.end).filter(b => b.type === 'trak')) {
    const tkhd = child(init, track, 'tkhd');
    const id = view.getUint32(tkhd.data + (init[tkhd.data] === 1 ? 20 : 12));
    const mdia = child(init, track, 'mdia');
    const mdhd = child(init, mdia, 'mdhd');
    const scale = view.getUint32(mdhd.data + (init[mdhd.data] === 1 ? 20 : 12));
    const stsd = child(init, child(init, child(init, mdia, 'minf'), 'stbl'), 'stsd');
    const sampleEntries = boxes(init, stsd.data + 8, stsd.end);
    if (!scale || !sampleEntries.length || sampleEntries.some(b => !['avc1', 'avc3', 'hvc1', 'hev1', 'mp4a'].includes(b.type))) {
      throw unsupported('unsupported or encrypted MP4 codecs.');
    }
    tracks.set(id, { scale, config: init.slice(stsd.data, stsd.end) });
  }
  if (!tracks.size) throw unsupported('no audio or video tracks.');
  return tracks;
}
function compatibleTracks(a: Map<number, Track>, b: Map<number, Track>) {
  if (a.size !== b.size || [...a].some(([id, track]) => !b.has(id) || b.get(id)!.scale !== track.scale || !same(b.get(id)!.config, track.config))) {
    throw unsupported('the audio or video format changes during the episode.');
  }
}
function normalizeUnknownDurations(init: Uint8Array): Uint8Array {
  const normalized = init.slice();
  const view = new DataView(normalized.buffer, normalized.byteOffset, normalized.byteLength);
  const visit = (start: number, end: number) => {
    for (const box of boxes(normalized, start, end)) {
      if (['moov', 'trak', 'mdia'].includes(box.type)) visit(box.data, box.end);
      else if (['mvhd', 'tkhd', 'mdhd'].includes(box.type)) {
        const version = normalized[box.data];
        if (version !== 0 && version !== 1) throw unsupported('an unsupported MP4 duration header.');
        const offset = box.data + (box.type === 'tkhd' ? 20 : 16) + (version === 1 ? 8 : 0);
        if (offset + (version === 1 ? 8 : 4) > box.end) throw unsupported('truncated MP4 duration data.');
        // mux.js uses all-one bits for unknown duration. Safari treats that as
        // a literal duration (24.8 hours for 48 kHz audio). Zero tells standalone
        // fragmented-MP4 readers to derive duration from the actual fragments.
        if (version === 1) {
          if (view.getBigUint64(offset) === 0xffffffffffffffffn) view.setBigUint64(offset, 0n);
        } else if (view.getUint32(offset) === 0xffffffff) view.setUint32(offset, 0);
      }
    }
  };
  visit(0, normalized.length);
  return normalized;
}
interface Timeline { origin?: number; start: number; sequence: number; last: Map<number, number> }
function normalizeFragment(bytes: Uint8Array, tracks: Map<number, Track>, timeline: Timeline): Uint8Array[] {
  const top = boxes(bytes);
  if (!top.some(b => b.type === 'moof') || !top.some(b => b.type === 'mdat')) throw unsupported('the MP4 segment has no media fragments.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stamps: Array<{ box: Box; track: number; ticks: number; scale: number }> = [];
  for (const moof of top.filter(b => b.type === 'moof')) {
    const mfhd = child(bytes, moof, 'mfhd');
    view.setUint32(mfhd.data + 4, ++timeline.sequence);
    for (const traf of boxes(bytes, moof.data, moof.end).filter(b => b.type === 'traf')) {
      const children = boxes(bytes, traf.data, traf.end);
      if (children.some(b => ['senc', 'saiz', 'saio'].includes(b.type))) throw unsupported('encrypted MP4 samples.');
      const tfhd = child(bytes, traf, 'tfhd');
      if (view.getUint32(tfhd.data) & 1) throw unsupported('absolute MP4 data offsets.');
      const id = view.getUint32(tfhd.data + 4);
      const track = tracks.get(id);
      if (!track) throw unsupported('the MP4 track layout changes.');
      const tfdt = child(bytes, traf, 'tfdt');
      const ticks = bytes[tfdt.data] === 1 ? Number(view.getBigUint64(tfdt.data + 4)) : view.getUint32(tfdt.data + 4);
      if (!Number.isSafeInteger(ticks)) throw unsupported('an unsupported MP4 timeline.');
      stamps.push({ box: tfdt, track: id, ticks, scale: track.scale });
    }
  }
  if (!stamps.length) throw unsupported('the MP4 segment has no timeline.');
  timeline.origin ??= Math.min(...stamps.map(s => s.ticks / s.scale));
  for (const stamp of stamps) {
    const adjusted = Math.round(stamp.ticks + (timeline.start - timeline.origin) * stamp.scale);
    const previous = timeline.last.get(stamp.track);
    if (adjusted < 0 || (previous !== undefined && adjusted < previous)) throw unsupported('overlapping media timestamps.');
    timeline.last.set(stamp.track, adjusted);
    if (bytes[stamp.box.data] === 1) view.setBigUint64(stamp.box.data + 4, BigInt(adjusted));
    else {
      if (adjusted > 0xffffffff) throw unsupported('this MP4 timeline is too long.');
      view.setUint32(stamp.box.data + 4, adjusted);
    }
  }
  // Per-segment sidx and mfra indexes refer to source byte offsets. Fragmented
  // MP4 readers can seek by moof/tfdt without them; carrying them over is wrong.
  return top.filter(b => !['sidx', 'mfra', 'styp', 'ftyp', 'moov'].includes(b.type)).map(b => bytes.subarray(b.start, b.end));
}

/** The sink must consume/copy each chunk before resolving. At most one segment is buffered. */
export async function writeAnimeVideo(
  cache: Cache,
  episode: Pick<OfflineEpisode, 'status' | 'localPlaylistUri' | 'format'>,
  write: (chunk: Uint8Array) => Promise<void>,
  options: AnimeVideoExportOptions = {},
): Promise<AnimeVideoExportResult> {
  const { signal, onProgress } = options;
  checkAbort(signal);
  if (episode.status !== 'ready' || !episode.localPlaylistUri) throw new Error('Finish downloading this episode before saving its video.');
  const response = await cache.match(episode.localPlaylistUri);
  if (!response) throw new Error('The saved episode is missing. Download it again.');
  let bytesWritten = 0;
  const emit = async (chunk: Uint8Array) => { checkAbort(signal); await write(chunk); bytesWritten += chunk.byteLength; checkAbort(signal); };
  onProgress?.(0);
  if (episode.format !== 'hls' && !/\.m3u8(?:[?#]|$)/i.test(episode.localPlaylistUri)) {
    const type = response.headers.get('content-type') || 'video/mp4';
    const mov = /quicktime/i.test(type);
    const length = Number(response.headers.get('content-length'));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          checkAbort(signal);
          const next = await reader.read();
          if (next.done) break;
          await emit(next.value);
          if (length > 0) onProgress?.(Math.min(0.99, bytesWritten / length));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else await emit(new Uint8Array(await response.arrayBuffer()));
    if (!bytesWritten) throw new Error('The saved video is empty. Download it again.');
    if (Number.isSafeInteger(length) && length > 0 && bytesWritten !== length) throw new Error('The saved video is incomplete. Download it again.');
    onProgress?.(1);
    return { mimeType: mov ? 'video/quicktime' : 'video/mp4', extension: mov ? 'mov' : 'mp4', bytes: bytesWritten };
  }
  const base = new URL(episode.localPlaylistUri, typeof location === 'undefined' ? 'https://offline.invalid' : location.href);
  const segments = playlistSegments(await response.text(), base.href);
  let lastKeyUri = '', lastKey: CryptoKey | undefined;
  const read = async (resource: Resource, sequence: bigint): Promise<Uint8Array> => {
    checkAbort(signal);
    const url = new URL(resource.uri);
    if (url.origin !== base.origin || !url.pathname.startsWith('/app/__offline/')) throw unsupported('a media resource is not saved locally.');
    const cached = await cache.match(resource.uri);
    if (!cached) throw new Error('Part of this saved episode is missing. Download it again.');
    const blob = await cached.blob();
    const range = resource.range;
    if (range && range.offset + range.length > blob.size) throw unsupported('a cached byte range is incomplete.');
    let bytes = new Uint8Array(await (range ? blob.slice(range.offset, range.offset + range.length) : blob).arrayBuffer());
    checkAbort(signal);
    if (resource.key) {
      if (!globalThis.crypto?.subtle) throw unsupported('this browser cannot decrypt saved video.');
      if (resource.key.uri !== lastKeyUri) {
        const keyBytes = await read({ uri: resource.key.uri }, 0n);
        if (keyBytes.length !== 16) throw unsupported('invalid AES-128 key.');
        lastKey = await crypto.subtle.importKey('raw', keyBytes as Uint8Array<ArrayBuffer>, { name: 'AES-CBC' }, false, ['decrypt']);
        lastKeyUri = resource.key.uri;
      }
      try {
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: (resource.key.iv ?? sequenceIv(sequence)) as Uint8Array<ArrayBuffer> }, lastKey!, bytes as Uint8Array<ArrayBuffer>));
      } catch { throw unsupported('saved encrypted media could not be decrypted.'); }
    }
    return bytes;
  };
  let tracks: Map<number, Track> | undefined;
  const initialize = async (init: Uint8Array) => {
    const next = tracksIn(init);
    if (tracks) compatibleTracks(tracks, next);
    else { tracks = next; await emit(normalizeUnknownDurations(init)); }
  };
  let elapsed = 0, activePeriod = -1, mode: 'ts' | 'mp4' | undefined;
  let transmuxer: InstanceType<typeof muxjs.mp4.Transmuxer> | undefined;
  let emitted: Array<{ initSegment: Uint8Array; data: Uint8Array }> = [];
  let activeMap: Resource | undefined;
  const timeline: Timeline = { start: 0, sequence: 0, last: new Map() };
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.period !== activePeriod) {
      activePeriod = segment.period;
      timeline.origin = undefined;
      timeline.start = elapsed;
      transmuxer = undefined;
    }
    const nextMode = segment.map ? 'mp4' : 'ts';
    if (mode && nextMode !== mode) throw unsupported('the media container changes during the episode.');
    mode = nextMode;
    const bytes = await read(segment, segment.sequence);
    if (segment.map) {
      if (segment.map !== activeMap) { await initialize(await read(segment.map, segment.sequence)); activeMap = segment.map; }
      for (const chunk of normalizeFragment(bytes, tracks!, timeline)) await emit(chunk);
    } else {
      validateTransportStream(bytes);
      if (!transmuxer) {
        transmuxer = new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: false });
        transmuxer.on('data', value => { emitted.push(value); });
      }
      emitted = [];
      transmuxer.push(bytes);
      transmuxer.flush();
      if (!emitted.length) throw unsupported('the video codec cannot be converted to MP4.');
      for (const value of emitted) {
        await initialize(value.initSegment);
        for (const chunk of normalizeFragment(value.data, tracks!, timeline)) await emit(chunk);
      }
      emitted = [];
    }
    elapsed += segment.duration;
    onProgress?.((index + 1) / segments.length);
  }
  return { mimeType: 'video/mp4', extension: 'mp4', bytes: bytesWritten };
}
