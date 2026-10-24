// Test driver: opens fake Claude chats and a plain terminal, spreads them over desktops in
// a different order than they opened, saves, closes them, fakes a new login, restores, and
// checks that every window is back on its own desktop. Results go to $TEST_OUT/results.txt.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('TEST_OUT');
const HOME = GLib.get_home_dir();
const SNAPSHOT = `${HOME}/.local/state/session-restore/snapshot.json`;
// Opened in this order; each title's window is then put on [desktop, x, y].
const CHATS = [['gamma-id', 'Gamma renamed'], ['alpha-id', 'Alpha chat'], ['beta-id', 'Beta chat']];
const LAYOUT = {'Alpha chat': [1, 100, 100], 'Beta chat': [2, 200, 150], 'Gamma renamed': [3, 300, 200], '': [0, 400, 250]};

const lines = [];
let failed = 0;
function out(s) {
    lines.push(s);
    GLib.file_set_contents(`${OUT}/results.txt`, `${lines.join('\n')}\n`);
}
function check(ok, what) {
    if (!ok)
        failed++;
    out(`${ok ? 'PASS' : 'FAIL'} ${what}`);
}
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => r() ?? GLib.SOURCE_REMOVE));
async function waitFor(fn, ms) {
    for (let t = 0; t < ms; t += 250) {
        if (fn())
            return true;
        await sleep(250);
    }
    return false;
}
const bare = t => (t || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/ — .*/, '').trim();
const titleOf = w => (bare(w.get_title()) in LAYOUT ? bare(w.get_title()) : '');
function terminals() {
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Ptyxis.desktop');
    return app ? app.get_windows().filter(w => w.get_window_type() === Meta.WindowType.NORMAL) : [];
}
const titled = () => terminals().filter(w => titleOf(w)).length;
const spawn = argv => Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
const chatArgv = id => ['ptyxis', '--new-window', '-d', HOME, '--', 'bash', '-lic', `claude --resume ${id}`];

async function run(ext) {
    await sleep(2000);
    Main.overview.hide();

    // 1. Open chats and a plain terminal, spread them out, save.
    for (const [id] of CHATS) {
        const n = terminals().length + 1;
        spawn(chatArgv(id));
        await waitFor(() => terminals().length === n, 15000);
    }
    spawn(['ptyxis', '--new-window']);
    check(await waitFor(() => terminals().length === 4 && titled() === 3, 20000),
        `4 terminals open, titles: ${terminals().map(w => JSON.stringify(w.get_title())).join(', ')}`);
    for (const w of terminals()) {
        const [desk, x, y] = LAYOUT[titleOf(w)];
        w.change_workspace_by_index(desk, false);
        w.move_resize_frame(true, x, y, 700, 500);
    }
    await sleep(800);
    ext._save();
    const snap = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(SNAPSHOT)[1]));
    for (const [id, title] of CHATS) {
        const c = snap.claude.find(x => x.sessionId === id);
        check(c?.geometry?.workspace === LAYOUT[title][0] && c.geometry.x === LAYOUT[title][1],
            `saved ${id} on desktop ${c?.geometry?.workspace} at x=${c?.geometry?.x} (want ${LAYOUT[title][0]}, ${LAYOUT[title][1]})`);
    }
    check(snap.terminals?.length === 1 && snap.terminals[0].workspace === 0, `saved 1 plain terminal on desktop 0: ${JSON.stringify(snap.terminals)}`);
    check(!snap.apps.some(a => a.id === 'org.gnome.Ptyxis.desktop'), 'terminal not saved as a plain app');

    // 2. Close everything, pretend this is the next login.
    const pids = new Set(terminals().map(w => w.get_pid()));
    for (const pid of pids)
        spawn(['kill', String(pid)]);
    check(await waitFor(() => terminals().length === 0, 10000), 'terminals closed');
    await sleep(1500);
    snap.session = 'previous-login';
    GLib.file_set_contents(SNAPSHOT, JSON.stringify(snap));
    ext.disable();
    ext.enable();
    const label = ext._button?.get_children()?.[0]?.get_first_child()?.label;
    check(label === '↻ Restore 4 apps', `button: ${label}`);

    // 3. Restore and check where each window lands.
    const readyNotices = () => Main.messageTray.getSources()
        .filter(src => src.constructor.name === 'WindowAttentionSource').length;
    // GNOME asks for attention when it refuses focus to a new window, which needs recent
    // user input; nobody types here, so ask for it the way GNOME would.
    const askId = global.display.connect('window-created', (d, w) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (w.get_compositor_private() && !w.has_focus())
                w.set_demands_attention();
            return GLib.SOURCE_REMOVE;
        });
    });
    let maxReady = 0;
    const readyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        maxReady = Math.max(maxReady, readyNotices());
        return GLib.SOURCE_CONTINUE;
    });
    ext._restore();
    check(await waitFor(() => terminals().length === 4 && titled() === 3, 45000),
        `4 terminals back: ${terminals().map(w => JSON.stringify(w.get_title())).join(', ')}`);
    await sleep(3000);
    GLib.source_remove(readyId);
    global.display.disconnect(askId);
    check(readyNotices() === 0, `no "is ready" notifications left after restore (${readyNotices()}; at most ${maxReady} at once)`);
    for (const w of terminals()) {
        const t = titleOf(w);
        const [desk, x, y] = LAYOUT[t];
        const r = w.get_frame_rect();
        check(w.get_workspace()?.index() === desk && r.x === x && r.y === y,
            `${t || 'plain terminal'}: desktop ${w.get_workspace()?.index()} at ${r.x},${r.y} (want ${desk} at ${x},${y})`);
    }
    // 4. Restored chats are titled "<title> — claude"; saving again must still match them.
    ext._save();
    const again = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(SNAPSHOT)[1]));
    for (const [id, title] of CHATS) {
        const c = again.claude.find(x => x.sessionId === id);
        check(c?.geometry?.workspace === LAYOUT[title][0], `saved again ${id} on desktop ${c?.geometry?.workspace} (want ${LAYOUT[title][0]})`);
    }
    out(failed ? `${failed} FAILED` : 'ALL PASSED');
}

export default class SrTest extends Extension {
    enable() {
        const ext = Main.extensionManager.lookup('session-restore@aimanelahssini')?.stateObj;
        if (!ext) {
            out('FAIL session-restore not loaded');
            return;
        }
        run(ext).catch(e => out(`FAIL ${e}\n${e.stack}`)).finally(() => {
            for (const pid of new Set(terminals().map(w => w.get_pid())))
                spawn(['kill', String(pid)]);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => global.context.terminate() ?? GLib.SOURCE_REMOVE);
        });
    }

    disable() {}
}
