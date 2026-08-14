/*
Patch: Always Online.

Element (and matrix-js-sdk) tracks your presence and flips it to "unavailable"
(away / orange) after a period of inactivity, and to "offline" (grey) when the
window is hidden or loses focus. This patch keeps you "online" (present / green)
for as long as the app is running.

How it works:
  - Hooks the MatrixClient instance's setPresence() and forces every call to
    "online", so Element's own idle/away/blur handlers can't change your status.
  - Re-asserts "online" on an interval, and immediately on window focus / when
    the tab becomes visible again.

The client is looked up lazily via window.mxMatrixClientPeg, so it works both
when already logged in at load time and when the client appears after login.
*/
(() => {
    "use strict";

    const PATCH_ID = "always-online";
    const REASSERT_INTERVAL = 15000;

    let timer = null;
    const originals = new Map(); // MatrixClient -> original setPresence

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function hook(client) {
        if (originals.has(client)) return;
        const original = client.setPresence;
        if (typeof original !== "function") return;
        originals.set(client, original);
        client.setPresence = function () {
            return original.call(client, "online");
        };
    }

    function unhook(client) {
        const original = originals.get(client);
        if (!original) return;
        client.setPresence = original;
        originals.delete(client);
    }

    function forceOnline() {
        const client = getClient();
        if (!client) return;
        hook(client);
        try {
            client.setPresence("online");
        } catch (err) {
            console.warn("[element-mods:always-online] setPresence failed", err);
        }
    }

    function onVisibility() {
        if (!document.hidden) forceOnline();
    }

    function start() {
        forceOnline();
        timer = setInterval(forceOnline, REASSERT_INTERVAL);
        window.addEventListener("focus", forceOnline);
        document.addEventListener("visibilitychange", onVisibility);
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        window.removeEventListener("focus", forceOnline);
        document.removeEventListener("visibilitychange", onVisibility);
        for (const client of Array.from(originals.keys())) unhook(client);
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
