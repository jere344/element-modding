# Element Mods

A small mod manager for the [Element](https://element.io/) (Matrix) desktop client.
It patches the app's bundled webapp to load a set of JavaScript mods (patches),
a bit like Vencord does for Discord.


## Requirements

- Node.js 18+
- A Linux install of Element (e.g. `/opt/Element-Nightly` or `/opt/Element`)

## Install

```sh
npm install
```

## Usage

Run commands from this directory with `node src/cli.js`. Since the app lives
in `/opt` (root-owned), any command that writes to it needs `sudo`:

```sh
node src/cli.js detect            # auto-detect the install path
node src/cli.js path /opt/Element-Nightly   # set the Element install path
sudo node src/cli.js apply        # patch Element
```

Then restart Element. All patches are loaded but disabled by default; toggle them on/off in
Settings -> Modding.

Other commands:

```sh
node src/cli.js list              # show available patches and patch status
node src/cli.js status            # show whether the app is currently patched
sudo node src/cli.js restore      # restore the original webapp
```

## Available patches

Click a patch to see its description.

<details>
<summary><b>Force User Status</b></summary>

Force-enables Element's built-in **MSC4426 User Status** feature (the emoji/text status row in your user menu and the status editor in Settings) even when your homeserver does not advertise support for the `org.matrix.msc4429` unstable feature it requires. Element silently force-disables that feature on servers that don't support it, so the setting alone does nothing — this patch bypasses the server-support check. Restart is recommended after enabling.

Works on any server, including matrix.org and custom servers.
</details>

<details>
<summary><b>Status Control</b></summary>

Lets you control your presence from your profile picture in the top-left corner. **Right-click** it to pick a status: **Online**, **Away**, **Offline**, **Busy** or **Automatic** (left-click keeps the normal user menu), and the chosen mode is forced on the server — Element's own idle/away logic can no longer change it. The current status is shown as a presence dot on your avatar.
</details>

<details>
<summary><b>GIF Picker</b></summary>

Adds a Giphy GIF picker button to the message composer to search GIFs and send them into the current room.

To use it you need a (free) Giphy API key:

1. Go to https://developers.giphy.com and sign in.
2. Click **Create an App** and fill out the short form (the beta key is fine for personal use).
3. Copy the API key.
4. In Element, open the GIF picker and click the **gear** (⚙) icon in its header.
5. Paste the key into the field and press Enter.

The key is stored locally in your browser's localStorage and never leaves your machine.
</details>

<details>
<summary><b>Hidden Features</b></summary>

Adds a 'Hidden Features' tab to the Settings dialog with toggle switches for Element features that aren't exposed in the normal UI: the MSC4426 user-status system (status rows in your user menu/Settings plus an automatic 📞 on-call status), QR-code login, reaction images, developer mode, timeline debug panels, hidden-event display and more. Changes take effect after restarting the app.
</details>

<details>
<summary><b>Hide Room</b></summary>

Right-click a room and choose 'Hide room' to remove it from the room list. Hidden rooms are saved locally and can be unhidden from a 'Hidden rooms' tab in Settings.
</details>

<details>
<summary><b>Message Logger</b></summary>

Remembers message text locally and shows deleted messages in red, with a dismiss button that restores the grey 'Message deleted' placeholder.
</details>

<details>
<summary><b>Modding Tab</b></summary>

Adds a 'Modding' tab to the Settings dialog showing the mod platform version and the list of active patches.
</details>

<details>
<summary><b>No Quick Settings</b></summary>

Removes the quick settings menu. Clicking the settings gear (bottom of the space panel) opens the full Settings page directly.
</details>

<details>
<summary><b>Pin Rooms</b></summary>

Pin/unpin rooms via the room right-click menu and show them as avatar buttons in the left sidebar, below the spaces.
</details>

<details>
<summary><b>Save Message</b></summary>

Right-click a message to save it, and open a 'Saved messages' page from a new button in the left sidebar.
</details>

<details>
<summary><b>Themes</b></summary>

Theme engine modeled after Vencord's theme system: apply and manage custom CSS themes (bundled, added by URL, or pasted)
</details>

## Uninstall

```sh
sudo node src/cli.js restore
```
