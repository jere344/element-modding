// Self-check for the autocorrect patch's pure logic (settings, URL, text mapping, match filtering).
// Run: node patches/autocorrect/test.js
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
assert.strictEqual(registered.id, "autocorrect");
assert.strictEqual(typeof registered.def.start, "function");
assert.strictEqual(typeof registered.def.stop, "function");

const t = registered.def._test;

// Minimal DOM stand-ins: element and text nodes with the fields buildText reads.
function textNode(value) {
    return { nodeType: 3, nodeValue: value, childNodes: [] };
}
function elem(name, children = [], attrs = {}) {
    return {
        nodeType: 1,
        nodeName: name,
        childNodes: children,
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
}

// --- mergeSettings ---
const defaults = t.mergeSettings(null);
assert.strictEqual(defaults.serverUrl, "http://127.0.0.1:8091");
assert.strictEqual(defaults.language, "auto");
assert.strictEqual(defaults.enabled, true);
assert.deepEqual(defaults.ignoredWords, []);
assert.deepEqual(defaults.disabledRules, []);

const merged = t.mergeSettings({
    serverUrl: "https://lt.example.org",
    language: "fr",
    enabled: false,
    disabledRules: ["WHITESPACE_RULE", 42],
    ignoredWords: [{ rule: "R1", text: "foo" }, { bad: true }],
    unknownKey: "ignored",
});
assert.strictEqual(merged.serverUrl, "https://lt.example.org");
assert.strictEqual(merged.language, "fr");
assert.strictEqual(merged.enabled, false);
assert.deepEqual(merged.disabledRules, ["WHITESPACE_RULE"]);
assert.deepEqual(merged.ignoredWords, [{ rule: "R1", text: "foo" }]);
assert.strictEqual(merged.unknownKey, undefined);

// Wrong types fall back to defaults.
assert.strictEqual(t.mergeSettings({ serverUrl: 5 }).serverUrl, "http://127.0.0.1:8091");

// --- normalizeServerUrl ---
assert.strictEqual(t.normalizeServerUrl("http://127.0.0.1:8091"), "http://127.0.0.1:8091");
assert.strictEqual(t.normalizeServerUrl("http://127.0.0.1:8091/"), "http://127.0.0.1:8091");
assert.strictEqual(t.normalizeServerUrl("  http://x.test/v2/  "), "http://x.test");
assert.strictEqual(t.normalizeServerUrl("http://x.test/api/v2"), "http://x.test/api");
assert.strictEqual(t.normalizeServerUrl(""), "");

// --- buildText: plain text, line breaks, offsets ---
const root = elem("DIV", [
    elem("P", [textNode("Hello")]),
    elem("P", [textNode("wrld")]),
]);
const built = t.buildText(root);
assert.strictEqual(built.text, "Hello\nwrld");
assert.strictEqual(built.map.length, 2);
assert.strictEqual(built.map[1].start, 6);
assert.strictEqual(built.map[1].end, 10);

const withBr = elem("DIV", [textNode("a"), elem("BR"), textNode("b")]);
assert.strictEqual(t.buildText(withBr).text, "a\nb");

// Empty text nodes are skipped.
assert.strictEqual(t.buildText(elem("DIV", [textNode(""), textNode("x")])).map.length, 1);

// Non-editable pills keep their length (as spaces) and are recorded.
const pillRoot = elem("DIV", [
    textNode("hi "),
    elem("SPAN", [textNode("@alice")], { contenteditable: "false" }),
    textNode(" teh"),
]);
const pill = t.buildText(pillRoot);
assert.strictEqual(pill.text, "hi        teh");
assert.strictEqual(pill.text.length, "hi @alice teh".length);
assert.deepEqual(pill.pills, [{ start: 3, end: 9 }]);

// --- offsetToPosition ---
const map = [
    { node: "A", start: 0, end: 5 },
    { node: "B", start: 6, end: 10 },
];
assert.deepEqual(t.offsetToPosition(map, 0), { node: "A", offset: 0 });
assert.deepEqual(t.offsetToPosition(map, 4), { node: "A", offset: 4 });
assert.deepEqual(t.offsetToPosition(map, 7), { node: "B", offset: 1 });
assert.deepEqual(t.offsetToPosition(map, 5), { node: "A", offset: 5 });
assert.strictEqual(t.offsetToPosition(map, -1), null);
assert.strictEqual(t.offsetToPosition([], 0), null);

// --- classifyMatch ---
assert.strictEqual(t.classifyMatch({ rule: { issueType: "misspelling" } }), "spelling");
assert.strictEqual(t.classifyMatch({ rule: { category: { id: "TYPOS" } } }), "spelling");
assert.strictEqual(t.classifyMatch({ rule: { issueType: "grammar", category: { id: "GRAMMAR" } } }), "grammar");
assert.strictEqual(t.classifyMatch({}), "grammar");

// --- filterMatches ---
const text = "Ceci est un tes. Il pleut teh pill.";
const m1 = { offset: 12, length: 3, rule: { id: "FR_SPELL" } }; // "tes"
const m2 = { offset: 0, length: 4, rule: { id: "UPPERCASE" } }; // "Ceci"
const m3 = { offset: 26, length: 3, rule: { id: "FR_SPELL" } }; // "teh"
const m4 = { offset: 5, length: 0, rule: { id: "EMPTY" } };     // zero length, dropped
const pillsList = [{ start: 30, end: 34 }];

const kept = t.filterMatches([m1, m2, m3, m4], { text, disabledRules: [], ignoredWords: [], pills: [] });
assert.strictEqual(kept.length, 3);

const disabled = t.filterMatches([m1, m2, m3], { text, disabledRules: ["UPPERCASE"], ignoredWords: [], pills: [] });
assert.deepEqual(disabled.map((m) => m.rule.id), ["FR_SPELL", "FR_SPELL"]);

const ignored = t.filterMatches([m1, m2, m3], {
    text,
    disabledRules: [],
    ignoredWords: [{ rule: "FR_SPELL", text: "tes" }],
    pills: [],
});
assert.strictEqual(ignored.length, 2);
assert.ok(!ignored.some((m) => m.offset === 12), "ignored word for same rule is filtered");

const overPill = t.filterMatches(
    [{ offset: 31, length: 2, rule: { id: "X" } }],
    { text: "x".repeat(40), disabledRules: [], ignoredWords: [], pills: pillsList },
);
assert.strictEqual(overPill.length, 0, "matches overlapping a pill are dropped");

// --- shouldCheck ---
assert.strictEqual(t.shouldCheck("hello there"), true);
assert.strictEqual(t.shouldCheck("hi"), false, "too short");
assert.strictEqual(t.shouldCheck("   "), false);
assert.strictEqual(t.shouldCheck("/shrug hello"), false, "slash commands skipped");
assert.strictEqual(t.shouldCheck("a".repeat(20001)), false, "too long");
assert.strictEqual(t.shouldCheck(undefined), false);

console.log("autocorrect self-check OK");
