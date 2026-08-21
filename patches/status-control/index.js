/*
Patch: Status Control.

Fuses the old "Always Online" and "My Activity" patches into a single status
control:

  - Right-clicking your profile picture in the top-left corner (.mx_UserMenu)
    opens a small menu to pick your status: Online, Away, Offline, Busy or
    Automatic. Left-click still opens Element's normal user menu. The chosen
    mode is remembered in localStorage and applied to the matrix client even
    when Element's own idle/away logic tries to change it.
  - A presence dot (online / away / offline / busy) is shown on your avatar in
    the top-left corner, matching the indicator Element renders on other users.

How the forcing works:
  Element's presence auto-logic (the "Presence" class) flips you to
  "unavailable" after 3 minutes of inactivity by calling
  MatrixClient.setSyncPresence(), and the SDK's MatrixClient.setPresence()
  validates the presence value against a fixed list. This patch hooks BOTH of
  those instance methods on the current client: every call is rewritten to the
  forced status, so idle/away/blur handlers can no longer change it. The busy
  status ("org.matrix.msc3026.busy") is not accepted by setPresence(), so for
  busy we route it through setSyncPresence() instead, letting /sync carry it.
  Choosing "Automatic" unhooks the client and shows your real presence.

The client is looked up lazily via window.mxMatrixClientPeg so this works
before login and when the client is recreated after login/logout.
*/
(() => {
    "use strict";

    const PATCH_ID = "status-control";
    const MODE_KEY = "element-mods.status-control.mode";
    const USER_MENU_SELECTOR = ".mx_UserMenu";
    const AVATAR_SELECTOR = '[role="img"][data-type="round"]';
    const INJECTED_SELECTOR = ".element-mods-status-control";
    const REASSERT_INTERVAL = 15000;

    const SVG_NS = "http://www.w3.org/2000/svg";

    const MODES = [
        { id: "online", label: "Online", presence: "online" },
        { id: "away", label: "Away", presence: "unavailable" },
        { id: "offline", label: "Offline", presence: "offline" },
        { id: "auto", label: "Automatic", presence: null },
    ];
    const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

    // SVG path data copied from Element's compound-design-tokens icons so the
    // dot is pixel-identical to the one used for other users.
    const ICON_PATHS = {
        solid: "M8 4a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
        outline: "M4 6.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M4 8a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
        strikethrough:
            "M8 4a4 4 0 1 1-8 0 4 4 0 0 1 8 0M5.435 6.048A2.5 2.5 0 0 1 1.687 3.05zm.914-1.19L2.648 1.897a2.5 2.5 0 0 1 3.701 2.961",
    };

    let observer = null;
    let client = null;
    let clientUser = null;
    let refreshTimer = null;
    let scanScheduled = false;
    let popover = null;
    const originals = new Map(); // client -> { setSyncPresence, setPresence }

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function getOwnUserId(c) {
        return c.getSafeUserId();
    }

    // -- stored mode -----------------------------------------------------

    function getMode() {
        try {
            const raw = window.localStorage.getItem(MODE_KEY);
            if (raw && MODE_BY_ID[raw]) return raw;
        } catch (_) {
            /* localStorage unavailable */
        }
        return "auto";
    }

    function setMode(mode) {
        try {
            window.localStorage.setItem(MODE_KEY, mode);
        } catch (_) {
            /* localStorage unavailable */
        }
    }

    function isForced() {
        const mode = getMode();
        return mode !== "auto" && !!MODE_BY_ID[mode].presence;
    }

    function forcedPresence() {
        return isForced() ? MODE_BY_ID[getMode()].presence : null;
    }

    // -- presence forcing ------------------------------------------------

    function hookClient(c) {
        if (originals.has(c)) return;

        const origSetSyncPresence = c.setSyncPresence;
        const origSetPresence = c.setPresence;
        if (typeof origSetSyncPresence !== "function" || typeof origSetPresence !== "function") return;

        originals.set(c, { setSyncPresence: origSetSyncPresence, setPresence: origSetPresence });

        c.setSyncPresence = function () {
            return origSetSyncPresence.call(c, forcedPresence());
        };

        c.setPresence = function (opts) {
            const forced = forcedPresence();
            if (forced === BUSY) {
                // Busy is rejected by the SDK's setPresence validation, so let
                // the next sync carry it via setSyncPresence instead.
                return origSetSyncPresence.call(c, forced);
            }
            if (opts && typeof opts === "object") {
                return origSetPresence.call(c, Object.assign({}, opts, { presence: forced }));
            }
            return origSetPresence.call(c, { presence: forced });
        };
    }

    function unhookClient(c) {
        const record = originals.get(c);
        if (!record) return;
        c.setSyncPresence = record.setSyncPresence;
        c.setPresence = record.setPresence;
        originals.delete(c);
    }

    function ownRawPresence(c) {
        const userId = getOwnUserId(c);
        if (!userId) return null;
        try {
            const user = c.getUser(userId);
            return user ? user.presence : null;
        } catch (_) {
            return null;
        }
    }

    function forcePresenceNow(c) {
        const forced = forcedPresence();
        if (!forced) return;
        try {
            c.setSyncPresence(forced);
        } catch (err) {
            console.warn("[element-mods:status-control] setSyncPresence failed", err);
        }
        const current = ownRawPresence(c);
        if (current !== forced && forced !== BUSY) {
            try {
                c.setPresence({ presence: forced });
            } catch (err) {
                console.warn("[element-mods:status-control] setPresence failed", err);
            }
        }
    }

    function applyMode() {
        const c = client;
        if (!c) return;
        if (!isForced()) {
            unhookClient(c);
            return;
        }
        hookClient(c);
        forcePresenceNow(c);
    }

    // -- presence dot -----------------------------------------------------

    // Mirrors the presence resolution in Element's WithPresenceIndicator.
    function getPresenceState() {
        if (!client) return null;
        const userId = getOwnUserId(client);
        if (!userId) return null;

        let user;
        try {
            user = client.getUser(userId);
        } catch (_) {
            return null;
        }
        if (!user) return null;

        const presence = user.presence;
        if (BUSY_PRESENCE.includes(presence)) return "dnd";

        const isOnline = user.currentlyActive || presence === "online";
        if (isOnline) return "online";
        if (presence === "offline") return "offline";
        if (presence === "unavailable" || presence === "io.element.unreachable") return "unavailable";

        return null;
    }

    // State shown on the avatar dot / menu.
    function getDisplayState() {
        const mode = getMode();
        if (mode === "online") return "online";
        if (mode === "away") return "unavailable";
        if (mode === "offline") return "offline";
        if (mode === "busy") return "dnd";
        return getPresenceState();
    }

    function iconFor(state) {
        if (state === "online") return { cls: "mx_PresenceIconView_online", path: ICON_PATHS.solid };
        if (state === "offline") return { cls: "mx_PresenceIconView_offline", path: ICON_PATHS.outline };
        if (state === "dnd") return { cls: "mx_PresenceIconView_dnd", path: ICON_PATHS.strikethrough };
        return { cls: "mx_PresenceIconView_unavailable", path: ICON_PATHS.solid };
    }

    function buildPresenceIcon(state) {
        const info = iconFor(state);

        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", info.cls);
        svg.setAttribute("width", "8px");
        svg.setAttribute("height", "8px");
        svg.setAttribute("viewBox", "0 0 8 8");
        svg.setAttribute("fill", "currentColor");
        svg.setAttribute("aria-hidden", "true");

        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", info.path);
        if (state === "offline" || state === "dnd") {
            path.setAttribute("fill-rule", "evenodd");
            path.setAttribute("clip-rule", "evenodd");
        }
        svg.appendChild(path);

        const icon = document.createElement("div");
        icon.className = "mx_PresenceIconView";
        icon.appendChild(svg);
        return icon;
    }

    function buildDot(state) {
        const wrap = document.createElement("div");
        wrap.className = "mx_WithPresenceIndicator_icon " + INJECTED_SELECTOR.slice(1) + " element-mods-status-dot";
        wrap.title = "Right-click to change status";
        wrap.appendChild(buildPresenceIcon(state));
        return wrap;
    }

    function updateDot(dot, state) {
        const info = iconFor(state);
        const svg = dot.querySelector("svg");
        const path = dot.querySelector("path");
        if (svg) svg.setAttribute("class", info.cls);
        if (path) {
            path.setAttribute("d", info.path);
            if (state === "offline" || state === "dnd") {
                path.setAttribute("fill-rule", "evenodd");
                path.setAttribute("clip-rule", "evenodd");
            } else {
                path.removeAttribute("fill-rule");
                path.removeAttribute("clip-rule");
            }
        }
    }

    function sync() {
        const menu = document.querySelector(USER_MENU_SELECTOR);
        const avatar = menu ? menu.querySelector(AVATAR_SELECTOR) : null;

        if (!avatar) {
            document.querySelectorAll(INJECTED_SELECTOR).forEach((n) => n.remove());
            return;
        }

        const state = getDisplayState();
        if (!state) {
            document.querySelectorAll(INJECTED_SELECTOR).forEach((n) => n.remove());
            return;
        }

        const parent = avatar.parentElement || avatar;
        let dot = parent.querySelector(INJECTED_SELECTOR);

        // Remove any orphaned dots that ended up somewhere else after re-renders.
        document.querySelectorAll(INJECTED_SELECTOR).forEach((n) => {
            if (n !== dot) n.remove();
        });

        if (!dot) {
            dot = buildDot(state);
            parent.appendChild(dot);
        } else {
            updateDot(dot, state);
        }
    }

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            sync();
        });
    }

    // -- status picker menu ----------------------------------------------

    function hidePopover() {
        if (popover) {
            popover.remove();
            popover = null;
        }
    }

    function showPopover(anchorEl) {
        hidePopover();
        if (!anchorEl) return;

        const rect = anchorEl.getBoundingClientRect();
        const mode = getMode();
        const displayState = getDisplayState();

        const root = document.createElement("div");
        root.className = "element-mods-status-popover";
        root.setAttribute("role", "menu");

        for (const m of MODES) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "element-mods-status-option" + (m.id === mode ? " selected" : "");
            btn.setAttribute("role", "menuitemradio");
            btn.setAttribute("aria-checked", m.id === mode ? "true" : "false");

            const optionState = m.id === "auto" ? displayState : m.presence === "online" ? "online" : m.presence === "unavailable" ? "unavailable" : m.presence === "offline" ? "offline" : m.presence === BUSY ? "dnd" : null;
            if (optionState) btn.appendChild(buildPresenceIcon(optionState));

            const label = document.createElement("span");
            label.className = "element-mods-status-label";
            label.textContent = m.label;
            btn.appendChild(label);

            if (m.id === mode) {
                const check = document.createElement("span");
                check.className = "element-mods-status-check";
                check.textContent = "\u2713";
                btn.appendChild(check);
            }

            btn.addEventListener("click", () => {
                setMode(m.id);
                applyMode();
                scheduleScan();
                hidePopover();
            });

            root.appendChild(btn);
        }

        document.body.appendChild(root);
        popover = root;

        // Position below the avatar, clamped to the viewport.
        const pw = root.offsetWidth;
        const ph = root.offsetHeight;
        let left = rect.left;
        let top = rect.bottom + 8;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (left < 8) left = 8;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 8);
        root.style.left = left + "px";
        root.style.top = top + "px";
    }

    function isAvatarHit(t) {
        if (!(t && t.nodeType === 1 && typeof t.closest === "function")) return false;
        const menu = t.closest(USER_MENU_SELECTOR);
        if (!menu) return false;
        const avatar = menu.querySelector(AVATAR_SELECTOR);
        if (!avatar) return false;
        if (t === avatar || avatar.contains(t)) return true;
        const parent = avatar.parentElement;
        return !!(parent && (t === parent || parent.contains(t)));
    }

    function onPointerDown(e) {
        // Left click keeps Element's normal user menu; just close our popover
        // when the user clicks anywhere outside it.
        if (popover && !popover.contains(e.target)) {
            hidePopover();
        }
    }

    function onContextMenu(e) {
        if (popover && popover.contains(e.target)) {
            e.preventDefault();
            return; // let the option handler run
        }
        if (isAvatarHit(e.target)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (popover) {
                hidePopover();
                return;
            }
            const menu = document.querySelector(USER_MENU_SELECTOR);
            const avatar = menu ? menu.querySelector(AVATAR_SELECTOR) : null;
            showPopover(avatar ? avatar.parentElement || avatar : null);
            return;
        }
        hidePopover();
    }

    function onKeydown(e) {
        if (e.key === "Escape" && popover) {
            e.stopPropagation();
            hidePopover();
        }
    }

    // -- observers / listeners -------------------------------------------

    function onPresence() {
        scheduleScan();
    }

    function attachUserListeners() {
        if (!client) return;
        let user = null;
        const userId = getOwnUserId(client);
        if (userId) {
            try {
                user = client.getUser(userId);
            } catch (_) {
                /* ignore */
            }
        }
        if (user === clientUser) return;

        if (clientUser && typeof clientUser.off === "function") {
            try {
                clientUser.off("User.presence", onPresence);
                clientUser.off("User.currentlyActive", onPresence);
            } catch (_) {
                /* ignore */
            }
        }
        clientUser = user;
        if (clientUser && typeof clientUser.on === "function") {
            try {
                clientUser.on("User.presence", onPresence);
                clientUser.on("User.currentlyActive", onPresence);
            } catch (_) {
                /* ignore */
            }
        }
    }

    function attachClient() {
        const c = getClient();
        if (!c) return;
        if (client !== c) {
            detachClient();
            client = c;
            try {
                client.on("User.presence", onPresence);
            } catch (_) {
                /* ignore */
            }
            attachUserListeners();
        }
        applyMode();
    }

    function detachClient() {
        if (client) {
            unhookClient(client);
            if (typeof client.off === "function") {
                try {
                    client.off("User.presence", onPresence);
                } catch (_) {
                    /* ignore */
                }
            }
        }
        if (clientUser && typeof clientUser.off === "function") {
            try {
                clientUser.off("User.presence", onPresence);
                clientUser.off("User.currentlyActive", onPresence);
            } catch (_) {
                /* ignore */
            }
        }
        client = null;
        clientUser = null;
    }

    function onFocus() {
        attachClient();
        scheduleScan();
    }

    function onVisibility() {
        if (!document.hidden) {
            attachClient();
            scheduleScan();
        }
    }

    function injectStyles() {
        const style = document.createElement("style");
        style.id = "element-mods-status-control-style";
        style.textContent = `
.element-mods-status-popover {
    position: fixed;
    z-index: 2147483000;
    min-width: 190px;
    padding: 6px;
    background: var(--cpd-color-bg-canvas-default, #1e1f28);
    border: 1px solid var(--cpd-color-border-default, rgba(255,255,255,0.12));
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.45);
    font-family: var(--cpd-font-family-sans, sans-serif);
    font-size: 14px;
    color: var(--cpd-color-text-primary, #f0f1f3);
}
.element-mods-status-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    margin: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
}
.element-mods-status-option:hover {
    background: var(--cpd-color-bg-subtle-hover, rgba(255,255,255,0.08));
}
.element-mods-status-option.selected {
    background: var(--cpd-color-bg-subtle-pressed, rgba(255,255,255,0.14));
}
.element-mods-status-check {
    margin-left: auto;
    font-weight: 600;
}
.element-mods-status-label {
    flex: 1;
}
.mx_PresenceIconView_online { color: var(--cpd-color-icon-accent-primary, #4cc38a); }
.mx_PresenceIconView_unavailable { color: var(--cpd-color-icon-warning-primary, #fbca52); }
.mx_PresenceIconView_offline { color: var(--cpd-color-icon-tertiary, #9f9f9f); }
.mx_PresenceIconView_dnd { color: var(--cpd-color-icon-critical-primary, #f4675a); }
.element-mods-status-control.element-mods-status-dot {
    position: absolute;
    right: 2px;
    bottom: 2px;
    z-index: 1;
    line-height: 0;
}
`;
        document.head.appendChild(style);
    }

    function removeStyles() {
        const el = document.getElementById("element-mods-status-control-style");
        if (el) el.remove();
    }

    function start() {
        injectStyles();
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("contextmenu", onContextMenu, true);
        document.addEventListener("keydown", onKeydown, true);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibility);
        attachClient();
        refreshTimer = setInterval(() => {
            attachClient();
            sync();
        }, REASSERT_INTERVAL);
        scheduleScan();
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        document.removeEventListener("keydown", onKeydown, true);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisibility);
        hidePopover();
        detachClient();
        for (const c of Array.from(originals.keys())) unhookClient(c);
        document.querySelectorAll(INJECTED_SELECTOR).forEach((n) => n.remove());
        removeStyles();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();