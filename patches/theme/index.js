/*
Patch: Themes (theme engine), modeled after Vencord's theme system.

Vencord ships a theme manager that lets users install CSS themes (by URL or by
pasting raw CSS), toggle them on/off from Settings, and applies them by injecting
<style> elements. Themes are plain CSS that may carry a metadata header comment
using @name / @description / @author / @version / @source tags (the same header
format Vencord uses).

This patch recreates that flow for Element Web:

  - It bundles a few popular themes (Vibrant Glass, Tokyo Night, OLED) that are
    available immediately. Their CSS lives in patches/theme/themes/*.css and is
    fetched at runtime from mods/patches/theme/themes/.
  - It adds a "Themes" tab to the Settings dialog where you can toggle themes,
    install one from a URL, or paste raw CSS.
  - Enabled themes are injected as <style data-theme-id="..."> elements so they
    can be removed again without reloading.

State is persisted in localStorage under "element-mods.themes".
*/
(() => {
    "use strict";

    const PATCH_ID = "theme";
    const STORAGE_KEY = "element-mods.themes";
    const STYLE_PREFIX = "element-mods-theme-";
    const TAB_ID = "themes";
    const PANEL_ID = `mx_tabpanel_${TAB_ID}`;

    // ------------------------------------------------------------------
    // Metadata parsing (Vencord-style theme headers).
    // ------------------------------------------------------------------
    const META_KEYS = ["name", "description", "author", "version", "source"];

    function parseMeta(css) {
        const meta = {};
        const match = css.match(/\/\*\*([\s\S]*?)\*\//);
        if (!match) return meta;
        for (const key of META_KEYS) {
            const re = new RegExp("@?" + key + "\\s+([^\\n*]+)", "i");
            const m = match[1].match(re);
            if (m) meta[key] = m[1].trim();
        }
        return meta;
    }

    // ------------------------------------------------------------------
    // Bundled themes. Each theme's CSS lives in its own file under
    // patches/theme/themes/<id>.css; the loader ships the patch directory
    // into mods/patches/theme/ so these can be fetched at runtime.
    // ------------------------------------------------------------------
    const BUNDLED_THEMES = ["vibrant-glass", "tokyo-night", "oled"];
    const BUNDLED_DIR = "mods/patches/theme/themes/";
    const bundledCss = new Map(); // id -> css text

    // ------------------------------------------------------------------
    // State (localStorage).
    // ------------------------------------------------------------------
    function loadState() {
        try {
            const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            return {
                enabled: Array.isArray(raw.enabled) ? raw.enabled : [],
                userThemes: Array.isArray(raw.userThemes) ? raw.userThemes : [],
            };
        } catch {
            return { enabled: [], userThemes: [] };
        }
    }

    function saveState(state) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (err) {
            console.warn(`[element-mods:${PATCH_ID}] failed to persist themes`, err);
        }
    }

    function normalizeTheme(theme, source) {
        const meta = parseMeta(theme.css);
        return {
            id: theme.id,
            name: meta.name || theme.name || theme.id,
            description: meta.description || theme.description || "",
            author: meta.author || theme.author || "",
            version: meta.version || "",
            css: theme.css,
            source,
        };
    }

    function listThemes() {
        const state = loadState();
        const bundled = BUNDLED_THEMES
            .filter((id) => bundledCss.has(id))
            .map((id) => normalizeTheme({ id, css: bundledCss.get(id) }, "bundled"));
        const user = state.userThemes.map((t) => normalizeTheme(t, "user"));
        return [...bundled, ...user];
    }

    function isEnabled(id) {
        return loadState().enabled.includes(id);
    }

    // ------------------------------------------------------------------
    // Applying/removing theme CSS.
    // ------------------------------------------------------------------
    function removeThemeStyle(id) {
        const style = document.getElementById(STYLE_PREFIX + id);
        if (style) style.remove();
    }

    function applyTheme(theme) {
        removeThemeStyle(theme.id);
        if (!isEnabled(theme.id)) return;
        const style = document.createElement("style");
        style.id = STYLE_PREFIX + theme.id;
        style.setAttribute("data-theme-id", theme.id);
        style.textContent = theme.css;
        document.head.appendChild(style);
    }

    function applyAll() {
        for (const theme of listThemes()) applyTheme(theme);
    }

    async function loadBundled() {
        await Promise.all(
            BUNDLED_THEMES.map(async (id) => {
                try {
                    const res = await fetch(BUNDLED_DIR + id + ".css", { cache: "no-store" });
                    if (!res.ok) throw new Error("HTTP " + res.status);
                    bundledCss.set(id, await res.text());
                } catch (err) {
                    console.warn(`[element-mods:${PATCH_ID}] failed to load bundled theme "${id}"`, err);
                }
            }),
        );
    }

    function setEnabled(id, enabled) {
        const state = loadState();
        const set = new Set(state.enabled);
        if (enabled) set.add(id);
        else set.delete(id);
        state.enabled = [...set];
        saveState(state);
        applyAll();
    }

    function addUserTheme(css, name) {
        const meta = parseMeta(css);
        const id = "user-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
        const theme = {
            id,
            name: name || meta.name || "Custom theme",
            css,
        };
        const state = loadState();
        state.userThemes.push(theme);
        state.enabled.push(id);
        saveState(state);
        applyAll();
        return normalizeTheme(theme, "user");
    }

    function removeUserTheme(id) {
        const state = loadState();
        state.userThemes = state.userThemes.filter((t) => t.id !== id);
        state.enabled = state.enabled.filter((e) => e !== id);
        saveState(state);
        applyAll();
    }

    async function addFromUrl(url, name) {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const css = await res.text();
        return addUserTheme(css, name);
    }

    // ------------------------------------------------------------------
    // UI helpers.
    // ------------------------------------------------------------------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function createSwitch(checked, onChange) {
        const wrap = el("span");
        wrap.style.cssText =
            "position:relative;display:inline-block;width:38px;height:22px;flex:0 0 auto;cursor:pointer;";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!checked;
        input.style.cssText =
            "position:absolute;inset:0;z-index:1;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;";

        const track = el("span");
        track.style.cssText =
            "position:absolute;inset:0;border-radius:999px;background:#d3d3d3;transition:background .15s ease;pointer-events:none;";

        const knob = el("span");
        knob.style.cssText =
            "position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;" +
            "background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s ease;pointer-events:none;";

        function paint() {
            track.style.background = input.checked ? "var(--cpd-color-bg-action-primary,#0dbd8b)" : "#d3d3d3";
            knob.style.transform = input.checked ? "translateX(16px)" : "translateX(0)";
        }
        paint();

        input.addEventListener("change", () => {
            paint();
            if (onChange) onChange(input.checked);
        });

        wrap.appendChild(input);
        wrap.appendChild(track);
        wrap.appendChild(knob);
        return wrap;
    }

    function themeRow(theme, enabled) {
        const item = el("div");
        item.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 12px;" +
            "background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:8px;";

        const left = el("div");

        const name = el("span", null, theme.name);
        name.style.cssText = "font-weight:600;";
        const title = el("div");
        title.appendChild(name);

        if (theme.author) {
            const author = el("span", null, ` by ${theme.author}`);
            author.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);";
            title.appendChild(author);
        }

        const desc = el("div", null, theme.description || "");
        desc.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;";

        const metaLine = el("div", null, `${theme.source === "bundled" ? "Bundled" : "Custom"}${theme.version ? " · v" + theme.version : ""}`);
        metaLine.style.cssText = "font-size:11px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;opacity:.8;";

        left.appendChild(title);
        left.appendChild(desc);
        left.appendChild(metaLine);
        item.appendChild(left);

        const controls = el("div");
        controls.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto;";

        controls.appendChild(
            createSwitch(enabled, (checked) => {
                setEnabled(theme.id, checked);
                refreshPanel();
            }),
        );

        if (theme.source === "user") {
            const removeBtn = el("button", null, "Remove");
            removeBtn.type = "button";
            removeBtn.style.cssText =
                "padding:4px 10px;border:1px solid var(--cpd-color-text-critical-primary,#ff5c5c);" +
                "border-radius:8px;background:transparent;color:var(--cpd-color-text-critical-primary,#ff5c5c);" +
                "font-size:12px;cursor:pointer;";
            removeBtn.addEventListener("click", () => {
                removeUserTheme(theme.id);
                refreshPanel();
            });
            controls.appendChild(removeBtn);
        }

        item.appendChild(controls);
        return item;
    }

    function createPanelContent() {
        const content = el("div");
        content.style.cssText = "padding:24px;max-width:680px;";

        const title = el("h3", null, "Themes");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";
        content.appendChild(title);

        const subtitle = el("div", null, "Custom CSS themes, applied the same way as Vencord's theme system.");
        subtitle.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";
        content.appendChild(subtitle);

        const divider = el("hr");
        divider.style.cssText = "border:none;border-top:1px solid var(--cpd-color-border-disabled,#e0e0e0);margin:16px 0;";
        content.appendChild(divider);

        const listTitle = el("div", null, "Installed themes");
        listTitle.style.cssText = "font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);margin-bottom:8px;";
        content.appendChild(listTitle);

        const themes = listThemes();
        if (themes.length === 0) {
            content.appendChild(el("div", null, "No themes installed."));
        } else {
            const list = el("div");
            list.style.cssText = "display:flex;flex-direction:column;gap:4px;";
            for (const t of themes) {
                list.appendChild(themeRow(t, isEnabled(t.id)));
            }
            content.appendChild(list);
        }

        const addDivider = el("hr");
        addDivider.style.cssText = "border:none;border-top:1px solid var(--cpd-color-border-disabled,#e0e0e0);margin:20px 0 16px;";
        content.appendChild(addDivider);

        const addTitle = el("div", null, "Add a theme");
        addTitle.style.cssText = "font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);margin-bottom:8px;";
        content.appendChild(addTitle);

        const status = el("div");
        status.style.cssText = "font-size:12px;color:var(--cpd-color-text-critical-primary,#ff5c5c);margin-bottom:8px;min-height:16px;";
        content.appendChild(status);

        // URL form.
        const urlRow = el("div");
        urlRow.style.cssText = "display:flex;gap:8px;margin-bottom:12px;";
        const urlInput = document.createElement("input");
        urlInput.type = "text";
        urlInput.placeholder = "https://example.com/theme.css";
        urlInput.style.cssText =
            "flex:1;padding:8px 10px;border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);" +
            "border-radius:8px;background:var(--cpd-color-bg-canvas-default,transparent);" +
            "color:var(--cpd-color-text-primary,inherit);";
        const urlBtn = el("button", null, "Add from URL");
        urlBtn.type = "button";
        urlBtn.style.cssText =
            "padding:8px 12px;border:none;border-radius:8px;background:var(--cpd-color-bg-action-primary,#0dbd8b);" +
            "color:#fff;cursor:pointer;white-space:nowrap;";
        urlBtn.addEventListener("click", async () => {
            const url = urlInput.value.trim();
            if (!url) return;
            urlBtn.disabled = true;
            status.textContent = "Downloading...";
            try {
                await addFromUrl(url);
                status.textContent = "";
                urlInput.value = "";
                refreshPanel();
            } catch (err) {
                status.textContent = "Failed to add theme: " + (err && err.message ? err.message : err);
            } finally {
                urlBtn.disabled = false;
            }
        });
        urlRow.appendChild(urlInput);
        urlRow.appendChild(urlBtn);
        content.appendChild(urlRow);

        // Paste-CSS form.
        const pasteTitle = el("div", null, "Or paste CSS");
        pasteTitle.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-bottom:6px;";
        content.appendChild(pasteTitle);

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.placeholder = "Theme name (optional; read from @name otherwise)";
        nameInput.style.cssText =
            "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);" +
            "border-radius:8px;background:var(--cpd-color-bg-canvas-default,transparent);" +
            "color:var(--cpd-color-text-primary,inherit);margin-bottom:8px;";
        content.appendChild(nameInput);

        const cssInput = document.createElement("textarea");
        cssInput.placeholder = '/** @name My Theme */ :root { --cpd-color-bg-canvas-default: #222; }';
        cssInput.rows = 5;
        cssInput.style.cssText =
            "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);" +
            "border-radius:8px;background:var(--cpd-color-bg-canvas-default,transparent);" +
            "color:var(--cpd-color-text-primary,inherit);font-family:monospace;font-size:12px;resize:vertical;margin-bottom:8px;";
        content.appendChild(cssInput);

        const pasteBtn = el("button", null, "Add theme");
        pasteBtn.type = "button";
        pasteBtn.style.cssText =
            "padding:8px 16px;border:none;border-radius:8px;background:var(--cpd-color-bg-action-primary,#0dbd8b);" +
            "color:#fff;cursor:pointer;";
        pasteBtn.addEventListener("click", () => {
            const css = cssInput.value.trim();
            if (!css) return;
            addUserTheme(css, nameInput.value.trim());
            status.textContent = "";
            nameInput.value = "";
            cssInput.value = "";
            refreshPanel();
        });
        content.appendChild(pasteBtn);

        return content;
    }

    function createTabLabel() {
        const li = el("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-controls", PANEL_ID);
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", `settings-tab-${TAB_ID}`);

        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

        li.appendChild(icon);
        li.appendChild(el("span", "mx_TabbedView_tabLabel_text", "Themes"));
        return li;
    }

    function createPanel() {
        const panel = el("div", "mx_TabbedView_tabPanel");
        panel.id = PANEL_ID;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", `${PANEL_ID}_label`);
        panel.setAttribute("data-theme-panel", "true");

        const scroller = el("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        scroller.appendChild(createPanelContent());
        panel.appendChild(scroller);
        return panel;
    }

    function refreshPanel() {
        const panel = document.querySelector("[data-theme-panel]");
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
    let registered = false;

    function start() {
        const tabs = window.mods && window.mods.settingsTabs;
        if (tabs) {
            tabs.register(TAB_ID, { label: createTabLabel(), renderPanel: createPanel });
            registered = true;
        }
        loadBundled().then(() => {
            applyAll();
            refreshPanel();
        });
    }

    function stop() {
        const tabs = window.mods && window.mods.settingsTabs;
        if (tabs && registered) tabs.unregister(TAB_ID);
        registered = false;
        for (const theme of listThemes()) removeThemeStyle(theme.id);
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
