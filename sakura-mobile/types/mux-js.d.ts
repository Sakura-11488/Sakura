/** Public mux.js surface used by offline MP4 export. */
declare module 'mux.js' {
  class Transmuxer {
    constructor(options: { remux: boolean; keepOriginalTimestamps: boolean });
    on(event: 'data', handler: (value: { initSegment: Uint8Array; data: Uint8Array }) => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }
  const muxjs: { mp4: { Transmuxer: typeof Transmuxer } };
  export default muxjs;
}
