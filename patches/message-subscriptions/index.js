/*
Patch: Message Subscriptions.

Lets you create "subscription channels": local-only channels, accessible only
to yourself, that gather every message containing a word you pick from a
channel (room) you pick. Config is stored in localStorage
("element-mods.message-subscriptions"), never sent to any server.

Each subscription:
  - Appears as a button in the left sidebar (the space panel), below the
    Pinned-rooms section, next to the other element-mods buttons.
  - Clicking it opens a full-screen "Subscription" view listing every matching
    message (newest first), updating live as new matching messages arrive.
  - Each row shows sender, source room, time and body, with a button to jump to
    the message in its real room.

Configuration lives in a "Subscriptions" tab added to the Settings dialog via
the loader's shared settingsTabs coordinator (same as the Room list / Hidden
rooms / Themes patches). There you add a subscription by picking a source room
from a dropdown and typing a word; you can remove subscriptions and see a live
count of how many messages match each one.

How messages are gathered:
  - Historical: iterate the source room's live timeline events and keep those
    of type m.room.message whose body contains the word (case-insensitive).
  - Live: listen to the matrix client's "Room.timeline" event and re-scan the
    affected room so newly arrived matching messages show up immediately.

The client is looked up lazily via window.mxMatrixClientPeg so it works whether
we load before or after login.
*/
(() => {
    "use strict";

    const PATCH_ID = "message-subscriptions";
    const TAB_ID = "message-subscriptions";
    const PANEL_ID = `mx_tabpanel_${TAB_ID}`;
    const STORAGE_KEY = "element-mods.message-subscriptions";

    const STYLE_ID = "element-mods-message-subscriptions-style";
    const SIDEBAR_SECTION_CLASS = "element-mods-subscriptions-sidebar";
    const SIDEBAR_BUTTON_CLASS = "element-mods-subscriptions-button";
    const OVERLAY_CLASS = "element-mods-subscriptions-overlay";
    const OVERLAY_OPEN_CLASS = "element-mods-subscriptions-overlay-open";

    const SPACE_PANEL_SELECTOR = ".mx_SpacePanel";
    const QUICK_SETTINGS_SELECTOR = ".mx_QuickSettingsButton";

    const MSG_TYPE = "m.room.message";

    const CSS = `
.${SIDEBAR_SECTION_CLASS}{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 0 2px;width:100%;box-sizing:border-box;}
.${SIDEBAR_SECTION_CLASS} .element-mods-subscriptions-divider{width:24px;height:1px;flex:0 0 auto;background:var(--cpd-color-border-disabled,rgba(128,128,128,.35));margin-bottom:2px;}
.${SIDEBAR_SECTION_CLASS} .element-mods-subscriptions-list{display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;}
.${SIDEBAR_BUTTON_CLASS}{position:relative;width:32px;height:32px;padding:0;border:none;border-radius:8px;overflow:visible;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;background:var(--cpd-color-bg-subtle-secondary,rgba(128,128,128,.2));color:var(--cpd-color-text-primary,inherit);}
.${SIDEBAR_BUTTON_CLASS}:hover{box-shadow:0 0 0 2px var(--cpd-color-bg-action-primary,#0dbd8b);}
.${SIDEBAR_BUTTON_CLASS} .element-mods-subscriptions-initial{color:var(--cpd-color-text-primary,inherit);font-weight:600;font-size:13px;line-height:1;}

.${OVERLAY_CLASS} .element-mods-subscriptions-room-link{background:none;border:none;padding:0;cursor:pointer;color:var(--cpd-color-text-secondary,inherit);font:inherit;font-size:12px;}
.${OVERLAY_CLASS} .element-mods-subscriptions-room-link:hover{color:var(--cpd-color-text-link-external,#0a84ff);text-decoration:underline;}

.${OVERLAY_CLASS}{position:fixed;inset:0;z-index:2147483000;display:none;flex-direction:column;background:var(--cpd-color-bg-canvas-default,var(--cpd-color-bg-canvas,#ffffff));color:var(--cpd-color-text-primary,inherit);font-family:inherit;}
.${OVERLAY_CLASS}.${OVERLAY_OPEN_CLASS}{display:flex;}
.${OVERLAY_CLASS} .element-mods-subscriptions-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.3));}
.${OVERLAY_CLASS} .element-mods-subscriptions-overlay-title{font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);margin:0;}
.${OVERLAY_CLASS} .element-mods-subscriptions-overlay-sub{font-size:12px;color:var(--cpd-color-text-secondary,inherit);}
.${OVERLAY_CLASS} .element-mods-subscriptions-overlay-close{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--cpd-color-icon-primary,inherit);}
.${OVERLAY_CLASS} .element-mods-subscriptions-overlay-close:hover{background:var(--cpd-color-bg-subtle-secondary,rgba(128,128,128,.2));}
.${OVERLAY_CLASS} .element-mods-subscriptions-overlay-list{flex:1;overflow-y:auto;padding:8px 12px;}
.${OVERLAY_CLASS} .element-mods-subscriptions-empty{color:var(--cpd-color-text-secondary,inherit);padding:16px 0;text-align:center;font-size:13px;}
.${OVERLAY_CLASS} .element-mods-subscriptions-row{padding:6px 10px;border-radius:6px;background:var(--cpd-color-bg-subtle-secondary,transparent);margin-bottom:4px;}
.${OVERLAY_CLASS} .element-mods-subscriptions-row-meta{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.4;}
.${OVERLAY_CLASS} .element-mods-subscriptions-sender{font-weight:600;color:var(--cpd-color-text-primary,inherit);font-size:13px;}
.${OVERLAY_CLASS} .element-mods-subscriptions-time{color:var(--cpd-color-text-secondary,inherit);font-size:12px;}
.${OVERLAY_CLASS} .element-mods-subscriptions-body{margin-top:2px;white-space:pre-wrap;word-break:break-word;color:var(--cpd-color-text-primary,inherit);font-size:13px;user-select:text;}
`;

    // ------------------------------------------------------------------
    // State.
    // ------------------------------------------------------------------
    let subscriptions = loadSubscriptions();
    let client = null;
    let observer = null;
    let refreshTimer = null;
    let positionScheduled = false;
    let refreshScheduled = false;
    let overlay = null;
    let overlayOpen = false;
    let activeSubId = null;
    let tabRegistered = false;

    // ------------------------------------------------------------------
    // Storage (localStorage survives app updates and mod re-application).
    // ------------------------------------------------------------------
    function loadSubscriptions() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
            if (!Array.isArray(raw)) return [];
            return raw.filter(
                (s) => s && typeof s.roomId === "string" && s.roomId && typeof s.word === "string" && s.word.trim(),
            );
        } catch {
            return [];
        }
    }

    function persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(subscriptions));
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] failed to persist subscriptions`, err);
        }
    }

    function getSubscriptions() {
        return subscriptions;
    }

    function addSubscription(roomId, roomName, word, days) {
        if (!roomId || !word || !word.trim()) return;
        const id = roomId + "\u0000" + word.trim().toLowerCase();
        if (subscriptions.some((s) => s.id === id)) return;
        subscriptions.push({
            id,
            roomId,
            roomName: roomName || roomId,
            word: word.trim(),
            days: Math.max(0, Math.floor(Number(days) || 0)),
            createdAt: Date.now(),
        });
        persist();
        onChanged();
    }

    function removeSubscription(id) {
        subscriptions = subscriptions.filter((s) => s.id !== id);
        persist();
        if (activeSubId === id) closeOverlay();
        onChanged();
    }

    function getSub(id) {
        return subscriptions.find((s) => s.id === id);
    }

    // ------------------------------------------------------------------
    // Matrix client helpers.
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

    function getRoom(id) {
        const c = getClient();
        if (!c || !id) return null;
        try {
            return c.getRoom(id);
        } catch {
            return null;
        }
    }

    function listRooms() {
        const c = getClient();
        if (!c) return [];
        try {
            return c.getRooms() || [];
        } catch {
            return [];
        }
    }

    function roomName(room) {
        if (!room) return null;
        try {
            const n = room.name;
            if (n && n.trim()) return n.trim();
        } catch {
            /* ignore */
        }
        return room.roomId || null;
    }

    function senderName(c, senderId) {
        if (!senderId) return null;
        try {
            const user = c.getUser(senderId);
            if (user && user.displayName) return user.displayName;
        } catch {
            /* ignore */
        }
        return senderId;
    }

    // ------------------------------------------------------------------
    // Message matching.
    // ------------------------------------------------------------------
    function bodyOf(event) {
        try {
            const content = event.getContent ? event.getContent() : event.content;
            if (content && typeof content.body === "string") return content.body;
        } catch {
            /* ignore */
        }
        return "";
    }

    function matchesWord(event, word) {
        if (!event) return false;
        try {
            if (event.getType && event.getType() !== MSG_TYPE) return false;
            if (event.getType && event.getType() === "m.room.redaction") return false;
        } catch {
            /* ignore */
        }
        const body = bodyOf(event);
        return bodyMatchesWord(body, word);
    }

    // Pure predicate: does a message body contain the word (case-insensitive)?
    function bodyMatchesWord(body, word) {
        if (!body || !word) return false;
        return body.toLowerCase().indexOf(String(word).toLowerCase()) !== -1;
    }

    // Collect matching events from a room's live timeline (newest first).
    // `days` (0 = no limit) bounds how far back we scan, so huge channels stay cheap.
    function matchingEvents(roomId, word, days) {
        const room = getRoom(roomId);
        if (!room) return [];
        const cutoff = days && days > 0 ? Date.now() - days * 86400000 : null;
        const out = [];
        let events = [];
        try {
            events = room.getLiveTimeline().getEvents() || [];
        } catch {
            /* ignore */
        }
        for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            if (cutoff) {
                try {
                    if (ev.getTs() < cutoff) break;
                } catch {
                    /* ignore */
                }
            }
            if (matchesWord(ev, word)) out.push(ev);
        }
        return out;
    }

    function describeEvent(ev) {
        const c = getClient();
        let senderId = null;
        let ts = null;
        try {
            senderId = ev.getSender();
        } catch {
            /* ignore */
        }
        try {
            ts = ev.getTs();
        } catch {
            /* ignore */
        }
        return {
            id: null,
            senderId,
            sender: senderName(c, senderId),
            body: bodyOf(ev),
            ts: ts || Date.now(),
        };
    }

    // Full display list for a subscription: events enriched with sender, room.
    function buildDisplay(sub) {
        const room = getRoom(sub.roomId);
        const roomLabel = roomName(room) || sub.roomName || sub.roomId;
        const events = matchingEvents(sub.roomId, sub.word, sub.days);
        return events.map((ev) => {
            const d = describeEvent(ev);
            return { ...d, roomLabel, roomId: sub.roomId, subId: sub.id, word: sub.word };
        });
    }
    // ------------------------------------------------------------------
    // Sidebar buttons (below pinned rooms).
    // ------------------------------------------------------------------
    function createSidebar() {
        const section = document.createElement("div");
        section.className = SIDEBAR_SECTION_CLASS;

        const divider = document.createElement("div");
        divider.className = "element-mods-subscriptions-divider";
        const list = document.createElement("div");
        list.className = "element-mods-subscriptions-list";
        section.appendChild(divider);
        section.appendChild(list);
        return section;
    }

    function createSidebarButton(sub) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = SIDEBAR_BUTTON_CLASS;
        btn.setAttribute("data-sub-id", sub.id);
        btn.title = `"${sub.word}" in ${sub.roomName}`;
        btn.setAttribute("aria-label", `Open subscription: ${sub.word}`);

        const initial = document.createElement("span");
        initial.className = "element-mods-subscriptions-initial";
        initial.textContent = sub.word.charAt(0).toUpperCase();
        btn.appendChild(initial);

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openSubscription(sub.id);
        });
        return btn;
    }

    function getSidebarSection(panel) {
        return panel.querySelector("." + SIDEBAR_SECTION_CLASS);
    }

    // Keep the section present in the space panel. Critical: once placed, it is
    // NEVER moved here — moving a sibling of React's space-panel children on
    // every body mutation fights the Pin Rooms patch's own injection (each move
    // triggers the other's observer) and breaks hover/click on the whole panel.
    // So this only (re)inserts a missing section; correction happens on the
    // slow interval only.
    function positionSidebar() {
        const panel = document.querySelector(SPACE_PANEL_SELECTOR);
        if (!panel) return;
        const section = getSidebarSection(panel);
        if (subscriptions.length === 0) {
            if (section) section.remove();
            return;
        }
        if (section && section.parentElement === panel) return;

        const fresh = section || createSidebar();
        const anchor = panel.querySelector(QUICK_SETTINGS_SELECTOR);
        try {
            if (anchor && anchor.parentElement === panel) panel.insertBefore(fresh, anchor);
            else panel.appendChild(fresh);
        } catch {
            /* ignore */
        }
    }

    // Expensive: rebuild the buttons with fresh match counts. Only called on
    // config changes or relevant timeline events (never on every body mutation).
    function refreshSidebarContent() {
        const panel = document.querySelector(SPACE_PANEL_SELECTOR);
        const section = panel && getSidebarSection(panel);
        if (!section) return;
        const list = section.querySelector(".element-mods-subscriptions-list");
        if (!list) return;
        list.textContent = "";
        for (const sub of subscriptions) {
            list.appendChild(createSidebarButton(sub));
        }
    }

    // ------------------------------------------------------------------
    // Full-screen subscription view.
    // ------------------------------------------------------------------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function formatStamp(ts) {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleString();
    }

    function createOverlay() {
        const ov = el("div", OVERLAY_CLASS);
        ov.setAttribute("role", "dialog");
        ov.setAttribute("aria-modal", "true");
        ov.setAttribute("aria-label", "Subscription");

        const header = el("div", "element-mods-subscriptions-overlay-header");
        const left = el("div");
        const title = el("h2", "element-mods-subscriptions-overlay-title");
        const sub = el("div", "element-mods-subscriptions-overlay-sub");
        const close = el("button", "element-mods-subscriptions-overlay-close");
        close.type = "button";
        close.title = "Close";
        close.setAttribute("aria-label", "Close");
        close.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
        close.addEventListener("click", closeOverlay);
        left.appendChild(title);
        left.appendChild(sub);
        header.appendChild(left);
        header.appendChild(close);

        const list = el("div", "element-mods-subscriptions-overlay-list");
        list.setAttribute("data-subscriptions-list", "true");

        ov.appendChild(header);
        ov.appendChild(list);
        return ov;
    }

    function ensureOverlay() {
        if (overlay && overlay.isConnected) return overlay;
        overlay = createOverlay();
        document.body.appendChild(overlay);
        return overlay;
    }

    function renderOverlay(sub) {
        const ov = ensureOverlay();
        ov.querySelector(".element-mods-subscriptions-overlay-title").textContent = `"${sub.word}"`;
        ov.querySelector(".element-mods-subscriptions-overlay-sub").textContent = `in ${sub.roomName}`;

        const list = ov.querySelector("[data-subscriptions-list]");
        list.textContent = "";

        const items = buildDisplay(sub);
        if (items.length === 0) {
            list.appendChild(
                el("div", "element-mods-subscriptions-empty", `No messages in ${sub.roomName} contain "${sub.word}".`),
            );
            return;
        }
        for (const m of items) list.appendChild(createRow(m));
    }

    function createRow(m) {
        const row = el("div", "element-mods-subscriptions-row");

        const meta = el("div", "element-mods-subscriptions-row-meta");
        const sender = el("span", "element-mods-subscriptions-sender", m.sender || m.senderId || "Unknown sender");
        meta.appendChild(sender);
        if (m.roomId) {
            const room = el("button", "element-mods-subscriptions-room-link", m.roomLabel);
            room.type = "button";
            room.title = "Open in its room";
            room.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeOverlay();
                window.location.hash = "#/room/" + encodeURIComponent(m.roomId);
            });
            meta.appendChild(room);
        }
        const time = el("span", "element-mods-subscriptions-time", formatStamp(m.ts));
        meta.appendChild(time);

        row.appendChild(meta);
        if (m.body) row.appendChild(el("div", "element-mods-subscriptions-body", m.body));
        return row;
    }

    function openSubscription(id) {
        const sub = getSub(id);
        if (!sub) return;
        activeSubId = id;
        const ov = ensureOverlay();
        renderOverlay(sub);
        ov.classList.add(OVERLAY_OPEN_CLASS);
        overlayOpen = true;
    }

    function closeOverlay() {
        if (overlay) overlay.classList.remove(OVERLAY_OPEN_CLASS);
        overlayOpen = false;
        activeSubId = null;
    }

    function refreshOverlay() {
        const sub = activeSubId ? getSub(activeSubId) : null;
        if (!sub || !overlayOpen) return;
        renderOverlay(sub);
    }

    function onKeydown(e) {
        if (e.key === "Escape" && overlayOpen) closeOverlay();
    }

    // ------------------------------------------------------------------
    // Settings tab ("Subscriptions").
    // ------------------------------------------------------------------
    function createTabLabel() {
        const li = el("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-controls", PANEL_ID);
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", "settings-tab-" + TAB_ID);

        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/><path d="M9 9l3 3 3-3"/></svg>';

        li.appendChild(icon);
        li.appendChild(el("span", "mx_TabbedView_tabLabel_text", "Subscriptions"));
        return li;
    }

    function createSwitch(checked, onChange) {
        const wrap = el("span");
        wrap.style.cssText = "position:relative;display:inline-block;width:38px;height:22px;flex:0 0 auto;";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = checked;
        input.style.cssText =
            "position:absolute;inset:0;z-index:1;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;";
        const track = el("span");
        track.style.cssText =
            "position:absolute;inset:0;border-radius:999px;background:#d3d3d3;transition:background .15s ease;pointer-events:none;";
        const knob = el("span");
        knob.style.cssText =
            "position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s ease;pointer-events:none;";
        function paint() {
            track.style.background = input.checked ? "var(--cpd-color-bg-action-primary,#0dbd8b)" : "#d3d3d3";
            knob.style.transform = input.checked ? "translateX(16px)" : "translateX(0)";
        }
        paint();
        input.addEventListener("change", () => {
            paint();
            onChange(input.checked);
        });
        wrap.appendChild(input);
        wrap.appendChild(track);
        wrap.appendChild(knob);
        return wrap;
    }

    function buildRoomOptions(selectedId) {
        const rooms = listRooms().sort((a, b) => {
            const na = (roomName(a) || "").toLowerCase();
            const nb = (roomName(b) || "").toLowerCase();
            return na < nb ? -1 : na > nb ? 1 : 0;
        });
        const opts = [];
        for (const room of rooms) {
            const id = room.roomId;
            if (!id) continue;
            const opt = el("option", null, roomName(room) || id);
            opt.value = id;
            if (id === selectedId) opt.selected = true;
            opts.push(opt);
        }
        return opts;
    }

    function createAddForm() {
        const wrap = el("div");
        wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

        const select = document.createElement("select");
        select.setAttribute("aria-label", "Source channel");
        select.style.cssText =
            "flex:1;min-width:180px;padding:6px 8px;border:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.4));border-radius:8px;background:var(--cpd-color-bg-subtle-secondary,transparent);color:var(--cpd-color-text-primary,inherit);font:inherit;";
        const placeholder = el("option", null, "Choose a channel…");
        placeholder.value = "";
        placeholder.selected = true;
        placeholder.disabled = true;
        select.appendChild(placeholder);
        for (const opt of buildRoomOptions(null)) select.appendChild(opt);

        const word = document.createElement("input");
        word.type = "text";
        word.placeholder = "word (e.g. notidoc)";
        word.setAttribute("aria-label", "Word to match");
        word.style.cssText =
            "flex:0 0 160px;padding:6px 10px;border:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.4));border-radius:8px;background:var(--cpd-color-bg-subtle-secondary,transparent);color:var(--cpd-color-text-primary,inherit);font:inherit;outline:none;";

        const days = document.createElement("input");
        days.type = "number";
        days.min = "0";
        days.value = "7";
        days.title = "Only look at messages from the last N days (0 = no limit)";
        days.setAttribute("aria-label", "Look back (days, 0 = no limit)");
        days.style.cssText =
            "flex:0 0 74px;padding:6px 8px;border:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.4));border-radius:8px;background:var(--cpd-color-bg-subtle-secondary,transparent);color:var(--cpd-color-text-primary,inherit);font:inherit;outline:none;";

        const add = el("button", null, "Add subscription");
        add.type = "button";
        add.style.cssText =
            "flex:0 0 auto;padding:6px 14px;border:none;border-radius:8px;background:var(--cpd-color-bg-action-primary,#0dbd8b);color:#fff;cursor:pointer;font:inherit;font-weight:600;";
        add.addEventListener("click", () => {
            const roomId = select.value;
            const room = getRoom(roomId);
            const name = room ? roomName(room) : roomId;
            const w = word.value.trim();
            if (!roomId || !w) {
                select.focus();
                return;
            }
            addSubscription(roomId, name, w, days.value);
            word.value = "";
            days.value = "7";
            refreshPanel();
        });

        wrap.appendChild(select);
        wrap.appendChild(word);
        wrap.appendChild(days);
        wrap.appendChild(add);
        return wrap;
    }

    function subscriptionRow(sub) {
        const row = el("div");
        row.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const left = el("div");
        left.style.cssText = "min-width:0;";

        const title = el("span", null, `"${sub.word}"`);
        title.style.cssText = "font-weight:600;";
        const desc = el("div", null, `in ${sub.roomName}`);
        desc.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";

        const count = matchingEvents(sub.roomId, sub.word, sub.days).length;
        const bound = sub.days && sub.days > 0 ? ` (last ${sub.days} day${sub.days === 1 ? "" : "s"})` : "";
        const countEl = el("div", null, count + (count === 1 ? " matching message" : " matching messages") + bound);
        countEl.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";

        left.appendChild(title);
        left.appendChild(desc);
        left.appendChild(countEl);

        const remove = el("button", null, "Remove");
        remove.type = "button";
        remove.style.cssText =
            "flex:0 0 auto;padding:4px 12px;border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);border-radius:8px;background:transparent;color:inherit;cursor:pointer;font-size:13px;";
        remove.addEventListener("click", () => {
            removeSubscription(sub.id);
            refreshPanel();
        });

        row.appendChild(left);
        row.appendChild(remove);
        return row;
    }

    function createPanelContent() {
        const content = el("div");
        content.style.cssText = "padding:24px;max-width:680px;";

        const title = el("h3", null, "Message subscriptions");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";
        content.appendChild(title);

        const subtitle = el(
            "div",
            null,
            "Create a local-only channel that gathers every message containing a word from a channel you choose. Each appears as a button in the left sidebar.",
        );
        subtitle.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";

        content.appendChild(subtitle);
        content.appendChild(createAddForm());

        const hint = el(
            "div",
            null,
            "For example: pick 'Escalade Support-DEV' and type 'notidoc' — every message in that channel containing 'notidoc' will appear in your subscription channel.",
        );
        hint.style.cssText = "margin:8px 0 16px;font-size:12px;color:var(--cpd-color-text-secondary,inherit);";

        const list = el("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        list.setAttribute("data-subscriptions-list-panel", "true");
        if (subscriptions.length === 0) {
            list.appendChild(el("div", null, "No subscriptions yet."));
        } else {
            for (const sub of subscriptions) list.appendChild(subscriptionRow(sub));
        }
        content.appendChild(list);
        return content;
    }

    function createPanel() {
        const panel = el("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", PANEL_ID + "_label");
        panel.setAttribute("data-subscriptions-panel", "true");

        const scroller = el("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        scroller.appendChild(createPanelContent());
        panel.appendChild(scroller);
        return panel;
    }

    function refreshPanel() {
        const panel = document.querySelector("[data-subscriptions-panel]");
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
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    // Cheap positioning only — safe to run on every body mutation.
    function onPositionChanged() {
        if (positionScheduled) return;
        positionScheduled = true;
        requestAnimationFrame(() => {
            positionScheduled = false;
            positionSidebar();
        });
    }

    // Expensive refresh (recounts matching messages) — debounced, only on
    // config changes or relevant timeline events, never on body mutations.
    function refreshContent() {
        refreshSidebarContent();
        refreshOverlay();
        refreshPanel();
    }

    function scheduleRefresh() {
        if (refreshScheduled) return;
        refreshScheduled = true;
        requestAnimationFrame(() => {
            refreshScheduled = false;
            refreshContent();
        });
    }

    function onChanged() {
        onPositionChanged();
        scheduleRefresh();
    }

    function attachClient() {
        const c = getClient();
        if (!c) return;
        if (client === c) return;
        detachClient();
        client = c;
        try {
            client.on("Room.timeline", onTimeline);
            client.on("sync", onChanged);
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] attach failed`, err);
            client = null;
            return;
        }
        scheduleRefresh();
    }

    function detachClient() {
        if (client && typeof client.off === "function") {
            try {
                client.off("Room.timeline", onTimeline);
            } catch {
                /* ignore */
            }
            try {
                client.off("sync", onChanged);
            } catch {
                /* ignore */
            }
        }
        client = null;
    }

    function onTimeline(event, room, toStartOfTimeline) {
        if (toStartOfTimeline) return;
        const roomId = room && room.roomId;
        const relevant = subscriptions.some((s) => s.roomId === roomId && matchesWord(event, s.word));
        if (relevant) scheduleRefresh();
    }

    function start() {
        injectStyle();
        observer = new MutationObserver(onPositionChanged);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("keydown", onKeydown, true);
        attachClient();
        refreshTimer = setInterval(() => {
            attachClient();
            positionSidebar();
        }, 5000);
        if (!tabRegistered && window.mods && window.mods.settingsTabs) {
            window.mods.settingsTabs.register(TAB_ID, { label: createTabLabel(), renderPanel: createPanel });
            tabRegistered = true;
        }
        positionSidebar();
        refreshSidebarContent();
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        document.removeEventListener("keydown", onKeydown, true);
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        detachClient();
        if (tabRegistered && window.mods && window.mods.settingsTabs) {
            window.mods.settingsTabs.unregister(TAB_ID);
        }
        tabRegistered = false;
        // Remove every sidebar section (not just the tracked one) so nothing is
        // left behind across re-renders.
        document.querySelectorAll("." + SIDEBAR_SECTION_CLASS).forEach((n) => n.remove());
        if (overlay) overlay.remove();
        overlay = null;
        overlayOpen = false;
        activeSubId = null;
        removeStyle();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop, _test: { bodyMatchesWord } });
})();
