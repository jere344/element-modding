/*
Patch: LanguageTool-style grammar and spelling checker for Element's message composer.

It talks to any LanguageTool-compatible HTTP backend (POST {server}/v2/check),
for example a custom server on http://127.0.0.1:8091 or the official LanguageTool
API. Matches are drawn with the CSS Custom Highlight API (no DOM mutation): red
wavy underline for spelling, blue wavy underline for grammar. Clicking a flagged
word opens a popover with suggestions, "Ignore" and "Disable rule" actions.

Settings live in localStorage ("element-mods.autocorrect") and are edited in an
"Autocorrect" tab of the Settings dialog via window.mods.settingsTabs.
*/
(() => {
    "use strict";

    const PATCH_ID = "autocorrect";
    const TAB_ID = "autocorrect";
    const SETTINGS_KEY = "element-mods.autocorrect";
    const STYLE_ID = "element-mods-autocorrect";
    const POPOVER_ID = "element-mods-autocorrect-popover";
    const LANGUAGE_LIST_ID = "element-mods-autocorrect-languages";
    const COMPOSER_SELECTOR = ".mx_BasicMessageComposer_input, .mx_WysiwygComposer_Editor_content";
    const HL_SPELLING = "mods-autocorrect-spelling";
    const HL_GRAMMAR = "mods-autocorrect-grammar";
    const DEBOUNCE_MS = 500;
    const MIN_LENGTH = 3;
    const MAX_LENGTH = 20000;
    const MAX_REPLACEMENTS = 5;
    const TEST_SENTENCE = "Ceci est un tes.";
    const LANGUAGE_SUGGESTIONS = ["auto", "fr", "en-US", "en-GB", "de-DE", "es", "it", "nl", "pt-BR"];
    const BLOCK_TAGS = new Set(["DIV", "P", "LI"]);
    const LOG_PREFIX = "[element-mods:autocorrect]";

    const DEFAULTS = {
        serverUrl: "http://127.0.0.1:8091",
        language: "auto",
        token: "",
        username: "",
        apiKey: "",
        ignoredWords: [],
        disabledRules: [],
        enabled: true,
        disableNativeSpellcheck: true,
    };

    const STYLE_TEXT = `
::highlight(${HL_SPELLING}) {
    text-decoration: underline wavy #e5484d;
}
::highlight(${HL_GRAMMAR}) {
    text-decoration: underline wavy #3b82f6;
}
`;

    // ------------------------------------------------------------------
    // Pure logic (exported through _test for node self-checks)
    // ------------------------------------------------------------------

    function mergeSettings(stored) {
        const out = {
            ...DEFAULTS,
            ignoredWords: [],
            disabledRules: [],
        };
        if (!stored || typeof stored !== "object") return out;
        for (const key of Object.keys(DEFAULTS)) {
            const value = stored[key];
            if (value === undefined) continue;
            if (key === "ignoredWords") {
                if (Array.isArray(value)) {
                    out.ignoredWords = value.filter(
                        (i) => i && typeof i.rule === "string" && typeof i.text === "string",
                    );
                }
            } else if (key === "disabledRules") {
                if (Array.isArray(value)) out.disabledRules = value.filter((v) => typeof v === "string");
            } else if (typeof value === typeof DEFAULTS[key]) {
                out[key] = value;
            }
        }
        return out;
    }

    function normalizeServerUrl(raw) {
        let url = String(raw || "").trim().replace(/\/+$/, "");
        if (/\/v2$/i.test(url)) url = url.slice(0, -3).replace(/\/+$/, "");
        return url;
    }

    function collectText(node) {
        if (!node) return "";
        if (node.nodeType === 3) return node.nodeValue || "";
        let out = "";
        for (const child of Array.from(node.childNodes || [])) out += collectText(child);
        return out;
    }

    // Builds the plain text of a composer and maps each text node to its
    // [start, end) range in that string. Offsets are UTF-16 code units, which
    // matches what LanguageTool returns.
    function buildText(root) {
        let text = "";
        const map = [];
        const pills = [];

        function newline() {
            if (text.length > 0 && !text.endsWith("\n")) text += "\n";
        }

        function walk(node) {
            for (const child of Array.from(node.childNodes || [])) {
                if (child.nodeType === 3) {
                    const value = child.nodeValue || "";
                    if (value.length === 0) continue;
                    map.push({ node: child, start: text.length, end: text.length + value.length });
                    text += value;
                    continue;
                }
                if (child.nodeType !== 1) continue;

                const name = String(child.nodeName || "").toUpperCase();
                if (name === "BR") {
                    text += "\n";
                    continue;
                }
                const editable = typeof child.getAttribute === "function" ? child.getAttribute("contenteditable") : null;
                if (editable === "false") {
                    // Mention pills and similar: keep the length, hide the content.
                    const pillText = collectText(child);
                    const start = text.length;
                    text += " ".repeat(pillText.length);
                    if (pillText.length > 0) pills.push({ start, end: text.length });
                    continue;
                }
                if (BLOCK_TAGS.has(name)) newline();
                walk(child);
            }
        }

        walk(root);
        return { text, map, pills };
    }

    // Maps a string offset to { node, offset } inside a text node.
    function offsetToPosition(map, offset) {
        if (!map || map.length === 0 || typeof offset !== "number" || offset < 0) return null;
        let fallback = null;
        for (const entry of map) {
            if (offset >= entry.start && offset < entry.end) {
                return { node: entry.node, offset: offset - entry.start };
            }
            if (offset === entry.end) {
                fallback = { node: entry.node, offset: entry.end - entry.start };
            }
        }
        return fallback;
    }

    function classifyMatch(match) {
        const rule = (match && match.rule) || {};
        const categoryId = rule.category && rule.category.id;
        if (rule.issueType === "misspelling" || categoryId === "TYPOS") return "spelling";
        return "grammar";
    }

    function ignoreKey(ruleId, text) {
        return JSON.stringify([ruleId, text]);
    }

    function filterMatches(matches, opts) {
        const text = (opts && opts.text) || "";
        const disabled = new Set((opts && opts.disabledRules) || []);
        const ignored = new Set(((opts && opts.ignoredWords) || []).map((i) => ignoreKey(i.rule, i.text)));
        const pills = (opts && opts.pills) || [];
        return (matches || []).filter((m) => {
            if (!m || typeof m.offset !== "number" || typeof m.length !== "number" || m.length <= 0) return false;
            const ruleId = m.rule && m.rule.id;
            if (ruleId && disabled.has(ruleId)) return false;
            const start = m.offset;
            const end = m.offset + m.length;
            if (ruleId && ignored.has(ignoreKey(ruleId, text.slice(start, end)))) return false;
            if (pills.some((p) => start < p.end && end > p.start)) return false;
            return true;
        });
    }

    function shouldCheck(text) {
        if (typeof text !== "string") return false;
        if (text.length > MAX_LENGTH) return false;
        if (text.trim().length < MIN_LENGTH) return false;
        if (text.trimStart().startsWith("/")) return false;
        return true;
    }

    // ------------------------------------------------------------------
    // Network
    // ------------------------------------------------------------------

    async function checkText(settings, text, signal) {
        const base = normalizeServerUrl(settings.serverUrl);
        if (!base) throw new Error("No server URL configured");

        const body = new URLSearchParams();
        body.set("text", text);
        body.set("language", settings.language || "auto");
        if (settings.username) body.set("username", settings.username);
        if (settings.apiKey) body.set("apiKey", settings.apiKey);

        const headers = { "Content-Type": "application/x-www-form-urlencoded" };
        if (settings.token) headers.Authorization = `Bearer ${settings.token}`;

        const res = await fetch(`${base}/v2/check`, {
            method: "POST",
            headers,
            body: body.toString(),
            signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return Array.isArray(json.matches) ? json.matches : [];
    }

    // ------------------------------------------------------------------
    // Browser state
    // ------------------------------------------------------------------

    let started = false;
    let settings = mergeSettings(null);
    let observer = null;
    let debounceTimer = null;
    let controller = null;
    let cache = null; // { key, matches }
    let lastError = "";
    let composer = null;
    let current = null; // { composer, text, map, pills, items: [{ match, kind, range, start, end }] }
    let popoverEl = null;
    let tabRegistered = false;
    const openPanels = new Set();

    function loadSettings() {
        let stored = null;
        try {
            const raw = window.localStorage.getItem(SETTINGS_KEY);
            if (raw) stored = JSON.parse(raw);
        } catch (err) {
            stored = null;
        }
        return mergeSettings(stored);
    }

    function saveSettings() {
        try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (err) {
            // Storage unavailable: keep working with in-memory settings.
        }
    }

    function updateSetting(key, value) {
        settings = { ...settings, [key]: value };
        saveSettings();
        applyNativeSpellcheck();
        recheck();
    }

    // Element's built-in (Chromium) spellcheck is single-language and overlaps our
    // underlines, so it is switched off on the composers while the patch is active.
    function applyNativeSpellcheck(restore) {
        const off = settings.disableNativeSpellcheck && !restore;
        for (const el of document.querySelectorAll(COMPOSER_SELECTOR)) {
            if (off) {
                if (!el.hasAttribute("data-mods-spellcheck")) {
                    el.setAttribute("data-mods-spellcheck", el.getAttribute("spellcheck") || "");
                }
                el.setAttribute("spellcheck", "false");
            } else if (el.hasAttribute("data-mods-spellcheck")) {
                const orig = el.getAttribute("data-mods-spellcheck");
                if (orig) el.setAttribute("spellcheck", orig);
                else el.removeAttribute("spellcheck");
                el.removeAttribute("data-mods-spellcheck");
            }
        }
    }

    function recheck() {
        if (composer && composer.isConnected) runCheck(composer);
    }

    function h(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = h("style");
        style.id = STYLE_ID;
        style.textContent = STYLE_TEXT;
        document.head.appendChild(style);
    }

    function removeStyle() {
        document.getElementById(STYLE_ID)?.remove();
    }

    function highlightRegistry() {
        if (typeof Highlight !== "function" || typeof CSS === "undefined" || !CSS.highlights) return null;
        return CSS.highlights;
    }

    function clearHighlights() {
        const registry = highlightRegistry();
        if (!registry) return;
        registry.delete(HL_SPELLING);
        registry.delete(HL_GRAMMAR);
    }

    function paintHighlights(items) {
        const registry = highlightRegistry();
        if (!registry) return;
        const spelling = items.filter((i) => i.kind === "spelling").map((i) => i.range);
        const grammar = items.filter((i) => i.kind === "grammar").map((i) => i.range);
        registry.set(HL_SPELLING, new Highlight(...spelling));
        registry.set(HL_GRAMMAR, new Highlight(...grammar));
    }

    function abortRequest() {
        if (controller) {
            controller.abort();
            controller = null;
        }
    }

    function cancelPending() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        abortRequest();
    }

    function resetState() {
        cancelPending();
        clearHighlights();
        hidePopover();
        current = null;
    }

    function scheduleCheck(target) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            runCheck(target);
        }, DEBOUNCE_MS);
    }

    async function runCheck(target) {
        if (!started) return;
        if (!target || !target.isConnected) {
            resetState();
            return;
        }
        const extracted = buildText(target);
        const text = extracted.text;
        if (!settings.enabled || !shouldCheck(text)) {
            abortRequest();
            clearHighlights();
            hidePopover();
            current = null;
            return;
        }

        const key = `${normalizeServerUrl(settings.serverUrl)}|${settings.language}|${text}`;
        if (cache && cache.key === key) {
            render(target, extracted, cache.matches);
            return;
        }

        abortRequest();
        const local = new AbortController();
        controller = local;
        let matches;
        try {
            matches = await checkText(settings, text, local.signal);
        } catch (err) {
            if (err && err.name === "AbortError") return;
            lastError = err && err.message ? err.message : String(err);
            clearHighlights();
            hidePopover();
            current = null;
            return;
        } finally {
            if (controller === local) controller = null;
        }

        lastError = "";
        cache = { key, matches };
        const now = buildText(target);
        // The text changed while the request was in flight; the input handler
        // has already scheduled a newer check.
        if (!target.isConnected || now.text !== text) return;
        render(target, now, matches);
    }

    function render(target, extracted, rawMatches) {
        hidePopover();
        const filtered = filterMatches(rawMatches, {
            text: extracted.text,
            disabledRules: settings.disabledRules,
            ignoredWords: settings.ignoredWords,
            pills: extracted.pills,
        });

        const items = [];
        for (const match of filtered) {
            const start = match.offset;
            const end = match.offset + match.length;
            const a = offsetToPosition(extracted.map, start);
            const b = offsetToPosition(extracted.map, end);
            if (!a || !b) continue;
            const range = document.createRange();
            try {
                range.setStart(a.node, a.offset);
                range.setEnd(b.node, b.offset);
            } catch (err) {
                continue;
            }
            if (range.collapsed) continue;
            items.push({ match, kind: classifyMatch(match), range, start, end });
        }

        current = { composer: target, text: extracted.text, map: extracted.map, pills: extracted.pills, items };
        clearHighlights();
        paintHighlights(items);
    }

    // ------------------------------------------------------------------
    // Interaction
    // ------------------------------------------------------------------

    function caretFromPoint(x, y) {
        if (typeof document.caretRangeFromPoint === "function") {
            const r = document.caretRangeFromPoint(x, y);
            if (r) return { node: r.startContainer, offset: r.startOffset };
        }
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const r = sel.getRangeAt(0);
            return { node: r.startContainer, offset: r.startOffset };
        }
        return null;
    }

    function findItemAt(items, caret) {
        return items.find((item) => {
            try {
                return item.range.isPointInRange(caret.node, caret.offset);
            } catch (err) {
                return false;
            }
        });
    }

    function hidePopover() {
        if (popoverEl) popoverEl.remove();
        popoverEl = null;
    }

    function makeButton(label, onClick, primary) {
        const btn = h("button", null, label);
        btn.type = "button";
        btn.style.cssText =
            "margin:0 6px 6px 0;padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit;" +
            (primary
                ? "border:none;background:var(--cpd-color-bg-action-primary,#0dbd8b);color:#fff;"
                : "border:1px solid var(--cpd-color-border-disabled,#ccc);background:transparent;color:inherit;");
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    function showPopover(item) {
        hidePopover();
        const el = h("div");
        el.id = POPOVER_ID;
        el.setAttribute("role", "dialog");
        el.setAttribute("data-testid", "mods-autocorrect-popover");
        el.style.cssText =
            "position:fixed;z-index:10000;max-width:320px;padding:10px 12px;border-radius:8px;" +
            "box-shadow:0 4px 16px rgba(0,0,0,.25);background:var(--cpd-color-bg-canvas-default,#fff);" +
            "color:var(--cpd-color-text-primary,#111);font:13px/1.4 sans-serif;";
        // Keep focus in the composer while interacting with the popover.
        el.addEventListener("mousedown", (e) => e.preventDefault());

        const message = h("div", null, item.match.message || item.match.shortMessage || "Possible issue");
        message.style.marginBottom = "8px";
        el.appendChild(message);

        const replacements = (item.match.replacements || [])
            .map((r) => (r && typeof r.value === "string" ? r.value : null))
            .filter((v) => v !== null)
            .slice(0, MAX_REPLACEMENTS);
        if (replacements.length > 0) {
            const row = h("div");
            row.style.cssText = "display:flex;flex-wrap:wrap;";
            for (const value of replacements) {
                row.appendChild(makeButton(value, () => applyReplacement(item, value), true));
            }
            el.appendChild(row);
        }

        const actions = h("div");
        actions.style.cssText = "display:flex;flex-wrap:wrap;";
        actions.appendChild(makeButton("Ignore", () => ignoreItem(item)));
        actions.appendChild(makeButton("Disable rule", () => disableRule(item)));
        el.appendChild(actions);

        document.body.appendChild(el);
        popoverEl = el;

        const rect = item.range.getBoundingClientRect();
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8));
        let top = rect.bottom + 6;
        if (top + el.offsetHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - el.offsetHeight - 6);
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    function onClick(event) {
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        if (popoverEl && popoverEl.contains(target)) return;
        const host = target.closest(COMPOSER_SELECTOR);
        if (!host || !current || current.composer !== host) {
            hidePopover();
            return;
        }
        const caret = caretFromPoint(event.clientX, event.clientY);
        const item = caret ? findItemAt(current.items, caret) : null;
        if (!item) {
            hidePopover();
            return;
        }
        showPopover(item);
    }

    function applyReplacement(item, value) {
        const host = current && current.composer;
        if (!host || !host.isConnected) {
            hidePopover();
            return;
        }
        const fresh = buildText(host);
        if (fresh.text !== current.text) {
            hidePopover();
            scheduleCheck(host);
            return;
        }
        const a = offsetToPosition(fresh.map, item.start);
        const b = offsetToPosition(fresh.map, item.end);
        hidePopover();
        if (!a || !b) return;

        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        host.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // execCommand keeps Element's composer model in sync (beforeinput/input).
        document.execCommand("insertText", false, value);
        scheduleCheck(host);
    }

    function ignoreItem(item) {
        const ruleId = item.match.rule && item.match.rule.id;
        const text = current ? current.text.slice(item.start, item.end) : "";
        if (ruleId) {
            const exists = settings.ignoredWords.some((i) => i.rule === ruleId && i.text === text);
            if (!exists) {
                updateSetting("ignoredWords", [...settings.ignoredWords, { rule: ruleId, text }]);
                return;
            }
        }
        hidePopover();
    }

    function disableRule(item) {
        const ruleId = item.match.rule && item.match.rule.id;
        if (ruleId && !settings.disabledRules.includes(ruleId)) {
            updateSetting("disabledRules", [...settings.disabledRules, ruleId]);
            return;
        }
        hidePopover();
    }

    function onInput(event) {
        const target = event.target;
        const host = target && typeof target.closest === "function" ? target.closest(COMPOSER_SELECTOR) : null;
        if (!host) return;
        composer = host;
        hidePopover();
        scheduleCheck(host);
    }

    function onMutations() {
        if (settings.disableNativeSpellcheck) applyNativeSpellcheck();
        if (composer && !composer.isConnected) {
            composer = null;
            resetState();
            return;
        }
        const active = document.activeElement;
        const host = active && typeof active.closest === "function" ? active.closest(COMPOSER_SELECTOR) : null;
        if (host && host !== composer) {
            composer = host;
            scheduleCheck(host);
        }
    }

    function onMouseDown(event) {
        if (popoverEl && !popoverEl.contains(event.target)) hidePopover();
    }

    function onKeyDown(event) {
        if (event.key === "Escape") hidePopover();
    }

    // ------------------------------------------------------------------
    // Settings tab
    // ------------------------------------------------------------------

    const INPUT_CSS =
        "padding:6px 8px;border-radius:6px;border:1px solid var(--cpd-color-border-disabled,#ccc);" +
        "background:transparent;color:inherit;font:inherit;";

    function field(labelText, input, extra) {
        const wrap = h("label");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:12px;";
        wrap.appendChild(h("span", null, labelText));
        wrap.appendChild(input);
        if (extra) wrap.appendChild(extra);
        return wrap;
    }

    function textInput(value, type, onCommit) {
        const input = document.createElement("input");
        input.type = type || "text";
        input.value = value || "";
        input.style.cssText = INPUT_CSS;
        input.addEventListener("change", () => onCommit(input.value.trim()));
        return input;
    }

    function sectionTitle(text) {
        const title = h("div", null, text);
        title.style.cssText = "font:var(--cpd-font-heading-sm-semibold,600 14px/1.4 sans-serif);margin:20px 0 8px;";
        return title;
    }

    function listRow(text, buttonLabel, onClick) {
        const row = h("div");
        row.style.cssText =
            "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;" +
            "background:var(--cpd-color-bg-subtle-secondary,transparent);border-radius:6px;margin-bottom:4px;";
        row.appendChild(h("span", null, text));
        row.appendChild(makeButton(buttonLabel, onClick));
        return row;
    }

    function renderPanelContent(scroller) {
        scroller.textContent = "";
        const wrap = h("div");
        wrap.style.cssText = "padding:24px;max-width:680px;";

        const title = h("h3", null, "Autocorrect");
        title.style.cssText = "margin:0 0 4px;font:var(--cpd-font-heading-md-semibold,600 16px/1.4 sans-serif);";
        wrap.appendChild(title);

        const status = h("div", null, lastError ? `Last error: ${lastError}` : "Backend status: no recent errors.");
        status.style.cssText = "font-size:12px;color:var(--cpd-color-text-secondary,inherit);margin-bottom:16px;";
        wrap.appendChild(status);

        const enabled = document.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = !!settings.enabled;
        enabled.addEventListener("change", () => updateSetting("enabled", enabled.checked));
        const enabledLabel = h("label");
        enabledLabel.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:12px;";
        enabledLabel.appendChild(enabled);
        enabledLabel.appendChild(h("span", null, "Enable grammar and spelling checks"));
        wrap.appendChild(enabledLabel);

        const native = document.createElement("input");
        native.type = "checkbox";
        native.checked = !!settings.disableNativeSpellcheck;
        native.addEventListener("change", () => updateSetting("disableNativeSpellcheck", native.checked));
        const nativeLabel = h("label");
        nativeLabel.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:12px;";
        nativeLabel.appendChild(native);
        nativeLabel.appendChild(h("span", null, "Disable Element's built-in spellcheck in the composer"));
        wrap.appendChild(nativeLabel);

        wrap.appendChild(
            field("Server URL", textInput(settings.serverUrl, "url", (v) => updateSetting("serverUrl", v))),
        );

        const langInput = textInput(settings.language, "text", (v) => updateSetting("language", v || "auto"));
        langInput.setAttribute("list", LANGUAGE_LIST_ID);
        const datalist = document.createElement("datalist");
        datalist.id = LANGUAGE_LIST_ID;
        for (const lang of LANGUAGE_SUGGESTIONS) {
            const option = document.createElement("option");
            option.value = lang;
            datalist.appendChild(option);
        }
        wrap.appendChild(field("Language", langInput, datalist));

        wrap.appendChild(
            field("Token (sent as Bearer, optional)", textInput(settings.token, "password", (v) => updateSetting("token", v))),
        );
        wrap.appendChild(
            field("Username (LanguageTool premium, optional)", textInput(settings.username, "text", (v) => updateSetting("username", v))),
        );
        wrap.appendChild(
            field("API key (LanguageTool premium, optional)", textInput(settings.apiKey, "password", (v) => updateSetting("apiKey", v))),
        );

        const testRow = h("div");
        testRow.style.cssText = "display:flex;align-items:center;gap:12px;margin-bottom:8px;";
        const result = h("span");
        result.style.cssText = "font-size:12px;";
        testRow.appendChild(
            makeButton("Test connection", async () => {
                result.textContent = "Testing...";
                try {
                    const matches = await checkText(settings, TEST_SENTENCE, undefined);
                    lastError = "";
                    result.textContent = `Connected. ${matches.length} match(es) for the test sentence.`;
                } catch (err) {
                    lastError = err && err.message ? err.message : String(err);
                    result.textContent = `Failed: ${lastError}`;
                }
            }, true),
        );
        testRow.appendChild(result);
        wrap.appendChild(testRow);

        wrap.appendChild(sectionTitle("Disabled rules"));
        if (settings.disabledRules.length === 0) {
            wrap.appendChild(h("div", null, "None."));
        } else {
            for (const ruleId of settings.disabledRules) {
                wrap.appendChild(
                    listRow(ruleId, "Remove", () =>
                        updateSetting("disabledRules", settings.disabledRules.filter((r) => r !== ruleId)),
                    ),
                );
            }
        }

        wrap.appendChild(sectionTitle("Ignored words"));
        if (settings.ignoredWords.length === 0) {
            wrap.appendChild(h("div", null, "None."));
        } else {
            settings.ignoredWords.forEach((entry, index) => {
                wrap.appendChild(
                    listRow(`"${entry.text}" (${entry.rule})`, "Remove", () =>
                        updateSetting(
                            "ignoredWords",
                            settings.ignoredWords.filter((_, i) => i !== index),
                        ),
                    ),
                );
            });
        }

        scroller.appendChild(wrap);
    }

    function refreshPanels() {
        for (const scroller of openPanels) {
            if (!scroller.isConnected) {
                openPanels.delete(scroller);
                continue;
            }
            renderPanelContent(scroller);
        }
    }

    function createTabLabel() {
        const li = h("li", "mx_TabbedView_tabLabel");
        li.setAttribute("role", "tab");
        li.setAttribute("tabindex", "0");
        li.setAttribute("aria-selected", "false");
        li.setAttribute("data-testid", `settings-tab-${TAB_ID}`);
        const icon = h("span");
        icon.setAttribute("aria-hidden", "true");
        icon.style.cssText = "display:inline-flex;margin-inline-end:8px;color:var(--cpd-color-icon-primary,inherit);";
        icon.innerHTML =
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10"/><path d="M4 12h7"/><path d="M4 17h5"/><path d="M16 15l2 2 4-4"/></svg>';
        li.appendChild(icon);
        li.appendChild(h("span", "mx_TabbedView_tabLabel_text", "Autocorrect"));
        return li;
    }

    function createPanel() {
        const panel = h("div", "mx_TabbedView_tabPanel");
        panel.id = `mx_tabpanel_${TAB_ID}`;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("data-autocorrect-panel", "true");
        const scroller = h("div", "mx_AutoHideScrollbar mx_TabbedView_tabPanelContent");
        renderPanelContent(scroller);
        openPanels.add(scroller);
        panel.appendChild(scroller);
        return panel;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    function start() {
        if (started) return;
        started = true;
        settings = loadSettings();
        injectStyle();
        applyNativeSpellcheck();
        observer = new MutationObserver(onMutations);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("input", onInput, true);
        document.addEventListener("focusin", onMutations, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("mousedown", onMouseDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        if (window.mods.settingsTabs) {
            window.mods.settingsTabs.register(TAB_ID, { label: createTabLabel(), renderPanel: createPanel });
            tabRegistered = true;
        }
    }

    function stop() {
        if (!started) return;
        started = false;
        resetState();
        applyNativeSpellcheck(true);
        if (observer) observer.disconnect();
        observer = null;
        document.removeEventListener("input", onInput, true);
        document.removeEventListener("focusin", onMutations, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("mousedown", onMouseDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        removeStyle();
        openPanels.clear();
        if (tabRegistered && window.mods.settingsTabs) window.mods.settingsTabs.unregister(TAB_ID);
        tabRegistered = false;
        composer = null;
        cache = null;
        lastError = "";
    }

    window.mods.registerPatch(PATCH_ID, {
        start,
        stop,
        _test: {
            mergeSettings,
            normalizeServerUrl,
            buildText,
            offsetToPosition,
            classifyMatch,
            filterMatches,
            shouldCheck,
        },
    });
})();
