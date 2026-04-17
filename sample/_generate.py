"""Generate a synthetic sample_landmarks.json.gz for the analyze page demo.

Not a real recording — just realistic-looking timing + blendshapes so
users can explore analyze.html without having to do the full quiz.
"""
import gzip, json, math, random
from pathlib import Path

random.seed(42)

N = 478
FPS = 30

# Base face shape (procedural fake)
pts0 = []
for i in range(N):
    phi = i * 2.399963
    r = 0.3 * ((i / N) ** 0.5)
    x = 0.5 + r * math.cos(phi) * 1.0
    y = 0.5 + r * math.sin(phi) * 1.3
    z = -0.08 * math.exp(-((x - 0.5) ** 2 + (y - 0.5) ** 2) * 20)
    pts0.append([x, y, z])

BS_NAMES = [
    "_neutral","browDownLeft","browDownRight","browInnerUp","browOuterUpLeft","browOuterUpRight",
    "cheekPuff","cheekSquintLeft","cheekSquintRight","eyeBlinkLeft","eyeBlinkRight",
    "eyeLookDownLeft","eyeLookDownRight","eyeLookInLeft","eyeLookInRight",
    "eyeLookOutLeft","eyeLookOutRight","eyeLookUpLeft","eyeLookUpRight",
    "eyeSquintLeft","eyeSquintRight","eyeWideLeft","eyeWideRight",
    "jawForward","jawLeft","jawOpen","jawRight",
    "mouthClose","mouthDimpleLeft","mouthDimpleRight","mouthFrownLeft","mouthFrownRight",
    "mouthFunnel","mouthLeft","mouthLowerDownLeft","mouthLowerDownRight",
    "mouthPressLeft","mouthPressRight","mouthPucker","mouthRight","mouthRollLower",
    "mouthRollUpper","mouthShrugLower","mouthShrugUpper",
    "mouthSmileLeft","mouthSmileRight","mouthStretchLeft","mouthStretchRight",
    "mouthUpperUpLeft","mouthUpperUpRight",
    "noseSneerLeft","noseSneerRight",
]

TITLES = [
    "寝つき","夜間の睡眠","早く目が覚めすぎる","眠りすぎる","悲しい気持ち",
    "食欲低下","食欲増進","体重減少","体重増加","集中力／決断",
    "自分についての見方","死や自殺についての考え","一般的な興味","エネルギーのレベル",
    "動きが遅くなった気がする","落ち着かない",
]
DOMAINS = ["sleep"]*4 + ["mood","appetite","appetite","appetite","appetite","concentration",
                         "self","suicide","interest","energy","psychomotor","psychomotor"]


def euler_to_mat16(yaw_deg, pitch_deg, roll_deg):
    y = math.radians(yaw_deg)
    p = math.radians(pitch_deg)
    r = math.radians(roll_deg)
    cy, sy = math.cos(y), math.sin(y)
    cp, sp = math.cos(p), math.sin(p)
    cr, sr = math.cos(r), math.sin(r)
    Rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]]
    Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]]

    def mm(a, b):
        return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]

    R = mm(Ry, mm(Rx, Rz))
    m = [0.0] * 16
    for c in range(3):
        for r_ in range(3):
            m[c * 4 + r_] = R[r_][c]
    m[15] = 1.0
    m[12] = 0
    m[13] = 0
    m[14] = -50
    return [round(v, 5) for v in m]


frames = []

def push_event(t_ms, q, ev, **extra):
    rec = {"event": ev, "t": round(t_ms, 2), "q": q}
    rec.update(extra)
    frames.append(rec)


t = 0.0
dt = 1000.0 / FPS

# Baseline 3s
push_event(t, 0, "baseline_start")
for _ in range(int(FPS * 3)):
    pts = [[round(p[0], 4), round(p[1], 4), round(p[2], 4)] for p in pts0]
    bs = {n: round(0.02 * random.random(), 4) for n in BS_NAMES}
    bs["_neutral"] = 0.82
    frames.append({
        "t": round(t, 2), "q": 0, "pts": pts, "bs": bs,
        "mat": euler_to_mat16(random.uniform(-1, 1), random.uniform(-1, 1), 0),
    })
    t += dt
push_event(t, 0, "baseline_end", skipped=False, durationMs=3000)

# 16 questions
for q in range(16):
    push_event(t, q, "question_enter")
    dwell_sec = random.uniform(1.5, 4.0)
    answer_time_sec = random.uniform(1, dwell_sec * 0.7)
    answer = random.randint(0, 3)
    will_change = random.random() < 0.3
    answer_logged = False
    changed_logged = False
    q_start_t = t

    emo_set = [
        {},
        {"browInnerUp": 0.3, "mouthFrownLeft": 0.15, "mouthFrownRight": 0.15},
        {"eyeBlinkLeft": 0.4, "eyeBlinkRight": 0.4},
        {"mouthSmileLeft": 0.3, "mouthSmileRight": 0.3},
        {"jawOpen": 0.1, "browDownLeft": 0.1},
        {"browInnerUp": 0.45, "mouthFrownLeft": 0.3, "mouthFrownRight": 0.3},
    ]
    emo = emo_set[q % len(emo_set)]

    elapsed_sec = 0.0
    while elapsed_sec < dwell_sec:
        phase = elapsed_sec / dwell_sec
        pts = []
        for i, p in enumerate(pts0):
            jx = 0.002 * math.sin(t * 0.006 + i * 0.1)
            jy = 0.002 * math.cos(t * 0.007 + i * 0.13)
            pts.append([round(p[0] + jx, 4), round(p[1] + jy, 4), round(p[2], 4)])
        bs = {n: round(random.uniform(0, 0.06), 4) for n in BS_NAMES}
        bs["_neutral"] = 0.72
        peak = 1.0 - abs(phase - 0.5) * 2
        for k, v in emo.items():
            bs[k] = round(min(1.0, v * peak + random.uniform(0, 0.05)), 4)
        if random.random() < 0.04:
            bs["eyeBlinkLeft"] = round(random.uniform(0.7, 0.95), 4)
            bs["eyeBlinkRight"] = round(random.uniform(0.7, 0.95), 4)
        yaw = 4 * math.sin(t * 0.0007) + random.uniform(-2, 2)
        pitch = 3 * math.sin(t * 0.0005) + random.uniform(-1, 1)
        roll = 2 * math.sin(t * 0.0003)
        frames.append({
            "t": round(t, 2), "q": q, "pts": pts, "bs": bs,
            "mat": euler_to_mat16(yaw, pitch, roll),
        })

        if not answer_logged and elapsed_sec >= answer_time_sec:
            push_event(t, q, "answer_selected", a=answer)
            answer_logged = True
        if will_change and answer_logged and not changed_logged and elapsed_sec >= answer_time_sec + 0.8:
            answer = (answer + 1) % 4
            push_event(t, q, "answer_selected", a=answer)
            changed_logged = True

        t += dt
        elapsed_sec = (t - q_start_t) / 1000
    push_event(t, q, "question_finalize", a=answer)


# questionSegments
segs_by_q = {}
cur_q = None
cur_enter = None
last_t = 0.0
for f in frames:
    if "t" in f and isinstance(f["t"], (int, float)):
        last_t = f["t"]
    ev = f.get("event")
    if ev == "question_enter":
        if cur_q is not None:
            segs_by_q[cur_q]["activeTimeRanges"].append([cur_enter, f["t"]])
        cur_q = f["q"]
        cur_enter = f["t"]
        segs_by_q.setdefault(cur_q, {
            "q": cur_q,
            "questionNumber": cur_q + 1,
            "title": TITLES[cur_q] if cur_q < 16 else None,
            "domain": DOMAINS[cur_q] if cur_q < 16 else None,
            "enterTimes": [],
            "activeTimeRanges": [],
            "firstAnswerTime": None,
            "lastAnswerTime": None,
            "finalAnswer": None,
            "finalizeTime": None,
            "answerEventCount": 0,
            "activeDurationMs": 0,
        })
        segs_by_q[cur_q]["enterTimes"].append(f["t"])
    elif ev == "answer_selected":
        s = segs_by_q[f["q"]]
        if s["firstAnswerTime"] is None:
            s["firstAnswerTime"] = f["t"]
        s["lastAnswerTime"] = f["t"]
        s["finalAnswer"] = f.get("a")
        s["answerEventCount"] += 1
    elif ev == "question_finalize":
        s = segs_by_q[f["q"]]
        s["finalizeTime"] = f["t"]
        if "a" in f:
            s["finalAnswer"] = f["a"]

if cur_q is not None:
    segs_by_q[cur_q]["activeTimeRanges"].append([cur_enter, last_t])

for s in segs_by_q.values():
    s["activeDurationMs"] = round(sum(b - a for a, b in s["activeTimeRanges"]), 2)

questionSegments = [segs_by_q[k] for k in sorted(segs_by_q.keys())]

answers = [{"q": i + 1, "title": TITLES[i], "score": segs_by_q[i]["finalAnswer"]} for i in range(16)]
max_sleep = max(segs_by_q[i]["finalAnswer"] or 0 for i in range(4))
max_apt = max(segs_by_q[i]["finalAnswer"] or 0 for i in range(5, 9))
max_psy = max(segs_by_q[i]["finalAnswer"] or 0 for i in [14, 15])
mid = [segs_by_q[i]["finalAnswer"] or 0 for i in [4, 9, 10, 11, 12, 13]]
total = max_sleep + max_apt + max_psy + sum(mid)
if total <= 5:
    severity, key = "正常", "normal"
elif total <= 10:
    severity, key = "軽度", "mild"
elif total <= 15:
    severity, key = "中等度", "moderate"
elif total <= 20:
    severity, key = "重度", "severe"
else:
    severity, key = "きわめて重度", "extreme"

doc = {
    "meta": {
        "sessionStart": "2026-04-17T14:25:30.123Z",
        "videoWidth": 640, "videoHeight": 480,
        "runtime": "@mediapipe/tasks-vision@0.10.14",
        "modelUrl": "models/face_landmarker.task",
        "modelSha384": "sha384-tYQh+yJE8llY+zO4RviZmWaSKs5W9tsB0ix5rjQVpF5/CLTqmwtP7bYtkUi2w65P",
        "targetFps": FPS, "actualFps": FPS, "droppedFrames": 0,
        "mirrored": True, "pointCount": N, "blendshapeCount": 52,
        "ptsFormat": "array of [x, y, z] normalized",
        "matFormat": "16 floats, 4x4 column-major",
        "timeBase": "performance.now() ms relative to recording start",
        "recorderFirstDataOffsetMs": 987.5,
        "recordedMime": "video/webm;codecs=vp9",
        "eventTypes": [
            "question_enter", "answer_selected", "question_finalize",
            "face_lost", "face_found", "baseline_start", "baseline_end",
            "crisis_modal_shown", "crisis_modal_closed",
        ],
        "device": {
            "userAgent": "Sample synthetic data — not a real session",
            "language": "ja-JP",
            "platform": "Synth",
            "hardwareConcurrency": 8,
            "deviceMemoryGB": 8,
            "devicePixelRatio": 2,
            "screenWidth": 1920,
            "screenHeight": 1080,
            "timezone": "Asia/Tokyo",
            "webglVendor": "Synth",
            "webglRenderer": "Synthetic sample",
            "camera": {"width": 640, "height": 480, "frameRate": 30, "facingMode": "user", "deviceId": "present"},
        },
        "notes": ["This is synthetic sample data for demo purposes; not a real recording."],
    },
    "questionSegments": questionSegments,
    "frames": frames,
    "result": {
        "total": total, "severity": severity, "severityKey": key,
        "breakdown": {
            "sleep": max_sleep, "appetite": max_apt, "psychomotor": max_psy,
            "sad": mid[0], "concentration": mid[1], "self": mid[2],
            "suicide": mid[3], "interest": mid[4], "energy": mid[5],
        },
    },
    "answers": answers,
}

out_path = Path(__file__).parent / "sample_landmarks.json.gz"
with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=9) as fh:
    json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))

text_size = len(json.dumps(doc, separators=(",", ":")))
print(f"Generated {out_path}")
print(f"  detection frames : {sum(1 for f in frames if 'pts' in f)}")
print(f"  total entries    : {len(frames)}")
print(f"  uncompressed     : {text_size / 1024 / 1024:.2f} MB")
print(f"  compressed       : {out_path.stat().st_size / 1024 / 1024:.2f} MB")
print(f"  QIDS total score : {total} ({severity})")
