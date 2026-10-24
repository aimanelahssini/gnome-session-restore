// Test driver: opens terminal windows with tabs (fake Claude chats and plain shells), spreads
// them over desktops, saves, closes them, fakes a new login, restores, and checks that every
// window is back on its desktop with the same tabs in the same order. Results go to
// $TEST_OUT/results.txt.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('TEST_OUT');
const HOME = GLib.get_home_dir();
const SNAPSHOT = `${HOME}/.local/state/session-restore/snapshot.json`;
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const G = 'cccccccc-0000-4000-8000-00000000000c';
const NAMES = {[A]: 'Alpha chat', [B]: 'Beta chat', [G]: 'Gamma renamed'};
// Each window: where it goes, and its tabs in order (a chat, or a plain shell's folder).
const LAYOUT = [
    {desk: 1, x: 100, y: 100, tabs: [{chat: A}, {dir: 'work'}]},
    {desk: 2, x: 200, y: 150, tabs: [{chat: B}]},
    {desk: 3, x: 300, y: 200, tabs: [{dir: ''}, {chat: G}]},
    {desk: 0, x: 400, y: 250, tabs: [{dir: 'notes'}]},
];
const describe = tabs => tabs.map(t => (t.chat ? NAMES[t.chat] : `~/${t.dir}`)).join(' | ');

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
        if (await fn())
            return true;
        await sleep(250);
    }
    return false;
}
function terminals() {
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Ptyxis.desktop');
    return app ? app.get_windows().filter(w => w.get_window_type() === Meta.WindowType.NORMAL) : [];
}
const run = argv => new Promise(resolve => Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE).wait_async(null, () => resolve()));
const chatCmd = id => `claude --resume ${id}`;
const tabCwd = t => (t.chat ? HOME : `${HOME}/${t.dir}`.replace(/\/$/, ''));
const readSnapshot = () => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(SNAPSHOT)[1]));

// A tab's title as the layout describes it: which chat it shows, or the shell's folder.
function tabName(title) {
    const chat = Object.values(NAMES).find(n => title.includes(n));
    if (chat)
        return chat;
    const m = title.match(/^[^@\s]+@[^:\s]+:(\S+)/);
    return m ? (m[1] === '~' ? '~/' : m[1]) : `?${title}`;
}
// What the snapshot says about a window's tabs, in the same words.
const savedTabs = tabs => tabs.map(t => (t.sessionId ? NAMES[t.sessionId] ?? t.sessionId
    : `~/${t.cwd.slice(HOME.length + 1)}`)).join(' | ');

async function openLayout() {
    const wins = [];
    for (const l of LAYOUT) {
        const before = new Set(terminals());
        const [first, ...more] = l.tabs;
        Gio.Subprocess.new(['ptyxis', '--new-window', '-d', tabCwd(first),
            ...first.chat ? ['--', 'bash', '-lic', chatCmd(first.chat)] : []], Gio.SubprocessFlags.NONE);
        await waitFor(() => terminals().some(w => !before.has(w)), 15000);
        const w = terminals().find(x => !before.has(x));
        for (const t of more) {
            await run(['ptyxis', '--tab', '-d', tabCwd(t),
                ...t.chat ? ['-x', `bash -lic '${chatCmd(t.chat)}'`] : []]);
        }
        wins.push(w);
    }
    return wins;
}

// Ptyxis's windows with their tabs, matched to GNOME's windows by title.
async function tabsByWindow(ext) {
    const frames = await ext._readTabs() ?? [];
    return terminals().map(w => {
        const f = frames.find(x => x.title.trim() === (w.get_title() || '').trim());
        return {w, tabs: f ? f.tabs.map(t => tabName(t)).join(' | ') : '(not found)'};
    });
}

async function runTest(ext) {
    await sleep(2000);
    Main.overview.hide();

    // 1. Open the windows with their tabs, spread them out, save.
    const wins = await openLayout();
    check(wins.every(Boolean) && terminals().length === 4, '4 windows open');
    await sleep(2500);  // titles settle
    wins.forEach((w, i) => {
        const l = LAYOUT[i];
        w.change_workspace_by_index(l.desk, false);
        w.move_resize_frame(true, l.x, l.y, 700, 500);
    });
    await sleep(800);
    for (const {w, tabs} of await tabsByWindow(ext))
        out(`  before: desktop ${w.get_workspace()?.index()}: ${tabs}`);
    await ext._save();
    let snap = readSnapshot();
    check(snap.version === 3 && snap.terminals.length === 4, `saved 4 terminal windows (version ${snap.version})`);
    for (const l of LAYOUT) {
        const s = snap.terminals.find(t => t.geometry?.workspace === l.desk);
        check(s && savedTabs(s.tabs) === describe(l.tabs) && s.geometry.x === l.x,
            `saved desktop ${l.desk}: ${s ? savedTabs(s.tabs) : 'missing'} (want ${describe(l.tabs)})`);
    }
    check(!snap.apps.some(a => a.id === 'org.gnome.Ptyxis.desktop'), 'terminal not saved as a plain app');

    // 2. Close everything, pretend this is the next login.
    for (const pid of new Set(terminals().map(w => w.get_pid())))
        await run(['kill', String(pid)]);
    check(await waitFor(() => terminals().length === 0, 10000), 'terminals closed');
    await sleep(1500);
    snap.session = 'previous-login';
    GLib.file_set_contents(SNAPSHOT, JSON.stringify(snap));
    ext.disable();
    ext.enable();
    const label = ext._button?.get_children()?.[0]?.get_first_child()?.label;
    check(label === '↻ Restore 4 windows', `button: ${label}`);

    // 3. Restore and check each window's desktop, place and tabs.
    // GNOME asks for attention when it refuses focus to a new window, which needs recent
    // user input; nobody types here, so ask for it the way GNOME would.
    const askId = global.display.connect('window-created', (d, w) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (w.get_compositor_private() && !w.has_focus())
                w.set_demands_attention();
            return GLib.SOURCE_REMOVE;
        });
    });
    const readyNotices = () => Main.messageTray.getSources()
        .filter(src => src.constructor.name === 'WindowAttentionSource').length;
    ext._restore();
    check(await waitFor(async () => terminals().length === 4 &&
        (await ext._readTabs() ?? []).flatMap(f => f.tabs).length === 6, 60000), '4 windows with 6 tabs back');
    await sleep(3500);  // titles settle, re-placing done
    global.display.disconnect(askId);
    check(readyNotices() === 0, `no "is ready" notifications left after restore (${readyNotices()})`);
    const after = await tabsByWindow(ext);
    for (const l of LAYOUT) {
        const got = after.find(x => x.w.get_workspace()?.index() === l.desk);
        const r = got?.w.get_frame_rect();
        check(got && got.tabs === describe(l.tabs) && r.x === l.x && r.y === l.y,
            `desktop ${l.desk}: ${got?.tabs ?? 'no window'} at ${r?.x},${r?.y} (want ${describe(l.tabs)} at ${l.x},${l.y})`);
    }

    // 4. Restored chats name themselves ("claude --resume ID"): saving again must place them
    // even without their transcripts.
    for (const id of [A, B, G])
        GLib.unlink(`${HOME}/.claude/projects/${HOME.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`);
    ext._titles.clear();

    await ext._save();
    snap = readSnapshot();
    for (const l of LAYOUT) {
        const s = snap.terminals.find(t => t.geometry?.workspace === l.desk);
        check(s && savedTabs(s.tabs) === describe(l.tabs), `saved again desktop ${l.desk}: ${s ? savedTabs(s.tabs) : 'missing'}`);
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
        runTest(ext).catch(e => out(`FAIL ${e}\n${e.stack}`)).finally(() => {
            for (const pid of new Set(terminals().map(w => w.get_pid())))
                Gio.Subprocess.new(['kill', String(pid)], Gio.SubprocessFlags.NONE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => global.context.terminate() ?? GLib.SOURCE_REMOVE);
        });
    }

    disable() {}
}
