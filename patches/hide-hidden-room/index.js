/*
Patch: Hide Room.

Lets you hide a room from the room list via its native right-click menu
("Hide room"). Hidden rooms disappear completely from the sidebar (and are
therefore inaccessible). The set of hidden room IDs is persisted in
localStorage, and a "Hidden rooms" tab is added to Settings where every hidden
room is listed with an "Unhide" button, so you can recover a room you hid by
mistake.

How it works:
  - Adds a "Hide room" entry to Element's existing room context menu (the
    Compound/Radix menu opened by right-clicking a room tile). The entry is
    injected by cloning an existing menu item so it inherits the exact styling,
    and the room id is resolved by walking the React fiber tree up from the menu
    node (same technique as the Pin Favorites patch).
  - Hidden room ids are stored in localStorage under "element-mods.hide-room.hidden".
  - The room list only exposes a room's *name* in the DOM (div with
    data-testid="room-name"); the room id is not rendered. So the hiding scan maps
    name -> hidden set each time, which also keeps hiding correct after a rename.
  - Hidden rooms are tagged with a CSS class that collapses their virtualised
    list row to a 1px non-zero height (a plain display:none would make
    react-virtuoso measure a zero-sized element and spam a warning). A
    MutationObserver scoped to the room list (plus a periodic timer) re-applies
    the class as the list re-renders.
  - The Settings tab uses the loader's shared settingsTabs coordinator (the same
    one the Themes and Modding patches use) to avoid fighting over tab injection.
*/
(() => {
    "use strict";

    const PATCH_ID = "hide-hidden-room";
    const HIDDEN_KEY = "element-mods.hide-room.hidden";
    const MARKER_CLASS = "element-mods-hidden-room";
    const STYLE_ID = "element-mods-hide-room-style";
    const REFRESH_INTERVAL = 5000;
    const TAB_ID = "hide-room";
    const PANEL_ID = `mx_tabpanel_${TAB_ID}`;

    const LIST_SELECTORS = ['[data-testid="room-list"]', ".mx_LeftPanel"];
    const TILE_SELECTOR = ".mx_RoomListItemView";
    const ROOM_NAME_SELECTOR = '[data-testid="room-name"]';
    const MENU_SELECTOR = 'div[role="menu"]';

    const HIDE_ICON_INNER =
        '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
        '<circle cx="12" cy="12" r="3"/>' +
        '<line x1="3" y1="3" x2="21" y2="21"/>';

    let bodyObserver = null;
    let listObservers = [];
    let refreshTimer = null;
    let scanTimer = null;
    let observeTimer = null;
    let tabRegistered = false;
    let lastContextRoomId = null;
    let lastContextAt = 0;

    // ------------------------------------------------------------------
    // Client access + room <-> id mapping.
    // ------------------------------------------------------------------
    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        try {
            if (typeof peg.safeGet === "function") return peg.safeGet();
            if (typeof peg.get === "function") return peg.get();
        } catch {
            /* ignore */
        }
        return null;
    }

    function getRooms() {
        const c = getClient();
        if (!c) return [];
        try {
            return c.getRooms() || [];
        } catch {
            return [];
        }
    }

    // id -> name
    function buildRoomMaps() {
        const byId = new Map();
        for (const room of getRooms()) {
            if (!room || !room.roomId) continue;
            let name = null;
            try {
                name = room.name;
            } catch {
                /* ignore */
            }
            if (name == null || name === "") name = room.roomId;
            byId.set(room.roomId, String(name));
        }
        return { byId };
    }

    function resolveName(id) {
        const { byId } = buildRoomMaps();
        return byId.get(id) || id;
    }

    // ------------------------------------------------------------------
    // Persistence.
    // ------------------------------------------------------------------
    function loadHidden() {
        try {
            const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
            return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
        } catch {
            return [];
        }
    }

    function saveHidden(ids) {
        try {
            localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
        } catch {
            /* ignore */
        }
    }

    function setHidden(id, hidden) {
        const ids = loadHidden();
        const idx = ids.indexOf(id);
        if (hidden && idx === -1) ids.push(id);
        if (!hidden && idx !== -1) ids.splice(idx, 1);
        saveHidden(ids);
    }

    // Lowercased names of every currently-hidden room.
    function hiddenNames() {
        const set = new Set();
        const { byId } = buildRoomMaps();
        for (const id of loadHidden()) {
            const name = byId.get(id);
            if (name) set.add(name.trim().toLowerCase());
        }
        return set;
    }

    // ------------------------------------------------------------------
    // Hiding.
    // ------------------------------------------------------------------
    function getLists() {
        for (const sel of LIST_SELECTORS) {
            try {
                const lists = document.querySelectorAll(sel);
                if (lists && lists.length) return lists;
            } catch {
                /* ignore */
            }
        }
        return [];
    }

    function setMarked(el, shouldMark) {
        if (!el) return;
        if (shouldMark) el.classList.add(MARKER_CLASS);
        else el.classList.remove(MARKER_CLASS);
    }

    function scan() {
        const names = hiddenNames();

        for (const list of getLists()) {
            let tiles;
            try {
                tiles = list.querySelectorAll(TILE_SELECTOR);
            } catch {
                continue;
            }
            for (const tile of tiles) {
                const nameEl = tile.querySelector(ROOM_NAME_SELECTOR);
                const name = nameEl
                    ? (nameEl.getAttribute("title") || nameEl.textContent || "").trim()
                    : "";
                const shouldHide = !!name && names.has(name.toLowerCase());
                const row = tile.closest('[role="row"], [role="option"]') || tile;
                const item = row.closest('[data-index]') || row;
                setMarked(item, shouldHide);
            }
        }
    }

    function scheduleScan() {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            scanTimer = null;
            scan();
        }, 200);
    }

    function observeLists() {
        let added = false;
        for (const list of getLists()) {
            if (list.__emHideObserved) continue;
            try {
                const obs = new MutationObserver(scheduleScan);
                obs.observe(list, { childList: true, subtree: true });
                list.__emHideObserved = obs;
                listObservers.push(obs);
                added = true;
            } catch {
                /* ignore */
            }
        }
        if (added) scheduleScan();
    }

    function scheduleObserve() {
        if (observeTimer) clearTimeout(observeTimer);
        observeTimer = setTimeout(() => {
            observeTimer = null;
            observeLists();
        }, 300);
    }

    function disconnectListObservers() {
        for (const obs of listObservers) {
            try {
                obs.disconnect();
            } catch {
                /* ignore */
            }
        }
        listObservers = [];
        for (const list of getLists()) {
            list.__emHideObserved = null;
        }
    }

    // ------------------------------------------------------------------
    // Context-menu integration (mirrors the Pin Favorites patch).
    // ------------------------------------------------------------------
    function roomIdFromProps(props) {
        if (!props || typeof props !== "object") return null;
        if (typeof props.roomId === "string" && props.roomId) return props.roomId;
        if (props.room && typeof props.room.roomId === "string") return props.room.roomId;
        for (const key of ["viewModel", "vm"]) {
            const vm = props[key];
            if (vm && typeof vm === "object") {
                if (typeof vm.roomId === "string" && vm.roomId) return vm.roomId;
                if (vm.props && vm.props.room && typeof vm.props.room.roomId === "string") return vm.props.room.roomId;
                if (vm.item && typeof vm.item.roomId === "string") return vm.item.roomId;
            }
        }
        if (props.item && typeof props.item.roomId === "string") return props.item.roomId;
        return null;
    }

    function findRoomIdFromNode(node) {
        // Walk the React fiber tree up from the given DOM node until we hit a
        // component whose props expose a room id (either directly, via a `room`
        // object, or via a `viewModel`/`vm`). This also crosses the Radix portal
        // boundary that renders the menu into document.body.
        let fiber = null;
        for (const key in node) {
            if (key.startsWith("__reactFiber$")) {
                fiber = node[key];
                break;
            }
        }
        let guard = 0;
        while (fiber && guard++ < 80) {
            const id = roomIdFromProps(fiber.memoizedProps);
            if (id) return id;
            fiber = fiber.return;
        }
        return null;
    }

    function onContextMenuCapture(ev) {
        // Record the room under the cursor before Element consumes the event.
        // Used as a fallback when the menu node's own fiber walk finds nothing.
        const target = ev.target;
        if (!target || typeof target.closest !== "function") return;
        const id = findRoomIdFromNode(target);
        if (id) {
            lastContextRoomId = id;
            lastContextAt = Date.now();
        }
    }

    function closeContextMenu(menu) {
        // The Compound/Radix menu closes on an Escape keydown. Dispatching it is
        // the least-invasive way to programmatically dismiss the menu.
        try {
            menu.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    code: "Escape",
                    bubbles: true,
                    cancelable: true,
                }),
            );
        } catch {
            /* ignore */
        }
    }

    function injectHideItem(menu, roomId) {
        // Clone an existing Compound menu item so the injected entry inherits the
        // exact same markup/styling (hashed css-module classes included).
        const template =
            menu.querySelector('[role="menuitem"]') ||
            menu.querySelector('[role="menuitemcheckbox"]') ||
            menu.querySelector('[role="menuitemradio"]');
        if (!template) return;

        const item = template.cloneNode(true);
        item.setAttribute("role", "menuitem");
        item.removeAttribute("aria-checked");
        item.removeAttribute("aria-disabled");
        item.removeAttribute("disabled");
        item.setAttribute("data-element-mods-hide-item", "1");
        if (item.className && typeof item.className === "string") {
            item.className = item.className
                .split(/\s+/)
                .filter((c) => c && c.indexOf("_disabled_") === -1)
                .join(" ");
        }

        const label = item.querySelector('[class*="_label_"]');
        if (label) label.textContent = "Hide room";

        const icon = item.querySelector('[class*="_icon_"]');
        if (icon) {
            icon.innerHTML = HIDE_ICON_INNER;
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("fill", "none");
            icon.setAttribute("stroke", "currentColor");
            icon.setAttribute("stroke-width", "2");
            icon.setAttribute("stroke-linecap", "round");
            icon.setAttribute("stroke-linejoin", "round");
        }

        const chevron = item.querySelector('[class*="_nav-hint_"]');
        if (chevron) chevron.remove();

        item.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setHidden(roomId, true);
            closeContextMenu(menu);
            scheduleScan();
            refreshPanel();
        });
        item.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });

        const firstCheckbox = menu.querySelector('[role="menuitemcheckbox"]');
        if (firstCheckbox && firstCheckbox.parentNode) {
            const parent = firstCheckbox.parentNode;
            if (firstCheckbox.nextElementSibling) {
                parent.insertBefore(item, firstCheckbox.nextElementSibling);
            } else {
                parent.appendChild(item);
            }
        } else if (menu.firstElementChild) {
            menu.insertBefore(item, menu.firstElementChild);
        } else {
            menu.appendChild(item);
        }
    }

    function injectHideMenuItems() {
        const menus = document.querySelectorAll(MENU_SELECTOR);
        for (const menu of menus) {
            if (menu.getAttribute("data-element-mods-hide-injected")) continue;
            // Only target the Compound room-list context menu: it always contains
            // the Favourite / Low priority toggles (button[role=menuitemcheckbox]).
            const checkbox = menu.querySelector('[role="menuitemcheckbox"]');
            if (!checkbox || checkbox.tagName !== "BUTTON") continue;
            let roomId = findRoomIdFromNode(menu);
            if (!roomId && Date.now() - lastContextAt < 5000) roomId = lastContextRoomId;
            if (!roomId) continue;
            menu.setAttribute("data-element-mods-hide-injected", "1");
            injectHideItem(menu, roomId);
        }
    }

    function onBodyMutation() {
        scheduleObserve();
        injectHideMenuItems();
    }

    // ------------------------------------------------------------------
    // Settings tab ("Hidden rooms").
    // ------------------------------------------------------------------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function createTabLabel() {
        const li = el("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-controls", PANEL_ID);
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", `settings-tab-${TAB_ID}`);

        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>';

        li.appendChild(icon);
        li.appendChild(el("span", "mx_TabbedView_tabLabel_text", "Hidden rooms"));
        return li;
    }

    function createPanelContent() {
        const content = el("div");
        content.style.cssText = "padding:24px;max-width:680px;";

        const title = el("h3", null, "Hidden rooms");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";
        content.appendChild(title);

        const subtitle = el("div", null, "Rooms you have hidden from the room list. Unhide one to bring it back.");
        subtitle.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";
        content.appendChild(subtitle);

        const ids = loadHidden();
        if (ids.length === 0) {
            content.appendChild(el("div", null, "No hidden rooms."));
        } else {
            const list = el("div");
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
            for (const id of ids) {
                const row = el("div");
                row.style.cssText =
                    "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;" +
                    "background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

                const name = el("span", null, resolveName(id));
                name.style.cssText = "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

                const unhide = el("button", null, "Unhide");
                unhide.type = "button";
                unhide.style.cssText =
                    "flex:0 0 auto;padding:4px 12px;border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);" +
                    "border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:13px;";
                unhide.addEventListener("click", () => {
                    setHidden(id, false);
                    scheduleScan();
                    refreshPanel();
                });

                row.appendChild(name);
                row.appendChild(unhide);
                list.appendChild(row);
            }
            content.appendChild(list);
        }

        return content;
    }

    function createPanel() {
        const panel = el("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", `${PANEL_ID}_label`);
        panel.setAttribute("data-hide-room-panel", "true");

        const scroller = el("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        scroller.appendChild(createPanelContent());
        panel.appendChild(scroller);
        return panel;
    }

    function refreshPanel() {
        const panel = document.querySelector("[data-hide-room-panel]");
        if (!panel) return;
        const scroller = panel.querySelector(".mx_TabbedView_tabPanelContent");
        if (scroller) {
            scroller.textContent = "";
            scroller.appendChild(createPanelContent());
        }
    }

    // ------------------------------------------------------------------
    // Lifecycle.
    // ------------------------------------------------------------------
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
            `.${MARKER_CLASS} {` +
            "height:1px !important;min-height:1px !important;max-height:1px !important;" +
            "overflow:hidden !important;padding:0 !important;margin:0 !important;" +
            "border:none !important;visibility:hidden !important;}"
        document.head.appendChild(style);
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    function start() {
        injectStyle();
        bodyObserver = new MutationObserver(onBodyMutation);
        bodyObserver.observe(document.body, { childList: true, subtree: true });
        observeLists();
        refreshTimer = setInterval(() => {
            observeLists();
            scan();
            injectHideMenuItems();
        }, REFRESH_INTERVAL);

        document.addEventListener("contextmenu", onContextMenuCapture, true);

        if (window.mods && window.mods.settingsTabs) {
            window.mods.settingsTabs.register(TAB_ID, { label: createTabLabel(), renderPanel: createPanel });
            tabRegistered = true;
        }

        scheduleScan();
    }

    function stop() {
        if (bodyObserver) bodyObserver.disconnect();
        bodyObserver = null;
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = null;
        if (observeTimer) clearTimeout(observeTimer);
        observeTimer = null;
        disconnectListObservers();

        document.removeEventListener("contextmenu", onContextMenuCapture, true);

        if (tabRegistered) window.mods.settingsTabs.unregister(TAB_ID);
        tabRegistered = false;

        for (const el of document.querySelectorAll("." + MARKER_CLASS)) {
            el.classList.remove(MARKER_CLASS);
        }
        removeStyle();
    }

    if (window.mods && typeof window.mods.registerPatch === "function") {
        window.mods.registerPatch(PATCH_ID, { start, stop });
    } else {
        start();
    }
})();
