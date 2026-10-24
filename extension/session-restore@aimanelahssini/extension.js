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
const PLACE_AGAIN_MS = 1200;    // apps like Firefox move their own window just after it appears
const TERMINAL_WAIT = 10;       // seconds to wait for a reopened terminal window before the next
const TITLE_TAIL = 512 * 1024;  // bytes at the end of a chat's transcript searched for its title
const TABS_WAIT = 10;           // seconds the tab reader may take
const TAB_WAIT = 5;             // seconds to wait for one reopened tab before the next
// Ptyxis adds the command to a tab's title, so a chat reopened by Restore names itself.
const RESUME = /\bclaude\b.*--resume[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
// A shell's own title is "user@host:folder".
const SHELL_TITLE = /^[^@\s]+@[^:\s]+:(.+)$/;

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

function ensureWorkspaces(count) {
    const wm = global.workspace_manager;
    while (wm.get_n_workspaces() < count)
        wm.append_new_workspace(false, global.get_current_time());
}

function placeWindow(w, g) {
    if (g.workspace >= 0) {
        ensureWorkspaces(g.workspace + 1);
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
    const seen = new Set();
    try {
        const en = Gio.File.new_for_path(CLAUDE_SESSIONS).enumerate_children('standard::name', 0, null);
        let info;
        while ((info = en.next_file(null))) {
            const name = info.get_name();
            if (!name.endsWith('.json'))
                continue;
            const s = readJson(GLib.build_filenamev([CLAUDE_SESSIONS, name]));
            if (!s?.sessionId || s.kind !== 'interactive' || seen.has(s.sessionId) ||
                !GLib.file_test(`/proc/${s.pid}`, GLib.FileTest.EXISTS))
                continue;
            seen.add(s.sessionId);
            chats.push({sessionId: s.sessionId, cwd: s.cwd || HOME});
        }
    } catch {}
    return chats;
}

// Claude Code titles its terminal "✳ <chat title>" (a spinner instead of ✳ while it works).
function bareTitle(title) {
    return (title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// Ptyxis adds " — claude" when Claude runs under a shell, as in chats reopened by Restore.
function showsTitle(windowTitle, title) {
    return !!title && (windowTitle === title || windowTitle.startsWith(`${title} — `));
}

// The folder a plain terminal tab was in, from its shell's title; home if unknown.
function tabFolder(title) {
    const m = bareTitle(title).replace(/ — .*/, '').match(SHELL_TITLE);
    const dir = m ? m[1].replace(/^~(?=\/|$)/, HOME) : HOME;
    return GLib.file_test(dir, GLib.FileTest.IS_DIR) ? dir : HOME;
}

// The ptyxis command for one saved tab: a new window for the first, then tabs in it.
function tabArgv(tab, first) {
    const cwd = GLib.file_test(tab.cwd ?? '', GLib.FileTest.IS_DIR) ? tab.cwd : HOME;
    const cmd = tab.sessionId && `claude --resume ${GLib.shell_quote(tab.sessionId)}; exec bash`;
    if (first)
        return ['ptyxis', '--new-window', '-d', cwd, ...cmd ? ['--', 'bash', '-lic', cmd] : []];
    return ['ptyxis', '--tab', '-d', cwd, ...cmd ? ['-x', `bash -lic ${GLib.shell_quote(cmd)}`] : []];
}

function transcriptFile(chat) {
    const dir = chat.cwd.replace(/[^A-Za-z0-9]/g, '-');
    return Gio.File.new_for_path(GLib.build_filenamev([HOME, '.claude', 'projects', dir, `${chat.sessionId}.jsonl`]));
}

// The chat's current title, read from the end of its transcript (Claude rewrites it often).
function readChatTitle(file, size) {
    try {
        const stream = file.read(null);
        stream.seek(Math.max(0, size - TITLE_TAIL), GLib.SeekType.SET, null);
        const parts = [];
        let bytes;
        while ((bytes = stream.read_bytes(65536, null)).get_size() > 0)
            parts.push(new TextDecoder().decode(bytes.toArray()));
        stream.close(null);
        const text = parts.join('');
        const last = key => [...text.matchAll(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].pop();
        const m = last('customTitle') ?? last('aiTitle');
        return m ? JSON.parse(`"${m[1]}"`) : null;
    } catch {
        return null;
    }
}

// Older snapshots: first (v1) only the terminal's windows, shared out to chats in order; then
// (v2) a window per chat plus plain terminals. Now (v3) terminal windows with their tabs.
function upgrade(snap) {
    if (snap.version >= 3)
        return snap;
    let apps = snap.apps || [], claude = snap.claude || [], plain = snap.terminals;
    if (!plain) {
        const term = apps.find(a => a.id === TERMINAL);
        const pool = [...term?.geometry ?? []];
        apps = apps.filter(a => a !== term);
        claude = claude.map(c => ({...c, geometry: pool.shift()}));
        plain = pool;
    }
    return {
        ...snap, version: 3, apps,
        claude: claude.map(({sessionId, cwd}) => ({sessionId, cwd})),
        terminals: [
            ...claude.map(({sessionId, cwd, geometry}) => ({geometry, tabs: [{sessionId, cwd}]})),
            ...plain.map(geometry => ({geometry, tabs: [{cwd: HOME}]})),
        ],
    };
}

export default class SessionRestoreExtension extends Extension {
    enable() {
        this._appSystem = Shell.AppSystem.get_default();
        this._session = sessionKey();
        this._enabledAt = GLib.get_monotonic_time();
        this._titles = new Map();   // sessionId -> {size, title} of its transcript

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
            this._save().catch(logError);
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
            this._save().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _save() {
        if (this._saving)
            return;
        this._saving = true;
        try {
            const terminal = this._appSystem.lookup_app(TERMINAL);
            const frames = terminal && normalWindows(terminal).length ? await this._readTabs() : [];
            if (!this._appSystem)
                return;     // disabled meanwhile
            const apps = this._appSystem.get_running()
                .filter(a => a.get_id()?.endsWith('.desktop') && a.get_id() !== TERMINAL)
                .map(a => ({id: a.get_id(), geometry: normalWindows(a).map(windowGeometry)}))
                .filter(a => a.geometry.length > 0)
                .map(a => ({...a, windows: a.geometry.length}));
            const {claude, terminals} = this._terminalLayout(frames);
            if (!apps.length && !claude.length && !terminals.length)
                return;     // never replace a good snapshot with an empty desktop
            GLib.mkdir_with_parents(STATE_DIR, 0o700);
            const workspaces = global.workspace_manager.get_n_workspaces();
            const data = {version: 3, session: this._session, savedAt: Date.now(), workspaces, apps, claude, terminals};
            GLib.file_set_contents(SNAPSHOT, JSON.stringify(data, null, 1));
        } finally {
            this._saving = false;
        }
    }

    // Ptyxis's windows and their tabs, from ptyxis-tabs.py; null if it can't tell.
    _readTabs() {
        return new Promise(resolve => {
            let proc, timeoutId;
            try {
                proc = Gio.Subprocess.new(['python3', '-I', GLib.build_filenamev([this.path, 'ptyxis-tabs.py'])],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            } catch {
                resolve(null);
                return;
            }
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TABS_WAIT, () => {
                timeoutId = null;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, null, (p, res) => {
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    resolve(p.get_successful() ? JSON.parse(out) : null);
                } catch {
                    resolve(null);
                }
            });
        });
    }

    // Every terminal window with its tabs in order. Ptyxis's view of a window is matched to
    // GNOME's by title; without it a window counts as one tab. A tab holds a Claude chat if
    // its title names the chat ("claude --resume ID") or shows the chat's title; leftover
    // chats take tabs that run claude, then get a window of their own. Other tabs are plain
    // terminals, kept with their folder.
    _terminalLayout(frames) {
        const app = this._appSystem.lookup_app(TERMINAL);
        const pool = [...frames ?? []];
        const windows = (app ? normalWindows(app) : []).map(w => {
            const title = (w.get_title() || '').trim();
            const i = pool.findIndex(f => f.title.trim() === title);
            const tabs = i >= 0 ? pool.splice(i, 1)[0].tabs : [title];
            return {geometry: windowGeometry(w), tabs: tabs.map(t => ({title: t.trim()}))};
        });
        const tabs = windows.flatMap(w => w.tabs);
        const chats = claudeChats();
        const byId = new Map(chats.map(c => [c.sessionId, c]));
        for (const tab of tabs) {
            const chat = byId.get(tab.title.match(RESUME)?.[1]);
            if (chat && !chat.placed)
                [tab.chat, chat.placed] = [chat, true];
        }
        const titles = tabs.map(t => bareTitle(t.title));
        for (const chat of chats.filter(c => !c.placed)) {
            const title = this._chatTitle(chat, titles);
            const tab = tabs.find(t => !t.chat && showsTitle(bareTitle(t.title), title));
            if (tab)
                [tab.chat, chat.placed] = [chat, true];
        }
        for (const chat of chats.filter(c => !c.placed)) {
            const tab = tabs.find(t => !t.chat && / — claude\b/.test(t.title));
            if (tab)
                [tab.chat, chat.placed] = [chat, true];
        }
        const saved = t => (t.chat ? {sessionId: t.chat.sessionId, cwd: t.chat.cwd} : {cwd: tabFolder(t.title)});
        return {
            claude: chats.map(({sessionId, cwd}) => ({sessionId, cwd})),
            terminals: [
                ...windows.map(w => ({geometry: w.geometry, tabs: w.tabs.map(saved)})),
                ...chats.filter(c => !c.placed).map(({sessionId, cwd}) => ({tabs: [{sessionId, cwd}]})),
            ],
        };
    }

    // Cached; the transcript is only read again when no tab shows the known title and the
    // transcript has grown since.
    _chatTitle(chat, titles) {
        const cached = this._titles.get(chat.sessionId);
        if (titles.some(t => showsTitle(t, cached?.title)))
            return cached.title;
        const file = transcriptFile(chat);
        let size = -1;
        try {
            size = file.query_info('standard::size', 0, null).get_size();
        } catch {}
        if (cached?.size === size)
            return cached.title;
        const title = size > 0 ? readChatTitle(file, size) : null;
        this._titles.set(chat.sessionId, {size, title});
        return title;
    }

    // What Restore would open right now: apps that aren't running yet, and terminal windows
    // with the tabs whose Claude chats aren't open, plus plain tabs if no terminal is open yet.
    _plan(snap) {
        snap = upgrade(snap);
        const open = new Set(claudeChats().map(c => c.sessionId));
        const plainToo = this._appSystem.lookup_app(TERMINAL)?.state === Shell.AppState.STOPPED;
        const terminals = [];
        for (const w of snap.terminals) {
            // (adding each chat to `open` also drops duplicates)
            const tabs = w.tabs.filter(t => (t.sessionId ? !open.has(t.sessionId) && open.add(t.sessionId) : plainToo));
            if (tabs.length)
                terminals.push({...w, tabs});
        }
        const apps = (snap.apps || []).filter(a => {
            const app = this._appSystem.lookup_app(a.id);
            return app && app.state === Shell.AppState.STOPPED;
        });
        return {apps, terminals};
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
        const {apps, terminals} = this._plan(snap);
        // Windows, as you'll see them: an app's windows, and each terminal window once
        // however many tabs it has.
        const n = apps.reduce((sum, a) => sum + (a.geometry?.length || 1), 0) + terminals.length;
        log(`restore offers ${n}: ${[...apps.map(a => a.id),
            ...terminals.map(w => `[${w.tabs.map(t => (t.sessionId ? `claude ${t.sessionId.slice(0, 8)}` : 'terminal')).join(', ')}]`)].join(', ')}`);
        if (n === 0) {
            GLib.unlink(PENDING);
            return;
        }
        this._button = new PanelMenu.Button(0.0, 'Session Restore', true);
        const btn = new St.Button({style_class: 'session-restore-btn',
            label: `↻ Restore ${n} ${n === 1 ? 'window' : 'windows'}`, y_align: Clutter.ActorAlign.CENTER});
        btn.connect('clicked', () => this._restore());
        // Small × beside the pill: skip restoring for this login.
        const close = new St.Button({style_class: 'session-restore-close', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 10})});
        close.connect('clicked', () => {
            log('restore declined');
            this._dismiss();
        });
        const box = new St.BoxLayout({style_class: 'session-restore-box'});
        box.add_child(btn);
        box.add_child(close);
        this._button.add_child(box);
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
    // were, in the order they open. Terminals open one at a time (see _nextTerminal), so
    // each one goes to the place of the chat or terminal it was opened for.
    _startPlacing(apps) {
        this._pending = new Map(apps.filter(a => a.geometry?.length)
            .map(a => [a.id, [...a.geometry]]));
        const tracker = Shell.WindowTracker.get_default();
        this._createdId = global.display.connect('window-created', (d, w) => {
            // A new window starts out as "window:N"; its app is known a moment later.
            let tries = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (!this._createdId || !w.get_compositor_private())
                    return GLib.SOURCE_REMOVE;
                const id = tracker.get_window_app(w)?.get_id();
                if (!id?.endsWith('.desktop'))
                    return ++tries < 33 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
                this._place(w, id);
                return GLib.SOURCE_REMOVE;
            });
        });
        this._armPlaceTimeout();
    }

    _armPlaceTimeout() {
        if (this._placeTimeout)
            GLib.source_remove(this._placeTimeout);
        this._placeTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PLACE_WINDOW, () => {
            this._placeTimeout = null;
            this._stopPlacing();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Opens the next terminal window once the previous one has appeared with its tabs.
    _nextTerminal() {
        if (this._termTimeout)
            GLib.source_remove(this._termTimeout);
        this._termTimeout = null;
        this._termJob = this._termJobs?.shift() ?? null;
        if (!this._termJob)
            return;
        this._armPlaceTimeout();
        try {
            Gio.Subprocess.new(this._termJob.argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('Session restore', `Could not open a terminal: ${e.message}`);
            this._nextTerminal();
            return;
        }
        this._termTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TERMINAL_WAIT, () => {
            this._termTimeout = null;
            log('a terminal window didn\'t appear in time; opening the next one');
            this._nextTerminal();
            return GLib.SOURCE_REMOVE;
        });
    }

    _place(w, id) {
        if (w.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        if (id === TERMINAL && this._termJob) {
            const job = this._termJob;
            this._termJob = null;
            if (this._termTimeout)
                GLib.source_remove(this._termTimeout);
            this._termTimeout = null;
            // Tabs first, while this is still Ptyxis's newest window: "--tab" opens in the
            // active one, and moving a window to another desktop hands focus to another.
            this._openTabs(job.tabs).then(() => {
                if (job.geometry)
                    this._placeAt(w, id, job.geometry);
                this._nextTerminal();
            });
            return;
        }
        const g = this._pending?.get(id)?.shift();
        if (g)
            this._placeAt(w, id, g);
    }

    // Runs each "ptyxis --tab" in turn, so the tabs keep their order.
    async _openTabs(argvs) {
        for (const argv of argvs) {
            await new Promise(resolve => {
                const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TAB_WAIT, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
                try {
                    Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE).wait_async(null, () => {
                        GLib.source_remove(timeoutId);
                        resolve();
                    });
                } catch (e) {
                    log(`could not open a tab: ${e.message}`);
                    GLib.source_remove(timeoutId);
                    resolve();
                }
            });
        }
    }

    _placeAt(w, id, g) {
        placeWindow(w, g);
        log(`placed ${id} on desktop ${g.workspace + 1} at ${g.x},${g.y} ${g.width}x${g.height}` +
            `${g.maximized ? ' (maximized)' : ''}`);
        // A window that opens without focus asks for attention, which GNOME shows as a
        // "… is ready" notification that stays until you visit it. Restored windows aren't news.
        // (After an idle: Mutter notifies before GNOME creates the notification, and
        // clearing it then would leave the notification behind.)
        const quiet = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (w.get_compositor_private() && w.demands_attention)
                w.unset_demands_attention();
            return GLib.SOURCE_REMOVE;
        });
        quiet();
        const quietId = w.connect('notify::demands-attention', quiet);
        // Once more shortly after, in case the app repositions itself on startup.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACE_AGAIN_MS, () => {
            if (!w.get_compositor_private())
                return GLib.SOURCE_REMOVE;  // window already closed
            w.disconnect(quietId);
            const r = w.get_frame_rect();
            const wrongDesk = g.workspace >= 0 && w.get_workspace()?.index() !== g.workspace;
            const moved = !g.maximized && !g.fullscreen && (r.x !== g.x || r.y !== g.y ||
                r.width !== g.width || r.height !== g.height);
            if (wrongDesk || moved) {
                placeWindow(w, g);
                log(`re-placed ${id} (the app had moved it)`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPlacing() {
        if (this._createdId)
            global.display.disconnect(this._createdId);
        for (const id of [this._placeTimeout, this._termTimeout])
            if (id)
                GLib.source_remove(id);
        this._createdId = this._placeTimeout = this._termTimeout = null;
        this._pending = this._termJobs = this._termJob = null;
    }

    _restore() {
        this._restoring = true;
        const snap = this._snap;
        const {apps, terminals} = this._plan(snap);
        log(`restoring ${apps.length} app(s) and ${terminals.length} terminal window(s) with ` +
            `${terminals.flatMap(w => w.tabs).length} tab(s) on ${snap.workspaces ?? '?'} desktop(s)`);
        if (snap.workspaces)
            ensureWorkspaces(snap.workspaces);
        this._startPlacing(upgrade(snap).apps || []);
        for (const {id} of apps)
            this._appSystem.lookup_app(id)?.activate();
        this._termJobs = terminals.map(({geometry, tabs}) => ({
            geometry,
            argv: tabArgv(tabs[0], true),
            tabs: tabs.slice(1).map(t => tabArgv(t, false)),
        }));
        this._nextTerminal();
        this._dismiss();
    }
}
