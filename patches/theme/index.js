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
    install one from a URL, paste raw CSS, or upload an image to build a theme
    from its color palette automatically (a browser-native reimplementation of
    the pywal/element-wal idea: the image is quantized on a canvas and the
    extracted colors are mapped onto Element's --cpd-color-* tokens). The
    uploaded image can optionally also be used as a glassmorphism background
    or as a blurred backdrop behind the conversation (two checkboxes).
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
        removeThemeStyle(id);
        const state = loadState();
        state.userThemes = state.userThemes.filter((t) => t.id !== id);
        state.enabled = state.enabled.filter((e) => e !== id);
        saveState(state);
        applyAll();
    }

    function renameUserTheme(id, name) {
        const state = loadState();
        const theme = state.userThemes.find((t) => t.id === id);
        if (!theme) return;
        theme.name = name;
        // Keep an @name header (if the CSS carries one) in sync so the new name
        // survives re-normalization via parseMeta.
        if (/@name\s+/i.test(theme.css)) {
            theme.css = theme.css.replace(/(@name\s+)([^\n*]+?)\s*(?=\*)/i, "$1" + name + " ");
        }
        saveState(state);
        applyAll();
    }

    function editUserTheme(id, css) {
        const state = loadState();
        const theme = state.userThemes.find((t) => t.id === id);
        if (!theme) return;
        theme.css = css;
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
    // Image -> palette -> theme generation lives in image-theme.js (loaded
    // on demand); this loader fetches it the same way the loader.js injects
    // patches, so it works under the app's script restrictions.
    // ------------------------------------------------------------------
    let imageThemePromise = null;
    function loadImageTheme() {
        if (!imageThemePromise) {
            imageThemePromise = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = "mods/patches/theme/image-theme.js";
                script.onload = () => resolve(window.elementModsImageTheme);
                script.onerror = () => {
                    imageThemePromise = null;
                    reject(new Error("Image helper failed to load"));
                };
                document.head.appendChild(script);
            });
        }
        return imageThemePromise;
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
        left.style.cssText = "flex:1 1 auto;min-width:0;";

        const name = el("span", null, theme.name);
        name.style.cssText =
            "font-weight:600;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;";
        const title = el("div");
        title.style.cssText = "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        title.appendChild(name);

        if (theme.author) {
            const author = el("span", null, ` by ${theme.author}`);
            author.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);";
            title.appendChild(author);
        }

        const desc = el("div", null, theme.description || "");
        desc.style.cssText =
            "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;" +
            "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

        const metaLine = el("div", null, `${theme.source === "bundled" ? "Bundled" : "Custom"}${theme.version ? " · v" + theme.version : ""}`);
        metaLine.style.cssText =
            "font-size:11px;color:var(--cpd-color-text-secondary,inherit);margin-top:2px;opacity:.8;" +
            "max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

        left.appendChild(title);
        left.appendChild(desc);
        left.appendChild(metaLine);
        item.appendChild(left);

        const controls = el("div");
        controls.style.cssText = "display:flex;align-items:center;gap:4px;flex:0 0 auto;";

        controls.appendChild(
            createSwitch(enabled, (checked) => {
                setEnabled(theme.id, checked);
                refreshPanel();
            }),
        );

        if (theme.source === "user") {
            const iconBtn = (svg, title, borderColor, color, onClick) => {
                const btn = el("button");
                btn.type = "button";
                btn.title = title;
                btn.style.cssText =
                    `display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;` +
                    `border:1px solid ${borderColor};border-radius:6px;background:transparent;color:${color};` +
                    "cursor:pointer;flex:0 0 auto;";
                btn.innerHTML = svg;
                btn.addEventListener("click", onClick);
                return btn;
            };
            const ICON = {
                rename: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
                edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
                remove: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
            };

            const startRename = () => {
                const input = document.createElement("input");
                input.type = "text";
                input.value = theme.name;
                input.style.cssText =
                    "width:100%;box-sizing:border-box;padding:4px 8px;border:1px solid " +
                    "var(--cpd-color-border-interactive-primary,#c0c0c0);border-radius:6px;" +
                    "background:var(--cpd-color-bg-canvas-default,transparent);" +
                    "color:var(--cpd-color-text-primary,inherit);font:inherit;font-weight:600;";
                const commit = () => {
                    const value = input.value.trim();
                    if (value && value !== theme.name) {
                        renameUserTheme(theme.id, value);
                        refreshPanel();
                    } else {
                        refreshPanel();
                    }
                };
                const cancel = () => refreshPanel();
                input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") cancel();
                });
                const saveBtn = el("button", null, "Save");
                saveBtn.type = "button";
                saveBtn.style.cssText =
                    "padding:4px 10px;border:none;border-radius:6px;background:var(--cpd-color-bg-action-primary,#0dbd8b);" +
                    "color:#fff;font-size:12px;cursor:pointer;white-space:nowrap;margin-left:8px;";
                saveBtn.addEventListener("click", commit);

                title.textContent = "";
                const row = el("div");
                row.style.cssText = "display:flex;align-items:center;gap:0;";
                row.appendChild(input);
                row.appendChild(saveBtn);
                title.appendChild(row);
                input.focus();
                input.select();
            };

            const renameBtn = iconBtn(ICON.rename, "Rename", "var(--cpd-color-border-interactive-primary,#c0c0c0)", "var(--cpd-color-text-primary,inherit)", startRename);
            controls.appendChild(renameBtn);

            const startEdit = () => {
                const ta = document.createElement("textarea");
                ta.value = theme.css;
                ta.rows = 12;
                ta.style.cssText =
                    "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid " +
                    "var(--cpd-color-border-interactive-primary,#c0c0c0);border-radius:8px;" +
                    "background:var(--cpd-color-bg-canvas-default,transparent);" +
                    "color:var(--cpd-color-text-primary,inherit);font-family:monospace;font-size:12px;resize:vertical;";
                const commit = () => {
                    const value = ta.value;
                    if (value && value !== theme.css) {
                        editUserTheme(theme.id, value);
                    }
                    refreshPanel();
                };
                const cancel = () => refreshPanel();
                ta.addEventListener("keydown", (e) => {
                    if (e.key === "Escape") cancel();
                    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
                });

                const saveBtn = el("button", null, "Save");
                saveBtn.type = "button";
                saveBtn.style.cssText =
                    "padding:4px 10px;border:none;border-radius:6px;background:var(--cpd-color-bg-action-primary,#0dbd8b);" +
                    "color:#fff;font-size:12px;cursor:pointer;white-space:nowrap;";
                saveBtn.addEventListener("click", commit);

                const cancelBtn = el("button", null, "Cancel");
                cancelBtn.type = "button";
                cancelBtn.style.cssText =
                    "padding:4px 10px;border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);border-radius:6px;" +
                    "background:transparent;color:var(--cpd-color-text-primary,inherit);font-size:12px;cursor:pointer;white-space:nowrap;";
                cancelBtn.addEventListener("click", cancel);

                const label = el("div", null, `Editing ${theme.name}`);
                label.style.cssText = "font-weight:600;margin-bottom:6px;";

                const hint = el("div", null, "Ctrl+Enter to save, Esc to cancel. Edits the raw CSS of this theme.");
                hint.style.cssText = "font-size:11px;color:var(--cpd-color-text-secondary,inherit);margin:4px 0 8px;";

                const btnRow = el("div");
                btnRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px;";
                btnRow.appendChild(saveBtn);
                btnRow.appendChild(cancelBtn);

                item.textContent = "";
                item.appendChild(label);
                item.appendChild(ta);
                item.appendChild(hint);
                item.appendChild(btnRow);
                ta.focus();
                ta.select();
            };

            const editBtn = iconBtn(ICON.edit, "Edit CSS", "var(--cpd-color-border-interactive-primary,#c0c0c0)", "var(--cpd-color-text-primary,inherit)", startEdit);
            controls.appendChild(editBtn);

            const removeBtn = iconBtn(ICON.remove, "Remove", "var(--cpd-color-text-critical-primary,#ff5c5c)", "var(--cpd-color-text-critical-primary,#ff5c5c)", () => {
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
        status.setAttribute("data-theme-status", "true");
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

        // Create-from-image form.
        const imageDivider = el("hr");
        imageDivider.style.cssText = "border:none;border-top:1px solid var(--cpd-color-border-disabled,#e0e0e0);margin:20px 0 16px;";
        content.appendChild(imageDivider);

        const imageTitle = el("div", null, "Or create one from an image");
        imageTitle.style.cssText = "font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);margin-bottom:8px;";
        content.appendChild(imageTitle);

        const imageHint = el("div", null, "Pick an image and a color palette is extracted from it to build a theme automatically. Optionally use the image as a glassy background and/or as a blurred backdrop behind the conversation.");
        imageHint.style.cssText = "color:var(--cpd-color-text-secondary,inherit);margin-bottom:10px;";
        content.appendChild(imageHint);

        const imageRow = el("div");
        imageRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:12px;";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.style.display = "none";

        const chooseBtn = el("button", null, "Choose image…");
        chooseBtn.type = "button";
        chooseBtn.style.cssText =
            "padding:8px 16px;border:none;border-radius:8px;background:var(--cpd-color-bg-action-primary,#0dbd8b);" +
            "color:#fff;cursor:pointer;white-space:nowrap;";
        chooseBtn.addEventListener("click", () => fileInput.click());

        const preview = document.createElement("img");
        preview.alt = "";
        preview.style.cssText =
            "width:44px;height:44px;object-fit:cover;border-radius:8px;" +
            "border:1px solid var(--cpd-color-border-interactive-primary,#c0c0c0);display:none;";

        const bgLabel = document.createElement("label");
        bgLabel.style.cssText =
            "display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;" +
            "color:var(--cpd-color-text-secondary,inherit);cursor:pointer;";
        const bgCheckbox = document.createElement("input");
        bgCheckbox.type = "checkbox";
        bgCheckbox.style.cssText = "margin:0;cursor:pointer;";
        bgLabel.appendChild(bgCheckbox);
        bgLabel.appendChild(el("span", null, "Use image as a glassy background (glassmorphism)"));
        content.appendChild(bgLabel);

        const blurLabel = document.createElement("label");
        blurLabel.style.cssText =
            "display:flex;align-items:center;gap:6px;margin-bottom:12px;font-size:12px;" +
            "color:var(--cpd-color-text-secondary,inherit);cursor:pointer;";
        const blurCheckbox = document.createElement("input");
        blurCheckbox.type = "checkbox";
        blurCheckbox.style.cssText = "margin:0;cursor:pointer;";
        blurLabel.appendChild(blurCheckbox);
        blurLabel.appendChild(el("span", null, "Use image as blurred conversation background"));
        content.appendChild(blurLabel);

        fileInput.addEventListener("change", async () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            preview.src = URL.createObjectURL(file);
            preview.style.display = "block";
            chooseBtn.disabled = true;
            status.textContent = "Extracting palette…";
            try {
                const opts = { asBackground: bgCheckbox.checked, asBlur: blurCheckbox.checked };
                const imageTheme = await loadImageTheme();
                await imageTheme.createThemeFromImage(file, opts, addUserTheme);
                status.textContent = "";
                refreshPanel();
                const st = document.querySelector("[data-theme-panel] [data-theme-status]");
                if (st) st.textContent = "Theme created.";
            } catch (err) {
                status.textContent = "Failed to create theme: " + (err && err.message ? err.message : err);
                preview.style.display = "none";
            } finally {
                chooseBtn.disabled = false;
            }
        });

        imageRow.appendChild(fileInput);
        imageRow.appendChild(chooseBtn);
        imageRow.appendChild(preview);
        content.appendChild(imageRow);

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
