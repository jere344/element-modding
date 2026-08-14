import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR =
    process.env.ELEMENT_MODS_CONFIG_DIR || path.join(os.homedir(), ".config", "element-mods");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        return { installPath: typeof raw.installPath === "string" ? raw.installPath : null };
    } catch {
        return { installPath: null };
    }
}

export function saveConfig(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    return CONFIG_PATH;
}
