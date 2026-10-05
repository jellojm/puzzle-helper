"""Stream a phone video's frames to stdout for the Node tests (no frame files).

    python tools/video-stream.py <video> [step] [maxSide] [fromSec] [toSec]

Every `step`-th frame (default 5: ~6 fps from a 30 fps video, about the
phone's analysed rate) is written as one JSON header line followed by
w*h*4 bytes of RGBA. The header carries what the phone's sensors would tell
the app: `still` and the motion. The phone calls a frame still when it turns
under 25 deg/s and accelerates under 0.7 m/s^2 (js/main.js isStill), which a
smooth sweep passes - the owner's reports: ~95% of frames still. Here: image
motion under ~3% of the frame width per 1/30 s (phase correlation of
consecutive frames); blurred reads are rejected by the engine itself.
"""
import json
import sys

import cv2
import numpy as np

video = sys.argv[1]
step = int(sys.argv[2]) if len(sys.argv) > 2 else 5
max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 0
t_from = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
t_to = float(sys.argv[5]) if len(sys.argv) > 5 else 1e9

cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
out = sys.stdout.buffer
prev = None
motions = []  # per-frame motion (px at full width), last few
i = -1
while True:
    ok, f = cap.read()
    if not ok:
        break
    i += 1
    t = i / fps
    if t > t_to:
        break
    small = cv2.cvtColor(cv2.resize(f, (f.shape[1] // 4, f.shape[0] // 4), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    if prev is not None:
        (dx, dy), _ = cv2.phaseCorrelate(prev, small)
        motions.append(4 * float(np.hypot(dx, dy)))
    prev = small
    motions = motions[-3:]
    if t < t_from or i % step:
        continue
    if max_side and max(f.shape[:2]) > max_side:
        s = max_side / max(f.shape[:2])
        f = cv2.resize(f, (round(f.shape[1] * s), round(f.shape[0] * s)), interpolation=cv2.INTER_AREA)
    h, w = f.shape[:2]
    motion = max(motions) if motions else 0.0
    rgba = cv2.cvtColor(f, cv2.COLOR_BGR2RGBA)
    head = {"i": i, "t": round(t, 3), "w": w, "h": h, "motion": round(motion, 2), "still": motion < 0.03 * w}
    out.write((json.dumps(head) + "\n").encode())
    out.write(rgba.tobytes())
    out.flush()
