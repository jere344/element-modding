/*
Patch: Message Logger.

When we see a message in the timeline (either as it renders in the DOM or as it
arrives via the matrix client), we remember its text locally in localStorage.
If that message is later redacted, Element swaps it for a grey "[Message
deleted]" placeholder. This patch detects that placeholder, looks up the text we
remembered, and shows it in red with a dismiss button. Clicking the button
removes the red overlay and restores the original grey placeholder.

Storage is keyed by event id and capped so it can't grow unbounded. Dismissals
are persisted too, so a message you already dismissed stays hidden across reloads.
*/
(() => {
    "use strict";

    const PATCH_ID = "message-logger";
    const STORAGE_KEY = "element-mods.show-deleted.messages";
    const STYLE_ID = "element-mods-show-deleted-style";
    const MAX_ENTRIES = 2000;
    const MAX_BODY_LENGTH = 5000;
    const ATTACH_INTERVAL = 5000;

    const TILE_SELECTOR = ".mx_EventTile[data-event-id]";
    const BODY_SELECTOR = ".mx_EventTile_body";
    const REDACTED_SELECTOR = ".mx_RedactedBody";
    const INJECTED_SELECTOR = ".element-mods-show-deleted-body";

    const MSGTYPE_LABELS = {
        "m.image": "Image",
        "m.video": "Video",
        "m.audio": "Audio",
        "m.file": "File",
    };

    let store = loadStore();
    let observer = null;
    let client = null;
    let attachTimer = null;
    let scanScheduled = false;

    function loadStore() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            return raw && typeof raw === "object" ? raw : {};
        } catch {
            return {};
        }
    }

    function saveStore() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] failed to persist messages`, err);
        }
    }

    function prune() {
        const keys = Object.keys(store);
        if (keys.length <= MAX_ENTRIES) return;
        keys.sort((a, b) => ((store[a] && store[a].ts) || 0) - ((store[b] && store[b].ts) || 0));
        for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete store[keys[i]];
    }

    function storeMessage(id, body, sender, ts) {
        if (!id || !body) return;
        if (store[id]) return;
        if (body.length > MAX_BODY_LENGTH) body = body.slice(0, MAX_BODY_LENGTH);
        store[id] = { body, sender: sender || null, ts: ts || Date.now() };
        prune();
        saveStore();
    }

    function isDismissed(id) {
        const entry = store[id];
        return !!(entry && entry.dismissed);
    }

    function markDismissed(id) {
        const entry = store[id];
        if (entry) {
            entry.dismissed = true;
            saveStore();
        }
    }

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function labelForMsgType(msgtype) {
        return MSGTYPE_LABELS[msgtype] || "";
    }

    function storeEvent(ev) {
        if (!ev || typeof ev.getType !== "function") return;
        if (ev.getType() !== "m.room.message") return;
        const id = ev.getId();
        if (!id || store[id]) return;

        let content = {};
        try {
            content = ev.getContent() || {};
        } catch {
            return;
        }
        let body = typeof content.body === "string" ? content.body.trim() : "";
        if (!body) body = labelForMsgType(content.msgtype);
        if (!body) return;

        let sender = null;
        let ts = null;
        try {
            sender = ev.getSender();
        } catch {
            /* ignore */
        }
        try {
            ts = ev.getTs();
        } catch {
            /* ignore */
        }
        storeMessage(id, body, sender, ts);
    }

    function onTimeline(event, room, toStart, removed) {
        if (removed) return;
        storeEvent(event);
    }

    function seedFromRooms(c) {
        let rooms = [];
        try {
            rooms = c.getRooms() || [];
        } catch {
            return;
        }
        for (const room of rooms) {
            let events = [];
            try {
                const timeline = room.getLiveTimeline();
                if (timeline) events = timeline.getEvents() || [];
            } catch {
                /* ignore */
            }
            for (const ev of events) storeEvent(ev);
        }
    }

    function attachClient() {
        const c = getClient();
        if (!c) return;
        if (client === c) return;
        if (client) detachClient();
        client = c;
        try {
            client.on("Room.timeline", onTimeline);
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] attach failed`, err);
            client = null;
            return;
        }
        seedFromRooms(c);
    }

    function detachClient() {
        if (client && typeof client.off === "function") {
            try {
                client.off("Room.timeline", onTimeline);
            } catch {
                /* ignore */
            }
        }
        client = null;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
${INJECTED_SELECTOR}{display:inline-flex;align-items:center;gap:6px;}
.element-mods-show-deleted-text{color:var(--cpd-color-text-critical-primary,#ff5c5c);font-style:italic;}
.element-mods-show-deleted-dismiss{background:none;border:none;color:var(--cpd-color-text-critical-primary,#ff5c5c);cursor:pointer;font-size:14px;line-height:1;padding:2px 5px;border-radius:4px;}
.element-mods-show-deleted-dismiss:hover{color:#ff2a2a;background:rgba(255,92,92,.14);}
`;
        document.head.appendChild(style);
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    function createOverlay(id, body, onDismiss) {
        const wrap = document.createElement("span");
        wrap.className = "element-mods-show-deleted-body";
        wrap.setAttribute("data-event-id", id);

        const text = document.createElement("span");
        text.className = "element-mods-show-deleted-text";
        text.textContent = body;
        wrap.appendChild(text);

        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "element-mods-show-deleted-dismiss";
        dismiss.setAttribute("aria-label", "Dismiss deleted message");
        dismiss.title = "Dismiss";
        dismiss.textContent = "\u00d7";
        dismiss.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
        });
        wrap.appendChild(dismiss);

        return wrap;
    }

    function injectDeleted(redacted, id, body) {
        redacted.style.display = "none";
        redacted.setAttribute("data-element-mods-hidden", "1");
        const overlay = createOverlay(id, body, () => dismissDeleted(redacted, overlay, id));
        redacted.parentNode.insertBefore(overlay, redacted.nextSibling);
    }

    function dismissDeleted(redacted, overlay, id) {
        if (overlay) overlay.remove();
        if (redacted && redacted.isConnected) {
            redacted.style.display = "";
            redacted.removeAttribute("data-element-mods-hidden");
        }
        markDismissed(id);
    }

    function handleRedacted(tile, redacted, id) {
        if (isDismissed(id)) return;

        const existing = tile.querySelector(INJECTED_SELECTOR);
        if (existing) {
            if (redacted.style.display !== "none") redacted.style.display = "none";
            return;
        }

        const entry = store[id];
        if (!entry || !entry.body) return;

        injectDeleted(redacted, id, entry.body);
    }

    function processTiles() {
        const tiles = document.querySelectorAll(TILE_SELECTOR);
        for (const tile of tiles) {
            const id = tile.getAttribute("data-event-id");
            if (!id) continue;

            const redacted = tile.querySelector(REDACTED_SELECTOR);
            if (redacted) {
                handleRedacted(tile, redacted, id);
                continue;
            }

            if (!store[id]) {
                const bodyEl = tile.querySelector(BODY_SELECTOR);
                if (bodyEl) {
                    const text = (bodyEl.textContent || "").trim();
                    if (text) storeMessage(id, text, null, Date.now());
                }
            }
        }
    }

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            processTiles();
        });
    }

    function start() {
        injectStyle();
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
        attachClient();
        attachTimer = setInterval(attachClient, ATTACH_INTERVAL);
        scheduleScan();
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        if (attachTimer) clearInterval(attachTimer);
        attachTimer = null;
        detachClient();

        document.querySelectorAll(INJECTED_SELECTOR).forEach((overlay) => {
            const tile = overlay.closest(".mx_EventTile");
            const redacted = tile ? tile.querySelector(REDACTED_SELECTOR) : null;
            overlay.remove();
            if (redacted) {
                redacted.style.display = "";
                redacted.removeAttribute("data-element-mods-hidden");
            }
        });
        removeStyle();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
