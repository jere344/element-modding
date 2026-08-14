#!/usr/bin/env node
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.js";
import { listPatches } from "./registry.js";
import { apply, restore, detectInstallPath, getStatus, resolveInstallPath } from "./apply.js";

const HELP = `element-mods - Vencord-style mod manager for Element Desktop

Usage:
  element-mods path [<installPath>]   Show or set the Element install path
  element-mods detect                 Auto-detect the Element install path
  element-mods list                   List available patches
  element-mods apply [--path <p>]     Apply all patches to the webapp
  element-mods restore [--path <p>]   Restore the original webapp.asar
  element-mods status [--path <p>]    Show whether the webapp is currently patched

All patches are bundled by default; enable/disable individual patches in the
Modding tab (Settings -> Modding).

State file: ${CONFIG_PATH}
`;

function parseArgs(argv) {
    const args = { _: [], path: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--path" || a === "-p") {
            args.path = argv[++i];
        } else if (a.startsWith("--path=")) {
            args.path = a.slice("--path=".length);
        } else if (a === "--help" || a === "-h") {
            args.help = true;
        } else {
            args._.push(a);
        }
    }
    return args;
}

function cmdPath(args) {
    const config = loadConfig();
    const target = args._[0];
    if (target) {
        config.installPath = target;
        saveConfig(config);
        console.log(`Install path set to: ${target}`);
    } else if (config.installPath) {
        console.log(config.installPath);
    } else {
        console.log("No install path set.");
    }
}

function cmdDetect() {
    const found = detectInstallPath();
    if (found) {
        console.log(found);
    } else {
        console.log("Could not auto-detect an Element installation.");
    }
}

function cmdList() {
    const patches = listPatches();
    if (patches.length === 0) {
        console.log("No patches found in patches/.");
        return;
    }
    for (const p of patches) {
        console.log(`[x] ${p.id}  v${p.version}  ${p.name}`);
        console.log(`    ${p.description}`);
    }
    const config = loadConfig();
    const installPath = config.installPath || detectInstallPath();
    if (installPath) {
        const status = getStatus(installPath);
        console.log(`\nElement: ${installPath}`);
        console.log(`Patched: ${status.ok && status.patched ? "yes" : "no"}`);
    }
    console.log("\nAll patches are bundled by default; toggle them on/off in the Modding tab (Settings -> Modding).");
}

async function run() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];

    if (!cmd || args.help) {
        console.log(HELP);
        return;
    }

    try {
        switch (cmd) {
            case "path":
                cmdPath({ _: args._.slice(1) });
                break;
            case "detect":
                cmdDetect();
                break;
            case "list":
                cmdList();
                break;
            case "apply": {
                const result = await apply({ installPath: args.path });
                console.log(`Applied patches: ${result.applied.join(", ")}`);
                console.log(`Updated: ${result.webapp}`);
                console.log("Restart Element to see changes.");
                break;
            }
            case "restore": {
                const result = restore({ installPath: args.path });
                console.log(`Restored original webapp: ${result.webapp}`);
                break;
            }
            case "status": {
                const installPath = resolveInstallPath(args.path);
                if (!installPath) {
                    console.log("No install path set. Run: element-mods path /opt/Element-Nightly");
                    process.exit(1);
                }
                const status = getStatus(installPath);
                if (!status.ok) {
                    console.log(`webapp.asar not found under ${installPath}`);
                    process.exit(1);
                }
                console.log(`Install path: ${installPath}`);
                console.log(`Patched:      ${status.patched ? "yes" : "no"}`);
                console.log(`Backup:       ${status.backupExists ? "present" : "absent"}`);
                break;
            }
            default:
                console.error(`Unknown command: ${cmd}\n`);
                console.log(HELP);
                process.exit(1);
        }
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

run();
