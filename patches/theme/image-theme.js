// Image -> palette -> theme generation.
//
// A browser-native take on pywal / element-wal: the picked image is drawn to a
// small canvas, its pixels are median-cut quantized into a handful of
// representative colors, and those are interpolated into Element's full
// --cpd-color-* surface/text/accent scales, generating a usable theme.
//
// Loaded at runtime by patches/theme/index.js via a <script> tag pointing at
// mods/patches/theme/image-theme.js. Exposes window.elementModsImageTheme.
(() => {
    function rgbToHex(r, g, b) {
        const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
        return "#" + c(r) + c(g) + c(b);
    }

    function relLuminance(r, g, b) {
        return 0.299 * r + 0.587 * g + 0.114 * b;
    }

    function mixRgb(a, b, t) {
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }

    function loadImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("Could not read the file"));
            reader.onload = () => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error("Could not decode the image"));
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function samplePixels(img, maxDim = 160) {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const pixels = [];
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue; // skip transparent pixels
            pixels.push([data[i], data[i + 1], data[i + 2]]);
        }
        return { pixels };
    }

    function avgRgb(pixels) {
        if (!pixels.length) return null;
        let r = 0, g = 0, b = 0;
        for (const p of pixels) {
            r += p[0];
            g += p[1];
            b += p[2];
        }
        return [r / pixels.length, g / pixels.length, b / pixels.length];
    }

    function channelRange(box) {
        let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (const p of box) {
            if (p[0] < rMin) rMin = p[0];
            if (p[0] > rMax) rMax = p[0];
            if (p[1] < gMin) gMin = p[1];
            if (p[1] > gMax) gMax = p[1];
            if (p[2] < bMin) bMin = p[2];
            if (p[2] > bMax) bMax = p[2];
        }
        const ranges = [rMax - rMin, gMax - gMin, bMax - bMin];
        let chan = 0;
        if (ranges[1] > ranges[chan]) chan = 1;
        if (ranges[2] > ranges[chan]) chan = 2;
        return { range: ranges[chan], chan };
    }

    function medianCut(pixels, maxColors) {
        if (pixels.length === 0) return [];
        let boxes = [pixels];
        while (boxes.length < maxColors) {
            let idx = -1, best = 0;
            for (let i = 0; i < boxes.length; i++) {
                const rng = channelRange(boxes[i]);
                if (rng.range > best) {
                    best = rng.range;
                    idx = i;
                }
            }
            if (idx === -1 || boxes[idx].length < 2) break;
            const chan = channelRange(boxes[idx]).chan;
            const sorted = [...boxes[idx]].sort((a, b) => a[chan] - b[chan]);
            const mid = sorted.length >> 1;
            boxes.splice(idx, 1, sorted.slice(0, mid), sorted.slice(mid));
        }
        return boxes.map(avgRgb).filter(Boolean);
    }

    function vividScore(r, g, b) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx === mn) return 0;
        const s = (mx - mn) / (255 - Math.abs(mx + mn - 255)); // HSL-style saturation
        const lum = (mx + mn) / 510; // 0..1
        const lumScore = 1 - Math.abs(lum - 0.5) * 2; // 1 at mid-luminance
        return s * (0.55 + 0.45 * lumScore);
    }

    function buildPaletteData(pixels) {
        const reps = medianCut(pixels, 12);
        if (reps.length === 0) reps.push([36, 36, 46]);

        const avg = avgRgb(pixels) || [36, 36, 46];
        const isLight = relLuminance(avg[0], avg[1], avg[2]) > 125;

        const sorted = reps
            .map((c) => ({ c, l: relLuminance(c[0], c[1], c[2]) }))
            .sort((a, b) => a.l - b.l)
            .map((s) => s.c);

        // 14 grey shades interpolated across the extracted colors, lightly tilted
        // toward black/white at the ends so text stays readable.
        const greys = [];
        for (let i = 0; i < 14; i++) {
            const t = i / 13;
            let c;
            if (sorted.length === 1) {
                c = sorted[0];
            } else {
                const pos = t * (sorted.length - 1);
                const lo = Math.floor(pos);
                const hi = Math.min(sorted.length - 1, lo + 1);
                c = mixRgb(sorted[lo], sorted[hi], pos - lo);
            }
            c = mixRgb(c, [0, 0, 0], Math.pow(1 - t, 1.3) * 0.35);
            c = mixRgb(c, [255, 255, 255], Math.pow(t, 1.3) * 0.35);
            greys.push(c);
        }

        // Anchor the ends so surfaces keep a hint of the image's colour instead of
        // collapsing to pure black/white (which makes large flat areas like the
        // left room list look like a solid black or white slab).
        greys[1] = mixRgb(greys[1] || avg, [0, 0, 0], 0.15);
        greys[12] = mixRgb(greys[12] || avg, [255, 255, 255], 0.15);
        greys[0] = mixRgb(greys[1] || avg, [0, 0, 0], 0.5);
        greys[13] = mixRgb(greys[12] || avg, [255, 255, 255], 0.4);

        // Bright images flip the scale: surfaces should be light, text dark.
        if (isLight) greys.reverse();

        let accent = [122, 162, 247];
        let best = -1;
        for (const c of reps) {
            const score = vividScore(c[0], c[1], c[2]);
            if (score > best) {
                best = score;
                accent = c;
            }
        }
        return { greys, accent, isLight, avg };
    }

    function contrastText(accent) {
        return relLuminance(accent[0], accent[1], accent[2]) > 127.5 ? [10, 10, 12] : [250, 250, 252];
    }

    function generateThemeCss(name, sourceName, pal, opts) {
        const { greys, accent, isLight } = pal;
        const hex = (c) => rgbToHex(c[0], c[1], c[2]);
        const rgba = (c, a) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`;
        const lighten = (c, t) => mixRgb(c, [255, 255, 255], t);
        const darken = (c, t) => mixRgb(c, [0, 0, 0], t);
        const onAccent = contrastText(accent);
        // On light themes, "hovered" needs to be darker than the base accent;
        // on dark themes it needs to be lighter.
        const accentHover = isLight ? darken(accent, 0.12) : lighten(accent, 0.15);
        const accentPress = isLight ? lighten(accent, 0.12) : darken(accent, 0.15);
        const accentLight = isLight ? darken(accent, 0.2) : lighten(accent, 0.3);
        const accentLighter = isLight ? darken(accent, 0.35) : lighten(accent, 0.45);

        const lines = [
            "/**",
            " * @name " + name,
            " * @author Generated by Element Mods",
            ' * @description Palette extracted from "' + sourceName + '".',
            " * @version 1.0",
            " */",
            "",
            ":root, body {",
        ];
        greys.forEach((c, i) => lines.push(`    --cpd-color-gray-${100 + i * 100}: ${hex(c)};`));
        lines.push(`    --cpd-color-theme-bg: ${hex(greys[0])};`);

        lines.push(
            "",
            "    /* Accent (picked from the image) */",
            `    --cpd-color-bg-accent-rest: ${hex(accent)};`,
            `    --cpd-color-bg-accent-hovered: ${hex(accentHover)};`,
            `    --cpd-color-bg-accent-pressed: ${hex(accentPress)};`,
            `    --cpd-color-bg-accent-selected: ${rgba(accent, 0.3)};`,
            `    --cpd-color-text-action-accent: ${hex(accentLight)};`,
            `    --cpd-color-icon-accent-primary: ${hex(accentLight)};`,
            `    --cpd-color-border-accent-primary: ${hex(accent)};`,
            "",
            "    /* Links + info */",
            `    --cpd-color-blue-900: ${hex(accent)};`,
            `    --cpd-color-blue-1100: ${hex(accentLighter)};`,
            "",
            "    /* Primary buttons */",
            `    --cpd-color-bg-action-primary-rest: ${hex(accent)};`,
            `    --cpd-color-bg-action-primary-hovered: ${hex(accentHover)};`,
            `    --cpd-color-bg-action-primary-pressed: ${hex(accentPress)};`,
            `    --cpd-color-text-action-primary: ${hex(onAccent)};`,
            `    --cpd-color-text-on-solid-primary: ${hex(onAccent)};`,
            `    --cpd-color-icon-on-solid-primary: ${hex(onAccent)};`,
            "}",
        );

        if (opts && opts.bg) {
            // Each background feature is toggled independently. The image is only
            // encoded once (opts.bg), then used by whichever blocks are enabled.
            if (opts.asBackground) {
                const tint = isLight ? lighten(opts.tint, 0.35) : darken(opts.tint, 0.3);
                const glass = rgba(tint, isLight ? 0.55 : 0.7);
                lines.push(
                    "",
                    "/* ===== IMAGE BACKGROUND (glassmorphism) ===== */",
                    "html, body {",
                    `    background: url('${opts.bg}') center / cover no-repeat fixed !important;`,
                    "}",
                    "#matrixchat, .mx_MatrixChat, .mx_MatrixChat_wrapper { background: transparent !important; }",
                    "",
                    "/* Keep the Element boot/login splash clean: give it an opaque themed",
                    "   background instead of showing the image while loading. */",
                    ".mx_MatrixChat_splash, .mx_SplashPage {",
                    `    background-color: ${hex(greys[0])} !important;`,
                    "}",
                    "",
                    ".mx_RoomView, .mx_RoomView_body, .mx_LeftPanel, .mx_RightPanel, .mx_RoomHeader,",
                    ".mx_RoomHeader_wrapper, .mx_MessageComposer, .mx_MessageComposer_wrapper,",
                    ".mx_SendMessageComposer, .mx_UserMenu, .mx_Dialog, .mx_UserSettingsDialog,",
                    ".mx_SpacePanel, .mx_RoomSublist, .mx_MemberList, .mx_BaseCard, .mx_RoomSearch,",
                    ".mx_ScrollPanel, .mx_AutoHideScrollbar {",
                    `    background-color: ${glass} !important;`,
                    "    backdrop-filter: blur(22px);",
                    "    -webkit-backdrop-filter: blur(22px);",
                    "}",
                    "",
                    "/* Inner scroll areas stay transparent so the glass doesn't stack too dark. */",
                    ".mx_RoomView_body .mx_ScrollPanel,",
                    ".mx_RoomList, .mx_RoomList .mx_AutoHideScrollbar,",
                    ".mx_SpacePanel .mx_AutoHideScrollbar,",
                    ".mx_MemberList .mx_AutoHideScrollbar,",
                    ".mx_Dialog .mx_AutoHideScrollbar {",
                    "    background-color: transparent !important;",
                    "    backdrop-filter: none !important;",
                    "    -webkit-backdrop-filter: none !important;",
                    "}",
                );
            }

            if (opts.asBlur) {
                const tint = isLight ? lighten(opts.tint, 0.35) : darken(opts.tint, 0.3);
                const scrim = rgba(tint, isLight ? 0.5 : 0.55);
                lines.push(
                    "",
                    "/* ===== THE IMAGE ITSELF, BLURRED, BEHIND THE CONVERSATION ===== */",
                    "/* The timeline shows the source image blurred for readability; messages",
                    "   sit on a translucent scrim on top so text stays legible. */",
                    ".mx_RoomView_body {",
                    "    position: relative !important;",
                    "    background: transparent !important;",
                    "}",
                    ".mx_RoomView_body::before {",
                    "    content: '' !important;",
                    "    position: absolute !important;",
                    "    top: -40px !important; right: -40px !important; bottom: -40px !important; left: -40px !important;",
                    `    background: url('${opts.bg}') center / cover no-repeat !important;`,
                    "    filter: blur(28px) saturate(1.2) !important;",
                    "    z-index: 0 !important;",
                    "    pointer-events: none !important;",
                    "}",
                    ".mx_RoomView_body > * {",
                    "    position: relative !important;",
                    "    z-index: 1 !important;",
                    "}",
                    "/* Scrim over the blurred image so message text stays readable. */",
                    ".mx_RoomView_body .mx_ScrollPanel {",
                    `    background-color: ${scrim} !important;`,
                    "}",
                    "",
                    "/* If glassmorphism isn't enabled, keep the area around the timeline readable */",
                    ".mx_RoomHeader, .mx_RoomHeader_wrapper, .mx_MessageComposer, .mx_MessageComposer_wrapper {",
                    "    backdrop-filter: blur(22px);",
                    "    -webkit-backdrop-filter: blur(22px);",
                    "}",
                );
            }
        }

        return lines.join("\n");
    }

    function sanitizeName(name) {
        const base = (name || "")
            .replace(/\.([^.]+)$/, "")
            .replace(/[^a-zA-Z0-9]+/g, " ")
            .trim();
        return base.charAt(0).toUpperCase() + base.slice(1);
    }

    async function encodeBackground(file) {
        // Re-encode the image (downscaled to <=1600px, JPEG) so the data URL
        // stays small enough to persist in localStorage alongside the theme CSS.
        const img = await loadImageFile(file);
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000"; // avoid JPEG's black halos for transparent images
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL("image/jpeg", 0.82);
    }

    async function createThemeFromImage(file, opts, addUserTheme) {
        const img = await loadImageFile(file);
        const { pixels } = samplePixels(img);
        if (pixels.length === 0) throw new Error("No usable pixels in that image");
        const pal = buildPaletteData(pixels);
        const name = sanitizeName(file.name) || "Image theme";
        const useBg = !!(opts && (opts.asBackground || opts.asBlur));
        let css;
        if (useBg) {
            const bg = opts.bg || (await encodeBackground(file));
            css = generateThemeCss(name, file.name, pal, {
                bg,
                tint: pal.avg || pal.greys[0],
                asBackground: opts.asBackground,
                asBlur: opts.asBlur,
            });
        } else {
            css = generateThemeCss(name, file.name, pal);
        }
        return addUserTheme(css, "From image: " + name);
    }

    window.elementModsImageTheme = { createThemeFromImage };
})();