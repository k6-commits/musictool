"""Reference SwiftF0 frames from the swift-f0 package (onnxruntime), to check the TypeScript port against.

    pip install "swift-f0[audio]==0.3.0"
    python eval/real/swiftf0_frames.py <out_dir> <file.wav>...

Writes <out_dir>/<name>.json with t, f0, conf and db per 16 ms frame. Compare with:
    npm run eval:check-swiftf0 -- <wav_dir> <out_dir>
(use 16 kHz files, such as eval/data/noisy/..., so both sides read the same samples without resampling).
The evaluation can also score these frames directly (engine "swiftf0-ref", from eval/data/frames/swiftf0/<condition>/<set>).
"""
import json
import os
import sys
import time

import numpy as np
import soundfile
from swift_f0 import SwiftF0

out_dir, paths = sys.argv[1], sys.argv[2:]
os.makedirs(out_dir, exist_ok=True)
detector = SwiftF0(threads=1)
audio_seconds = model_seconds = 0.0
for path in paths:
    audio, sr = soundfile.read(path, dtype="float32", always_2d=True)
    t0 = time.perf_counter()
    r = detector.detect(audio, sr)
    model_seconds += time.perf_counter() - t0
    audio_seconds += len(audio) / sr
    name = os.path.splitext(os.path.basename(path))[0]
    # Full precision, so that comparisons with the port are not limited by rounding.
    with open(os.path.join(out_dir, name + ".json"), "w") as f:
        json.dump({"t": r.timestamps.tolist(), "f0": r.pitch_hz.tolist(),
                   "conf": r.confidence.tolist(), "db": r.loudness_db.tolist()}, f)
print(f"{len(paths)} files, {audio_seconds:.1f} s of audio, {1000 * model_seconds / max(1, audio_seconds / 0.016):.3f} ms per 16 ms frame")
