# Project state

Handoff after Prompt 7, the release audit (2026-11-25). Requirements, evidence and class per capability: [feature-parity.md](feature-parity.md), "Release audit". For users: [SETUP.md](SETUP.md). Building and testing: [DEVELOPMENT.md](DEVELOPMENT.md). Signing and distribution: [RELEASE.md](RELEASE.md). Decisions D1 to D9 hold. Prompt 6 widened FC-INST-14 (a bundle for Claude Desktop). Prompt 5 widened four rows in the user's words (FC-CONN-25, FC-AGT-11, FC-AGT-15, FC-DBG-06) and narrowed one (FC-DATA-01: no HttpOnly value and no token ever).

## Verdicts

| Use | Verdict | What the evidence supports | Still blocked |
|---|---|---|---|
| Local testing by the owner, on this kind of computer | **Ready**, with the limits on the right | **1.0.0 prepared on 2026-11-26** (CHANGELOG.md): version, update_url, optional bookmarksInfo, text before Connect, chat marked experimental. On it: units 130, integration 54, install 21, packaged 14, firefox 33, companion 27, audit 26, control 24, advanced 20 passed; web-ext lint --self-hosted 0/0/0; release/SHA256SUMS.txt gives kitewarden-1.0.0-unsigned.xpi fb7e4f08…, KitewardenSetup-1.0.0.exe 32637d4e…, kitewarden-1.0.0.mcpb e83c3b27…. Not signed; desktop and live not run on it. Before that the add-on IDs became @fireiscoolsolo.github.io (D10); units 130, integration 54, install 21, packaged 14, firefox 33, companion 27, audit 26, control 24 and advanced 20 passed on it, and the checksums below are of the build before. Every headless suite passed on the candidate `9deca7c`, the first commit named Kitewarden (D10): units, integration, install, packaged artifacts in real Firefox, all Firefox suites of the development build. The visible desktop (4 passed, 4 not run, the user at the computer) and short live runs passed on `51552f1`, which has the same product code. Install, upgrade from the previous version, interruption, doctor and uninstall work with the packaged files | The add-on is temporary and gone after each restart of Firefox. Cross-account denial (AC-03, AC-04) is not shown, so use it on a computer whose other accounts you trust. Claude Desktop, Thunderbird, two computers and real sites were not tried. File and shell tools of a chat are as strong as the user's own account: leave them off unless needed |
| Public distribution | **Not ready** | Lint and validation of the packages are clean (the mail add-on has four warnings), builds are reproducible, the rules of Mozilla and Anthropic were read again | Public name, add-on IDs, copyright holder, terms of the artwork, data declaration, listed or self-distributed, and the subscription question are decisions of the owner (name and IDs: decided, D10). No signed build, so AC-06 is open. AC-03 and AC-04 are open. Mozilla has reviewed nothing. The policies of 2026-12-01 come into effect in days |

## Checkpoint

- Source: https://github.com/Fireiscoolsolo/kitewarden, public, pushed 2026-11-25 with a history from which local folder paths were removed (so every hash differs from the first local repository; the hashes here are those of GitHub). Author is a placeholder identity of this repository.
- On GitHub only `main` exists; it is the end of `feat/optional-backends` below. The other branch names are those of the local repository. Locally `main` = `42a20ca`, the audit baseline. `feat/windows-bridge-slice` = `2e99263`, the end of Prompt 2. `feat/sidebar-chat` = `59f65f2`, the end of Prompt 3.
- `feat/browser-control` = `d34fba3`, the end of Prompt 4 (code `fa75413`).
- `feat/optional-backends` starts there: two `wip:` commits, then **`26d1256`, the code and tests of the Prompt 5 results**, plus the commits that add this file and the last parity rows, up to `7bb7f27`.
- Prompt 6 went on to `8bfefbe` on the same branch: code `ae0de1c`, lint fix `e726f09`, version 0.5.0.
- **Prompt 7 starts there. The final candidate is `9deca7c`, version 0.6.0, protocol 4**: code, tests and user documents that the results below belong to. The commit after it holds this file and the parity document.
- Nothing is signed or published as a package (the source is on GitHub), and no everyday Firefox profile was touched: every Firefox of the tests ran with `-no-remote` and a profile in the temp folder.
- Prompt 1: the audit is complete and its checkers pass. The orchestrator's delivery was refused. Its record in `.claude/opus-orchestrator/` is unchanged and not in Git.

## What exists

A Firefox add-on (Manifest V2, persistent background, native sidebar), a native messaging host with a named pipe per profile that also runs the user's own Claude Code and reads files for uploads, and an MCP server over stdio. That everyday product has no TCP port, no CDP, no debugger permission and no dependency to install. Node 22 or later runs the MCP server, the optional programs, the build and the tests. Protocol 4, version 0.6.0. A 0.5.0 or 0.4.0 add-on works with a 0.6.0 helper (PF); another protocol is refused and the older part is named.

Beside it, separate and off: optional programs that the user starts, an add-on for Thunderbird, and a developer build.

| Part | Files |
|---|---|
| One table of tools, limits, argument checks, redaction | [shared/protocol.mjs](../shared/protocol.mjs) |
| The one command path: sessions, rights, stop, batch | [ext/background/router.mjs](../ext/background/router.mjs) |
| Tools that read or act in a page | [ext/background/pagetools.mjs](../ext/background/pagetools.mjs) |
| Tools for tabs, windows, containers, browser data | [ext/background/tabtools.mjs](../ext/background/tabtools.mjs) |
| Wiring, native port | [ext/background/main.mjs](../ext/background/main.mjs), [native.mjs](../ext/background/native.mjs) |
| Grants, approval cards, site rules | [ext/grants/grants.mjs](../ext/grants/grants.mjs), [approvals.mjs](../ext/grants/approvals.mjs), [rules.mjs](../ext/grants/rules.mjs) |
| Saved prompts | [ext/chat/prompts.mjs](../ext/chat/prompts.mjs) |
| Chats: history, attachments, runs | [ext/chat/chats.mjs](../ext/chat/chats.mjs) |
| Workflows: recording, redaction, skill text; replay; outline parser | [ext/workflow/workflows.mjs](../ext/workflow/workflows.mjs), [replay.mjs](../ext/workflow/replay.mjs), [elements.mjs](../ext/workflow/elements.mjs) |
| GIF recording and encoder | [ext/capture/gif.mjs](../ext/capture/gif.mjs), [encoder.mjs](../ext/capture/encoder.mjs) |
| Page side, one script in each granted frame | [ext/page/content.js](../ext/page/content.js) |
| Sidebar | [ext/sidebar/](../ext/sidebar/sidebar.mjs): `sidebar.mjs`, `ui.mjs`, `chat.mjs`, `workflows.mjs`, `markdown.mjs` |
| Host, pipe, login | [host/native/Host.cs](../host/native/Host.cs) |
| Files for uploads | [host/native/Files.cs](../host/native/Files.cs) |
| Claude Code runs, skill file | [host/native/Chat.cs](../host/native/Chat.cs) |
| Install, upgrade, recovery, uninstall, doctor; KitewardenSetup | [host/native/Setup.cs](../host/native/Setup.cs) |
| MCP server, pipe client, choice of profile | [mcp/server/server.mjs](../mcp/server/server.mjs) (entry), [serve.mjs](../mcp/server/serve.mjs), [link.mjs](../mcp/server/link.mjs) |
| Console, requests, bodies of granted tabs; hooks in the page | [ext/background/observe.mjs](../ext/background/observe.mjs), [ext/page/hooks.js](../ext/page/hooks.js) |
| Diagnostics, page tools (WebMCP), calls of the backends | [ext/background/devtools.mjs](../ext/background/devtools.mjs) |
| Cookies, storage, download details; the only code that reads cookies | [ext/background/sitedata.mjs](../ext/background/sitedata.mjs) |
| Optional backends: attach, switch, commands, their tabs | [ext/background/backends.mjs](../ext/background/backends.mjs) |
| Schedules; pairings of remote clients | [ext/schedule/schedule.mjs](../ext/schedule/schedule.mjs), [ext/remote/remote.mjs](../ext/remote/remote.mjs) |
| One rule set that takes credentials out | [shared/redact.mjs](../shared/redact.mjs) |
| Isolated Firefox (BiDi), Windows input | [backends/isolated.mjs](../backends/isolated.mjs), [input.mjs](../backends/input.mjs), [Input.cs](../backends/Input.cs), [link.mjs](../backends/link.mjs) |
| Remote gateway and client | [remote/gateway.mjs](../remote/gateway.mjs), [client.mjs](../remote/client.mjs), [wire.mjs](../remote/wire.mjs) |
| Thunderbird add-on | [thunderbird/](../thunderbird/mail.mjs) |
| Developer build | [developer/](../developer/pagescript.mjs) |
| Build to `dist/`, same bytes from the compiler, packages in `release/` | [build/build.mjs](../build/build.mjs), [compile.mjs](../build/compile.mjs), [release.mjs](../build/release.mjs) |
| Checks of the packages | [test/install/](../test/install/setup.test.mjs), [test/firefox/packaged.mjs](../test/firefox/packaged.mjs) |
| Test double of Claude Code | [test/doubles/](../test/doubles/claude.mjs) |

## Contracts

From Prompts 2 and 3, still valid:

- Both entry points call `router.call(sessionId, id, tool, args)`. Grants live in memory only: session, tab, exact origins, level. Only messages of the real sidebar port change grants, answer cards, pause, stop or connect. A card closes after 60 s seen or 120 s unseen, ignores its first 500 ms, and serves one waiting call.
- Pipe login: host nonce, client nonce and HMAC, host HMAC, then versions. After a lost link calls in flight end with `outcome_unknown`, nothing is repeated, the next call returns `session_ended`, grants are gone.
- A chat is a session of kind `chat`. A run is one `claude -p` process per message in a job object, with Kitewarden tools only, joined to its chat by a ticket that works once. Skill files are written only after a preview. The list of options is in [Chat.cs](../host/native/Chat.cs).
- `router.call(..., { user: true })` opens the tools that are for the user only (`get_selection`) and waives no other check.

New in Prompt 7:

- **Site rules** (`storage.local.siteRules` `{block, ask, allow}`, hosts): `ruleFor` in rules.mjs is the only judge. `authorize`, `authorizeFrame`, `allowedSite` (opening, navigating, granting, approving), the tab list, history and bookmarks ask it. `setRules` takes blocked origins and frames out of every grant and suspends what is there. Rules that cannot be read are no rules: `router.unreadable` refuses everything until they are, or the user resets them.
- **Order of codes** in `authorize`: `site_blocked` and `restricted_page` come before `grant_suspended`, as the matrix says.
- **File, shell and web tools of a chat** (`chat.tools`, off at first, never copied to a new chat): the helper adds `--tools`, an `ask` rule for each of them, `--permission-mode manual` and `--permission-prompt-tool mcp__kitewarden__chat_permission`, and `FC_CHAT_TOOLS` for the MCP server of that run, which then lists that tool. `Chats.permission` asks on the ordinary card: only in a run of that chat that began with the switch on, only the tools of `CHAT_TOOLS` (the same list as `Offered` in Chat.cs), the whole input, hidden characters written out, at most 20,000 characters, and the switch again after the card. Anything but an allow is answered as a deny. The outcome becomes done with the tool's result. A pause ends such a run.
- **Levels:** `router.setLevel` ends acting calls of that tab when it goes down. `call.level` holds the level of a call.
- **Clipboard:** group `clipboard`, `api.clipboard`. `session.copied` is what ctrl+v inserts; nothing reads the clipboard.
- **Lists of a page** (role combobox or listbox, aria-haspopup listbox): `choose` in content.js, through `form_input`.
- **MCP over stdio:** a line ends at \n only, and U+2028 and U+2029 are escaped on the way out, also in the message to Claude Code.
- **Content policy** of the add-on: `default-src 'none'`; no server can be reached from its pages.
- **Look:** one stylesheet with named colors (pine product, blue read, amber act or question, brick stop), light and dark. Icons are files in `ext/sidebar/icons/`, used as masks, so a replacement keeps its name and is one color on transparent. `ext/sidebar/art/` and `ext/icon.svg` are pictures with their own colors, drawn for light paper; the stylesheet inverts those of the sidebar in dark. The owner supplied them all, made with another AI tool; by decision of the owner `NOTICE.txt` says that there is no artwork of others. The picture of the empty chat also shows a link that is down and a stop.
- **Limit:** 120 calls of one session in a minute. Test clients pace themselves (`McpClient.pace`).

From Prompt 6, still valid:

- **Files of an installation:** `install.json` (pipe, made once), `key.bin` (made once), `installed.json` `{version, protocol, files: {name: sha256}}`, program files named in `Names` of Setup.cs, `native-manifest*.json`, `claude-code.txt` (only if the installer registered the server; holds CLAUDE_CONFIG_DIR of that moment or nothing), `setup\` while an installation runs.
- **Exchange of files:** new files complete in `setup\new-*`, then `setup\journal.txt` (folder of the old files, then `=name` for a file that was there and `+name` for a new one), then each old file to `setup\old-*` and the new one into its place. The journal exists: the old version counts. Deleting it commits.
- **An installer** starts and turns on nothing, keeps key, pipe, pairings, profiles, chat folder and the Thunderbird registration, refuses a newer installed version, and stops only helpers started from its own folder.
- **Setup program** = the helper's sources with `payload.txt` and the files as resources. Without arguments it asks; with them it is the same command line as the helper. Only it makes an entry in Settings, Apps.
- **`doctor`** logs in to the pipe with protocol 0: the helper proves the key and names its protocol, and no session begins.
- **Claude Desktop bundle:** the files of `mcp/` under `server/`, started with `--home ${user_config.home}`. Its tool list comes from `mcpTools([])`.

New in Prompt 5:

- **Groups:** `GROUPS` in protocol.mjs names every switch and the Firefox permissions that it needs. All are off at first. A switch counts before the card, after it and at the last gate; one that goes off ends what runs and waits (`stopGroup`). `switches.isolated`, `input` and `remote` live in memory for one connection of the backend.
- **Backends:** a program logs in to the pipe and says `hello {backend: {id}}`. Known are `isolated`, `input`, `remote`; a second one of a kind is refused. It does nothing until the user turns it on, and is off again after each connection. It gets `command {id, method, params}` and answers in parts (`reply`, base64), and may send `event`s about its own tabs. `error.before` means that nothing was done; anything else leaves the outcome open. A backend holds no rule.
- **Virtual tabs:** tabs of the isolated Firefox have IDs from `VIRTUAL` (1e9) on. `Backends.extend(api)` puts them into what the router takes for the browser, so every ordinary tool works there through the same session, grant, origin, frame, level, pause, take-over and card. Tools for windows, groups, downloads and uploads refuse them. `sent.trusted` becomes `trusted_event`.
- **No fallback:** nothing calls a backend except the tools that name it and the tabs that belong to it.
- **Captures** belong to one grant (`Observer`), in memory, and end with release, suspension, pause, stop and switch; what they held is dropped. Entries count by the sender that Firefox names. Requests come from webRequest only.
- **Redaction:** `redactUrl`, `redactText`, `redactHeaders`, `redactBody`, `redactData`, by names and shapes. A value of an HttpOnly cookie, and one that looks like a credential, never leaves sitedata.mjs.
- **Page script:** only in `dist/developer`, which `npm run build:developer` makes. `javascript_tool` runs in the world of the page through the page's own eval.
- **Schedules** (`storage.local.schedules`): `{id, workflow, title, digest, kind, at, minutes, time, days, on, next, runs}`. Due: an ordinary replay of the sidebar session. A changed workflow, a pause, a stop or a time missed by 5 minutes means no run. Waits 30 minutes for the user. No tool reaches it.
- **Remote** (`storage.local.pairings`): `{id, name, state, created, expires, fingerprint, device, address, seen}`, without keys. Keys are in `<home>\remote\clients.json` and in `link.json` of the other computer. States offered, pending, allowed, revoked, expired. The add-on decides at `hello {remote: {id}}` and at each call; the gateway checks as well. Kind `remote` gets no private tab, and its lost grants go to no local client.
- **MCP server:** `--with isolated,input` lists those tools, `--mail` serves Thunderbird only, `--home` names another installation. Listing is no right.
- **Profiles** have a `kind` in their record; the everyday server ignores `mail`.

From Prompt 4, still valid:

- **Adding a tool:** one entry in `TOOLS` (level, arguments, `group` for a switch, `approval`), and a handler in `pagetools.mjs` or `tabtools.mjs` with `(router, call, spec, origin, args)`. A handler describes, calls `r.ask`, then `r.sent` right before the side effect. **`r.sent` is the last gate:** it throws if the call was stopped, cancelled, paused or revoked. Set `call.sent.outcome = 'done'` when the outcome is known.
- **Rights, in order:** session, pause or stop, grant of this session for this tab (`conflict` if another agent session has it), private flag, current origin, tab taken over, level, host permission. `authorize` runs at the start, again after the wait for the turn, and again after every approval. `authorizeFrame` asks the frame itself for its origin, which must be the tab's or one in `grant.frames`. The page compares the origin once more before it does anything.
- **Grant:** `{sessionId, tabId, origins, frames, level, state, private}`. `frames` is filled only by `approve_frames` and lets the tab itself go nowhere. One agent session per tab; the user can move it. The session of the sidebar is the user and does not count. `rememberLost` and `regrant` give the same tabs, origins and frames to a new session of the same client, once, by one click, never private tabs.
- **Refs:** `ref_f<frame>_<document>_<n>`, without the frame part in the top frame. `stale_ref` carries up to three `candidates` of the same role and name.
- **Reply of an action:** `dispatched`, `trusted_event: false`, `observed`, `page` (navigated, opened a tab, changed, or no visible change), `hint` (names the optional input backend when nothing was seen), `dialogs`. Dispatch is never reported as an effect.
- **Order:** actions in one tab run one after the other. A queued one that is stopped never begins.
- **Stop:** `halt()` refuses new work, ends running and queued calls and returns for each `{session, tool, state, may_have_taken_effect}`. Only `resume()` from the sidebar ends it. `stopTab(tabId)` and `resumeTab(tabId)` do it for one tab; the page pill can only stop. The content script has an epoch that a stop raises, so typing and dragging end in the middle.
- **Batch:** `{completed, stopped_by, message, done, steps}`; each step has state, result or error, `may_have_taken_effect`. A page that moved ends the batch unless the step says `navigates` or is `navigate`.
- **Uploads:** add-on to host `folder_check {path}`, `file_stat {paths, folder, folders}`, `file_read {path, stamp, offset, count, folders}`. The user lists folders in the sidebar (`storage.local.folders`); no tool can. The helper resolves by handle and checks again at each read.
- **Switches:** `storage.local.switches` for bookmarks, history and downloads, off at first, plus the optional Firefox permission. Checked before the card and after it.
- **Profiles:** a random ID and a label in `storage.local.profile`, sent in `hello`. Pipe `<base>-<first 16 hex digits>`, record in `<home>\profiles\<id>.json`. With several running ones a client gets `ambiguous` and calls `list_connected_browsers` and `select_browser`. A chat run is pinned by `FC_PROFILE`.
- **Workflow:** `{id, title, origin, tabs, created, steps, rest}`. A step may have `tab` (0 to 4) and `frame {origin, path}`. A text step is `ask: true`; `literal: true` with a value only by a choice in the editor, never for personal or credential-like fields. A text that an earlier version stored becomes `old: true`: kept, hidden, unused and in no preview, log, skill or export until the user keeps or deletes it. Steps that this version does not know stay in `rest`. Replay takes the grants of that moment for each tab and frame.
- **Private windows:** `incognito: spanning`. Firefox hides them from the add-on unless the user allows it there. Then a private tab is in no list, count, log or lost-grant list without a grant of its own (second tick, MCP client only).

## Packaged artifacts

Version 0.6.0, protocol 4, from `9deca7c`, not signed. `npm run release` makes them; `release/` is not in Git. SHA-256:

| Path | What | SHA-256 |
|---|---|---|
| `release/KitewardenSetup-0.6.0.exe` | per-user installer, upgrade, doctor, uninstall | `6b98dcb3363edab81f0edd4ed41668acd4fcaad2519f493451bf2bd3b5644e55` |
| `release/kitewarden-0.6.0-unsigned.xpi` | everyday Firefox add-on | `327dd01246d7e3df86df3fb2d8f3932db3d9747b2371a715c4ebb763a3d7a301` |
| `release/kitewarden-0.6.0.mcpb` | Claude Desktop bundle | `3be3e486927d6d20c87632c6f34d14bbfecef1f0d7a3fd37e314ad8caa40da36` |
| `release/optional/kitewarden-optional-0.6.0.zip` | isolated Firefox, Windows input, remote link; separate | `dafd2ccd1c9c60a21bd43bfef3858ccadbbc91a58cdec8413a846f8638ac2324` |
| `release/optional/kitewarden-mail-0.6.0-unsigned.xpi` | Thunderbird add-on; separate | `0d7c4cdd0da48813142d57671a976505740978ce0311024e689be160fd6f0bac` |
| `release/CONTENTS.txt` | hashes of every file inside | `c7a2b79346059c0fd9398567bcd3846e6035dbc2f8f9f9d24fda200858d2071e` |
| `release/NOTICE.txt` | license (MPL-2.0), third-party code (none), trademarks | `38605ff0b176fd2ae9684b8b8e610469d143c128e30d991b8fdd6f4dfdd9fa40` |
| `release/LICENSE` | text of MPL-2.0 | `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5` |
| `release/SETUP.md` | for users | `64db7cff85b682cc36a5feab99a25fa9247d0cde3ed5dd8afeb4f6dc3279b01a` |

`SHA256SUMS.txt` lists the same. The working folder, a clone with autocrlf on in a path with a space, and a plain clone gave the same bytes for `9deca7c`, programs included (csc 4.8 of this Windows). The developer build is not in `release/`; packing stops at a trace of it. The everyday package, the mail add-on, the optional programs and the developer build are four separate things, and none contains another.

### Results of Prompt 7

Windows 11 build 26300, without elevation, Firefox 160.0.1 release (161.0 for every run of Kitewarden, from `9deca7c` on), Node 26.12.1, Claude Code 2.1.302 (haiku for the live runs), Claude Desktop not run (6.28899.6 when Prompt 6 read its files), on 2026-11-25. The user's own Firefox ran all the time and was not touched: every test Firefox ran with `-no-remote` and a profile in the temp folder. Complete output of each run: `test-results/final/` (not in Git).

| Command | Kind of evidence | Result on `9deca7c` |
|---|---|---|
| `npm test` | simulated, and package checks | 130 of 130 |
| `npm run test:integration` | real helper, pipes, server; Firefox played by the test; Claude Code a test double | 54 of 54, and 54 of 54 in each of 10 more runs of the commit before. On the untouched `8bfefbe`: 51 of 51 in each of 20 runs |
| `npm run test:install` | **packaged**: setup program, files, registry, pipes; Firefox played | 21 of 21 |
| `npm run test:packaged` | **packaged** in real Firefox, headless | 14 of 14. The builds before the rename carry the old names and IDs, so the upgrade starts from this code with the version 0.5.99; the checks from 0.3.0 and 0.5.0 are retired |
| `npm run test:firefox`, `:companion`, `:control`, `:audit`, `:advanced`, `:developer` | development build in real Firefox, headless | 33 of 33, 27 of 27 (before that three times, and twice with half of the processors busy), 24 of 24, 26 of 26, 20 of 20, 4 of 4 |
| `npm run test:desktop` | **visible Firefox** on the desktop | on `51552f1` (Kitewarden), the user at the computer: 4 passed, 0 failed, 4 not run (`test-results/final/test-desktop.log`). Not run: another window kept in front, because the new Firefox window was in front itself; Windows input on and refused, which the test leaves out while somebody uses the computer; and the refusal while somebody uses it, because the backend waited for a pause of 0.7 s and then clicked: it refused only after 8 s of input without such a pause, so a click could land between two keystrokes. **Made stricter in `d4089f2`**: it clicks only after 2 s without mouse or keyboard, waits at most 5 s for that, and looks again before the move and before each press (a press always gets its release); the approval card says so. On `d4089f2`, with a script that reported a mouse move of 0 pixels every 0.3 s: 5 passed, 0 failed, 3 not run (`test-results/final/test-desktop-busy.log`); the refusal was shown ("No click was sent: the user is using mouse or keyboard; it clicks only after 2 s without them"). With nobody at the computer for a minute, on `453a7cb`: 6 passed, 0 failed, 2 not run (`test-results/final/test-desktop-idle.log`): denied sends nothing, the approved click reaches the page once, the pointer of the user stays (459,489 before and after), and covered, hidden, minimized and changed targets get no click. Not run: the focus check (the new window was in front) and the refusal, which needs somebody at the computer and was shown in the run before. Units 130, integration 54 and advanced 20 passed on it. Before the rename, on `ef59754`, nobody at the computer: 6 passed, 0 failed, 2 not run (`test-results/final/test-desktop.log`): another window kept in front, because the new Firefox window was in front itself, and the refusal of Windows input while somebody uses the computer. Earlier, before the new look, in use, with another program in front: 5 passed, 3 not run (`desktop-in-use.json`): the focus stayed with the other program also after a new window; the refusal of Windows input while somebody types was again not observed, because the user rested at that moment |
| `npm run test:live-audit` | **live and paid**, haiku, real Firefox headless | exported skill; file and shell tools off, denied, allowed; PDF and picture: all 7 checks passed on `51552f1` (Kitewarden), as before on `ef59754` (`test-results/final/test-live-audit.log`). The skill run cost 0.0065 USD; the log has no cost of the chat runs. Chats leave transcripts in the folder of Claude Code of this user; nothing else of the user was written |
| `test:claude`, `test:chat`, `test:milestone` (live) | not run again: their paths (standalone server, chat, resume) ran in `test:live-audit` on the candidate | Prompt 5 |
| `web-ext lint --warnings-as-errors` 10.8.0 on the unpacked .xpi | **packaged**, official linter, from the local npm cache | Firefox package: 0 errors, 0 warnings, 0 notices. Thunderbird package: 0 errors and the same 4 warnings |
| `mcpb unpack`, `validate`, `info` 2.1.2 | **packaged**, official tool | unpacks, manifest valid, "Not signed". Claude Desktop itself was not used |
| `node .opus-inbox/audit_tools.mjs check-parity` | documents | OK |
| 30 new guards taken out one at a time, in a copy | control of the new unit tests, simulated | 29 noticed at once, 1 (frames that leave a grant under a rule) after its test was made stricter |
| Signed build | none exists | open |

**The failure of Prompt 6.** One of its runs of `test:integration` failed (14 of 15 passed in its record) in "run: the documented options in a folder of the helper"; the message was not kept. It did not come back in 20 runs of the untouched `8bfefbe`. With every processor busy, the same test failed in 8 of 12 runs, each time with this assertion: `assert.deepEqual(hello.map((b) => b.ticket), [r.ticket])`, actual `[]`, expected one ticket (output in `test-results/integration-race/`). The test double of Claude Code ended before the MCP server of that run had logged in to the pipe. It is a race of the test, and the test now waits for the login: 12 of 12 under the same load. Whether the failure of Prompt 6 was this one is **not known**, because its message was not kept; it is the same test. No product defect was found behind it.

Other failures on the way, on earlier states of the candidate, with logs in `test-results/before-final/`: `test:packaged` 12 of 16 once, because a click on a switch of the old add-ons did not arrive; 16 of 16 in every run since. `test:companion` while the mutation runs loaded the computer: twice a click on Stop missed (fixed, below), and once four replay checks ended with "The element of this step is not on the page". Its cause was found afterwards: the first defect of the next table, not the load.

After the runs: no registration, no entry of a test in the temp folder, no helper and no test Firefox was left. `%LOCALAPPDATA%\Kitewarden` does not exist. Three folders `fc-claude-config`, `fc-docs` and `fc-empty` in the temp folder are older than this audit and were left.

### Found and fixed by the audit

| Defect | Since | How it was found | Fix and its test |
|---|---|---|---|
| In 1 of 429 documents the random part of a ref began with f and seven digits. The refs of that page were then read as those of a frame that does not exist, so its elements could not be found, clicked, filled in or replayed until it was loaded again | Prompt 4 | one failed companion run; forced with that id on the unchanged code: the same 4 of 27 checks failed with the same messages | a letter before the random part (U, failed before; with the forced id 27 of 27 in Firefox) |
| `tabs_create` with `duplicateOf` gave a grant for the origin that the tab showed at that moment, also when it had just left the granted one | Prompt 4 | reading | origin compared (U, failed before) |
| `windows_close` closed a window with a tab that the user had taken over or was busy with; `tabs_close` a tab that was handed to the user | Prompt 4 | reading | both refuse (U, failed before; F) |
| After the user closed the window of a session, its `tabs_create` failed for good | Prompt 4 | reading | closed windows are forgotten (U, failed before; F) |
| A call whose text held U+2028 or U+2029 was never answered: the line reader of Node ends a line there. Nothing could be smuggled in, because quotes are escaped | Prompt 2 | a hostile client name in the audit suite | own line reader, escapes on the way out (I, failed on `8bfefbe`) |
| A card put a value of several lines into one line, so a second command would read as arguments of the first; a long card pushed its buttons away | Prompt 2 | reading, for the new shell tools | line breaks kept, long values scroll, their size is named (U, F) |
| A file or a choice made right after New went to the chat before | Prompt 3 | two tests | the new chat comes before the answer, and what follows waits for it (F) |
| Stop moved away under the pointer while text streamed in | Prompt 3 | the companion suite under load | Stop is above the messages (F) |
| Damaged site rules counted as none; uninstall left a new file of chats | Prompt 7 | audit suite | fail closed (F), file listed (I) |
| The sidebar was not parsed by any test but the Firefox suites | Prompt 2 | a broken line | every shipped script is parsed (U) |

### Review of authorization and recovery

| Area | Result |
|---|---|
| Pipe and key file | access lists name the current user only, network path denied, existing pipe and Everyone stop the host, doctor names the file (I, run again). **Open: another Windows account** |
| Session identity | IDs from the host; tickets of chat runs work once; a client cannot name itself as another kind; 205 unknown actions over an authenticated pipe refused (F) |
| Tab and frame grants, origin changes | run again (F); new: copies, windows, levels, browser pages, site rules |
| Private windows | run again (F): no list, count, log or lost grant without the second tick; downloads stay private (U) |
| Upload scope | run again (I, F): listed folders only, by handle, checked at each read; a key outside is path_not_allowed |
| Redaction, recording defaults | run again (U, F): secret fields, cookies, tokens; text is asked for at replay, also by the exported skill (live) |
| Take over, pause, stop, revoke | each ended a waiting call 39 to 42 ms after the click (measured); queued actions never start (U, F); a pause also ends chat runs that may have a command under way |
| Optional and remote paths | off after install and after each upgrade (PI, PF); off, revoke and stop end queued backend actions before they start (F, run again); pairing, expiry and revocation (I, F on one computer) |
| Recovery | helper killed, Firefox closed, add-on restarted, interrupted install, damaged settings: run again |
| New limits to know | an allowed shell command can do what the user can do, and a stop cannot take back what it did. Ask rules of Claude Code are what brings each call to the card: a Claude Code that ignores them would run read-only commands without a card, so the live check belongs to each new version |

### Compared with the sources

Kitewarden was measured headless on this computer with local pages (`test-results/measure.json`). The others were not run: FoxPilot is installed in the user's everyday Firefox, which must not be changed, and the others would have to be downloaded and installed. What is said of them is from their instructions or the source audit at the pinned commits, and nothing of it was measured.

| Workflow | Kitewarden, observed | Other, not measured |
|---|---|---|
| Everyday control (FoxPilot): read a form, set a field, send it, know the outcome | Setup: installer, add-on, Connect, attach a tab with one question of Firefox. 4 calls and 2 cards, 447 ms without the cards; in one batch 1 call after the read and 2 cards, 359 ms. The reply said "navigated" and the page confirmed one save | Its instructions ask for a fresh snapshot after each action, so list, snapshot, fill, snapshot, click, snapshot: 6 calls and no card. Its permission is per site, not per tab (02 in "Permission boundaries") |
| Action outcome | dispatched and observed are apart; a dead button says that nothing changed (F) | not measured |
| Sidebar and recording (ccfox) | chat, history, resume, recording, replay with a card for each step, export as a skill that a model ran (live) | sidebar chat (01-F16) and a mode that acts without asking (01 in "Permission boundaries"); not run |
| Background and several profiles (Agent F) | read, navigate, open, read and close in the background: 0 switches of the tab in front (F). On the visible desktop another program stays in front (D, Prompt 5). Two profiles: ambiguous, pick, no grant carried over (F) | any connected profile, the focused tab is the default (03); not run |
| Approvals (Inari MCP) | a card for each action, bound to element, value, origin and one call; 500 ms guard; denied, late and swapped ones do nothing (F) | approval bound to tool, site and argument hash (07); not run |
| Reconnect | new helper 1.1 s after it was killed, next call session_ended, grants back with one click (F) | not measured |
| Pause and revoke | pause 41 ms, take over 39 ms, stop 42 ms, revoke 39 ms from the click to the end of the call (F) | not measured |

### Checks kept apart

| Check | State | Needs |
|---|---|---|
| Claude Desktop | manifest valid, server started as the manifest says reaches the helper (PI, PF). **Not verified**: not installed there | yes of the user, or a test sign-in (check 11) |
| Thunderbird | lint: 4 warnings, one of them the missing data declaration; name length fixed in Prompt 6. Mocked and played only. **Not run in Thunderbird, not submitted** | Thunderbird and a dummy account (check 8); declaration and store review by the owner |
| AC-03, AC-04 | **open** for another account; the rest run again. This Windows has other enabled accounts, none was used and none was created | their user, with the steps of check 1 |
| AC-06 | **open** for a restart with the add-on staying installed | a signed build |
| Remote link | works on one computer (I, F); **not tested between two** | a second computer, its firewall (check 9) |
| Public name | "`<name>` for Firefox" in the policies, also those of 2026-12-01, and in the trademark guidelines, which name "Firefox NewGadget Extension" as not allowed; read on 2026-11-25. **Decided** 2026-11-25: Kitewarden (D10); a trademark office search is open | owner |
| Data declaration, signing | **to decide** (license MPL-2.0 and IDs firefox@fireiscoolsolo.github.io, thunderbird@fireiscoolsolo.github.io decided 2026-11-25): bookmarksInfo, searchTerms, personalCommunications; API key and certificate | owner, RELEASE.md |
| Claude subscription | Legal and compliance, read on 2026-11-25: a user may sign in to the unmodified Claude Code with their own subscription; a third party may not offer claude.ai login or route requests through plan credentials for its users; running Claude Code in a product needs the Commercial Terms. `--bare`, which never reads a subscription login, is to become the default of `claude -p`. **To decide** | owner |

### Results of Prompt 6

Windows 11 build 26300, without elevation (medium integrity), Firefox 160.0.1 release, Node 26.12.1, Claude Code 2.1.302, Claude Desktop 6.28899.6 (files read, not run), on 2026-11-24 and 25. The results are of 2026-11-25, in a fresh clone of `ae0de1c` with autocrlf on.

| Command | Kind of evidence | Result |
|---|---|---|
| `npm run test:install` | **packaged artifact**: real setup program, files, registry, processes, pipes, unpacked by another zip reader; Firefox played by the test; installed Claude Code with its own configuration folder, no model called | 21 of 21 |
| `npm run test:packaged` | **packaged artifact in real Firefox**, headless, disposable profiles, unsigned .xpi as a temporary add-on, real clicks; Claude Code is a test double | 15 of 15, `test-results/packaged.json` |
| `npm test` | development build, simulated; plus package checks | 116 of 116 |
| `npm run test:integration` | development build, Firefox played by the test | 51 of 51 in the clone; 14 of 15 runs. The second run failed in "run: the documented options in a folder of the helper"; its message was not kept, and it did not come back in 13 further runs. Cause unknown |
| `npm run test:firefox`, `test:companion`, `test:control`, `test:advanced`, `test:developer` | development build in real Firefox, headless | 33 of 33, 27 of 27, 24 of 24, 20 of 20, 4 of 4 |
| `npm run test:desktop` | not run again: input and focus did not change | Prompt 5 |
| `test:claude`, `test:chat`, `test:milestone` (live, paid) | not run again: Claude Code starts the server as before (`node <home>\mcp\server.mjs`), and chats start Claude Code as before. The free part is in `test:install`: Claude Code itself started the installed server and reported Connected | Prompt 5 |
| `web-ext lint --warnings-as-errors` 10.8.0 on the unpacked .xpi | **packaged artifact**, official linter | Firefox package: 0 errors, 0 warnings, 0 notices. Thunderbird package: one error at first (name of 49 characters, limit 45), fixed; 4 warnings left: accountsRead, messagesRead and accounts.list are not of Firefox, no data declaration |
| `mcpb unpack`, `validate`, `info` 2.1.2 | **packaged artifact**, official tool | unpacks, manifest valid, "Not signed" |
| 12 runs of both tools on copies, 10 with planted mistakes | control of the tools | all 10 seen, 2 unchanged copies clean |
| after the fix: `npm test`, `test:integration`, `test:install` | as above, in the working folder at `e726f09` | 116 of 116, 51 of 51, 21 of 21. `test:packaged` and the Firefox suites were not run again: their files have the same bytes |
| Signed build | none exists | open |
| `node .opus-inbox/audit_tools.mjs check-parity` | documents | OK |

30 guards of the installer, the packing and the manifest were taken out of a scratch copy one at a time and `test:install` ran: all 30 are noticed. At first two were not: the doctor did not see a damaged `install.json` (fixed in the product), and a helper that keeps running on uninstall was noticed only as a test that hung (now limited to 60 s).

What `test:install` and `test:packaged` show, by what Prompt 6 named:

| Named | Packaged, Firefox played (PI) | Packaged, real Firefox (PF) |
|---|---|---|
| Fresh install | only its own files, one registration, one entry in Settings, again: no change; standard folder through the questions | add-on first, then the installer |
| Helper discovery | registration and manifest, path `Jörg Müller & Söhne` | found by itself 1 s after the installer ended |
| Pairing | key proved both ways, doctor without a session, wrong key named | every hop reports its version |
| Permission setup | | declined: no grant; accepted: grant, and one approved click arrives once |
| cookies | optional in the manifest | not given at install; container refused, after the button it opens; reading stays off |
| Missing helper | client says not_installed and names the installer | sidebar too, and both go on after an install |
| Helper restart | | killed: another one after 1.6 s, session_ended, no grant, regrant |
| Firefox restart | | helper ends with Firefox; the temporary add-on is gone, loaded again: stored data there, no grant, connects |
| Upgrade | from 0.4.0 with a running helper and a running client: key, pipe, pairings, profile, Thunderbird | helper under the old add-on, then the add-on: stored data and permissions equal, no optional part on; from 0.3.0 |
| Interrupted | 24 kills (12 during the exchange, 12 at the start of the next run), every point of the exchange by hand, registration not writable, file held open, key or identity cut off | |
| Uninstall | by the installed program while connected, another installation and files of others stay, after interruptions | sidebar names the missing helper |
| Claude Code | asked, not asked, twice, other entry, changed entry, removal | |
| Claude Desktop | fields of manifest 0.3, tools equal, server starts as its manifest says | its server reaches the same helper |

Fixed on the way: the module ID was taken from an embedded program, so the installer differed at each build; the sidebar named developer folders for the optional programs. The stored data of the upgrade check was partly seeded (workflow, schedule, pairing, chat); switches, folder and label were set by clicks.

After the runs: registration and entries in Settings absent, no folder `%LOCALAPPDATA%\Kitewarden`, no process and no temporary folder of these tests, no entry in the user's Claude Code. The user's everyday Firefox profile, Claude Code configuration and Claude Desktop were not changed.

## Commands and results of Prompt 5

Windows 11 build 26300, Firefox 160.0.1 (release), Node 26.12.1, Claude Code 2.1.302, on 2026-11-24, for `26d1256`.

| Command | Kind of evidence | Result |
|---|---|---|
| `npm test` | **simulated**: browser, storage, helper, clock, Thunderbird, hand-written Claude events; plus checks of the built packages | 116 of 116 |
| `npm run test:integration` | real helper, pipes, files, registry, MCP server, gateway, client and TLS; **Firefox and Thunderbird played by the test**; Claude Code is a test double | 51 of 51 |
| `npm run test:firefox` | **observed in Firefox**, headless, disposable profile, temporary add-on, real clicks; the Prompt 2 checks | 33 of 33 |
| `npm run test:companion` | the Prompt 3 checks, same kind, with the real helper | 27 of 27 |
| `npm run test:control` | the Prompt 4 checks, same kind | 24 of 24 |
| `npm run test:advanced` | **observed in Firefox**, headless: observation, site data, page tools, dialogs, isolated Firefox, schedule, remote link | 20 of 20, `test-results/advanced.json` |
| `npm run test:developer` | **observed in Firefox**, headless: the developer build as a temporary add-on | 4 of 4, `test-results/developer.json` |
| `npm run test:desktop` | **observed on the visible desktop**: focus, minimized windows, Windows input. Two modes | in use: 5 passed, 3 not run, `test-results/desktop-in-use.json`; see below |
| `npm run test:claude` | **live** Claude Code (haiku); run again because the MCP entry, the protocol and the action path changed | exit 0, the page confirms one click |
| `npm run test:milestone` | **live** Claude Code (haiku), real helper, real Firefox; run again for the same reason | 6 of 6 |
| `npm run test:chat` | not run again: Chat.cs did not change, and the order of messages in the helper that did is covered by the integration and companion runs | 7 of 7 in Prompt 4 |
| `node .opus-inbox/audit_tools.mjs check-parity` | documents | OK |

The desktop runs, in order, with the same input files: (1) screen saver up, so no window was in front: 6 passed, the focus check not run. This run has the full input checks: denied, one real click on a page that ignores synthetic ones, then covered, hidden tab, minimized, changed element and stopped, with nothing sent. (2) The user came back in the middle: the click was refused with "the user is using mouse or keyboard" (the rest of that run failed for the same reason). (3) and (4) in use, with a window of another program in front: focus and minimized windows as in FC-TAB-11, FC-TAB-15 and FC-SHOT-01; in (3) the user rested and the page got a real click. The JSON file is from (4). Runs 1 to 3 are in this record only. Some checks failed only because of the test and were corrected before (4).

26 guards were taken out of the build one at a time (senders, origins, HttpOnly, tokens, switches after the card, backends that are off, digest of a workflow, missed times, expiry, fingerprint, shares of mail and others). At first three were not noticed; those tests were made stricter, and then all 26 failed a test. Simulated evidence.

After the runs: both registry keys absent, no process of the helper, the backends or a test Firefox, no temporary folder of these tests. A test run that is killed leaves the key behind; `kitewarden-host.exe uninstall --home <that folder>` removes it.

### What Prompt 5 asked for, by backend

| Backend | Off or absent at first | Channel, version, permissions | Setup | Evidence |
|---|---|---|---|---|
| Console, network, bodies, cookies, storage, WebMCP (everyday add-on) | each `tool_off`, no card, console native, no object in the page (F) | Firefox 160 release. webRequest, webRequestBlocking, cookies: optional, and Firefox shows no question for them, so the switch in the sidebar is the only one. Others none | sidebar, Browser data | U, F |
| `isolated` | not running; running is off; `unknown_tool` without `--with isolated` (F) | Firefox 160.0.1 release, WebDriver BiDi, no system access, headless or with a window. No permission of the add-on | `node dist/backends/isolated.mjs [--headless] [--out folder] [--firefox path] [--home folder]`, then Turn on | U, F (headless only) |
| `input` | not running; running is off (D) | Windows messages, program built from Input.cs. No permission | `node dist/backends/input.mjs`, then Turn on | U, D |
| `remote` | nothing listens before and after (I, F) | TLS 1.2 ECDHE-PSK-CHACHA20-POLY1305. No permission | `node dist/remote/gateway.mjs --listen 127.0.0.1:8475`, Turn on, Pair a client; there `node client.mjs pair --host ...`, compare the fingerprint, Allow | U, I, F on one computer |
| Thunderbird | another add-on, another registration, another server | Thunderbird 140 or later, accountsRead, messagesRead, storage, nativeMessaging; no experiment | `install --thunderbird`, load `dist/thunderbird`, `server.mjs --mail` | U, I. **Thunderbird is not installed here: nothing was observed in it** |
| Developer build | not in the everyday folder; the tool is off (U, I, F) | any Firefox that takes unsigned or temporary add-ons | `npm run build:developer`, load `dist/developer/extension`, server from `dist/developer/mcp --home <installation>` | U, I, F |

### cookies and contextualIdentities

- `contextualIdentities` stays required: Firefox refuses it as optional. Alone it lists containers.
- `cookies` is **optional now**. Firefox opens a tab in a container only with it; without it: "No permission for cookieStoreId" (F, four variants of a manifest). Reopening and downloading there follow the same rule in the code and were not tried without it. The button Allow tabs in containers asks for it, `permission_required` says so before, and a container then works (F).
- Everyday tools with the permission given: 14 replies, the activity list and the stored log hold no cookie value (F). One file reads cookies (U). `get_cookies` has a switch of its own and masks HttpOnly and token-like values also with `values: true` (U, F).
- Having contextualIdentities still turns containers on in Firefox.

### Found and fixed at the milestone

In Firefox only: the console hook broke the page's own console (a page function may not read an array of a content script); a timer called as a method ended every command of a backend; the body filter came too late and lost answers; two commands at once loaded the page script of the isolated tab twice and left it without an answer; the question before leaving came after the card; a second question was swallowed by the first answer. By the older suites: an empty list of schedules was stored. By reading the diff: the port of the isolated Firefox was told to clients; a flood of console lines ended the capture; a closed isolated tab could be reopened in the everyday Firefox; a download from a container without the permission gave an internal error.

### The cases that Prompt 4 named

| Case | Simulated (U) or played (I) | Observed in Firefox (F) |
|---|---|---|
| Controlled inputs | | a framework-like input has the text in its model; all characters arrived |
| SPAs | | view changed by pushState, old ref stale, new view works, other refs stay |
| Cross-origin frames | read, refused, moved after the approval (U) | placeholder, allowed by a click, read, clicked by ref and by a point |
| Shadow DOM | | a button in a closed root is read, marked and clicked |
| Stale refs | candidates (U) | after a view change, with one candidate |
| Navigation mid-action | frame and tab (U) | card open, page moves to another origin, neither page got an event |
| Denied uploads | links, hard links, key names, streams, network, changed file (I) | no folder, forbidden folder, outside, `..`, denied card: nothing arrived |
| Profile conflicts | same ID twice, ambiguous, stays with its choice (I) | two real profiles, ambiguous, pick, no grants carried over |
| Minimized windows | (U) | state `minimized`, picture refused with the reason, reading works. Headless only |
| Interrupted batches | cancel before and after an action, limit, late cancel (U) | a moved page, a cancel with an open card |
| Emergency stop | all states, and a stop during the last question to the browser (U) | waiting and queued calls, report, resume; typing stopped after 4 to 5 of 200 characters |
| Recorder | default text in no step, storage, preview, log, skill (U) | default, edited and old recordings in the sidebar; frame and second tab |

Not tried in Firefox, only simulated or by code: copying a tab, activating a tab, resizing a window, the card for closing a tab of the user, opening on a new origin with its card, `request_user`, alert and prompt, pointer drag, rich editors, private downloads, tab group names, overlays at the top of the outline, `scroll_to`, the fixed pause.

Found and fixed at the milestone: files dropped on a zone did not reach the page (the DataTransfer must belong to the page); a stop during the last question to the browser was reported as not carried out although the tab then opened; a batch that was cancelled between two steps could begin the next; a tab could open on an origin whose grant was revoked in the same moment; a switch turned off under an open card did not count; a download from a private tab was not private. All but the first were found by reading the diff. Two new tests failed before these fixes, and each of the five fixes was taken out of the build once: a test failed each time (simulated evidence).

## Acceptance criteria

AC-01, AC-02, AC-05, AC-07, AC-08 and AC-09 are met (AC-02 with the temporary add-on). Their checks in `test:firefox`, `test:companion` and `test:claude` ran again on protocol 4. No new evidence for the open ones:

| ID | Status | Shown | Open |
|---|---|---|---|
| AC-03 | open | access list, network path denied while a control pipe is reached, existing pipe stops the host | second Windows user |
| AC-04 | open | access lists of key and folder, Everyone stops the host, doctor names the file | second Windows user |
| AC-06 | open | revoke, refs and covers gone, no grant after the add-on restarts; Firefox restarted with the temporary add-on loaded again: no grant (PF) | restart of Firefox with the add-on staying installed, needs a signed build |

### AC-08 record (documentation read on 2026-11-24, in Prompt 3)

- Supported path: the unmodified `claude` program of the user over `-p` with stream-json ([headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)). The documentation says that `--resume <id>` finds a session from any folder, and that a run that was killed leaves its turn unfinished and the next prompt drives on. The user signs in through Claude Code itself; the add-on and the host hold no credential.
- Terms, open: see open question 3 in [feature-parity.md](feature-parity.md) and [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). Personal use with one's own sign-in is described there; a public release around a subscription sign-in is a decision for the user. The names Claude Code and Anthropic may not be part of the product name.
- Risk: `--bare` will become the default of `claude -p` and never reads a subscription login. The pages read name no option against it. If it happens, a chat says that Claude Code is not signed in, or that it uses an API key (from `apiKeySource`).
- Question 19: roots yes (observed), hints have an effect (documentation), display of annotations and resource links open.

## Where the build differs from the rows

- Stricter: every acting call asks except hover; there is no work on a site without a card for each step (FC-GRANT-07, FC-GRANT-12).
- Uploads come only from folders that the user lists in the sidebar. The roots of a client give nothing, and the helper reads the files, not the MCP server (FC-ACT-21).
- `contextualIdentities` is a required permission, because Firefox refuses it as optional; `cookies` is optional (FC-INST-19, "cookies and contextualIdentities" above).
- Values of HttpOnly cookies and of token-like ones are never returned, also where FC-DATA-01 allowed it.
- Console and network need a switch before a grant starts a capture (FC-DBG-01, FC-DBG-03).
- Breakpoints that hold a page are not offered, only logpoints (FC-DBG-13).
- FC-TAB-32 was deferred and is built, because Prompt 4 asked for a separate grant.
- A reopened tab has no history (FC-DATA-15). Frames of the same origin are shown in pictures (FC-SHOT-08).

Not built from the areas of Prompt 4: strokes, upload of a screenshot, catching a file chooser, consent banners, sign-in notice, locators as arguments, articles as Markdown, links, HTML, page summary, comparison, quality check, network idle, browser events, several addresses, filters of the tab list, unloading and waking tabs, changes of tabs at the end of a reply, changing bookmarks, a capture queue, zoom, element and full-page pictures, `expect` in a batch, `switch_browser`, `ask_user`. Element details are FC-DBG-10 now. Each is a row in "Release audit", Outstanding rows, with where to build it. Built by Prompt 7 from that list: custom comboboxes, details of a tab, moving, pinning and muting, clipboard, site rules, 120 calls per minute.

Not built from the areas of Prompt 5: preferences, privileged script, other add-ons and process output of the isolated Firefox (FC-DBG-12); keys, dragging and frames of Windows input; uploads and WebMCP in isolated tabs; HTML drag and drop there (Firefox does not start it from BiDi input); bodies there; a relay for the remote link; page requests (FC-DATA-13); a first-run page (FC-GRANT-24); conditions of schedules and notices outside the sidebar.

Limits of Prompt 5: console lines and WebMCP offers of the first scripts of a fast page are missed, and the reply says so. A page can tell that its console is wrapped. Redaction goes by names and shapes; page text of `read_page` is not masked. A backend is any program of this user that has the key (D2), so the user has to know what they turn on; its name and version are what it says. The isolated Firefox has a debugging port on 127.0.0.1 without a password, with its only session taken. A backend that is killed takes its Firefox with it and leaves the profile folder, which the next start deletes (observed once, headless, by a scratch script). Windows input is matched by process and title. `tabs_select` with `focusWindow` can say focused while Windows keeps another program in front. A paired remote client that is lost keeps its key until the user revokes it or it expires; a revoke while the gateway is not running reaches it when the link is turned on again, and the add-on refuses the client until then. Times of schedules are those of this computer, and nothing runs while Firefox is closed.

Limits: any program of the same user can read the key, and a run file while its run lasts (D2). Secret and personal fields are found by type, name and shape, which is a heuristic. Values of selects and checkboxes, names of clicked elements and paths of pages are still recorded. Hover needs no card. A stop cannot take back what the page already has; the report says so. Synthetic events are ignored by pages that check for trusted input. A client chooses its own name; its label in the sidebar always says that it is a client.

Still true from Prompt 3: skills and agents are listed only after the first message of a chat that may use them, and commands, connectors and the `@` list are missing (FC-AGT-09); Delete and Clear leave the transcripts that Claude Code keeps (FC-UI-03); a card can wait up to 180 s, and the documentation says that Claude Code moves an MCP call to the background after 120 s, which was not tried; only `claude.exe` on PATH or in `%USERPROFILE%\.local\bin` is found; the whole open chat is sent to the sidebar on each change.

## Blockers and open checks

1. Second Windows account (AC-03, AC-04). Use an existing second account; none was created:
   1. First user: `release\KitewardenSetup-0.6.0.exe install --home C:\Users\Public\fc-acl-test`, load the add-on, press Connect, note the pipe name in `C:\Users\Public\fc-acl-test\profiles\<id>.json`.
   2. Second user: `Get-Content C:\Users\Public\fc-acl-test\key.bin` must be denied.
   3. Second user: `$c = New-Object IO.Pipes.NamedPipeClientStream('.', '<name>', 'InOut'); $c.Connect(2000)` must fail with "Access to the path is denied".
   4. First user: press Disconnect, then `release\KitewardenSetup-0.6.0.exe uninstall --home C:\Users\Public\fc-acl-test`.
2. Restart of Firefox (AC-06, FC-GRANT-16, FC-UI-03): after the user signs a build, attach a tab, start a chat, press Stop everything, restart Firefox with session restore. Expected: no grant, paused, the helper reconnects, the chat is listed and goes on.
3. Visible desktop: focus and minimized windows are observed (FC-TAB-11, FC-SHOT-01), and the record of the idle mode exists (`test-results/desktop-idle.json`, 2026-11-25). Open there: clicks and typing while another program is in front, the isolated Firefox with a window, Windows input while somebody uses the computer (run `npm run test:desktop` and keep working), a file pasted into the chat and the picture on the clipboard of Windows (they need the yes of the user to overwrite that clipboard).
4. Prompt 3: saved prompts (FC-AGT-10), the switch for file and shell tools (FC-AGT-02) and the run of an exported skill (FC-AGT-08) are done; Status of each says what is missing. A replay that failed once is explained and fixed ("Found and fixed by the audit").
5. Public distribution with a subscription sign-in: a decision for the user. Event page wake (D1): an inference, not tested.
6. Mozilla review of `incognito: spanning`, of the optional cookies, webRequest and webRequestBlocking, of WebMCP offered by an add-on, and the data declaration (cookies and storage of sites; mail in the Thunderbird add-on): not asked.
7. Not tried: screen reader, two windows with the sidebar, real sites with editors and drag targets (open question 16), an add-on update with stored data of a real user. From 0.3.0 and 0.4.0 in a test profile: PF; Firefox leaves cookies given when it turns from required to optional.
8. Thunderbird (FC-DATA-20): not installed, and nothing was downloaded. With it: `release\KitewardenSetup-0.6.0.exe install --thunderbird`, load `release\optional\kitewarden-mail-0.6.0-unsigned.xpi` as a temporary add-on, Connect, share one account with a client of `server.mjs --mail`, use a dummy account.
9. Remote link between two computers, and what a firewall does with it. Developer Edition with the developer build.
10. Signing and public release: [RELEASE.md](RELEASE.md). Prerequisites, all of the owner: public name and the two add-on IDs (fixed by the first submission), copyright holder (license: MPL-2.0, decided), a public place for the source, terms of the artwork (made with another AI tool), listed or self-distributed, data declaration (bookmarksInfo, searchTerms, personalCommunications), Mozilla account with an API key, a code-signing certificate, and the subscription question (5).
11. Claude Desktop itself: installing the .mcpb file changes the user's own Claude Desktop, so it was not done. With the user's yes, or a Claude Desktop with a test sign-in: Settings, Extensions, Advanced settings, Install Extension, `release\kitewarden-0.6.0.mcpb`, then ask for the connection status with the helper installed. Claude Desktop 6.28899.6 starts Node bundles in its own Node 24.22.3 with the arguments of the manifest (read from its files). Unsigned bundles: not tried.
12. Lint and validation ran again on the 0.6.0 files, with the pinned tools from the local npm cache. Open: the data declaration of the mail add-on, and the review of the Thunderbird add-ons site.
13. Not tried: more than one Firefox window with several chats at work, real sites, Windows SmartScreen and security software with the unsigned program, Windows before 11, Firefox older than 160 or absent, an account with special letters (only the folder had them), the Uninstall button in Settings by hand (its command was run), an installation while a chat runs, power loss (kills only), a full disk.
14. Limits: a file that a later version drops is not deleted by an upgrade. Servers that a client started and optional programs run on after an uninstall until their owner ends them. The optional programs have no installer.

## Try it by hand

1. `npm run release`, then start `release\KitewardenSetup-0.6.0.exe` and choose `i`. `d` checks, `u` removes.
2. In Firefox open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on, and pick `release\kitewarden-0.6.0-unsigned.xpi`. It is gone after a restart of Firefox.
3. Open the sidebar with the toolbar button and press Connect. Tabs: attach this tab; Frames shows frames of other sites; Take over and Give back hold one tab; Stop everything holds all of it. Browser data has the switches, the upload folders and the name of this profile.
4. In PowerShell, `claude mcp add -s user kitewarden -- node "$env:LOCALAPPDATA\Kitewarden\mcp\server.mjs"` registers the MCP server. It needs no chat.

## What comes next can build on

- `router.mjs` holds every rule. A new tool is an entry in `TOOLS`, a handler, and a sample in `router.test.mjs`. A new switch is a line in `GROUPS`.
- A new backend is a name in `KNOWN` (backends.mjs) and a program with `Backend` of `backends/link.mjs`.
- `r.page(call, origin, {cmd}, frame)` is the only way into a page, also of an isolated tab, which loads the same `content.js`.
- `test/firefox/audit.mjs "<part>"` and `test/live/audit.mjs skill|chat|files` are the checks of Prompt 7.
- `test/firefox/advanced.mjs "<part>"` runs its setup and the checks that match.
- `test/firefox/control.mjs` with the pages of [fixtures.mjs](../test/firefox/fixtures.mjs) is the place for further real checks; `node test/firefox/control.mjs "<part of a name>"` stops after that check.
- A tool that a chat run may ask for beyond Kitewarden is a name in `CHAT_TOOLS` (chats.mjs) and in `Offered` (Chat.cs), and needs the live check of `npm run test:live-audit`.
