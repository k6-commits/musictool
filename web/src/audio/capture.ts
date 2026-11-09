// Microphone capture with raw (unprocessed) audio and context-frame timestamps,
// so recorded samples can be lined up with the metronome clicks.

const WORKLET_SOURCE = `
class MtTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.start = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.start = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
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

export class MicCapture {
  readonly sampleRate: number;
  /** Estimated input latency in seconds (0 when the browser does not say). */
  readonly inputLatency: number;
  readonly kind: 'worklet' | 'script-processor';
  /** RMS of the latest chunk, for the level meter. */
  level = 0;
  private listener: ChunkListener | null = null;
  private nextFrame = -1;

  private constructor(
    readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly nodes: AudioNode[],
    kind: 'worklet' | 'script-processor',
  ) {
    this.sampleRate = ctx.sampleRate;
    this.kind = kind;
    const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
    this.inputLatency = typeof settings?.latency === 'number' ? settings.latency : 0;
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
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'mt-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      source.connect(node);
      node.connect(mute);
      capture = new MicCapture(ctx, stream, [source, node, mute], 'worklet');
      node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) =>
        capture.receive(e.data.data, e.data.frame);
    } catch {
      // Older browsers or pages that forbid blob: workers.
      const node = ctx.createScriptProcessor(1024, 1, 1);
      source.connect(node);
      node.connect(mute);
      capture = new MicCapture(ctx, stream, [source, node, mute], 'script-processor');
      node.onaudioprocess = (e) => {
        const frame = Math.round(e.playbackTime * ctx.sampleRate) - e.inputBuffer.length;
        capture.receive(new Float32Array(e.inputBuffer.getChannelData(0)), frame);
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

  get samples(): number {
    return this.length;
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
