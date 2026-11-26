# Kitewarden: setup and troubleshooting

Kitewarden needs Windows 11 and Firefox 160 or later. It is not signed yet, so Firefox release loads the add-on only for one run ("Load the add-on"). It is not made or supported by Mozilla or Anthropic.

## What you have

| File | What it is |
|---|---|
| `KitewardenSetup-<version>.exe` | Installs, upgrades, checks and removes the helper, for your Windows user only |
| `kitewarden-<version>-unsigned.xpi` | The add-on for everyday Firefox |
| `kitewarden-<version>.mcpb` | For Claude Desktop |
| `optional\kitewarden-optional-<version>.zip` | Programs that you start yourself: isolated Firefox, Windows input, remote link. Nothing of it is installed |
| `optional\kitewarden-mail-<version>-unsigned.xpi` | A separate add-on for Thunderbird |
| `SHA256SUMS.txt`, `CONTENTS.txt`, `NOTICE.txt` | Checksums of these files and of what is inside them; licensing and trademarks |

Check a file before you use it. The value must be the one in `SHA256SUMS.txt`, taken from a place you trust:

```powershell
Get-FileHash .\KitewardenSetup-1.0.0.exe -Algorithm SHA256
```

## Install the helper

Start `KitewardenSetup-<version>.exe` and choose `i`. It lists what it will do and asks. Windows may warn about an unknown publisher, because the program is not signed.

It needs no administrator rights and changes only this:

- the folder `%LOCALAPPDATA%\Kitewarden`, readable by you only: program, MCP server, a random key, the name of the pipe;
- one registry value, `HKCU\Software\Mozilla\NativeMessagingHosts\kitewarden`, which lets exactly this add-on start the helper;
- one entry in Settings, Apps;
- in Claude Code one server entry, only if you say yes.

It changes no Firefox profile, no Firefox setting, no PATH, and starts nothing at logon. It turns on no remote access, no Windows input and no isolated Firefox.

Without questions, for scripts:

```powershell
.\KitewardenSetup-1.0.0.exe install --dry-run
```

```powershell
.\KitewardenSetup-1.0.0.exe install
```

Further options: `--home <folder>` for another folder, `--claude-code` to register with Claude Code, `--thunderbird` for the mail add-on. Exit code 0 is done, 1 failed and undone, 2 a wrong option, 3 installed but Claude Code was not changed.

## Load the add-on

Firefox release installs only add-ons that Mozilla has signed. Until then:

1. Open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on and pick the `.xpi` file.
2. It is gone after a restart of Firefox; load it again. Do not turn off signature checks for this.

Then open the sidebar with the toolbar button and press **Connect**. If the helper is not installed yet, the sidebar says so and connects by itself once it is.

## Permissions

- At install: tabs, storage, the active tab, native messaging, and containers (Firefox does not allow that one as optional).
- Firefox asks for a site when you attach the first tab of it. Declining attaches nothing.
- Bookmarks, history, downloads, names of tab groups, requests, cookies and writing to the clipboard are optional and off. Nothing can read the clipboard.
- **cookies** is optional. Firefox ties containers to it: it opens a tab in a container only for an add-on that has `cookies`, also if no cookie is read. **Allow tabs in containers** (Tabs, Browser data) asks for it; without it containers are listed and no tab opens in one. The permission alone lets no client see a cookie. Reading cookies has a switch of its own, off at first, asks each time, and never returns HttpOnly values or tokens. Firefox shows no question of its own for cookies; take it back in `about:addons`, Permissions. Version 0.3 required cookies; Firefox keeps it as given after an update, and you can take it back.

## Connect Claude

Claude works only with tabs that you attach to its session in the sidebar, and each action asks you.

**Claude Code** needs Node 22 or later on PATH. Answer yes in the installer, or:

```powershell
claude mcp add -s user kitewarden -- node "$env:LOCALAPPDATA\Kitewarden\mcp\server.mjs"
```

`claude mcp get kitewarden` must say Connected. The installer adds no allow rule, hook or instruction file. If another entry of that name exists, it stays as it is.

**Claude Desktop** brings its own Node. Settings, Desktop app, Extensions: Manage (older layout: Settings, Extensions), Advanced settings, Install Extension, pick the `.mcpb` file. Leave the folder as it is unless you used `--home`. A file installed this way is updated by hand: install the new one after each upgrade of the helper. Your organization may block extensions.

Instead of the `.mcpb` file, with Node installed: add the entry that the installer printed under "Other clients" to `claude_desktop_config.json` (Settings, Developer, Edit Config). Use one of the two, not both.

**The chat in the sidebar** runs your own installed and signed-in Claude Code. The add-on holds no account and no key.

The run has the tools of Kitewarden and no others. Two switches of a chat, both off at first, add to that:

- **Skills, plugins and agents** of your Claude Code. Hooks and shell commands in skills stay off.
- **File, shell and web tools on this computer.** Each use shows its whole input on a card and runs only after Allow, read-only commands included. What you allow there is not limited to attached tabs: a command can do what you can do, and it starts in the folder of the helper. Text of a page can try to talk Claude into a command, so read the card. Pause and Stop end such a run; a command that began may have taken effect. Needs Claude Code 2.1.302 or later.

**Saved prompts** (Chat): write a message, name it, press Save the message as a prompt, and start it with `/name`. A blank like `{{city}}` is asked for each time. A saved prompt gives no right.

## Site rules

Tabs, Site rules: sites that Claude never sees, sites that ask before each read, or only these sites. A rule covers the site and everything below it, holds in every tool, list, frame and search, and stands above every grant. Never wins over the others. A site that a rule blocks is suspended at once; after you remove the rule you approve it again. If the stored rules cannot be read, every call is refused and the sidebar offers to reset them.

Instructions hidden in a page can still mislead Claude inside what you attached. Rules, levels and cards limit what that can do; they do not make a page harmless.

## Upgrade

Start the newer `KitewardenSetup` and choose `i`, then load or update the add-on. Firefox may stay open: the running helper is stopped, chats that it runs end, and the add-on starts the new one. Kept: key, pairings of remote clients, profiles, Thunderbird registration, and in the add-on all settings, chats, workflows and schedules. Switches stay as you set them. Grants always end.

An older installer refuses to replace a newer version. If the parts speak different protocols, the sidebar and `connection_status` name the older part.

**Interrupted?** Run the installer again. It first puts back what was there before, then installs. Until then `doctor` says "the last one was interrupted". A failure during the run undoes itself.

## Uninstall

Settings, Apps, Kitewarden, Uninstall, or choose `u` in the setup program. It removes the registration, stops the helper, and deletes its own files and the Claude Code entry that it made. Files of others in the folder stay. Not removed: the add-on and its data (remove it in `about:addons`), the Claude Desktop extension (remove it there), transcripts of Claude Code, and skills that you exported.

## Optional parts

Extract the optional zip to a folder of your choice. Each program works with the installed helper and does nothing until you start it and press Turn on under Advanced; it is off again when it ends. `node backends\isolated.mjs`, `node backends\input.mjs`, `node remote\gateway.mjs`. The other computer of a remote link needs the folder `remote` alone. For Thunderbird 140 or later: `install --thunderbird`, then load the mail `.xpi` in Thunderbird the same way. Thunderbird itself was not tested yet, nor a remote link between two computers.

## Troubleshooting

Run the check first. It names each problem with its fix and prints no key:

```powershell
.\KitewardenSetup-1.0.0.exe doctor --claude-code
```

| You see | Do |
|---|---|
| Sidebar: Helper not installed | Run the installer. If the doctor says that the registry points elsewhere, install again |
| Sidebar: Helper stopped | It comes back within 30 s. Press Retry now. Security software may hold the program back |
| Sidebar: The helper refused to start | The doctor names the file that others can read. Install again sets the access lists |
| Versions differ | Update the part that is named as older |
| Installer: being used by another process | Nothing was changed. Close the program that holds the file, run again |
| Installer: this installer is damaged | Get the file again and check its checksum |
| Installer: exists and is not a Kitewarden folder | Choose another folder with `--home` |
| Client: not_installed | The client looks in another folder than the installer used |
| Client: session_ended | The helper was restarted. Attach the tab again, or press the button that gives the lost grants back |
| Client: permission_required for a container | Press Allow tabs in containers |
| Claude Code: Failed to connect | `node --version` must be 22 or later, then the doctor |
| Chat: Claude Code was not found | Install Claude Code, restart Firefox |
| Claude Desktop shows no tools | Restart Claude Desktop; look at the extension's log under Settings, Extensions |
| Client: site_blocked | A site rule of yours. Tabs, Site rules |
| Client: rate_limited | More than 120 calls of one client in a minute; the message says how long to wait |
| Sidebar: Settings cannot be read | Restart Firefox. If it stays, press Reset the site rules; nothing else is deleted |
| Add-on gone after a restart | Expected until it is signed |
