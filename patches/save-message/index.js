/*
Patch: Save Message.

Adds a "Save message" entry to the message right-click context menu. Saving
stores the message (body, sender, room, timestamp) in localStorage under
"element-mods.saved-messages". localStorage lives in the app's user-data
directory, outside webapp.asar, so it survives app updates and re-applying the
mods — it is never bundled into or wiped by an update.

A bookmark button is added to the left sidebar (the space panel, just above the
quick-settings gear). Clicking it opens a full-screen "Saved messages" page that
lists every saved message (newest first), with an option to unsave each one and
click-to-open the originating room.

How it works:
  - A capture-phase "contextmenu" listener records the right-clicked event tile
    (its data-event-id plus the current room id and rendered body text).
  - A MutationObserver watches for the context menu that Element then renders
    (an option list containing role="menuitem" items) and injects our own
    menu item next to Element's options. Clicking it saves (or unsaves) the
    recorded message and closes the menu.
  - The same observer keeps the sidebar button anchored in the space panel so it
    survives React re-renders.
*/
(() => {
    "use strict";

    const PATCH_ID = "save-message";
    const STORAGE_KEY = "element-mods.saved-messages";
    const STYLE_ID = "element-mods-save-message-style";
    const MENU_ITEM_CLASS = "element-mods-save-message-menuitem";
    const SIDEBAR_BUTTON_CLASS = "element-mods-save-message-sidebar-button";
    const OVERLAY_CLASS = "element-mods-save-message-overlay";
    const OVERLAY_OPEN_CLASS = "element-mods-save-message-overlay-open";

    const SPACE_PANEL_SELECTOR = ".mx_SpacePanel";
    const QUICK_SETTINGS_SELECTOR = ".mx_QuickSettingsButton";
    const TILE_SELECTOR = ".mx_EventTile[data-event-id]";
    const CONTEXT_TIMEOUT = 2000;

    const MSGTYPE_LABELS = {
        "m.image": "Image",
        "m.video": "Video",
        "m.audio": "Audio",
        "m.file": "File",
        "m.text": "Text",
    };

    const BOOKMARK_SVG =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
    const CLOSE_SVG =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    const CSS = `
.${SIDEBAR_BUTTON_CLASS}{position:relative;width:32px;height:32px;align-self:center;margin:4px auto;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:var(--cpd-color-icon-secondary,inherit);cursor:pointer;flex:0 0 auto;}
.${SIDEBAR_BUTTON_CLASS}:hover,.${SIDEBAR_BUTTON_CLASS}:focus-visible{background:var(--cpd-color-bg-subtle-secondary,rgba(128,128,128,.2));color:var(--cpd-color-icon-primary,inherit);}
.${SIDEBAR_BUTTON_CLASS} .element-mods-save-message-badge{position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:var(--cpd-color-bg-action-primary,#0dbd8b);color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center;}

.${MENU_ITEM_CLASS}{display:flex;align-items:center;gap:10px;width:100%;padding:8px 12px;border:none;background:none;cursor:pointer;text-align:left;font:inherit;color:var(--cpd-color-text-primary,inherit);}
.${MENU_ITEM_CLASS}:hover,.${MENU_ITEM_CLASS}:focus-visible{background:var(--cpd-color-bg-subtle-secondary,rgba(128,128,128,.15));}
.${MENU_ITEM_CLASS} .element-mods-save-message-menuitem-icon{display:inline-flex;flex:0 0 auto;color:var(--cpd-color-icon-primary,inherit);}

.${OVERLAY_CLASS}{position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;background:var(--cpd-color-bg-canvas-default,var(--cpd-color-bg-canvas,#ffffff));color:var(--cpd-color-text-primary,inherit);font-family:inherit;}
.${OVERLAY_CLASS}.${OVERLAY_OPEN_CLASS}{display:flex;}
.${OVERLAY_CLASS} .element-mods-save-message-overlay-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.3));}
.${OVERLAY_CLASS} .element-mods-save-message-overlay-title{font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);margin:0;}
.${OVERLAY_CLASS} .element-mods-save-message-overlay-close{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--cpd-color-icon-primary,inherit);}
.${OVERLAY_CLASS} .element-mods-save-message-overlay-close:hover{background:var(--cpd-color-bg-subtle-secondary,rgba(128,128,128,.2));}
.${OVERLAY_CLASS} .element-mods-save-message-search{display:flex;padding:8px 16px;border-bottom:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.3));}
.${OVERLAY_CLASS} .element-mods-save-message-search input{flex:1;padding:6px 10px;border:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.4));border-radius:8px;background:var(--cpd-color-bg-subtle-secondary,transparent);color:var(--cpd-color-text-primary,inherit);font:inherit;outline:none;}
.${OVERLAY_CLASS} .element-mods-save-message-overlay-list{flex:1;overflow-y:auto;padding:8px 12px;}
.${OVERLAY_CLASS} .element-mods-save-message-empty{color:var(--cpd-color-text-secondary,inherit);padding:16px 0;text-align:center;font-size:13px;}
.${OVERLAY_CLASS} .element-mods-save-message-row{padding:6px 10px;border-radius:6px;background:var(--cpd-color-bg-subtle-secondary,transparent);margin-bottom:4px;}
.${OVERLAY_CLASS} .element-mods-save-message-row-meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.4;}
.${OVERLAY_CLASS} .element-mods-save-message-sender{font-weight:600;color:var(--cpd-color-text-primary,inherit);font-size:13px;}
.${OVERLAY_CLASS} .element-mods-save-message-room-link{background:none;border:none;padding:0;cursor:pointer;color:var(--cpd-color-text-secondary,inherit);font:inherit;font-size:12px;}
.${OVERLAY_CLASS} .element-mods-save-message-room-link:hover{color:var(--cpd-color-text-link-external,#0a84ff);text-decoration:underline;}
.${OVERLAY_CLASS} .element-mods-save-message-time{color:var(--cpd-color-text-secondary,inherit);font-size:12px;}
.${OVERLAY_CLASS} .element-mods-save-message-saved{color:var(--cpd-color-text-secondary,inherit);font-size:12px;}
.${OVERLAY_CLASS} .element-mods-save-message-remove{margin-left:auto;width:22px;height:22px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border:none;border-radius:4px;background:transparent;cursor:pointer;color:var(--cpd-color-text-secondary,inherit);font-size:14px;line-height:1;}
.${OVERLAY_CLASS} .element-mods-save-message-remove:hover{background:var(--cpd-color-bg-critical-subtle,rgba(255,92,92,.15));color:var(--cpd-color-text-critical-primary,#ff5c5c);}
.${OVERLAY_CLASS} .element-mods-save-message-body{margin-top:2px;white-space:pre-wrap;word-break:break-word;color:var(--cpd-color-text-primary,inherit);font-size:13px;user-select:text;}
`;

    let saved = loadSaved();
    let observer = null;
    let lastContext = null;
    let injectedMenu = null;
    let overlay = null;
    let overlayOpen = false;
    let scanScheduled = false;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // ------------------------------------------------------------------
    // Storage (localStorage survives app updates and mod re-application).
    // ------------------------------------------------------------------
    function loadSaved() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
            return Array.isArray(raw) ? raw : [];
        } catch {
            return [];
        }
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] failed to persist saved messages`, err);
        }
    }

    function getSaved() {
        return saved;
    }

    function isSaved(id) {
        return saved.some((m) => m.id === id);
    }

    function saveMessage(entry) {
        if (!entry || !entry.id) return;
        if (isSaved(entry.id)) return;
        entry.savedAt = Date.now();
        saved.unshift(entry);
        persist();
    }

    function unsave(id) {
        saved = saved.filter((m) => m.id !== id);
        persist();
    }

    // ------------------------------------------------------------------
    // Matrix client helpers.
    // ------------------------------------------------------------------
    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function getRoomId() {
        const m = /#\/room\/([^/?#]+)/.exec(window.location.hash);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function mediaLabel(msgtype) {
        return MSGTYPE_LABELS[msgtype] || "";
    }

    function buildSavedMessage(eventId, roomId, ctx) {
        const entry = {
            id: eventId,
            roomId: roomId || null,
            roomName: null,
            sender: ctx.sender || null,
            senderId: null,
            body: ctx.body || "",
            type: null,
            ts: null,
        };

        const c = getClient();
        let room = null;
        if (c && roomId) {
            try {
                room = c.getRoom(roomId);
            } catch {
                /* ignore */
            }
        }

        if (room) {
            try {
                entry.roomName = room.name || null;
            } catch {
                /* ignore */
            }
            let ev = null;
            try {
                ev = room.findEventById(eventId);
            } catch {
                /* ignore */
            }
            if (ev) {
                try {
                    entry.type = ev.getType();
                } catch {
                    /* ignore */
                }
                try {
                    entry.ts = ev.getTs() || null;
                } catch {
                    /* ignore */
                }
                try {
                    entry.senderId = ev.getSender() || null;
                } catch {
                    /* ignore */
                }
                let content = {};
                try {
                    content = ev.getContent() || {};
                } catch {
                    /* ignore */
                }
                if (!entry.body && typeof content.body === "string" && content.body.trim()) {
                    entry.body = content.body.trim();
                }
                if (!entry.body) entry.body = mediaLabel(content.msgtype);
            }
        }

        if (entry.senderId) {
            let user = null;
            try {
                user = c.getUser(entry.senderId);
            } catch {
                /* ignore */
            }
            if (user) {
                try {
                    entry.sender = user.displayName || entry.senderId;
                } catch {
                    entry.sender = entry.senderId;
                }
            } else {
                entry.sender = entry.senderId;
            }
        }

        if (!entry.sender) entry.sender = "Unknown sender";
        if (!entry.roomName) entry.roomName = entry.roomId || "Unknown room";
        if (!entry.ts) entry.ts = Date.now();
        return entry;
    }

    // ------------------------------------------------------------------
    // Right-click context menu handling.
    // ------------------------------------------------------------------
    function extractBody(tile) {
        const bodyEl = tile.querySelector(".mx_EventTile_body");
        if (!bodyEl) return "";
        return (bodyEl.textContent || "").trim();
    }

    function extractSender(tile) {
        for (const sel of [".mx_DisambiguatedProfile_displayName", ".mx_EventTile_sender"]) {
            const n = tile.querySelector(sel);
            if (n && n.textContent && n.textContent.trim()) return n.textContent.trim();
        }
        return null;
    }

    function onContextMenu(event) {
        lastContext = null;
        injectedMenu = null;

        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        const tile = target.closest(TILE_SELECTOR);
        if (!tile) return;

        const eventId = tile.getAttribute("data-event-id");
        if (!eventId) return;

        lastContext = {
            eventId,
            roomId: getRoomId(),
            body: extractBody(tile),
            sender: extractSender(tile),
            ts: Date.now(),
        };
    }

    function createMenuItem(alreadySaved) {
        const item = el("button", MENU_ITEM_CLASS + " mx_IconizedContextMenu_option");
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.setAttribute("tabindex", "0");

        const icon = el("span", "element-mods-save-message-menuitem-icon mx_IconizedContextMenu_icon");
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = BOOKMARK_SVG;

        const label = el("span", "mx_IconizedContextMenu_label", alreadySaved ? "Remove from saved" : "Save message");

        item.appendChild(icon);
        item.appendChild(label);
        item.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleMenuAction();
        });
        return item;
    }

    function handleMenuAction() {
        const ctx = lastContext;
        lastContext = null;
        if (!ctx || !ctx.eventId) return;

        if (isSaved(ctx.eventId)) {
            unsave(ctx.eventId);
        } else {
            saveMessage(buildSavedMessage(ctx.eventId, ctx.roomId, ctx));
        }
        updateBadge();
        closeContextMenu();
    }

    function findMenuRoot(node) {
        let root = node;
        while (
            root &&
            root.parentElement &&
            root.parentElement !== document.body &&
            root.parentElement !== document.documentElement
        ) {
            root = root.parentElement;
        }
        return root;
    }

    function closeContextMenu() {
        const menu = injectedMenu;
        injectedMenu = null;
        if (!menu || !menu.isConnected) return;

        const root = findMenuRoot(menu);
        try {
            document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
            document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        } catch {
            /* ignore */
        }
        window.setTimeout(() => {
            if (root && root.isConnected) {
                try {
                    root.remove();
                } catch {
                    /* ignore */
                }
            }
        }, 0);
    }

    function maybeInjectMenuItem() {
        if (!lastContext) return;
        if (Date.now() - lastContext.ts > CONTEXT_TIMEOUT) {
            lastContext = null;
            return;
        }

        const options = document.querySelectorAll('[role="menuitem"], .mx_IconizedContextMenu_option');
        for (const opt of options) {
            const list = opt.parentElement;
            if (!list || !list.isConnected) continue;
            if (list.getClientRects().length === 0) continue;
            if (list.querySelector("." + MENU_ITEM_CLASS)) continue;

            list.appendChild(createMenuItem(isSaved(lastContext.eventId)));
            injectedMenu = list;
            return;
        }
    }

    // ------------------------------------------------------------------
    // Sidebar button and full-screen page.
    // ------------------------------------------------------------------
    function createSidebarButton() {
        const btn = el("button", SIDEBAR_BUTTON_CLASS);
        btn.type = "button";
        btn.setAttribute("aria-label", "Saved messages");
        btn.title = "Saved messages";
        btn.innerHTML = BOOKMARK_SVG;
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleOverlay();
        });
        return btn;
    }

    function syncSidebarButton() {
        const panel = document.querySelector(SPACE_PANEL_SELECTOR);
        if (!panel) return;

        let btn = panel.querySelector("." + SIDEBAR_BUTTON_CLASS);
        if (!btn) btn = createSidebarButton();

        const qs = panel.querySelector(QUICK_SETTINGS_SELECTOR);
        if (btn.parentElement !== panel) {
            if (qs && qs.parentElement === panel) panel.insertBefore(btn, qs);
            else panel.appendChild(btn);
        } else if (qs && qs.parentElement === panel && btn.nextElementSibling !== qs) {
            panel.insertBefore(btn, qs);
        }
    }

    function updateBadge() {
        const btn = document.querySelector("." + SIDEBAR_BUTTON_CLASS);
        if (!btn) return;
        const count = getSaved().length;
        let badge = btn.querySelector(".element-mods-save-message-badge");
        if (count > 0) {
            if (!badge) {
                badge = el("span", "element-mods-save-message-badge");
                btn.appendChild(badge);
            }
            badge.textContent = count > 99 ? "99+" : String(count);
        } else if (badge) {
            badge.remove();
        }
    }

    function createOverlay() {
        const ov = el("div", OVERLAY_CLASS);
        ov.setAttribute("role", "dialog");
        ov.setAttribute("aria-modal", "true");
        ov.setAttribute("aria-label", "Saved messages");

        const header = el("div", "element-mods-save-message-overlay-header");
        const title = el("h2", "element-mods-save-message-overlay-title", "Saved messages");
        const close = el("button", "element-mods-save-message-overlay-close");
        close.type = "button";
        close.title = "Close";
        close.setAttribute("aria-label", "Close saved messages");
        close.innerHTML = CLOSE_SVG;
        close.addEventListener("click", closeOverlay);
        header.appendChild(title);
        header.appendChild(close);

        const searchWrap = el("div", "element-mods-save-message-search");
        const search = el("input");
        search.type = "search";
        search.placeholder = "Search saved messages…";
        search.setAttribute("aria-label", "Search saved messages");
        search.addEventListener("input", () => renderOverlayList(ov));
        searchWrap.appendChild(search);

        const list = el("div", "element-mods-save-message-overlay-list");
        list.setAttribute("data-save-message-list", "true");

        ov.appendChild(header);
        ov.appendChild(searchWrap);
        ov.appendChild(list);
        return ov;
    }

    function ensureOverlay() {
        if (overlay && overlay.isConnected) return overlay;
        overlay = createOverlay();
        document.body.appendChild(overlay);
        return overlay;
    }

    function renderOverlayList(ov) {
        const list = ov.querySelector("[data-save-message-list]");
        if (!list) return;
        list.textContent = "";

        const searchEl = ov.querySelector(".element-mods-save-message-search input");
        const query = (searchEl ? searchEl.value : "").trim().toLowerCase();

        const msgs = getSaved().slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        const filtered = query ? msgs.filter((m) => matchesQuery(m, query)) : msgs;

        if (filtered.length === 0) {
            list.appendChild(
                el(
                    "div",
                    "element-mods-save-message-empty",
                    query ? "No saved messages match your search." : 'No saved messages yet. Right-click a message and choose "Save message".',
                ),
            );
            return;
        }
        for (const m of filtered) list.appendChild(createMessageRow(m));
    }

    function matchesQuery(m, query) {
        const fields = [m.body, m.sender, m.senderId, m.roomName, m.roomId];
        return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(query));
    }

    function formatDate(ts) {
        if (!ts) return "";
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleDateString();
    }

    function formatTime(ts) {
        if (!ts) return "";
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }

    function formatStamp(ts) {
        const d = formatDate(ts);
        const t = formatTime(ts);
        if (d && t) return d + " " + t;
        return d || t;
    }

    function createMessageRow(m) {
        const row = el("div", "element-mods-save-message-row");

        const meta = el("div", "element-mods-save-message-row-meta");

        const sender = el("span", "element-mods-save-message-sender", m.sender || m.senderId || "Unknown sender");
        meta.appendChild(sender);

        if (m.roomId) {
            const room = el("button", "element-mods-save-message-room-link", m.roomName || m.roomId || "");
            room.type = "button";
            room.title = "Open room";
            room.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.hash = "#/room/" + encodeURIComponent(m.roomId);
                closeOverlay();
            });
            meta.appendChild(room);
        }

        const time = el("span", "element-mods-save-message-time", formatStamp(m.ts));
        meta.appendChild(time);

        const savedWhen = el("span", "element-mods-save-message-saved", "Saved " + formatStamp(m.savedAt));
        meta.appendChild(savedWhen);

        const remove = el("button", "element-mods-save-message-remove", "\u00d7");
        remove.type = "button";
        remove.title = "Remove from saved";
        remove.setAttribute("aria-label", "Remove from saved");
        remove.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            unsave(m.id);
            renderOverlayList(overlay);
            updateBadge();
        });
        meta.appendChild(remove);

        row.appendChild(meta);
        if (m.body) row.appendChild(el("div", "element-mods-save-message-body", m.body));
        return row;
    }

    function openOverlay() {
        const ov = ensureOverlay();
        renderOverlayList(ov);
        ov.classList.add(OVERLAY_OPEN_CLASS);
        overlayOpen = true;
    }

    function closeOverlay() {
        if (overlay) overlay.classList.remove(OVERLAY_OPEN_CLASS);
        overlayOpen = false;
    }

    function toggleOverlay() {
        if (overlayOpen) closeOverlay();
        else openOverlay();
    }

    function onKeydown(e) {
        if (e.key === "Escape" && overlayOpen) closeOverlay();
    }

    // ------------------------------------------------------------------
    // Lifecycle.
    // ------------------------------------------------------------------
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

    function scan() {
        syncSidebarButton();
        updateBadge();
        maybeInjectMenuItem();
    }

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            scan();
        });
    }

    function start() {
        injectStyle();
        document.addEventListener("contextmenu", onContextMenu, true);
        document.addEventListener("keydown", onKeydown, true);
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleScan();
    }

    function stop() {
        document.removeEventListener("contextmenu", onContextMenu, true);
        document.removeEventListener("keydown", onKeydown, true);
        if (observer) observer.disconnect();
        observer = null;
        lastContext = null;
        injectedMenu = null;
        document.querySelectorAll("." + SIDEBAR_BUTTON_CLASS).forEach((n) => n.remove());
        if (overlay) overlay.remove();
        overlay = null;
        overlayOpen = false;
        removeStyle();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
