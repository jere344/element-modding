// Self-check for the message-subscriptions patch's core matching logic.
// Run: node patches/message-subscriptions/test.js
import assert from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");

let registered = null;
const sandbox = {
    window: {
        mods: {
            registerPatch(id, def) {
                registered = { id, def };
            },
        },
    },
    console,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

assert.ok(registered, "patch should register");
assert.strictEqual(registered.id, "message-subscriptions");
assert.strictEqual(typeof registered.def.start, "function");
assert.strictEqual(typeof registered.def.stop, "function");

const { bodyMatchesWord } = registered.def._test;

assert.strictEqual(bodyMatchesWord("hello world", "world"), true);
assert.strictEqual(bodyMatchesWord("Hello World", "world"), true, "case-insensitive");
assert.strictEqual(bodyMatchesWord("notidoc is here", "notidoc"), true);
assert.strictEqual(bodyMatchesWord("minutier", "minutier"), true);
assert.strictEqual(bodyMatchesWord("nothing here", "notidoc"), false);
assert.strictEqual(bodyMatchesWord("", "notidoc"), false);
assert.strictEqual(bodyMatchesWord("text", ""), false);

console.log("message-subscriptions self-check OK");
