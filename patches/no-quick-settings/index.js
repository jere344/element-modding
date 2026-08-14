/*
Patch: removes the "Quick settings" popover and makes the settings gear open the
full Settings page directly.

In current Element Web (Compound UI) the gear lives at the bottom of the space
panel and is rendered as a button with the .mx_QuickSettingsButton class. By
default its onClick opens a context menu (data-testid="quick-settings-menu")
whose "All settings" entry dispatches the ViewUserSettings action on the global
dispatcher (window.mxDispatcher) to open the .mx_UserSettingsDialog.

This patch intercepts the click in the capture phase (so the React onClick never
fires), dispatches ViewUserSettings directly, and hides the quick settings menu
via CSS as a belt-and-suspenders fallback.
*/
(() => {
    "use strict";

    const PATCH_ID = "no-quick-settings";
    const BUTTON_SELECTOR = ".mx_QuickSettingsButton";
    const STYLE_ID = "element-mods-no-quick-settings";
    const ACTION_VIEW_USER_SETTINGS = "view_user_settings";

    function openFullSettings() {
        const dispatcher = window.mxDispatcher;
        if (dispatcher && typeof dispatcher.dispatch === "function") {
            dispatcher.dispatch({ action: ACTION_VIEW_USER_SETTINGS });
            return true;
        }
        console.error(`[element-mods:${PATCH_ID}] window.mxDispatcher is not available`);
        return false;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.mx_QuickSettingsButton_ContextMenuWrapper,
[data-testid="quick-settings-menu"] {
    display: none !important;
}
`;
        document.head.appendChild(style);
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    function onClickCapture(event) {
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        if (!target.closest(BUTTON_SELECTOR)) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openFullSettings();
    }

    function start() {
        injectStyle();
        document.addEventListener("click", onClickCapture, true);
    }

    function stop() {
        document.removeEventListener("click", onClickCapture, true);
        removeStyle();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
