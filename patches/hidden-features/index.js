/*
Patch: Hidden Features.

Adds a "Hidden Features" tab to the Settings dialog that exposes toggleable
switches for Element features that are not surfaced in the normal UI:

  - feature_* labs flags (MSC4426 user status, QR login, reaction images, ...)
  - hidden/dev settings (developer mode, timeline debug panels, hidden-event
    display, redaction/join-leave/avatar/displayname event visibility, ...)

How it stores values (mirroring Element's own settings handlers):
  - lab flags   -> localStorage "mx_labs_feature_<flagName>" = "true"/"false"
  - settings    -> the "mx_local_settings" JSON object in localStorage

Changes to lab flags only apply at startup, so the panel offers an
"Apply & Restart" button (window.mods.reload() puts them into effect).
*/
(() => {
    "use strict";

    const SELF_ID = "hidden-features";
    const TAB_ID = "hidden-features";
    const PANEL_ID = "mx_tabpanel_hidden-features";
    const LAB_FLAG_PREFIX = "mx_labs_feature_";
    const SETTINGS_KEY = "mx_local_settings";

    let registered = false;

    // -- storage helpers --------------------------------------------------

    function readFeature(name) {
        try {
            return window.localStorage.getItem(LAB_FLAG_PREFIX + name) === "true";
        } catch (_) {
            return false;
        }
    }

    function writeFeature(name, enabled) {
        try {
            window.localStorage.setItem(LAB_FLAG_PREFIX + name, enabled ? "true" : "false");
        } catch (_) {
            /* ignore */
        }
    }

    function readSettings() {
        try {
            const raw = window.localStorage.getItem(SETTINGS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (_) {
            return {};
        }
    }

    function writeSetting(name, value) {
        try {
            const obj = readSettings();
            obj[name] = value;
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
        } catch (_) {
            /* ignore */
        }
    }

    // -- catalog ----------------------------------------------------------

    // Lab flags. Each reads/writes mx_labs_feature_<name>.
    const FEATURES = [
        {
            name: "feature_user_status",
            label: "User status",
            desc: "MSC4426 statuses: adds a status row/picker in your user menu and Settings, and an automatic \u{1F4DE} on-call status while in a call. Requires a homeserver with extended profiles. (Restart required)",
        },
        {
            name: "feature_ask_to_join",
            label: "Ask to join",
            desc: "Use 'Ask to join' for restricted rooms instead of immediately suggesting to join. (Restart required)",
        },
        {
            name: "feature_bridge_state",
            label: "Bridge state",
            desc: "Show bridge/ghost state in the room member list and profiles. (Restart required)",
        },
        {
            name: "feature_custom_themes",
            label: "Custom themes",
            desc: "Load custom themes via URL. (Restart required)",
        },
        {
            name: "feature_dynamic_room_predecessors",
            label: "Dynamic room predecessors",
            desc: "Automatically follow room predecessor links when a room is replaced. (Restart required)",
        },
        {
            name: "feature_element_call_video_rooms",
            label: "Element Call video rooms",
            desc: "Turn video rooms into Element Call calls. (Restart required)",
        },
        {
            name: "feature_hidebold",
            label: "Hide bold unread badge",
            desc: "Adds control for the bold unread-badge count. (Restart required)",
        },
        {
            name: "feature_login_with_qr",
            label: "Login with QR code",
            desc: "Allow logging in by scanning a QR code with another device. (Restart required)",
        },
        {
            name: "feature_mjolnir",
            label: "Mjolnir",
            desc: "Support for banning users through Mjolnir moderation bots. (Restart required)",
        },
        {
            name: "feature_msc3531_hide_messages_pending_moderation",
            label: "Hide pending-moderation messages",
            desc: "Hide messages awaiting moderation (MSC3531) and show a redacted placeholder. (Restart required)",
        },
        {
            name: "feature_msc4095_url_preview_bundle",
            label: "URL preview bundle (MSC4095)",
            desc: "Use the bundled URL previews endpoint (MSC4095). (Restart required)",
        },
        {
            name: "feature_msc4362_encrypted_state_events",
            label: "Encrypted state events",
            desc: "Allow encrypted account-data/state events (MSC4362). (Restart required)",
        },
        {
            name: "feature_notifications",
            label: "Notifications",
            desc: "New notifications experience. (Restart required)",
        },
        {
            name: "feature_render_reaction_images",
            label: "Reaction images",
            desc: "Render uploaded images as reaction icons. (Restart required)",
        },
        {
            name: "feature_retention",
            label: "Room retention",
            desc: "Support for room retention policy (server-set message lifetimes). (Restart required)",
        },
        {
            name: "feature_video_rooms",
            label: "Video rooms",
            desc: "Support for Element video rooms. (Restart required)",
        },
        {
            name: "feature_wysiwyg_composer",
            label: "WYSIWYG composer",
            desc: "Use the new rich-text message composer instead of the plain one. (Restart required)",
        },
    ];

    // Hidden settings. Each reads/writes <name> inside mx_local_settings.
    // `default` is the value used when the key is absent.
    const SETTINGS = [
        {
            name: "developerMode",
            label: "Developer mode",
            desc: "Shows 'View Source' on event tiles and extra developer options. Default: off",
            default: false,
        },
        {
            name: "showHiddenEventsInTimeline",
            label: "Show hidden events in timeline",
            desc: "Reveal hidden/pending-moderation events instead of collapsing them. Default: off",
            default: false,
        },
        {
            name: "debug_timeline_panel",
            label: "Debug timeline panel",
            desc: "Show a debug panel with event details in the timeline. Default: off",
            default: false,
        },
        {
            name: "debug_scroll_panel",
            label: "Debug scroll panel",
            desc: "Show scroll behaviour debug information. Default: off",
            default: false,
        },
        {
            name: "showRedactions",
            label: "Show redacted messages",
            desc: "Show messages that were redacted (with a placeholder). Default: on",
            default: true,
        },
        {
            name: "showJoinLeaves",
            label: "Show join/leave events",
            desc: "Show membership join/leave events in the timeline. Default: on",
            default: true,
        },
        {
            name: "showAvatarChanges",
            label: "Show avatar changes",
            desc: "Show avatar-change events in the timeline. Default: on",
            default: true,
        },
        {
            name: "showDisplaynameChanges",
            label: "Show display name changes",
            desc: "Show display-name-change events in the timeline. Default: on",
            default: true,
        },
        {
            name: "useOnlyCurrentProfiles",
            label: "Only use current profiles",
            desc: "Use only the current room member profile for display names in the timeline (avoids stale names). Default: off",
            default: false,
        },
        {
            name: "searchShowNsfwGlobally",
            label: "Show NSFW in global search",
            desc: "Include NSFW/gated rooms in global directory search results. Default: off",
            default: false,
        },
    ];

    // -- DOM helpers (same style as the Modding tab) ----------------------

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function createSwitch(checked, onChange) {
        const wrap = el("span");
        wrap.style.cssText = "position:relative;display:inline-block;width:38px;height:22px;flex:0 0 auto;cursor:pointer;";

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

    function featureRow(f) {
        const row = el("div");
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const left = el("div");
        left.style.cssText = "min-width:0;";

        const title = el("span", undefined, f.label);
        title.style.cssText = "font-weight:600;";

        const desc = el("div", undefined, f.desc);
        desc.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";

        left.appendChild(title);
        left.appendChild(desc);

        const sw = createSwitch(readFeature(f.name), (enabled) => {
            writeFeature(f.name, enabled);
        });

        row.appendChild(left);
        row.appendChild(sw);
        return row;
    }

    function settingRow(s) {
        const row = el("div");
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const left = el("div");
        left.style.cssText = "min-width:0;";

        const title = el("span", undefined, s.label);
        title.style.cssText = "font-weight:600;";

        const desc = el("div", undefined, s.desc);
        desc.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";

        left.appendChild(title);
        left.appendChild(desc);

        const settings = readSettings();
        const value = settings[s.name];
        const checked = value === undefined || value === null ? s.default : value;

        const sw = createSwitch(checked, (enabled) => {
            writeSetting(s.name, enabled);
        });

        row.appendChild(left);
        row.appendChild(sw);
        return row;
    }

    function createSection(title, rows) {
        const subtitle = el("div", undefined, title);
        subtitle.style.cssText = "font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);margin-bottom:8px;";

        const list = el("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        rows.forEach((r) => list.appendChild(r));

        const block = el("div");
        block.style.cssText = "margin-bottom:16px;";
        block.appendChild(subtitle);
        block.appendChild(list);
        return block;
    }

    function createPanelContent() {
        const content = el("div");
        content.style.cssText = "padding:24px;max-width:680px;";

        const title = el("h3", undefined, "Hidden Features");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";

        const version = el("div", undefined, "v1.0.0 \u2014 toggle Element features that are not exposed in the UI");
        version.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";

        const divider = el("hr");
        divider.style.cssText = "border:none;border-top:1px solid var(--cpd-color-border-disabled,#e0e0e0);margin:16px 0;";

        const featureSections = createSection(
            "Feature flags",
            FEATURES.map((f) => featureRow(f)),
        );
        const settingsSections = createSection(
            "Hidden settings",
            SETTINGS.map((s) => settingRow(s)),
        );

        const applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.textContent = "Apply & Restart";
        applyBtn.style.cssText =
            "margin-top:20px;padding:8px 16px;border:none;border-radius:8px;background:var(--cpd-color-bg-action-primary,#0dbd8b);color:#fff;font:var(--cpd-font-body-md-semibold,600 15px/1.5 sans-serif);cursor:pointer;";
        applyBtn.addEventListener("click", () => {
            window.mods.reload();
        });

        const hint = el(
            "div",
            undefined,
            "Lab flags and most hidden settings only take effect at startup, so restart (or press the button above) to apply your changes. Settings that are currently unset use Element's defaults.",
        );
        hint.style.cssText = "margin-top:8px;font-size:12px;color:var(--cpd-color-text-secondary,inherit);";

        content.appendChild(title);
        content.appendChild(version);
        content.appendChild(featureSections);
        content.appendChild(divider);
        content.appendChild(settingsSections);
        content.appendChild(applyBtn);
        content.appendChild(hint);
        return content;
    }

    function createTabLabel() {
        const li = el("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-controls", PANEL_ID);
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", "settings-tab-" + TAB_ID);

        const icon = el("span");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);vertical-align:middle;";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';

        const text = el("span", "mx_TabbedView_tabLabel_text", "Hidden Features");
        li.appendChild(icon);
        li.appendChild(text);
        return li;
    }

    function createPanel() {
        const panel = el("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", PANEL_ID + "_label");
        panel.dataset.hiddenFeaturesPanel = "true";

        const scroller = el("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        scroller.appendChild(createPanelContent());
        panel.appendChild(scroller);
        return panel;
    }

    function start() {
        if (registered) return;
        window.mods.settingsTabs.register(TAB_ID, {
            label: createTabLabel(),
            renderPanel: createPanel,
        });
        registered = true;
    }

    function stop() {
        if (!registered) return;
        window.mods.settingsTabs.unregister(TAB_ID);
        registered = false;
    }

    window.mods.registerPatch(SELF_ID, { start, stop });
})();