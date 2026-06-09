#!/usr/bin/env python3
"""
au_map.py — MediaPipe(ARKit)52 blendshape → FACS AU 近似マッピング + 情動コンポジット。

blendshape は ARKit 準拠で、多くが AU に概ね対応する（厳密な FACS ではない近似）。
抑うつ研究で重要なもの: AU12(笑)、AU15(口角下制=悲)、AU1+AU4(悲しみ眉)、
AU6(頬上げ=デュシェンヌ真の笑い)、非デュシェンヌ「作り笑い」指数 = AU12 - AU6。
"""
from __future__ import annotations

# AU -> 構成 blendshape 名（左右は平均）
AU_MAP = {
    "AU1_innerBrowRaiser": ["browInnerUp"],
    "AU2_outerBrowRaiser": ["browOuterUpLeft", "browOuterUpRight"],
    "AU4_browLowerer": ["browDownLeft", "browDownRight"],
    "AU5_upperLidRaiser": ["eyeWideLeft", "eyeWideRight"],
    "AU6_cheekRaiser": ["cheekSquintLeft", "cheekSquintRight"],
    "AU7_lidTightener": ["eyeSquintLeft", "eyeSquintRight"],
    "AU9_noseWrinkler": ["noseSneerLeft", "noseSneerRight"],
    "AU10_upperLipRaiser": ["mouthUpperUpLeft", "mouthUpperUpRight"],
    "AU12_lipCornerPuller": ["mouthSmileLeft", "mouthSmileRight"],
    "AU14_dimpler": ["mouthDimpleLeft", "mouthDimpleRight"],
    "AU15_lipCornerDepressor": ["mouthFrownLeft", "mouthFrownRight"],
    "AU17_chinRaiser": ["mouthShrugLower", "mouthShrugUpper"],
    "AU20_lipStretcher": ["mouthStretchLeft", "mouthStretchRight"],
    "AU23_lipTightener": ["mouthPressLeft", "mouthPressRight"],
    "AU26_jawDrop": ["jawOpen"],
    "AU28_lipSuck": ["mouthRollLower", "mouthRollUpper"],
    "AU45_blink": ["eyeBlinkLeft", "eyeBlinkRight"],
}

# 情動コンポジット（構成 AU の平均）。抑うつ関連を中心に。
COMPOSITES = {
    "EMO_sadness": ["AU1_innerBrowRaiser", "AU4_browLowerer", "AU15_lipCornerDepressor"],
    "EMO_duchenne": ["AU6_cheekRaiser", "AU12_lipCornerPuller"],
    "EMO_distress": ["AU4_browLowerer", "AU7_lidTightener"],
}


def au_features(get):
    """get(blendshape_name)->値(平均) を受け取り、AU + コンポジット dict を返す。"""
    au = {}
    for name, bss in AU_MAP.items():
        vals = [get(b) for b in bss if get(b) is not None]
        au[name] = (sum(vals) / len(vals)) if vals else None
    out = dict(au)
    for cname, aus in COMPOSITES.items():
        vals = [au[a] for a in aus if au.get(a) is not None]
        out[cname] = (sum(vals) / len(vals)) if vals else None
    # 非デュシェンヌ(作り笑い)指数: 口角は上がるが頬は上がらない
    if au.get("AU12_lipCornerPuller") is not None and au.get("AU6_cheekRaiser") is not None:
        out["EMO_nonduchenne"] = au["AU12_lipCornerPuller"] - au["AU6_cheekRaiser"]
    return out
