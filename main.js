// main.js — completely rebuilt context‐menu logic
if (typeof browser === "undefined" && typeof chrome === "object") {
    browser = chrome;
    if (!browser.menus) browser.menus = browser.contextMenus;
    if (!browser.browserAction) browser.browserAction = browser.action;
}

// Constants
const CONTEXTS = ["tab"];              // show only in tab right‐click menu
const ROOT_ID = "group-tabs-window";  // root menu item ID
let TAB_MAP = {};                     // mapping from menu ID → {tabs, recycle}

// ----- Utility: compare functions -----
const SCHEMES = [
    /^(http)s?:$/, /^(file):$/, /^s?(ftp):$/, /^(about):$/, /(.*)/
];
function compareSchemes(a, b) {
    const ea = SCHEMES.map((rx, i) => a.protocol.match(rx) ? i : -1).filter(i => i >= 0)[0];
    const eb = SCHEMES.map((rx, i) => b.protocol.match(rx) ? i : -1).filter(i => i >= 0)[0];
    if (ea !== eb) return ea - eb;
    const na = a.protocol.match(SCHEMES[ea])[1];
    const nb = b.protocol.match(SCHEMES[eb])[1];
    return na.localeCompare(nb);
}
function compareDomains(a, b) {
    const pa = a.hostname.replace(/^www\d*\./, '').toLowerCase().split('.').reverse();
    const pb = b.hostname.replace(/^www\d*\./, '').toLowerCase().split('.').reverse();
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const da = pa[i] || '';
        const db = pb[i] || '';
        if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
}
function compareLocal(a, b) {
    const sa = a.pathname + a.search + a.hash;
    const sb = b.pathname + b.search + b.hash;
    return sa.localeCompare(sb);
}
function compareURIs(a, b) {
    if (!(a instanceof URL)) a = new URL(a);
    if (!(b instanceof URL)) b = new URL(b);
    let cmp = compareSchemes(a, b);
    if (cmp === 0) cmp = compareDomains(a, b);
    if (cmp === 0) cmp = compareLocal(a, b);
    return cmp;
}
function compareTabs(a, b) {
    const pa = a.pinned ? 0 : 1;
    const pb = b.pinned ? 0 : 1;
    if (pa !== pb) return pa - pb;
    let cmp = compareURIs(a.url, b.url);
    if (cmp !== 0) return cmp;
    return b.lastAccessed - a.lastAccessed;
}

// ----- Toolbar button: sort tabs by domain in current window -----
browser.browserAction.onClicked.addListener(async () => {
    const { 'pinned-tabs': keepPinned = true } = await browser.storage.sync.get('pinned-tabs');
    const tabs = await browser.tabs.query({ currentWindow: true });
    tabs.sort(compareTabs);
    for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].pinned && !keepPinned) continue;
        await browser.tabs.move(tabs[i].id, { index: i });
    }
});

// ----- Context menu: show dynamic submenu on tab right‐click -----
browser.menus.onShown.addListener(async (info, tab) => {
    // remove all old items (root will be recreated below)
    await browser.menus.removeAll();
    TAB_MAP = {};

    // recreate the root menu item
    await browser.menus.create({
        id: ROOT_ID,
        title: 'Group Tabs to Window',
        contexts: CONTEXTS
    });

    // determine hostname of the clicked tab
    let host;
    try {
        host = new URL(tab.url).hostname.replace(/^www\d*\./, '').toLowerCase();
    } catch {
        await browser.menus.refresh();
        return;
    }

    // split into labels for progressive domain matching
    const parts = host.split('.');
    for (let i = 0; i < parts.length; i++) {
        const domain = parts.slice(i).join('.');
        const queryMask = `*.${domain}`;                  // always wildcard for query
        const displayLabel = (i === 0) ? domain : queryMask;
        const menuId = `group-${i}`;

        // find matching tabs (naked + subdomains)
        let tabs = await browser.tabs.query({ url: `*://${queryMask}/*`, pinned: false });
        tabs = tabs.filter(t => t.incognito === tab.incognito);
        if (tabs.length === 0) continue;

        // split into this-window vs other-windows
        const mine = tabs.filter(t => t.windowId === tab.windowId);
        const othr = tabs.filter(t => t.windowId !== tab.windowId);
        const recycle = (mine.length === tabs.length);

        // add to map
        TAB_MAP[menuId] = { tabs, recycle };

        // create submenu entry
        await browser.menus.create({
            id: menuId,
            parentId: ROOT_ID,
            title: `${displayLabel} (${tabs.length})`,
            contexts: CONTEXTS
        });

        // if there are tabs in other windows, add children
        if (othr.length > 0) {
            const curId = `${menuId}-cur`;
            TAB_MAP[curId] = { tabs: mine, recycle: true };
            await browser.menus.create({
                id: curId,
                parentId: menuId,
                title: `This Window Only (${mine.length})`,
                contexts: CONTEXTS
            });

            const allId = `${menuId}-all`;
            TAB_MAP[allId] = { tabs, recycle: false };
            await browser.menus.create({
                id: allId,
                parentId: menuId,
                title: `From All Windows (${tabs.length})`,
                contexts: CONTEXTS
            });
        }
    }

    // finally, refresh to show new menu
    await browser.menus.refresh();
});

// ----- Handle menu clicks -----
browser.menus.onClicked.addListener(async (info, tab) => {
    const entry = TAB_MAP[info.menuItemId];
    if (!entry) return;

    const tabs = entry.tabs.sort(compareTabs);
    // open the first tab in a brand-new window
    const win = await browser.windows.create({ tabId: tabs[0].id });
    // move the rest into it
    for (let i = 1; i < tabs.length; i++) {
        await browser.tabs.move(tabs[i].id, { windowId: win.id, index: -1 });
    }
});
  
  