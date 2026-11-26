#!/usr/bin/env python3
"""Judges the header measurements of one device run of src/header.test.tsx (tools/header-check.sh).

Each marker the test left in the folder, `<page>-<connection>-<scheme>.png`, has its measurement beside it: `.json`
from the iOS probe (ios/DSHUITests/HeaderProbe.swift, frames in points) or `.xml` from `uiautomator dump` on Android
(bounds in pixels, divided by `density` in `density.txt`). On each page in PAGES the title and the centers of its
header buttons are on one line (1 pt at most apart), the buttons are inside the bar, and none reaches the connection
banner under it. A `-menu` marker has the ⋯ menu open and a `-new` marker the new chat sheet: a press that did nothing
fails. On Android each chats-page marker also has `<marker>.taps.json`, where the probe tapped ⋯ near its edges and
inside its hit slop (`taps`): each tap must have opened the menu; and each `menu-again-<scheme>` marker, where the
menu is open, has `<marker>.double.json` and `<marker>.double.xml` from two quick taps on ⋯: both `input` calls exit
0, and the app's trace (`menu-trace`) in the dump after them, past what the marker's dump had, shows two presses in order,
under 300 ms apart, the menu closed and then open, and the menu itself is in that dump. Prints one line
per marker with the measured y values; exits 1 on any failure. An Android dump with no view of the app, or with a
system "isn't responding" dialog over it, fails with what it shows ("environment: ..."), not "no header bar".
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


# The app `nsh test --target android` runs (nsh-cli test_android.rs).
APP_PACKAGE = "com.longbridge.nsh.host"
# Android's own "isn't responding" dialog: its title and buttons belong to the system (package "android"), so an
# app's text that happens to say "isn't responding" is not one.
ANR = re.compile(r"isn.t responding")
# The only ANRs the probe clears, and only before the test starts: the launcher's or System UI's.
CLEARABLE = re.compile(r"^(Pixel Launcher|Launcher3?|System UI) isn.t responding$")


def system_anr(nodes):
    """The title of a system "isn't responding" dialog in a dump's nodes, or None."""
    return next((n.get("text") for n in nodes if n.get("package") == "android"
                 and n.get("resource-id") == "android:id/alertTitle" and ANR.search(n.get("text") or "")), None)


def environment(xml):
    """What the dump shows besides the app: None when the app's views are there and no system ANR dialog is.
    An observation for the reader; it does not say why (the runner, the app or the test)."""
    nodes = list(ET.parse(xml).iter("node"))
    anr = system_anr(nodes)
    if any(n.get("package") == APP_PACKAGE for n in nodes):
        return f'environment: a system dialog "{anr}" is on screen over the app' if anr else None
    shown = sorted({n.get("package") for n in nodes if n.get("package")})
    return (f"environment: no view of {APP_PACKAGE} on screen; "
            + (f'a system dialog "{anr}" is' if anr else f"the dump shows {', '.join(shown) or 'nothing'}"))


def anr_button(xml):
    """Pixel center of Wait on a launcher or System UI "isn't responding" dialog, or None for anything else."""
    nodes = list(ET.parse(xml).iter("node"))
    if not CLEARABLE.match(system_anr(nodes) or ""):
        return None
    n = next((n for n in nodes if n.get("package") == "android" and n.get("resource-id") == "android:id/aerr_wait"), None)
    m = n is not None and re.match(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", n.get("bounds", ""))
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


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
    return {"platform": "android", "bar": bar, "texts": texts, "views": views, "environment": environment(path)}


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
    if m.get("environment") and "no view of" in m["environment"]:  # nothing of the app to judge
        return [m["environment"]], ""
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


def center(xml, density):
    """`x y` in pixels of ⋯'s center in this dump."""
    more = android(xml, density)["views"]["more"]
    print(round((more["x"] + more["w"] / 2) * density), round((more["y"] + more["h"] / 2) * density))


def trace(xml):
    """The app's `menu-trace` in a dump (App.tsx): [(what, ms)], or None without one."""
    if not xml.exists() or not xml.stat().st_size:
        return None
    node = next((n for n in ET.parse(xml).iter("node") if n.get("resource-id") == "menu-trace"), None)
    if node is None:
        return None
    return [(w, int(t)) for w, t in (item.split("@") for item in (node.get("text") or "").split())]


def double_tap(folder, name):
    """What is wrong with the probe's double tap at the `name` marker, or nothing."""
    js = folder / f"{name}.double.json"
    marker = folder / f"{name}.xml"
    seen = environment(marker) if marker.exists() else None
    if seen:  # the probe sends no taps onto a covered screen (tools/header-check.sh)
        return [f"{seen}; no taps sent"]
    if not js.exists():
        return ["not measured"]
    after_xml = folder / f"{name}.double.xml"
    seen = environment(after_xml) if after_xml.exists() else None
    if seen:
        return [f"after the taps: {seen}"]
    exits = json.loads(js.read_text()).get("exits")
    before, after = trace(folder / f"{name}.xml"), trace(folder / f"{name}.double.xml")
    if exits != [0, 0]:
        return [f"the two `input tap` calls exited {exits}"]
    if before is None or after is None:
        return ["no menu trace in the dump " + ("before" if before is None else "after") + " the taps"]
    new = after[len(before):]
    presses = [t for w, t in new if w == "press"]
    states = [w for w, _ in new if w in ("open", "closed")]
    problems = []
    if len(presses) != 2:
        problems.append(f"{len(presses)} presses on ⋯ delivered, not 2")
    elif not 0 <= presses[1] - presses[0] < 300:
        problems.append(f"the presses came {presses[1] - presses[0]} ms apart, not 0 to under 300")
    if states != ["closed", "open"]:
        problems.append(f"the menu went {states or 'nowhere'}, not closed and then open")
    if not any(n.get("resource-id") == "header-menu" for n in ET.parse(folder / f"{name}.double.xml").iter("node")):
        problems.append("the dump after the taps has no menu")
    return [p + f" (trace {' '.join(f'{w}@{t}' for w, t in new)})" for p in problems]


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
        if m.get("environment") and m["environment"] not in problems:  # a system dialog over the app fails it too
            problems.append(m["environment"])
        if m["platform"] == "android" and not m.get("environment") and name.startswith("chats-") and name.count("-") == 2:  # the chats page itself: the probe's edge taps
            taps_file = folder / f"{name}.taps.json"
            taps = json.loads(taps_file.read_text()) if taps_file.exists() else {}
            for label, *_ in EDGE_TAPS:
                if taps.get(label) is not True:
                    problems.append(f"a tap {label} of ⋯ did not open its menu" if label in taps else f"no tap {label}")
        print(f"{'FAIL' if problems else 'ok  '} {name}: {line}" + "".join(f"\n       {p}" for p in problems))
        failed |= bool(problems)
    if density_file.exists():  # Android: the probe's double taps on an open menu
        for scheme in SCHEMES:
            problems = double_tap(folder, f"menu-again-{scheme}")
            print(f"{'FAIL' if problems else 'ok  '} menu-again-{scheme}: two quick taps on ⋯ with its menu open"
                  + "".join(f"\n       {p}" for p in problems))
            failed |= bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    if sys.argv[1] == "taps":  # taps <dump.xml> <density>: the points the Android probe taps
        tap_points(sys.argv[2], float(sys.argv[3]))
    elif sys.argv[1] == "center":  # center <dump.xml> <density>: where the Android probe double-taps ⋯
        center(sys.argv[2], float(sys.argv[3]))
    elif sys.argv[1] == "covered":  # covered <dump.xml>: what covers the app or replaces it; nothing when neither
        print(environment(sys.argv[2]) or "")
    elif sys.argv[1] == "anr":  # anr <dump.xml>: "x y" (pixels) or "back" to dismiss an ANR dialog; nothing without one
        button = anr_button(sys.argv[2])
        if button:
            print(f"{button[0]} {button[1]}")
    else:
        sys.exit(main(sys.argv[1]))
