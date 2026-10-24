#!/bin/bash
# Saves and restores terminal windows with tabs (fake Claude chats and plain shells) in a
# throwaway headless GNOME Shell. Settings go to a keyfile in a temp folder, never to the real dconf.
#   tests/shell/run.sh [OUT_DIR]     results.txt and shell.log land in OUT_DIR
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UUID=session-restore@aimanelahssini
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT   # also when a run is stopped early
OUT="$(mkdir -p "${1:-$T/out}" && cd "${1:-$T/out}" && pwd)"
mkdir -p "$T"/{home/titles,bin,config/glib-2.0/settings,data/gnome-shell/extensions,state,cache,rt}
chmod 700 "$T/rt"
cp -r "$REPO/extension/$UUID" "$HERE/sr-test@tests" "$T/data/gnome-shell/extensions/"
cp "$HERE/fake-claude" "$T/bin/claude"
cp "$HERE/fake-systemd-run" "$T/bin/systemd-run"

# Titles the fake chats give their terminals (Beta shows Claude's busy spinner), and
# transcripts holding those titles. Gamma was renamed and its title sits behind 700 KB.
H="$T/home"
P="$H/.claude/projects/$(echo -n "$H" | sed 's/[^A-Za-z0-9]/-/g')"
A=aaaaaaaa-0000-4000-8000-00000000000a B=bbbbbbbb-0000-4000-8000-00000000000b G=cccccccc-0000-4000-8000-00000000000c
mkdir -p "$P" "$H/work" "$H/notes"
echo '✳ Alpha chat' > "$H/titles/$A"
echo '⠐ Beta chat' > "$H/titles/$B"
echo '✳ Gamma renamed' > "$H/titles/$G"
echo "{\"type\":\"ai-title\",\"aiTitle\":\"Alpha chat\",\"sessionId\":\"$A\"}" > "$P/$A.jsonl"
echo "{\"type\":\"ai-title\",\"aiTitle\":\"Beta chat\",\"sessionId\":\"$B\"}" > "$P/$B.jsonl"
{
    echo "{\"type\":\"ai-title\",\"aiTitle\":\"Gamma old\",\"sessionId\":\"$G\"}"
    python3 -c 'print(("{\"type\":\"user\",\"text\":\"" + "x" * 1000 + "\"}\n") * 700, end="")'
    echo "{\"type\":\"custom-title\",\"customTitle\":\"Gamma renamed\",\"sessionId\":\"$G\"}"
    echo "{\"type\":\"ai-title\",\"aiTitle\":\"Gamma newer\",\"sessionId\":\"$G\"}"
} > "$P/$G.jsonl"
# Plain shells title their tab "user@host:folder", as on a normal Fedora login.
echo '. ~/.bashrc' > "$H/.bash_profile"
echo '. /etc/bashrc' > "$H/.bashrc"

cat > "$T/config/glib-2.0/settings/keyfile" <<KEYS
[org/gnome/shell]
enabled-extensions=['$UUID', 'sr-test@tests']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/mutter]
dynamic-workspaces=false

[org/gnome/desktop/wm/preferences]
num-workspaces=4

[org/gnome/Ptyxis]
restore-session=false
KEYS
dconf dump / > "$T/dconf-before.txt"
env -u WAYLAND_DISPLAY -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
    HOME="$H" PATH="$T/bin:$PATH" XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_STATE_HOME="$T/state" \
    XDG_CACHE_HOME="$T/cache" XDG_RUNTIME_DIR="$T/rt" GSETTINGS_BACKEND=keyfile TEST_OUT="$OUT" \
    dbus-run-session -- bash -c '/usr/libexec/at-spi-bus-launcher --launch-immediately & sleep 1; /usr/libexec/at-spi2-registryd & exec timeout 180 gnome-shell --headless --wayland --virtual-monitor 1440x900' \
    > "$OUT/shell.log" 2>&1 || true
dconf dump / > "$T/dconf-after.txt"
if diff -q "$T/dconf-before.txt" "$T/dconf-after.txt" > /dev/null; then
    echo "real dconf: unchanged"
else
    # The test writes only to its keyfile; changes here are usually your own apps meanwhile.
    echo "REAL DCONF CHANGED during the run:"
    diff "$T/dconf-before.txt" "$T/dconf-after.txt" | grep '^[<>]' | sed 's/^/  /'
fi
grep -E 'JS ERROR|TypeError|ReferenceError|SyntaxError' "$OUT/shell.log" | head -5 || true
grep 'session-restore:' "$OUT/shell.log" | sed 's/.*session-restore: /  log: /' || true
cat "$OUT/results.txt" 2>/dev/null
rm -rf "$T"
