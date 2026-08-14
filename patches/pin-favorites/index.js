/*
Patch: Pin Rooms.

Lets you pin/unpin a room to the left sidebar via the room's right-click menu
("Pin to sidebar" / "Unpin from sidebar"). Pinned rooms are remembered in
localStorage (independent of Element's "favourite" feature) and shown as a
compact column of avatar buttons in the left sidebar, below the spaces (and
above the Threads section), so they are always one click away.

How it works:
  - Adds a "Pin to sidebar" / "Unpin from sidebar" entry to Element's existing
    room context menu (the one opened by right-clicking a room tile).
  - Pinned room ids are stored in localStorage under "element-mods.pinned".
  - Injects a small section into the space panel (.mx_SpacePanel), anchored just
    above the Threads section (.mx_ThreadsActivityCentre_container).
  - Renders each pinned room as a square avatar button (room avatar, or the other
    participant's avatar for a 1:1 chat, or the first letter of the room name as
    a final fallback). Clicking it opens the room via the hash router
    (#/room/<id>).
  - Keeps the list in sync via a MutationObserver (survives React re-renders)
    and a periodic refresh.

The client is looked up lazily via window.mxMatrixClientPeg, so it works both
when already logged in at load time and when the client appears after login.
*/
(() => {
    "use strict";

    const PATCH_ID = "pin-favorites";
    const SECTION_ID = "element-mods-pin-favorites";
    const STYLE_ID = "element-mods-pin-favorites-style";
    const SPACE_PANEL_SELECTOR = ".mx_SpacePanel";
    const THREADS_SELECTOR = ".mx_ThreadsActivityCentre_container";
    const QUICK_SETTINGS_SELECTOR = ".mx_QuickSettingsButton";
    const MENU_SELECTOR = 'div[role="menu"]';
    const STORAGE_KEY = "element-mods.pinned";
    const REFRESH_INTERVAL = 5000;

    const CSS = `
#${SECTION_ID}{display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 0 4px;width:100%;box-sizing:border-box;}
#${SECTION_ID} .element-mods-pin-favorites-divider{width:24px;height:1px;flex:0 0 auto;background:var(--cpd-color-border-disabled,rgba(128,128,128,.35));margin-bottom:2px;}
#${SECTION_ID} .element-mods-pin-favorites-list{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;}
#${SECTION_ID} .element-mods-pin-favorites-room{width:32px;height:32px;padding:0;border:none;border-radius:8px;overflow:hidden;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:var(--cpd-color-bg-subtle-secondary,rgba(128,128,128,.2));}
#${SECTION_ID} .element-mods-pin-favorites-room:hover{box-shadow:0 0 0 2px var(--cpd-color-bg-action-primary,#0dbd8b);}
#${SECTION_ID} .element-mods-pin-favorites-room img{width:100%;height:100%;object-fit:cover;display:block;}
#${SECTION_ID} .element-mods-pin-favorites-initial{color:var(--cpd-color-text-primary,inherit);font-weight:600;font-size:14px;line-height:1;}
`;

    const PIN_PATH =
        '<path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/>';

    let observer = null;
    let client = null;
    let refreshTimer = null;
    let scanScheduled = false;
    let renderedSection = null;
    let renderedSignature = null;
    let lastContextRoomId = null;
    let lastContextAt = 0;

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function getBaseUrl(c) {
        return c.getHomeserverUrl();
    }

    function getRoomAvatarUrl(c, room) {
        const base = getBaseUrl(c);
        if (!base) return null;

        try {
            if (typeof room.getAvatarUrl === "function") {
                const url = room.getAvatarUrl(base, 48, 48, "crop", false);
                if (url) return url;
            }
        } catch {
            /* ignore */
        }

        // DM fallback: a 1:1 chat has no room avatar of its own, so Element
        // shows the other participant's avatar instead. getAvatarFallbackMember
        // returns that member for two-person conversations.
        try {
            const member = room.getAvatarFallbackMember();
            if (member && typeof member.getAvatarUrl === "function") {
                const url = member.getAvatarUrl(base, 48, 48, "crop", false);
                if (url) return url;
            }
        } catch {
            /* ignore */
        }

        return null;
    }

    function describeRoom(c, room) {
        const roomId = room.roomId || "";
        let name = roomId;
        try {
            const n = room.name;
            if (n) name = n;
        } catch {
            /* ignore */
        }

        const avatarUrl = getRoomAvatarUrl(c, room);
        const initial = name && name !== roomId ? name.charAt(0).toUpperCase() : "#";
        return { roomId, name, initial, avatarUrl };
    }

    function listRooms(c) {
        try {
            return c.getRooms() || [];
        } catch {
            return [];
        }
    }

    function readPinnedIds() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((id) => typeof id === "string" && id);
        } catch {
            return [];
        }
    }

    function writePinnedIds(ids) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
        } catch {
            /* ignore */
        }
    }

    function isPinned(roomId) {
        return readPinnedIds().indexOf(roomId) !== -1;
    }

    function pinRoom(roomId) {
        if (!roomId) return;
        const ids = readPinnedIds();
        if (ids.indexOf(roomId) === -1) {
            ids.push(roomId);
            writePinnedIds(ids);
        }
        onChanged();
    }

    function unpinRoom(roomId) {
        if (!roomId) return;
        const ids = readPinnedIds().filter((id) => id !== roomId);
        writePinnedIds(ids);
        onChanged();
    }

    function togglePin(roomId) {
        if (isPinned(roomId)) unpinRoom(roomId);
        else pinRoom(roomId);
    }

    function getPinnedRooms() {
        const c = getClient();
        if (!c) return [];

        const ids = readPinnedIds();
        if (ids.length === 0) return [];

        const roomsById = new Map();
        for (const room of listRooms(c)) {
            if (room && room.roomId) roomsById.set(room.roomId, room);
        }

        const out = [];
        for (const id of ids) {
            const room = roomsById.get(id);
            if (room) out.push(describeRoom(c, room));
        }
        return out;
    }

    function openRoom(roomId) {
        if (!roomId) return;
        window.location.hash = "#/room/" + encodeURIComponent(roomId);
    }

    function createRoomButton(room) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "element-mods-pin-favorites-room";
        btn.setAttribute("data-room-id", room.roomId);
        btn.title = room.name;
        btn.setAttribute("aria-label", "Open " + room.name);

        if (room.avatarUrl) {
            const img = document.createElement("img");
            img.src = room.avatarUrl;
            img.alt = room.name;
            img.setAttribute("draggable", "false");
            btn.appendChild(img);
        } else {
            const span = document.createElement("span");
            span.className = "element-mods-pin-favorites-initial";
            span.textContent = room.initial;
            btn.appendChild(span);
        }

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openRoom(room.roomId);
        });
        return btn;
    }

    function createSection() {
        const section = document.createElement("div");
        section.id = SECTION_ID;
        section.className = "element-mods-pin-favorites";

        const divider = document.createElement("div");
        divider.className = "element-mods-pin-favorites-divider";
        section.appendChild(divider);

        const list = document.createElement("div");
        list.className = "element-mods-pin-favorites-list";
        section.appendChild(list);

        return section;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    function removeSection() {
        if (renderedSection && renderedSection.isConnected) renderedSection.remove();
        renderedSection = null;
        renderedSignature = null;
    }

    function sync() {
        const panel = document.querySelector(SPACE_PANEL_SELECTOR);
        const rooms = getPinnedRooms();

        if (!panel || rooms.length === 0) {
            removeSection();
            return;
        }

        const signature = rooms
            .map((r) => r.roomId + "\u0001" + r.name + "\u0001" + (r.avatarUrl || ""))
            .join("\u0002");

        // (Re)create the section if it's no longer in the DOM (React removes it
        // when the space panel re-renders, e.g. on collapse/expand).
        let section = renderedSection;
        if (!section || !section.isConnected) {
            section = createSection();
            renderedSection = section;
            renderedSignature = null;
        }

        // Anchor the section inside the current space panel, right above the
        // Threads section (or above the quick-settings gear if Threads is
        // absent) — i.e. below the spaces. This is a no-op once the section is
        // already in place, so it doesn't fight the MutationObserver.
        const anchor =
            panel.querySelector(THREADS_SELECTOR) || panel.querySelector(QUICK_SETTINGS_SELECTOR);
        if (section.parentElement !== panel) {
            if (anchor && anchor.parentElement === panel) panel.insertBefore(section, anchor);
            else panel.appendChild(section);
        } else if (anchor && anchor.parentElement === panel && section.nextElementSibling !== anchor) {
            panel.insertBefore(section, anchor);
        }

        if (signature === renderedSignature) return;
        renderedSignature = signature;

        const list = section.querySelector(".element-mods-pin-favorites-list");
        list.textContent = "";
        for (const room of rooms) list.appendChild(createRoomButton(room));
    }

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            sync();
        });
    }

    function onChanged() {
        scheduleScan();
    }

    function attachClient() {
        const c = getClient();
        if (!c) return;
        if (client === c) return;
        detachClient();
        client = c;
        try {
            client.on("Room", onChanged);
            client.on("accountData", onChanged);
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] attach failed`, err);
            client = null;
            return;
        }
        scheduleScan();
    }

    function detachClient() {
        if (client && typeof client.off === "function") {
            try {
                client.off("Room", onChanged);
            } catch {
                /* ignore */
            }
            try {
                client.off("accountData", onChanged);
            } catch {
                /* ignore */
            }
        }
        client = null;
    }

    // --- Context-menu integration -------------------------------------------------

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
        // The Compound/Radix menu closes on an Escape keydown (handled at the
        // document level by Radix's DismissableLayer). Dispatching it here is the
        // least-invasive way to programmatically dismiss the menu.
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

    function injectPinItem(menu, roomId) {
        const pinned = isPinned(roomId);

        // Clone an existing Compound menu item so the injected entry inherits the
        // exact same markup/styling (hashed css-module classes included). Prefer
        // a plain menuitem, fall back to the favourite checkbox item.
        let template =
            menu.querySelector('[role="menuitem"]') ||
            menu.querySelector('[role="menuitemcheckbox"]') ||
            menu.querySelector('[role="menuitemradio"]');
        if (!template) return;

        const item = template.cloneNode(true);
        item.setAttribute("role", "menuitem");
        item.removeAttribute("aria-checked");
        item.removeAttribute("aria-disabled");
        item.removeAttribute("disabled");
        item.setAttribute("data-element-mods-pin-item", "1");
        if (item.className && typeof item.className === "string") {
            item.className = item.className
                .split(/\s+/)
                .filter((c) => c && c.indexOf("_disabled_") === -1)
                .join(" ");
        }

        const label = item.querySelector('[class*="_label_"]');
        if (label) label.textContent = pinned ? "Unpin from sidebar" : "Pin to sidebar";

        const icon = item.querySelector('[class*="_icon_"]');
        if (icon) {
            icon.innerHTML = PIN_PATH;
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("fill", "currentColor");
        }

        const chevron = item.querySelector('[class*="_nav-hint_"]');
        if (chevron) chevron.remove();

        item.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            togglePin(roomId);
            closeContextMenu(menu);
        });
        item.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        });

        // Insert right after the first toggle (Favourite / Low priority) so it
        // sits near the other toggles; otherwise prepend it. Items may live in a
        // wrapper <div> inside the menu, so insert relative to the checkbox's
        // actual parent, not the menu root.
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

    function injectPinMenuItems() {
        const menus = document.querySelectorAll(MENU_SELECTOR);
        for (const menu of menus) {
            if (menu.getAttribute("data-element-mods-pin-injected")) continue;
            // Only target the Compound room-list context menu. It always contains
            // the Favourite / Low priority toggles (button[role=menuitemcheckbox]);
            // this also skips Radix submenus ("Move to section") and the old
            // matrix-react-sdk menus, whose items are <li> rather than <button>.
            const checkbox = menu.querySelector('[role="menuitemcheckbox"]');
            if (!checkbox || checkbox.tagName !== "BUTTON") continue;
            let roomId = findRoomIdFromNode(menu);
            if (!roomId && Date.now() - lastContextAt < 5000) roomId = lastContextRoomId;
            if (!roomId) {
                console.warn(`[element-mods:${PATCH_ID}] could not resolve room id for context menu`, menu);
                continue;
            }
            menu.setAttribute("data-element-mods-pin-injected", "1");
            injectPinItem(menu, roomId);
        }
    }

    function onMutation() {
        scheduleScan();
        injectPinMenuItems();
    }

    function start() {
        injectStyle();
        observer = new MutationObserver(onMutation);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("contextmenu", onContextMenuCapture, true);
        attachClient();
        refreshTimer = setInterval(() => {
            attachClient();
            sync();
        }, REFRESH_INTERVAL);
        scheduleScan();
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        document.removeEventListener("contextmenu", onContextMenuCapture, true);
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        detachClient();
        removeSection();
        removeStyle();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
