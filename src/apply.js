import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { listPatches } from "./registry.js";
import { list, extract, pack } from "./asar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADER_SRC = path.join(__dirname, "runtime", "loader.js");

const WEBAPP_NAME = "webapp.asar";
const BACKUP_NAME = "webapp.asar.orig";
const LOADER_SCRIPT = '<script src="mods/loader.js"></script>';

export function resolveInstallPath(override) {
    const candidate = override || loadConfig().installPath;
    if (!candidate) return null;
    return candidate;
}

function resolveWebappPath(installPath) {
    if (!installPath) return null;
    const webapp = path.join(installPath, "resources", WEBAPP_NAME);
    try {
        return fs.existsSync(webapp) && fs.statSync(webapp).isFile() ? webapp : null;
    } catch {
        return null;
    }
}

function isPatched(webappPath) {
    try {
        return list(webappPath).includes("/mods/loader.js");
    } catch {
        return false;
    }
}

function ensureWritable(dir) {
    try {
        fs.accessSync(dir, fs.constants.W_OK);
    } catch {
        throw new Error(
            `No write access to ${dir}. Re-run with elevated permissions (e.g. sudo) or fix ownership.`,
        );
    }
}

function getModInfo() {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return { name: pkg.name, version: pkg.version };
}

export function detectInstallPath() {
    const candidates = [
        "/opt/Element-Nightly",
        "/opt/Element",
        "/usr/lib/element-desktop-nightly",
        "/usr/lib/element-desktop",
        "/opt/element-desktop-nightly",
        "/opt/element-desktop",
    ];
    for (const c of candidates) {
        if (resolveWebappPath(c)) return c;
    }
    return null;
}

export function getStatus(installPath) {
    const webapp = resolveWebappPath(installPath);
    if (!webapp) return { ok: false };
    const resources = path.dirname(webapp);
    const backup = path.join(resources, BACKUP_NAME);
    return { ok: true, webapp, patched: isPatched(webapp), backupExists: fs.existsSync(backup) };
}

export async function apply({ installPath: installPathOverride }) {
    const installPath = resolveInstallPath(installPathOverride);
    if (!installPath) {
        throw new Error(
            "No Element install path set. Run: element-mods path /opt/Element-Nightly (or `element-mods detect`).",
        );
    }

    const webapp = resolveWebappPath(installPath);
    if (!webapp) {
        throw new Error(
            `Could not find ${WEBAPP_NAME} under "${installPath}". ` +
                `Expected "${path.join(installPath, "resources", WEBAPP_NAME)}".`,
        );
    }

    const resources = path.dirname(webapp);
    const backup = path.join(resources, BACKUP_NAME);
    ensureWritable(resources);

    // Baseline: keep a pristine backup, but refresh it if the app was updated
    // underneath us (i.e. the current webapp is no longer one of ours).
    if (!fs.existsSync(backup) || !isPatched(webapp)) {
        fs.copyFileSync(webapp, backup);
    }

    // All patches are bundled; enable/disable happens at runtime in the Modding tab.
    const patches = listPatches();
    if (patches.length === 0) {
        throw new Error("No patches found to apply.");
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "element-mods-"));
    try {
        // Always unpack from the pristine backup so re-applying is idempotent.
        extract(backup, tempDir);

        const indexHtml = path.join(tempDir, "index.html");
        if (!fs.existsSync(indexHtml)) {
            throw new Error("index.html not found in webapp archive; unsupported Element build.");
        }
        let html = fs.readFileSync(indexHtml, "utf8");

        // Idempotent injection: strip any prior loader tag, then add ours.
        html = html.replace(new RegExp(LOADER_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
        if (html.includes("</body>")) {
            html = html.replace("</body>", `    ${LOADER_SCRIPT}\n  </body>`);
        } else {
            html += `\n${LOADER_SCRIPT}\n`;
        }
        fs.writeFileSync(indexHtml, html);

        // Write the mods payload: loader, manifest, and each patch.
        const modsDir = path.join(tempDir, "mods");
        const patchesDir = path.join(modsDir, "patches");
        fs.rmSync(modsDir, { recursive: true, force: true });
        fs.mkdirSync(patchesDir, { recursive: true });
        fs.copyFileSync(LOADER_SRC, path.join(modsDir, "loader.js"));

        const manifestPatches = [];
        for (const patch of patches) {
            const src = path.join(patch.dir, patch.main);
            if (!fs.existsSync(src)) {
                throw new Error(`Patch "${patch.id}" is missing its main file: ${src}`);
            }
            fs.copyFileSync(src, path.join(patchesDir, `${patch.id}.js`));

            // Ship any extra asset files the patch bundles (e.g. themes/*.css)
            // so it can fetch them at runtime from mods/patches/<id>/<path>.
            for (const name of fs.readdirSync(patch.dir)) {
                if (name === "manifest.json" || name === patch.main) continue;
                const from = path.join(patch.dir, name);
                const to = path.join(patchesDir, patch.id, name);
                const stat = fs.statSync(from);
                if (stat.isFile()) {
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    fs.copyFileSync(from, to);
                } else if (stat.isDirectory()) {
                    fs.cpSync(from, to, { recursive: true });
                }
            }

            manifestPatches.push({
                id: patch.id,
                name: patch.name,
                version: patch.version,
                author: patch.author,
                description: patch.description,
                required: !!patch.required,
            });
        }
        fs.writeFileSync(
            path.join(modsDir, "manifest.json"),
            JSON.stringify({ mod: getModInfo(), patches: manifestPatches }, null, 2) + "\n",
        );

        // Repack and swap in.
        const tmpArchive = `${webapp}.tmp`;
        await pack(tempDir, tmpArchive);
        fs.renameSync(tmpArchive, webapp);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    return { installPath, webapp, applied: patches.map((p) => p.id) };
}

export function restore({ installPath: installPathOverride }) {
    const installPath = resolveInstallPath(installPathOverride);
    if (!installPath) {
        throw new Error("No Element install path set. Run: element-mods path /opt/Element-Nightly");
    }
    const webapp = resolveWebappPath(installPath);
    if (!webapp) {
        throw new Error(`Could not find ${WEBAPP_NAME} under "${installPath}".`);
    }
    const resources = path.dirname(webapp);
    const backup = path.join(resources, BACKUP_NAME);
    ensureWritable(resources);

    if (!fs.existsSync(backup)) {
        throw new Error("No backup found; nothing to restore.");
    }
    fs.copyFileSync(backup, webapp);
    return { installPath, webapp };
}
