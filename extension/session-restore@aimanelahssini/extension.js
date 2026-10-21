import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HOME = GLib.get_home_dir();
const STATE_DIR = GLib.build_filenamev([HOME, '.local', 'state', 'session-restore']);
const SNAPSHOT = GLib.build_filenamev([STATE_DIR, 'snapshot.json']);
// The previous login's snapshot, set aside for this login until Restore is clicked or the
// button times out, so a later save, lock/unlock or extension reload can't lose it.
const PENDING = GLib.build_filenamev([STATE_DIR, 'pending.json']);
const CLAUDE_SESSIONS = GLib.build_filenamev([HOME, '.claude', 'sessions']);
const TERMINAL = 'org.gnome.Ptyxis.desktop';
const SAVE_DEBOUNCE = 15;       // seconds a change must settle before saving
const SAVE_PERIOD = 60;         // also save this often (catches new Claude chats)
const HIDE_AFTER = 180;         // button lifetime once you start opening apps
const LOGIN_GRACE = 10;         // ignore autostart apps right after login
const PLACE_WINDOW = 120;       // seconds after Restore during which new windows get placed

function readJson(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
        return null;
    }
}

function log(msg) {
    console.log(`session-restore: ${msg}`);
}

// Unique per login: pids repeat across boots, the boot id doesn't.
function sessionKey() {
    let boot = '';
    try {
        boot = new TextDecoder().decode(GLib.file_get_contents('/proc/sys/kernel/random/boot_id')[1]).trim();
    } catch {}
    return `${boot}:${new Gio.Credentials().get_unix_pid()}`;
}

function normalWindows(app) {
    return app.get_windows()
        .filter(w => w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar())
        .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
}

function windowGeometry(w) {
    const r = w.get_frame_rect();
    return {
        x: r.x, y: r.y, width: r.width, height: r.height,
        maximized: w.is_maximized(),
        fullscreen: w.is_fullscreen(),
        minimized: w.minimized,
        workspace: w.is_on_all_workspaces() ? -1 : w.get_workspace()?.index() ?? 0,
    };
}

function placeWindow(w, g) {
    const wm = global.workspace_manager;
    if (g.workspace >= 0) {
        while (wm.get_n_workspaces() <= g.workspace)
            wm.append_new_workspace(false, global.get_current_time());
        w.change_workspace_by_index(g.workspace, false);
    }
    if (w.is_maximized())
        w.unmaximize();
    w.move_resize_frame(true, g.x, g.y, g.width, g.height);
    if (g.maximized)
        w.maximize();
    if (g.fullscreen)
        w.make_fullscreen();
    if (g.minimized)
        w.minimize();
}

function claudeChats() {
    const chats = [];
    try {
        const en = Gio.File.new_for_path(CLAUDE_SESSIONS).enumerate_children('standard::name', 0, null);
        let info;
        while ((info = en.next_file(null))) {
            const name = info.get_name();
            if (!name.endsWith('.json'))
                continue;
            const s = readJson(GLib.build_filenamev([CLAUDE_SESSIONS, name]));
            if (!s?.sessionId || s.kind !== 'interactive' ||
                !GLib.file_test(`/proc/${s.pid}`, GLib.FileTest.EXISTS))
                continue;
            chats.push({sessionId: s.sessionId, cwd: s.cwd || HOME});
        }
    } catch {}
    return chats;
}

export default class SessionRestoreExtension extends Extension {
    enable() {
        this._appSystem = Shell.AppSystem.get_default();
        this._session = sessionKey();
        this._enabledAt = GLib.get_monotonic_time();

        // Before saving anything, set the previous login's snapshot aside for this login.
        let pending = readJson(PENDING);
        if (pending?.session !== this._session) {
            const snap = readJson(SNAPSHOT);
            pending = snap && snap.session !== this._session ? {session: this._session, snap} : null;
            if (pending) {
                GLib.mkdir_with_parents(STATE_DIR, 0o700);
                GLib.file_set_contents(PENDING, JSON.stringify(pending));
                log(`new login; snapshot from ${new Date(snap.savedAt).toISOString()} set aside`);
            } else {
                GLib.unlink(PENDING);
            }
        }
        if (pending)
            this._showButton(pending.snap);

        this._stateId = this._appSystem.connect('app-state-changed', (sys, app) => {
            this._scheduleSave();
            if (app.state === Shell.AppState.STARTING || app.state === Shell.AppState.RUNNING)
                this._onAppOpened();
        });
        this._periodId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAVE_PERIOD, () => {
            this._save();
            return GLib.SOURCE_CONTINUE;
        });
        this._scheduleSave();
    }

    disable() {
        this._appSystem?.disconnect(this._stateId);
        this._stopPlacing();
        for (const id of [this._periodId, this._debounceId, this._hideId])
            if (id)
                GLib.source_remove(id);
        this._periodId = this._debounceId = this._hideId = null;
        this._button?.destroy();
        this._button = null;
        this._appSystem = null;
    }

    _scheduleSave() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAVE_DEBOUNCE, () => {
            this._debounceId = null;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        const apps = this._appSystem.get_running()
            .filter(a => a.get_id()?.endsWith('.desktop'))
            .map(a => ({id: a.get_id(), geometry: normalWindows(a).map(windowGeometry)}))
            .filter(a => a.geometry.length > 0)
            .map(a => ({...a, windows: a.geometry.length}));
        const claude = claudeChats();
        if (!apps.length && !claude.length)
            return;     // never replace a good snapshot with an empty desktop
        GLib.mkdir_with_parents(STATE_DIR, 0o700);
        const data = {session: this._session, savedAt: Date.now(), apps, claude};
        GLib.file_set_contents(SNAPSHOT, JSON.stringify(data, null, 1));
    }

    // What Restore would open right now: apps that aren't running yet, and Claude chats that
    // aren't open. Terminal windows that held chats come back with those chats, so they
    // aren't opened (or counted) a second time.
    _plan(snap) {
        const open = new Set(claudeChats().map(c => c.sessionId));
        const allChats = snap.claude || [];
        const chats = allChats.filter(c => !open.has(c.sessionId));
        const apps = (snap.apps || []).filter(a => {
            if (a.id === TERMINAL && a.windows <= allChats.length)
                return false;
            const app = this._appSystem.lookup_app(a.id);
            return app && app.state === Shell.AppState.STOPPED;
        });
        return {apps, chats};
    }

    _dismiss() {
        GLib.unlink(PENDING);
        this._button?.destroy();
        this._button = null;
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = null;
    }

    _showButton(snap) {
        this._snap = snap;
        const {apps, chats} = this._plan(snap);
        const n = apps.length + chats.length;
        log(`restore offers ${n}: ${[...apps.map(a => a.id), ...chats.map(c => `claude ${c.sessionId.slice(0, 8)}`)].join(', ')}`);
        if (n === 0) {
            GLib.unlink(PENDING);
            return;
        }
        this._button = new PanelMenu.Button(0.0, 'Session Restore', true);
        const btn = new St.Button({style_class: 'session-restore-btn',
            label: `↻ Restore ${n} ${n === 1 ? 'app' : 'apps'}`, y_align: Clutter.ActorAlign.CENTER});
        btn.connect('clicked', () => this._restore());
        this._button.add_child(btn);
        Main.panel.addToStatusArea(`${this.uuid}-btn`, this._button, 1, 'left');
    }

    _onAppOpened() {
        if (!this._button || this._hideId || this._restoring)
            return;
        if (GLib.get_monotonic_time() - this._enabledAt < LOGIN_GRACE * 1e6)
            return;
        this._hideId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HIDE_AFTER, () => {
            this._hideId = null;
            log('button timed out');
            this._dismiss();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Windows that appear after Restore are moved back to where the same app's windows
    // were, in the order they open.
    _startPlacing(apps) {
        this._pending = new Map(apps.filter(a => a.geometry?.length)
            .map(a => [a.id, [...a.geometry]]));
        if (!this._pending.size)
            return;
        const tracker = Shell.WindowTracker.get_default();
        this._createdId = global.display.connect('window-created', (d, w) => {
            const actor = w.get_compositor_private();
            const place = () => {
                const id = tracker.get_window_app(w)?.get_id();
                const queue = this._pending?.get(id);
                if (w.get_window_type() !== Meta.WindowType.NORMAL || !queue?.length)
                    return;
                placeWindow(w, queue.shift());
            };
            if (actor)
                actor.connect('first-frame', place);
            else
                place();
        });
        this._placeTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PLACE_WINDOW, () => {
            this._placeTimeout = null;
            this._stopPlacing();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPlacing() {
        if (this._createdId)
            global.display.disconnect(this._createdId);
        if (this._placeTimeout)
            GLib.source_remove(this._placeTimeout);
        this._createdId = this._placeTimeout = null;
        this._pending = null;
    }

    _restore() {
        this._restoring = true;
        const snap = this._snap;
        const {apps, chats} = this._plan(snap);
        log(`restoring ${apps.length} app(s) and ${chats.length} chat(s)`);
        this._startPlacing(snap.apps || []);
        for (const {id} of apps)
            this._appSystem.lookup_app(id)?.activate();
        for (const {sessionId, cwd} of chats) {
            const cmd = `claude --resume ${GLib.shell_quote(sessionId)}; exec bash`;
            try {
                Gio.Subprocess.new(['ptyxis', '--new-window', '-d', cwd, '--', 'bash', '-lic', cmd],
                    Gio.SubprocessFlags.NONE);
            } catch (e) {
                Main.notify('Session restore', `Could not reopen Claude chat: ${e.message}`);
            }
        }
        this._dismiss();
    }
}
