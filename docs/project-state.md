# Project state

Handoff after Prompt 5 (2026-11-24). Requirements and evidence per capability: [feature-parity.md](feature-parity.md). Decisions D1 to D9 hold. Prompt 5 widened four rows in the user's words (FC-CONN-25, FC-AGT-11, FC-AGT-15, FC-DBG-06) and narrowed one (FC-DATA-01: no HttpOnly value and no token ever).

## Checkpoint

- Local Git repository, nothing pushed. Author is a placeholder identity of this repository.
- `main` = `4082ac1`, the audit baseline. `feat/windows-bridge-slice` = `bfb39b0`, the end of Prompt 2. `feat/sidebar-chat` = `d51c615`, the end of Prompt 3.
- `feat/browser-control` = `70c9a70`, the end of Prompt 4 (code `6b0e049`).
- `feat/optional-backends` starts there: two `wip:` commits, then **`0c95826`, the code and tests that every result below belongs to**, plus the commit that adds this file and the last parity rows. Nothing is signed, published or pushed, and no everyday Firefox profile was touched: every Firefox of the tests ran with `-no-remote` and a profile in the temp folder.
- Prompt 1: the audit is complete and its checkers pass. The orchestrator's delivery was refused. Its record in `.claude/opus-orchestrator/` is unchanged and not in Git.

## What exists

A Firefox add-on (Manifest V2, persistent background, native sidebar), a native messaging host with a named pipe per profile that also runs the user's own Claude Code and reads files for uploads, and an MCP server over stdio. That everyday product has no TCP port, no CDP, no debugger permission and no dependency to install. Node 22 or later runs the MCP server, the optional programs, the build and the tests. Protocol 4, version 0.4.0: add-on, helper and MCP server must be updated together.

Beside it, separate and off: optional programs that the user starts, an add-on for Thunderbird, and a developer build.

| Part | Files |
|---|---|
| One table of tools, limits, argument checks, redaction | [shared/protocol.mjs](../shared/protocol.mjs) |
| The one command path: sessions, rights, stop, batch | [ext/background/router.mjs](../ext/background/router.mjs) |
| Tools that read or act in a page | [ext/background/pagetools.mjs](../ext/background/pagetools.mjs) |
| Tools for tabs, windows, containers, browser data | [ext/background/tabtools.mjs](../ext/background/tabtools.mjs) |
| Wiring, native port | [ext/background/main.mjs](../ext/background/main.mjs), [native.mjs](../ext/background/native.mjs) |
| Grants, approval cards | [ext/grants/grants.mjs](../ext/grants/grants.mjs), [approvals.mjs](../ext/grants/approvals.mjs) |
| Chats: history, attachments, runs | [ext/chat/chats.mjs](../ext/chat/chats.mjs) |
| Workflows: recording, redaction, skill text; replay; outline parser | [ext/workflow/workflows.mjs](../ext/workflow/workflows.mjs), [replay.mjs](../ext/workflow/replay.mjs), [elements.mjs](../ext/workflow/elements.mjs) |
| GIF recording and encoder | [ext/capture/gif.mjs](../ext/capture/gif.mjs), [encoder.mjs](../ext/capture/encoder.mjs) |
| Page side, one script in each granted frame | [ext/page/content.js](../ext/page/content.js) |
| Sidebar | [ext/sidebar/](../ext/sidebar/sidebar.mjs): `sidebar.mjs`, `ui.mjs`, `chat.mjs`, `workflows.mjs`, `markdown.mjs` |
| Host, pipe, login | [host/native/Host.cs](../host/native/Host.cs) |
| Files for uploads | [host/native/Files.cs](../host/native/Files.cs) |
| Claude Code runs, skill file | [host/native/Chat.cs](../host/native/Chat.cs) |
| Install, uninstall, doctor | [host/native/Setup.cs](../host/native/Setup.cs) |
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
| Build to `dist/` | [build/build.mjs](../build/build.mjs) |
| Test double of Claude Code | [test/doubles/](../test/doubles/claude.mjs) |

## Contracts

From Prompts 2 and 3, still valid:

- Both entry points call `router.call(sessionId, id, tool, args)`. Grants live in memory only: session, tab, exact origins, level. Only messages of the real sidebar port change grants, answer cards, pause, stop or connect. A card closes after 60 s seen or 120 s unseen, ignores its first 500 ms, and serves one waiting call.
- Pipe login: host nonce, client nonce and HMAC, host HMAC, then versions. After a lost link calls in flight end with `outcome_unknown`, nothing is repeated, the next call returns `session_ended`, grants are gone.
- A chat is a session of kind `chat`. A run is one `claude -p` process per message in a job object, with Companion tools only, joined to its chat by a ticket that works once. Skill files are written only after a preview. The list of options is in [Chat.cs](../host/native/Chat.cs).
- `router.call(..., { user: true })` opens the tools that are for the user only (`get_selection`) and waives no other check.

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

## Commands and results

Windows 11 build 26300, Firefox 160.0.1 (release), Node 26.12.1, Claude Code 2.1.302, on 2026-11-24, for `0c95826`.

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

After the runs: both registry keys absent, no process of the helper, the backends or a test Firefox, no temporary folder of these tests. A test run that is killed leaves the key behind; `firefox-companion-host.exe uninstall --home <that folder>` removes it.

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
| AC-06 | open | revoke, refs and covers gone, no grant after the add-on restarts | restart of Firefox, needs a signed build |

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

Not built from the areas of Prompt 4: custom comboboxes (FC-ACT-14), strokes, upload of a screenshot, catching a file chooser, consent banners, sign-in notice, locators as arguments, articles as Markdown, links, HTML, element details, page summary, comparison, quality check, network idle, browser events, several addresses, filters and details of tabs, moving, pinning, muting, unloading and waking tabs, changes of tabs at the end of a reply, changing bookmarks, clipboard, site rules, 120 calls per minute, a capture queue, zoom, element and full-page pictures, `expect` in a batch, `switch_browser`, `ask_user`. Element details are FC-DBG-10 now.

Not built from the areas of Prompt 5: preferences, privileged script, other add-ons and process output of the isolated Firefox (FC-DBG-12); keys, dragging and frames of Windows input; uploads and WebMCP in isolated tabs; HTML drag and drop there (Firefox does not start it from BiDi input); bodies there; a relay for the remote link; page requests (FC-DATA-13); a first-run page (FC-GRANT-24); conditions of schedules and notices outside the sidebar.

Limits of Prompt 5: console lines and WebMCP offers of the first scripts of a fast page are missed, and the reply says so. A page can tell that its console is wrapped. Redaction goes by names and shapes; page text of `read_page` is not masked. A backend is any program of this user that has the key (D2), so the user has to know what they turn on; its name and version are what it says. The isolated Firefox has a debugging port on 127.0.0.1 without a password, with its only session taken. A backend that is killed takes its Firefox with it and leaves the profile folder, which the next start deletes (observed once, headless, by a scratch script). Windows input is matched by process and title. `tabs_select` with `focusWindow` can say focused while Windows keeps another program in front. A paired remote client that is lost keeps its key until the user revokes it or it expires; a revoke while the gateway is not running reaches it when the link is turned on again, and the add-on refuses the client until then. Times of schedules are those of this computer, and nothing runs while Firefox is closed.

Limits: any program of the same user can read the key, and a run file while its run lasts (D2). Secret and personal fields are found by type, name and shape, which is a heuristic. Values of selects and checkboxes, names of clicked elements and paths of pages are still recorded. Hover needs no card. A stop cannot take back what the page already has; the report says so. Synthetic events are ignored by pages that check for trusted input. A client chooses its own name; its label in the sidebar always says that it is a client.

Still true from Prompt 3: skills and agents are listed only after the first message of a chat that may use them, and commands, connectors and the `@` list are missing (FC-AGT-09); Delete and Clear leave the transcripts that Claude Code keeps (FC-UI-03); a card can wait up to 180 s, and the documentation says that Claude Code moves an MCP call to the background after 120 s, which was not tried; only `claude.exe` on PATH or in `%USERPROFILE%\.local\bin` is found; the whole open chat is sent to the sidebar on each change.

## Blockers and open checks

1. Second Windows account (AC-03, AC-04). Use an existing second account; none was created:
   1. First user: `npm run build`, then `dist\host\firefox-companion-host.exe install --home C:\Users\Public\fc-acl-test`, load the add-on, press Connect, note the pipe name in `C:\Users\Public\fc-acl-test\profiles\<id>.json`.
   2. Second user: `Get-Content C:\Users\Public\fc-acl-test\key.bin` must be denied.
   3. Second user: `$c = New-Object IO.Pipes.NamedPipeClientStream('.', '<name>', 'InOut'); $c.Connect(2000)` must fail with "Access to the path is denied".
   4. First user: press Disconnect, then `dist\host\firefox-companion-host.exe uninstall --home C:\Users\Public\fc-acl-test`.
2. Restart of Firefox (AC-06, FC-GRANT-16, FC-UI-03): after the user signs a build, attach a tab, start a chat, press Stop everything, restart Firefox with session restore. Expected: no grant, paused, the helper reconnects, the chat is listed and goes on.
3. Visible desktop: focus and minimized windows are observed now (FC-TAB-11, FC-SHOT-01). Open there: clicks and typing while another program is in front, the isolated Firefox with a window, and one JSON record of the idle mode: leave the computer alone for a minute and run `npm run test:desktop`.
4. Open from Prompt 3, not worked on: saved prompts (FC-AGT-10), the switch for file and shell tools in a chat (FC-AGT-02), the run of an exported skill by a model (FC-AGT-08).
5. Public distribution with a subscription sign-in: a decision for the user. Event page wake (D1): an inference, not tested.
6. Mozilla review of `incognito: spanning`, of the optional cookies, webRequest and webRequestBlocking, of WebMCP offered by an add-on, and the data declaration (cookies and storage of sites; mail in the Thunderbird add-on): not asked.
7. Not tried: screen reader, two windows with the sidebar, real sites with editors and drag targets (open question 16), an add-on update from protocol 2 or 3 with stored data of a real user (old recordings were seeded in a test profile), in particular one that takes the cookies permission away from containers.
8. Thunderbird (FC-DATA-20): not installed, and nothing was downloaded. With it: `npm run build`, `dist\host\firefox-companion-host.exe install --thunderbird`, load `dist\thunderbird\manifest.json` as a temporary add-on, Connect, share one account with a client of `server.mjs --mail`, use a dummy account.
9. Remote link between two computers, and what a firewall does with it. Developer Edition with the developer build.
10. Packaging: everyday add-on and helper as before. Optional programs need Node 22 and their folders (`dist/backends` and `dist/remote` with `dist/mcp` beside them; the other computer needs `dist/remote` alone). The developer build must not be signed or published (P2). The Thunderbird add-on needs its own review. None of it has an installer.

## Try it by hand

1. `npm run build`, then `dist\host\firefox-companion-host.exe install`. `doctor` checks it, `uninstall` removes it.
2. In Firefox open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on, and pick `dist\extension\manifest.json`. It is gone after a restart of Firefox.
3. Open the sidebar with the toolbar button and press Connect. Tabs: attach this tab; Frames shows frames of other sites; Take over and Give back hold one tab; Stop everything holds all of it. Browser data has the switches, the upload folders and the name of this profile.
4. In PowerShell, `claude mcp add -s user firefox-companion -- node "$env:LOCALAPPDATA\FirefoxCompanion\mcp\server.mjs"` registers the MCP server. It needs no chat.

## What comes next can build on

- `router.mjs` holds every rule. A new tool is an entry in `TOOLS`, a handler, and a sample in `router.test.mjs`. A new switch is a line in `GROUPS`.
- A new backend is a name in `KNOWN` (backends.mjs) and a program with `Backend` of `backends/link.mjs`.
- `r.page(call, origin, {cmd}, frame)` is the only way into a page, also of an isolated tab, which loads the same `content.js`.
- `test/firefox/advanced.mjs "<part>"` runs its setup and the checks that match.
- `test/firefox/control.mjs` with the pages of [fixtures.mjs](../test/firefox/fixtures.mjs) is the place for further real checks; `node test/firefox/control.mjs "<part of a name>"` stops after that check.
- Not decided: whether file and shell tools in a chat get the approval card through `--permission-prompt-tool`.
