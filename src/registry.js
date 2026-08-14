import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATCHES_DIR = path.join(__dirname, "..", "patches");

export function listPatches() {
    if (!fs.existsSync(PATCHES_DIR)) return [];
    return fs
        .readdirSync(PATCHES_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
            const dir = path.join(PATCHES_DIR, e.name);
            const manifestPath = path.join(dir, "manifest.json");
            if (!fs.existsSync(manifestPath)) return null;
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
                if (!manifest.id || !manifest.main) return null;
                return { ...manifest, dir };
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}
