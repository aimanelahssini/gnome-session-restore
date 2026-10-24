#!/usr/bin/python3
"""Prints Ptyxis's windows and their tabs, in order, as JSON:
    [{"title": "<window title>", "tabs": ["<tab title>", ...]}, ...]
GNOME Shell only sees windows, so the tabs are read from the accessibility tree. A window
with a single tab has no tab bar; its one tab is the window title."""
import json

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

Atspi.set_timeout(2000, 5000)


def find(node, role, depth=0):
    """Descendants with this role, in order (not looking inside them or terminals)."""
    out = []
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if not child:
            continue
        r = child.get_role()
        if r == role:
            out.append(child)
        elif r != Atspi.Role.TERMINAL and depth < 40:
            out += find(child, role, depth + 1)
    return out


windows = []
desktop = Atspi.get_desktop(0)
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    if not app or app.get_name() != 'ptyxis':
        continue
    for j in range(app.get_child_count()):
        frame = app.get_child_at_index(j)
        if not frame or frame.get_role() != Atspi.Role.FRAME:
            continue
        # The tab bar; Ptyxis also has an (empty until opened) tab overview list.
        lists = [[t.get_name() for t in find(tl, Atspi.Role.PAGE_TAB)]
                 for tl in find(frame, Atspi.Role.PAGE_TAB_LIST)]
        tabs = max(lists, key=len, default=[])
        windows.append({'title': frame.get_name(), 'tabs': tabs or [frame.get_name()]})
print(json.dumps(windows))
