// Microphone capture with raw (unprocessed) audio and context-frame timestamps,
// so recorded samples can be lined up with the metronome clicks.
// One MicCapture lives for one take: it is opened when recording starts and closed when it stops,
// so the browser's microphone indicator is only on while recording.

const WORKLET_SOURCE = `
class MtTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.start = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const len = input[0].length;
      if (this.n === 0) this.start = currentFrame;
      // Mono mix of whatever channels arrive (a stereo interface may carry the voice on one side only).
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        this.buf[this.n + i] = s / input.length;
      }
      this.n += len;
      if (this.n >= 512) {
        this.port.postMessage({ frame: this.start, data: this.buf.slice(0, this.n) });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('mt-tap', MtTap);
`;

export type ChunkListener = (data: Float32Array, frame: number) => void;

const workletLoaded = new WeakSet<BaseAudioContext>();

export class MicCapture {
  readonly sampleRate: number;
  /** Estimated input latency in seconds (0 when the browser does not say). */
  readonly inputLatency: number;
  readonly kind: 'worklet' | 'script-processor';
  /** RMS of the latest chunk, for the level meter. */
  level = 0;
  /** Called once if the device goes away (unplugged, permission revoked) while open. */
  onEnded: (() => void) | null = null;
  private listener: ChunkListener | null = null;
  private nextFrame = -1;
  private closed = false;

  private constructor(
    readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly nodes: AudioNode[],
    kind: 'worklet' | 'script-processor',
  ) {
    this.sampleRate = ctx.sampleRate;
    this.kind = kind;
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    this.inputLatency = typeof settings?.latency === 'number' ? settings.latency : 0;
    track?.addEventListener('ended', () => {
      if (!this.closed) this.onEnded?.();
    });
  }

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  static async open(ctx: AudioContext): Promise<MicCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const source = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    let capture: MicCapture;
    try {
      if (!workletLoaded.has(ctx)) {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        workletLoaded.add(ctx);
      }
      const node = new AudioWorkletNode(ctx, 'mt-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
      source.connect(node);
      node.connect(mute);
      capture = new MicCapture(ctx, stream, [source, node, mute], 'worklet');
      node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) =>
        capture.receive(e.data.data, e.data.frame);
    } catch {
      // Older browsers or pages that forbid blob: workers. The node down-mixes its input to mono.
      const node = ctx.createScriptProcessor(1024, 1, 1);
      source.connect(node);
      node.connect(mute);
      capture = new MicCapture(ctx, stream, [source, node, mute], 'script-processor');
      // playbackTime is read on the main thread and jitters, so only the first block is stamped from it;
      // later blocks continue the sample count, which keeps the timeline free of invented gaps.
      let next = -1;
      node.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        if (next < 0) next = Math.max(0, Math.round(e.playbackTime * ctx.sampleRate) - data.length);
        capture.receive(data, next);
        next += data.length;
      };
    }
    return capture;
  }

  listen(listener: ChunkListener | null): void {
    this.listener = listener;
    this.nextFrame = -1;
  }

  private receive(data: Float32Array, frame: number): void {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    this.level = Math.sqrt(sum / Math.max(1, data.length));
    if (!this.listener) return;
    // Keep the timeline continuous: fill dropped blocks with silence.
    if (this.nextFrame >= 0 && frame > this.nextFrame && frame - this.nextFrame < this.sampleRate) {
      this.listener(new Float32Array(frame - this.nextFrame), this.nextFrame);
    }
    this.listener(data, frame);
    this.nextFrame = frame + data.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listener = null;
    for (const n of this.nodes) n.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
  }
}

/** Collects chunks into one buffer and remembers the context frame of its first sample. */
export class TakeRecorder {
  private chunks: Float32Array[] = [];
  private length = 0;
  firstFrame = -1;

  push(data: Float32Array, frame: number): void {
    if (this.firstFrame < 0) this.firstFrame = frame;
    this.chunks.push(data);
    this.length += data.length;
  }

  merge(): Float32Array {
    const out = new Float32Array(this.length);
    let p = 0;
    for (const c of this.chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }
}
