# Contributing

Thanks for helping out! The project is small, so the process is too.

## Setup

```sh
git clone https://github.com/jere344/element-modding.git
cd element-modding
npm install
npm test
```

## Writing a patch

A patch is a folder in `patches/<id>/` with two files:

- `manifest.json`: `id`, `name`, `description`, `version`, `author`, `main`
  (add `"required": true` only for patches the platform depends on).
- `index.js`: plain browser JavaScript, run inside Element's renderer. No build step.

Look at a small patch such as `patches/no-quick-settings` to see the shape.
If your patch has pure logic worth checking, add a `test.js` next to it that
exits non-zero on failure; `npm test` runs every `patches/*/test.js`.

## Pull requests

- One topic per PR, with a short description of what changed and why.
- Add a collapsible entry for new patches to the README.
- Keep patches self-contained and local-first: no telemetry, and any API key
  stays in the user's `localStorage`.
- Run `npm test` before pushing.

## Reporting bugs

Open an issue with your Element version, install path and distro. Console errors
from Element's devtools help a lot.
