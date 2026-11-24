#!/usr/bin/env python3
"""Judges the header measurements of one device run of src/header.test.tsx (tools/header-check.sh).

Each marker the test left in the folder, `<page>-<connection>-<scheme>.png`, has its measurement beside it: `.json`
from the iOS probe (ios/DSHUITests/HeaderProbe.swift, frames in points) or `.xml` from `uiautomator dump` on Android
(bounds in pixels, divided by `density` in `density.txt`). On each page in PAGES the title and the centers of its
header buttons are on one line (1 pt at most apart), the buttons are inside the bar, and none reaches the connection
banner under it. A `-menu` marker has the ⋯ menu open and a `-new` marker the new chat sheet: a press that did nothing
fails. On Android each chats-page marker also has `<marker>.taps.json`, where the probe tapped ⋯ near its edges and
inside its hit slop (`taps`): each tap must have opened the menu. Prints one line per marker with the measured y
values; exits 1 on any failure.
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

TOLERANCE = 1.0  # points (dp on Android)
STATES = ("connecting", "offline", "online")
SCHEMES = ("light", "dark")


def rect(x, y, w, h):
    return {"x": x, "y": y, "w": w, "h": h}


def android(path, density):
    """The iOS probe's shape from a uiautomator dump: the bar is the smallest view holding the title and buttons."""
    nodes = []
    for n in ET.parse(path).iter("node"):
        m = re.match(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", n.get("bounds", ""))
        if not m:
            continue
        x1, y1, x2, y2 = (int(v) / density for v in m.groups())
        nodes.append((n.get("resource-id", ""), n.get("text", ""), rect(x1, y1, x2 - x1, y2 - y1)))
    views = {}
    for rid, _, r in nodes:
        if rid and rid not in views:
            views[rid] = r
    texts = [{"label": t, "frame": r} for _, t, r in nodes if t]
    bar = None
    for label, buttons, _ in PAGES.values():
        title = next((t["frame"] for t in texts if t["label"] == label), None)
        inside = [r for r in (title, *(views.get(b) for b in buttons)) if r]
        if title and views.get(buttons[0]):
            holders = [r for _, _, r in nodes if all(contains(r, i) for i in inside)]
            bar = min(holders, key=lambda r: r["w"] * r["h"], default=None)
            break
    return {"platform": "android", "bar": bar, "texts": texts, "views": views}


def contains(outer, inner, slack=0.5):
    return (inner["x"] >= outer["x"] - slack and inner["y"] >= outer["y"] - slack
            and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + slack
            and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + slack)


def mid(r):
    return r["y"] + r["h"] / 2


# Each page whose header has buttons: its title, the buttons it always shows (each must be measured and sit on the
# title's line), and whether a connection banner sits under the header (the chats page always has one; a chat's shows
# only a problem).
PAGES = {
    "chats": ("Chats", ("new-chat", "more"), True),
    "chat": ("First chat", ("chat-more", "connection-dot", "activity"), False),
}


def judge(name, m):
    problems, views = [], m.get("views", {})
    page = name.split("-")[0]
    if "-menu-" in name:
        return ([] if "header-menu" in views else ["⋯ was pressed but its menu is not open"]), ""
    if "-new-" in name:
        return ([] if "quick-chat" in views else ["new chat was pressed but its sheet is not open"]), ""
    label, buttons, banner_required = PAGES[page]
    bar = m.get("bar")
    title = next((t["frame"] for t in m.get("texts", []) if t["label"] == label), None)
    if bar is None:
        problems.append("no header bar on screen")
    if title is None:
        problems.append(f'no "{label}" title in the header')
    # Every button the page has must be measured: one that is missing would otherwise pass unchecked.
    for b in buttons:
        if b not in views:
            problems.append(f"no {b} button measured")
    if problems:
        return problems, ""
    ty = mid(title)
    line = [f'"{label}" center y {ty:.1f}']
    banner = views.get("connection")
    if banner is None and banner_required:
        problems.append("no connection banner under the header")
    for b in buttons:
        r = views[b]
        line.append(f"{b} center y {mid(r):.1f}")
        if abs(mid(r) - ty) > TOLERANCE:
            problems.append(f"{b} center is {mid(r) - ty:+.1f} pt from the title's (more than {TOLERANCE:g})")
        if not contains(bar, r):
            problems.append(f"{b} {r} reaches out of the header bar {bar}")
        if banner is not None and r["y"] + r["h"] > banner["y"] + 0.5:
            problems.append(f"{b} bottom {r['y'] + r['h']:.1f} reaches the banner top {banner['y']:.1f}")
    if banner is not None:
        line.append(f"banner top {banner['y']:.1f}")
    return problems, ", ".join(line)


# Where the Android probe taps ⋯ on the chats page, besides the test's own press at its center: near the drawn
# button's edges and inside its 6 dp hit slop. Each is (label, where in the button as fractions, then an offset in dp)
# and must open the menu (`<marker>.taps.json`).
EDGE_TAPS = (
    ("2 dp inside the top", 0.5, 0, 0, 2),
    ("2 dp inside the bottom", 0.5, 1, 0, -2),
    ("4 dp below it, inside its hit slop", 0.5, 1, 0, 4),
    ("3 dp right of it, inside its hit slop", 1, 0.5, 3, 0),
)


def tap_points(xml, density):
    """`label<TAB>x<TAB>y` in pixels for each of EDGE_TAPS on ⋯ in this dump."""
    more = android(xml, density)["views"]["more"]
    for label, fx, fy, ox, oy in EDGE_TAPS:
        x, y = more["x"] + more["w"] * fx + ox, more["y"] + more["h"] * fy + oy
        print(f"{label}\t{round(x * density)}\t{round(y * density)}")


def main(folder):
    folder = Path(folder)
    density_file = folder / "density.txt"
    density = float(density_file.read_text().strip()) if density_file.exists() else 1.0
    expected = [f"chats{kind}-{s}-{c}" for kind in ("", "-menu", "-new") for s in STATES for c in SCHEMES]
    expected += [f"chat{kind}-online-{c}" for kind in ("", "-menu") for c in SCHEMES]
    failed = False
    for name in sorted(expected):
        js, xml = folder / f"{name}.json", folder / f"{name}.xml"
        if js.exists():
            m = json.loads(js.read_text())
        elif xml.exists():
            m = android(xml, density)
        else:
            print(f"FAIL {name}: not measured (the test did not reach it, or the probe did not see its marker)")
            failed = True
            continue
        problems, line = judge(name, m)
        if m["platform"] == "android" and name.startswith("chats-") and name.count("-") == 2:  # the chats page itself: the probe's edge taps
            taps_file = folder / f"{name}.taps.json"
            taps = json.loads(taps_file.read_text()) if taps_file.exists() else {}
            for label, *_ in EDGE_TAPS:
                if taps.get(label) is not True:
                    problems.append(f"a tap {label} of ⋯ did not open its menu" if label in taps else f"no tap {label}")
        print(f"{'FAIL' if problems else 'ok  '} {name}: {line}" + "".join(f"\n       {p}" for p in problems))
        failed |= bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    if sys.argv[1] == "taps":  # taps <dump.xml> <density>: the points the Android probe taps
        tap_points(sys.argv[2], float(sys.argv[3]))
    else:
        sys.exit(main(sys.argv[1]))
