// Minimal WAV reader for the evaluation data: PCM 16/24/32-bit and 32-bit float, mixed down to mono.

export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

export function readWav(bytes: Uint8Array): Audio {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { offset: number; length: number } | null = null;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, bytes.length - body) };
    }
    o = body + size + (size & 1);
  }
  if (!data || !channels || !sampleRate) throw new Error('WAV without fmt or data chunk');
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const out = new Float32Array(frames);
  const read = (p: number): number => {
    if (format === 3 && bits === 32) return v.getFloat32(p, true);
    if (format !== 1) throw new Error(`unsupported WAV format ${format}`);
    if (bits === 16) return v.getInt16(p, true) / 32768;
    if (bits === 24) return ((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)) << 8 >> 8) / 8388608;
    if (bits === 32) return v.getInt32(p, true) / 2147483648;
    if (bits === 8) return (bytes[p] - 128) / 128;
    throw new Error(`unsupported bit depth ${bits}`);
  };
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += read(data.offset + (i * channels + c) * width);
    out[i] = s / channels;
  }
  return { samples: out, sampleRate };
}
