/*
Patch: My Activity.

Element renders a presence dot on other users' avatars but not on your own
profile picture in the top-left corner. This patch reads your own presence from
the Matrix client and overlays the exact same presence indicator on your avatar
in the top-left UserMenu, reusing Element's own presence CSS classes
(mx_WithPresenceIndicator_icon / mx_PresenceIconView) so it looks identical to
the dots shown on other users.

How it works:
  - Locates the top-left UserMenu (.mx_UserMenu) and the avatar inside it
    (the [role="img"][data-type="round"] element).
  - Reads the current user's presence via window.mxMatrixClientPeg, mapping it
    to online / unavailable (away) / offline / busy, the same way Element does
    in WithPresenceIndicator.
  - Injects a presence icon into the avatar wrapper, positioned bottom-right
    (right: 0; bottom: 2px) exactly like other users.
  - Keeps it in sync via User.presence / User.currentlyActive events and a
    MutationObserver so it survives React re-renders and login/logout.
*/
(() => {
    "use strict";

    const PATCH_ID = "my-activity";
    const USER_MENU_SELECTOR = ".mx_UserMenu";
    const AVATAR_SELECTOR = '[role="img"][data-type="round"]';
    const INJECTED_SELECTOR = ".element-mods-my-activity";
    const REFRESH_INTERVAL = 10000;

    const BUSY_PRESENCE = ["busy", "org.matrix.msc3026.busy"];

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

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function getOwnUserId(c) {
        return c.getSafeUserId();
    }

    // Mirrors the presence resolution in Element's WithPresenceIndicator.
    function getPresenceState() {
        if (!client) return null;
        const userId = getOwnUserId(client);
        if (!userId) return null;

        let user;
        try {
            user = client.getUser(userId);
        } catch {
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

    function iconFor(state) {
        if (state === "online") return { cls: "mx_PresenceIconView_online", path: ICON_PATHS.solid };
        if (state === "offline") return { cls: "mx_PresenceIconView_offline", path: ICON_PATHS.outline };
        if (state === "dnd") return { cls: "mx_PresenceIconView_dnd", path: ICON_PATHS.strikethrough };
        return { cls: "mx_PresenceIconView_unavailable", path: ICON_PATHS.solid };
    }

    function buildDot(state) {
        const info = iconFor(state);

        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", info.cls);
        svg.setAttribute("width", "8px");
        svg.setAttribute("height", "8px");
        svg.setAttribute("viewBox", "0 0 8 8");
        svg.setAttribute("fill", "currentColor");
        svg.setAttribute("aria-hidden", "true");

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", info.path);
        if (state === "offline" || state === "dnd") {
            path.setAttribute("fill-rule", "evenodd");
            path.setAttribute("clip-rule", "evenodd");
        }
        svg.appendChild(path);

        const icon = document.createElement("div");
        icon.className = "mx_PresenceIconView";
        icon.appendChild(svg);

        const wrap = document.createElement("div");
        wrap.className = "mx_WithPresenceIndicator_icon element-mods-my-activity";
        wrap.appendChild(icon);
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

        const state = getPresenceState();
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
            } catch {
                /* ignore */
            }
        }
        if (user === clientUser) return;

        if (clientUser && typeof clientUser.off === "function") {
            try {
                clientUser.off("User.presence", onPresence);
                clientUser.off("User.currentlyActive", onPresence);
            } catch {
                /* ignore */
            }
        }
        clientUser = user;
        if (clientUser && typeof clientUser.on === "function") {
            try {
                clientUser.on("User.presence", onPresence);
                clientUser.on("User.currentlyActive", onPresence);
            } catch {
                /* ignore */
            }
        }
    }

    function attachClient() {
        const c = getClient();
        if (!c) return;
        if (client === c) {
            attachUserListeners();
            return;
        }
        detachClient();
        client = c;
        try {
            client.on("User.presence", onPresence);
        } catch {
            /* ignore */
        }
        attachUserListeners();
    }

    function detachClient() {
        if (client && typeof client.off === "function") {
            try {
                client.off("User.presence", onPresence);
            } catch {
                /* ignore */
            }
        }
        if (clientUser && typeof clientUser.off === "function") {
            try {
                clientUser.off("User.presence", onPresence);
                clientUser.off("User.currentlyActive", onPresence);
            } catch {
                /* ignore */
            }
        }
        client = null;
        clientUser = null;
    }

    function start() {
        observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, { childList: true, subtree: true });
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
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        detachClient();
        document.querySelectorAll(INJECTED_SELECTOR).forEach((n) => n.remove());
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
