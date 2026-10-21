#!/bin/bash
# Install the Session Restore GNOME Shell extension.
#   git clone https://github.com/aimanelahssini/gnome-session-restore && cd gnome-session-restore && ./install.sh
set -e
cd "$(dirname "$0")"
UUID=session-restore@aimanelahssini

mkdir -p ~/.local/share/gnome-shell/extensions
rm -rf ~/.local/share/gnome-shell/extensions/$UUID
cp -r extension/$UUID ~/.local/share/gnome-shell/extensions/
gnome-extensions enable $UUID 2>/dev/null || python3 - "$UUID" <<'PY'
import ast, subprocess, sys
cur = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True)
l = ast.literal_eval(cur.replace('@as ', ''))
if sys.argv[1] not in l:
    l.append(sys.argv[1])
subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(l)], check=True)
PY
echo "Installed. Log out and back in once so GNOME loads it."
