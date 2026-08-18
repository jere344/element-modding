/*
Patch: Room list sections.

Lets you show/hide the different "sections" of the room list (the primary
filter chips: Unreads, People, Rooms, Mentions, Invites) from a new Settings
tab, and adds a "Latest" section that shows every conversation (rooms and
chats) in chronological order, from the most recent message to the oldest.

How it works:
  - The "sections" are the primary filter chips rendered by Element's room
    list v3 inside the element with data-testid="primary-filters". Each chip
    is a <button role="option">; its filter id is read from the React fiber
    key ("unread-0", "people-1", ...).
  - Hidden sections are simply hidden with display:none (persisted in
    localStorage "element-mods.room-list-sections").
  - A synthetic "Latest" chip is injected into the chip row. Element's room
    list already supports exactly this view: when the "RoomList.showSections"
    setting is disabled, the room-list store returns a single "chats" section
    containing every room sorted by recency (the default sort), which is
    rendered as a flat list. So clicking "Latest" just writes that setting
    (device level, via window.mxSettingsStore), and the app's own view model
    re-renders the list accordingly.
  - "favourite" and "low_priority" chips only appear while sections are
    disabled (Latest mode); they are always hidden since the user did not ask
    for them.
  - A MutationObserver keeps the chip row in sync across React re-renders.
*/
(() => {
    "use strict";

    const PATCH_ID = "room-list-sections";
    const TAB_ID = "room-list-sections";
    const PANEL_ID = "mx_tabpanel_room-list-sections";
    const STORAGE_KEY = "element-mods.room-list-sections";

    const FILTERS_SELECTOR = '[data-testid="primary-filters"]';
    const LISTBOX_SELECTOR = 'div[role="listbox"]';
    const CHIP_SELECTOR = 'button[role="option"]';
    const LATEST_ATTR = "data-element-mods-latest";

    // Chips Element renders (id -> label). "favourite"/"low_priority" only
    // appear when sections are disabled; they are always hidden.
    const NATIVE_FILTERS = {
        unread: "Unreads",
        people: "People",
        rooms: "Rooms",
        mentions: "Mentions",
        invites: "Invites",
    };
    const ALWAYS_HIDDEN = new Set(["favourite", "low_priority"]);

    const SECTIONS = [
        { id: "unread", label: "Unreads", desc: "Rooms with unread notifications." },
        { id: "people", label: "People", desc: "Direct messages and chats with people." },
        { id: "rooms", label: "Rooms", desc: "Group rooms." },
        { id: "mentions", label: "Mentions", desc: "Rooms where you were mentioned." },
        { id: "invites", label: "Invites", desc: "Rooms you have been invited to." },
        {
            id: "latest",
            label: "Latest",
            desc: "Every conversation (rooms and chats) in chronological order, newest message first.",
        },
    ];

    let observer = null;
    let registered = false;

    // -- storage ----------------------------------------------------------

    function readVisible() {
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") return parsed;
            }
        } catch (_) {
            /* ignore */
        }
        return {};
    }

    function isVisible(id) {
        return readVisible()[id] !== false;
    }

    function setVisible(id, value) {
        const obj = readVisible();
        obj[id] = value;
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch (_) {
            /* ignore */
        }
    }

    // -- helpers ----------------------------------------------------------

    function getListbox() {
        const container = document.querySelector(FILTERS_SELECTOR);
        if (!container) return null;
        return container.querySelector(LISTBOX_SELECTOR);
    }

    function getFilterId(chip) {
        // The chip's filter id is the React key ("unread-0", "people-1", ...)
        // on one of the fibers up the tree from the button element.
        let fiber = null;
        for (const key in chip) {
            if (key.startsWith("__reactFiber$")) {
                fiber = chip[key];
                break;
            }
        }
        let guard = 0;
        while (fiber && guard++ < 25) {
            if (typeof fiber.key === "string") {
                const dash = fiber.key.lastIndexOf("-");
                if (dash > 0) {
                    const id = fiber.key.slice(0, dash);
                    if (id in NATIVE_FILTERS || ALWAYS_HIDDEN.has(id)) return id;
                }
            }
            fiber = fiber.return;
        }
        // Fallback: match by rendered label (locale dependent).
        const text = (chip.textContent || "").trim().toLowerCase();
        for (const [id, label] of Object.entries(NATIVE_FILTERS)) {
            if (text === label.toLowerCase()) return id;
        }
        if (text === "low priority" || text === "low priorities") return "low_priority";
        if (text === "favourites" || text === "favorites") return "favourite";
        return null;
    }

    function getShowSections() {
        try {
            const store = window.mxSettingsStore;
            if (store && typeof store.getValue === "function") {
                return store.getValue("RoomList.showSections") !== false;
            }
        } catch (_) {
            /* ignore */
        }
        return true;
    }

    function setShowSections(value) {
        const store = window.mxSettingsStore;
        if (!store || typeof store.setValue !== "function") return;
        try {
            store.setValue("RoomList.showSections", null, "device", value);
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] failed to set RoomList.showSections`, err);
        }
    }

    function nativeChipSelected(listbox) {
        if (!listbox) return null;
        return listbox.querySelector(`${CHIP_SELECTOR}[aria-selected="true"]:not([${LATEST_ATTR}])`);
    }

    function isLatestActive() {
        return getShowSections() === false && !nativeChipSelected(getListbox());
    }

    function clickChip(chip) {
        // Prefer invoking the React onClick directly (walk up the fiber to the
        // first handler) over .click(), so we never fight event delegation.
        let fiber = null;
        for (const key in chip) {
            if (key.startsWith("__reactFiber$")) {
                fiber = chip[key];
                break;
            }
        }
        let guard = 0;
        while (fiber && guard++ < 25) {
            const onClick = fiber.memoizedProps && fiber.memoizedProps.onClick;
            if (typeof onClick === "function") {
                onClick();
                return;
            }
            fiber = fiber.return;
        }
        try {
            chip.click();
        } catch (_) {
            /* ignore */
        }
    }

    // -- latest chip ------------------------------------------------------

    function onLatestClick() {
        const listbox = getListbox();
        const showSections = getShowSections();

        if (showSections === false) {
            // Already in flat (Latest) mode. If a native filter is active, clear
            // it to return to "all conversations"; otherwise leave Latest mode.
            const selected = nativeChipSelected(listbox);
            if (selected) {
                clickChip(selected);
            } else {
                setShowSections(true);
            }
        } else {
            // Enter Latest mode: flat list of every conversation, recency-sorted.
            // Element's own view model clears any active filter when the setting
            // changes, so no extra cleanup is needed here.
            setShowSections(false);
        }
    }

    function createLatestChip(nativeChip) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.setAttribute(LATEST_ATTR, "1");
        chip.setAttribute("role", "option");
        chip.tabIndex = 0;
        chip.textContent = "Latest";
        // Reuse a native chip's (hashed css-module) classes so it looks identical.
        if (nativeChip && typeof nativeChip.className === "string") {
            chip.className = nativeChip.className;
        }
        chip.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onLatestClick();
        });
        return chip;
    }

    function syncChips() {
        const listbox = getListbox();
        if (!listbox) return;

        const nativeChips = [];
        for (const chip of listbox.querySelectorAll(CHIP_SELECTOR)) {
            if (chip.getAttribute(LATEST_ATTR) === "1") continue;
            nativeChips.push(chip);

            const id = getFilterId(chip);
            let visible = true;
            if (id) {
                visible = ALWAYS_HIDDEN.has(id) ? false : isVisible(id);
            }
            chip.style.display = visible ? "" : "none";
        }

        const showLatest = isVisible("latest");
        let latest = listbox.querySelector(`${CHIP_SELECTOR}[${LATEST_ATTR}]`);
        if (showLatest) {
            if (!latest) {
                latest = createLatestChip(nativeChips[0] || null);
                listbox.appendChild(latest);
            }
            // Keep Latest pinned at the end of the row across React re-renders.
            if (listbox.lastElementChild !== latest) listbox.appendChild(latest);
            latest.setAttribute("aria-selected", String(isLatestActive()));
            latest.style.display = "";
        } else if (latest) {
            latest.remove();
        }
    }

    function scheduleSync() {
        requestAnimationFrame(syncChips);
    }

    // -- settings tab -----------------------------------------------------

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

    function sectionRow(section) {
        const row = el("div");
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const left = el("div");
        left.style.cssText = "min-width:0;";

        const title = el("span", undefined, section.label);
        title.style.cssText = "font-weight:600;";

        const desc = el("div", undefined, section.desc);
        desc.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";

        left.appendChild(title);
        left.appendChild(desc);

        const sw = createSwitch(isVisible(section.id), (enabled) => {
            setVisible(section.id, enabled);
            if (section.id === "latest" && !enabled && isLatestActive()) {
                // Leaving Latest mode: restore the sectioned view.
                setShowSections(true);
            }
            syncChips();
        });

        row.appendChild(left);
        row.appendChild(sw);
        return row;
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
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h12"/><circle cx="17" cy="17" r="2.5"/></svg>';

        const text = el("span", "mx_TabbedView_tabLabel_text", "Room list");
        li.appendChild(icon);
        li.appendChild(text);
        return li;
    }

    function createPanelContent() {
        const content = el("div");
        content.style.cssText = "padding:24px;max-width:680px;";

        const title = el("h3", undefined, "Room list sections");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";

        const version = el(
            "div",
            undefined,
            "Show or hide the sections of the conversation list, and add a 'Latest' section that lists every conversation in chronological order.",
        );
        version.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";

        const list = el("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        SECTIONS.forEach((s) => list.appendChild(sectionRow(s)));

        const hint = el(
            "div",
            undefined,
            "Hidden sections disappear from the filter row above the conversation list. 'Latest' shows rooms and chats together, sorted by the most recent message.",
        );
        hint.style.cssText = "margin-top:12px;font-size:12px;color:var(--cpd-color-text-secondary,inherit);";

        content.appendChild(title);
        content.appendChild(version);
        content.appendChild(list);
        content.appendChild(hint);
        return content;
    }

    function createPanel() {
        const panel = el("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", PANEL_ID + "_label");
        panel.dataset.roomListSectionsPanel = "true";

        const scroller = el("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        scroller.appendChild(createPanelContent());
        panel.appendChild(scroller);
        return panel;
    }

    // -- lifecycle --------------------------------------------------------

    function onMutation() {
        scheduleSync();
    }

    function start() {
        if (observer) return;
        observer = new MutationObserver(onMutation);
        observer.observe(document.body, { childList: true, subtree: true });
        if (!registered) {
            window.mods.settingsTabs.register(TAB_ID, {
                label: createTabLabel(),
                renderPanel: createPanel,
            });
            registered = true;
        }
        syncChips();
    }

    function stop() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (registered) {
            window.mods.settingsTabs.unregister(TAB_ID);
            registered = false;
        }
        // Remove the injected chip and restore any chips we hid.
        const listbox = getListbox();
        if (listbox) {
            const latest = listbox.querySelector(`${CHIP_SELECTOR}[${LATEST_ATTR}]`);
            if (latest) latest.remove();
            for (const chip of listbox.querySelectorAll(CHIP_SELECTOR)) {
                if (chip.getAttribute(LATEST_ATTR) === "1") continue;
                chip.style.display = "";
            }
        }
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
