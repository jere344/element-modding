/*
Patch: GIF picker (Giphy source).

Adds a "GIF" button to the message composer (next to the emoji button). Clicking
it opens a popover that searches Giphy (https://api.giphy.com) and shows a grid
of animated thumbnails. Clicking a result uploads the GIF to the homeserver and
sends it as an m.image message into the currently open room.

Sending relies on Element's page-world globals:
  - window.mxMatrixClientPeg.safeGet() -> the matrix-js-sdk MatrixClient
  - window.location.hash              -> "#/room/<roomId>" for the current room

You need a free Giphy API key (developers.giphy.com -> Create an App -> beta
key). Paste it via the gear icon in the picker. The key is stored in
localStorage under "element-mods.giphy.key".
*/
(() => {
    "use strict";

    const PATCH_ID = "gif-picker";
    const API_BASE = "https://api.giphy.com/v1/gifs/search";
    const API_KEY_STORAGE = "element-mods.giphy.key";
    const FAVORITES_STORAGE = "element-mods.gifpicker.favorites";

    const COMPOSER_SELECTOR = ".mx_MessageComposer_actions";
    const EMOJI_SELECTOR = ".mx_EmojiButton";

    let picker = null;
    let grid = null;
    let searchInput = null;
    let keyInput = null;
    let statusEl = null;
    let keyRow = null;
    let composerButton = null;
    let observer = null;
    let open = false;
    let sending = false;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function getApiKey() {
        try {
            return localStorage.getItem(API_KEY_STORAGE);
        } catch {
            return null;
        }
    }

    function setApiKey(key) {
        try {
            if (key) localStorage.setItem(API_KEY_STORAGE, key);
            else localStorage.removeItem(API_KEY_STORAGE);
        } catch {
            /* ignore */
        }
    }

    function getFavorites() {
        try {
            const raw = localStorage.getItem(FAVORITES_STORAGE);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function setFavorites(favs) {
        try {
            localStorage.setItem(FAVORITES_STORAGE, JSON.stringify(favs));
        } catch {
            /* ignore */
        }
    }

    function isFavorite(result) {
        return getFavorites().some((f) => f.id === result.id);
    }

    function toggleFavorite(result) {
        const favs = getFavorites();
        const idx = favs.findIndex((f) => f.id === result.id);
        let nowFav;
        if (idx >= 0) {
            favs.splice(idx, 1);
            nowFav = false;
        } else {
            favs.push(result);
            nowFav = true;
        }
        setFavorites(favs);
        return nowFav;
    }

    function getClient() {
        const peg = window.mxMatrixClientPeg;
        if (!peg) return null;
        return peg.safeGet();
    }

    function getRoomId() {
        const m = /#\/room\/([^/?#]+)/.exec(window.location.hash);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function setStatus(text, isError) {
        if (!statusEl) return;
        statusEl.textContent = text || "";
        statusEl.style.color = isError ? "#f87171" : "#9ca3af";
    }

    function injectStyle() {
        if (document.getElementById("element-mods-gifpicker-style")) return;
        const style = document.createElement("style");
        style.id = "element-mods-gifpicker-style";
        style.textContent = `
#element-mods-gifpicker-picker{position:fixed;width:360px;max-width:calc(100vw - 40px);height:480px;max-height:calc(100vh - 120px);background:#1c1c22;color:#e5e7eb;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5);display:none;flex-direction:column;overflow:hidden;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
#element-mods-gifpicker-picker.emo-open{display:flex;}
.element-mods-gifpicker-composer-button{display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--cpd-color-icon-secondary,inherit);}
.element-mods-gifpicker-composer-button:hover{color:var(--cpd-color-icon-primary,inherit);}
.emo-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #2f2f38;}
.emo-title{font-weight:700;font-size:15px;}
.emo-gear{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;}
.emo-gear:hover{color:#fff;}
.emo-keyrow{display:none;padding:8px 12px;border-bottom:1px solid #2f2f38;background:#16161b;}
.emo-keyrow.emo-open{display:flex;gap:8px;}
.emo-keyrow input{flex:1;}
.emo-search{display:flex;gap:8px;padding:10px 12px;}
.emo-search input{flex:1;}
.emo-input{background:#121217;border:1px solid #2f2f38;border-radius:8px;color:#e5e7eb;padding:8px 10px;font-size:13px;outline:none;}
.emo-input:focus{border-color:#2563eb;}
.emo-search-btn{background:#2563eb;border:none;color:#fff;border-radius:8px;padding:0 14px;cursor:pointer;font-weight:600;font-size:13px;}
.emo-search-btn:hover{background:#1d4ed8;}
.emo-status{min-height:16px;padding:0 12px 6px;font-size:12px;color:#9ca3af;}
.emo-grid{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;align-items:flex-start;gap:6px;padding:0 12px 12px;}
.emo-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:6px;}
.emo-result{position:relative;width:100%;padding:0;border:none;background:#121217;border-radius:8px;overflow:hidden;}
.emo-result-send{display:block;width:100%;padding:0;border:none;background:none;cursor:pointer;}
.emo-result img{display:block;width:100%;height:auto;}
.emo-result:hover{outline:2px solid #2563eb;}
.emo-star{position:absolute;top:6px;right:6px;width:26px;height:26px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#e5e7eb;font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;}
.emo-star:hover{background:rgba(0,0,0,.8);color:#fff;}
.emo-star.emo-star-on{color:#fbbf24;}
.emo-empty{flex:1 1 100%;width:100%;padding:24px;color:#9ca3af;font-size:13px;text-align:center;}
`;
        document.head.appendChild(style);
    }

    function thumbInfo(images) {
        if (!images) return null;
        const cand = images.preview_gif || images.fixed_width || images.downsized;
        if (!cand || !cand.url) return null;
        return {
            url: cand.url,
            width: parseInt(cand.width, 10) || undefined,
            height: parseInt(cand.height, 10) || undefined,
        };
    }

    const COLUMNS = 2;
    const COLUMN_WIDTH = 170; // approx px per column, used to estimate masonry height

    function renderResults(results, emptyText) {
        if (!grid) return;
        grid.textContent = "";
        if (!results.length) {
            grid.appendChild(el("div", "emo-empty", emptyText || "No results. Try another search."));
            return;
        }

        const cols = Array.from({ length: COLUMNS }, () => el("div", "emo-col"));
        const heights = new Array(COLUMNS).fill(0);

        for (const r of results) {
            const info = thumbInfo(r.images);
            if (!info) continue;
            const wrap = el("div", "emo-result");
            const btn = el("button", "emo-result-send");
            btn.type = "button";
            const img = document.createElement("img");
            img.src = info.url;
            img.alt = r.title || "";
            img.loading = "lazy";
            if (info.width) img.width = info.width;
            if (info.height) img.height = info.height;
            btn.appendChild(img);
            btn.addEventListener("click", () => sendGif(r));
            wrap.appendChild(btn);

            const fav = isFavorite(r);
            const star = el("button", "emo-star" + (fav ? " emo-star-on" : ""));
            star.type = "button";
            star.title = fav ? "Remove from favorites" : "Add to favorites";
            star.textContent = fav ? "★" : "☆";
            star.addEventListener("click", (e) => {
                e.stopPropagation();
                const nowFav = toggleFavorite(r);
                if (nowFav) {
                    star.classList.add("emo-star-on");
                    star.textContent = "★";
                    star.title = "Remove from favorites";
                } else {
                    star.classList.remove("emo-star-on");
                    star.textContent = "☆";
                    star.title = "Add to favorites";
                    if (!searchInput.value.trim()) showFavorites();
                }
            });
            wrap.appendChild(star);

            const ratio = info.width && info.height ? info.height / info.width : 1;
            const estH = ratio * COLUMN_WIDTH;
            let target = 0;
            for (let i = 1; i < COLUMNS; i++) {
                if (heights[i] < heights[target]) target = i;
            }
            cols[target].appendChild(wrap);
            heights[target] += estH + 6;
        }

        for (const c of cols) grid.appendChild(c);
    }

    function showFavorites() {
        setStatus("");
        renderResults(getFavorites(), "No favorites yet. Star a GIF to save it here.");
    }

    async function search(query) {
        query = (query || "").trim();
        if (!query) {
            showFavorites();
            return;
        }
        const key = getApiKey();
        if (!key) {
            setStatus("Set a Giphy API key (gear icon) first.", true);
            keyRow.classList.add("emo-open");
            if (keyInput) keyInput.focus();
            return;
        }
        setStatus("Searching…");
        try {
            const url = `${API_BASE}?api_key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&limit=20&rating=g&lang=en`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Giphy HTTP ${res.status}`);
            const data = await res.json();
            renderResults(data.data || []);
            setStatus("");
        } catch (err) {
            console.error("[element-mods:gif-picker] search failed", err);
            setStatus("Search failed: " + err.message, true);
        }
    }

    async function sendGif(result) {
        if (sending) return;
        const client = getClient();
        if (!client) {
            setStatus("You must be logged in.", true);
            return;
        }
        const roomId = getRoomId();
        if (!roomId) {
            setStatus("Open a room first.", true);
            return;
        }
        const gif = result.images && result.images.original;
        if (!gif || !gif.url) {
            setStatus("No GIF media URL.", true);
            return;
        }

        sending = true;
        setStatus("Sending…");
        try {
            const resp = await fetch(gif.url);
            if (!resp.ok) throw new Error(`fetch ${resp.status}`);
            const blob = await resp.blob();
            const file = new File([blob], `giphy-${result.id}.gif`, { type: "image/gif" });

            const upload = await client.uploadContent(file);
            const mxc = upload && (upload.content_uri || upload.url);
            if (!mxc) throw new Error("no content_uri from upload");

            const info = {
                mimetype: "image/gif",
                size: file.size,
                w: gif.width ? parseInt(gif.width, 10) : undefined,
                h: gif.height ? parseInt(gif.height, 10) : undefined,
            };
            await client.sendImageMessage(roomId, null, mxc, info, result.title || "GIF");
            setStatus("Sent ✓");
        } catch (err) {
            console.error("[element-mods:gif-picker] send failed", err);
            setStatus("Send failed: " + err.message, true);
        } finally {
            sending = false;
        }
    }

    function createComposerButton() {
        const btn = el("div", "mx_MessageComposer_button element-mods-gifpicker-composer-button");
        btn.setAttribute("role", "button");
        btn.setAttribute("tabindex", "0");
        btn.setAttribute("title", "GIF picker");
        btn.setAttribute("aria-label", "GIF picker");
        btn.innerHTML =
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            togglePicker();
        });
        btn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                togglePicker();
            }
        });
        return btn;
    }

    function syncComposerButton() {
        const actions = document.querySelector(COMPOSER_SELECTOR);
        if (!actions) return;
        if (composerButton && composerButton.isConnected && composerButton.parentElement === actions) return;
        if (!composerButton) composerButton = createComposerButton();
        const emoji = actions.querySelector(EMOJI_SELECTOR);
        if (emoji && emoji !== composerButton) actions.insertBefore(composerButton, emoji);
        else actions.insertBefore(composerButton, actions.firstChild);
    }

    function positionPicker() {
        if (!composerButton) return;
        const rect = composerButton.getBoundingClientRect();
        const width = 360;
        let left = rect.left;
        if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
        picker.style.left = left + "px";
        picker.style.right = "auto";
        picker.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    }

    function openPicker() {
        open = true;
        positionPicker();
        picker.classList.add("emo-open");
        if (searchInput.value.trim()) search(searchInput.value);
        else showFavorites();
        if (searchInput) searchInput.focus();
    }

    function closePicker() {
        open = false;
        picker.classList.remove("emo-open");
    }

    function togglePicker() {
        if (open) closePicker();
        else openPicker();
    }

    function onDocumentClick(e) {
        if (!open) return;
        if (picker.contains(e.target)) return;
        if (composerButton && composerButton.contains(e.target)) return;
        closePicker();
    }

    function createPicker() {
        const p = el("div");
        p.id = "element-mods-gifpicker-picker";

        // Header
        const header = el("div", "emo-header");
        header.appendChild(el("span", "emo-title", "Giphy"));
        const gear = el("button", "emo-gear", "⚙");
        gear.type = "button";
        gear.title = "API key";
        gear.addEventListener("click", () => keyRow.classList.toggle("emo-open"));
        header.appendChild(gear);
        p.appendChild(header);

        // API key row
        keyRow = el("div", "emo-keyrow");
        keyInput = el("input", "emo-input");
        keyInput.type = "password";
        keyInput.placeholder = "Giphy API key";
        keyInput.value = getApiKey();
        keyInput.addEventListener("change", () => setApiKey(keyInput.value.trim()));
        keyRow.appendChild(keyInput);
        p.appendChild(keyRow);

        // Search row
        const searchRow = el("div", "emo-search");
        searchInput = el("input", "emo-input");
        searchInput.placeholder = "Search GIFs…";
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") search(searchInput.value);
        });
        searchInput.addEventListener("input", () => {
            if (!searchInput.value.trim()) showFavorites();
        });
        const searchBtn = el("button", "emo-search-btn", "Search");
        searchBtn.type = "button";
        searchBtn.addEventListener("click", () => {
            if (searchInput.value.trim()) search(searchInput.value.trim());
        });
        searchRow.appendChild(searchInput);
        searchRow.appendChild(searchBtn);
        p.appendChild(searchRow);

        // Status line
        statusEl = el("div", "emo-status");
        p.appendChild(statusEl);

        // Results grid
        grid = el("div", "emo-grid");
        grid.appendChild(el("div", "emo-empty", "No favorites yet. Star a GIF to save it here."));
        p.appendChild(grid);

        return p;
    }

    function build() {
        injectStyle();
        picker = createPicker();
        document.body.appendChild(picker);
        observer = new MutationObserver(syncComposerButton);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("click", onDocumentClick);
        syncComposerButton();
    }

    function start() {
        if (picker) return;
        build();
    }

    function stop() {
        if (observer) observer.disconnect();
        observer = null;
        document.removeEventListener("click", onDocumentClick);
        if (composerButton) composerButton.remove();
        if (picker) picker.remove();
        composerButton = null;
        picker = grid = searchInput = keyInput = statusEl = keyRow = null;
        open = false;
        const style = document.getElementById("element-mods-gifpicker-style");
        if (style) style.remove();
    }

    window.mods.registerPatch(PATCH_ID, { start, stop });
})();
