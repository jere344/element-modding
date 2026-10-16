#!/usr/bin/env node
// Runs every patches/*/test.js and checks every manifest.json is well-formed.
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "patches");
let failed = 0;

for (const id of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const dir = join(root, id);
    try {
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        for (const key of ["id", "name", "description", "version", "main"]) {
            if (!m[key]) throw new Error(`missing "${key}"`);
        }
        if (m.id !== id) throw new Error(`id "${m.id}" does not match folder`);
        if (!existsSync(join(dir, m.main))) throw new Error(`main file "${m.main}" not found`);
        console.log(`ok   ${id}: manifest`);
    } catch (e) {
        failed++;
        console.error(`FAIL ${id}: manifest: ${e.message}`);
    }
    const test = join(dir, "test.js");
    if (existsSync(test)) {
        const r = spawnSync(process.execPath, [test], { stdio: "inherit" });
        if (r.status !== 0) {
            failed++;
            console.error(`FAIL ${id}: test.js`);
        }
    }
}

process.exit(failed ? 1 : 0);
