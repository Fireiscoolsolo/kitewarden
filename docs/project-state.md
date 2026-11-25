# Project state

Handoff after Prompt 4 (2026-11-24). Requirements and evidence per capability: [feature-parity.md](feature-parity.md). Decisions D1 to D9 hold.

## Checkpoint

- Local Git repository, nothing pushed. Author is a placeholder identity of this repository.
- `main` = `4082ac1`, the audit baseline. `feat/windows-bridge-slice` = `bfb39b0`, the end of Prompt 2. `feat/sidebar-chat` = `d51c615`, the end of Prompt 3.
- `feat/browser-control` starts there: `6b0f2a4` (text default of the recorder), then work in progress, then **`6b0e049`, the code and tests that every result below belongs to**, plus the commit that adds this file and the parity rows. The `wip:` commits in between are steps and were not squashed.
- Prompt 1: the audit is complete and its checkers pass. The orchestrator's delivery was refused. Its record in `.claude/opus-orchestrator/` is unchanged and not in Git.

## What exists

A Firefox add-on (Manifest V2, persistent background, native sidebar), a native messaging host with a named pipe per Firefox profile that also runs the user's own Claude Code and reads files for uploads, and an MCP server over stdio. No TCP port, no CDP, no debugger permission, no dependency to install. Node 22 or later runs the MCP server, the build and the tests. Protocol 3, version 0.3.0: add-on, helper and MCP server must be updated together.

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
| MCP server, pipe client, choice of profile | [mcp/server/server.mjs](../mcp/server/server.mjs), [link.mjs](../mcp/server/link.mjs) |
| Build to `dist/` | [build/build.mjs](../build/build.mjs) |
| Test double of Claude Code | [test/doubles/](../test/doubles/claude.mjs) |

## Contracts

From Prompts 2 and 3, still valid:

- Both entry points call `router.call(sessionId, id, tool, args)`. Grants live in memory only: session, tab, exact origins, level. Only messages of the real sidebar port change grants, answer cards, pause, stop or connect. A card closes after 60 s seen or 120 s unseen, ignores its first 500 ms, and serves one waiting call.
- Pipe login: host nonce, client nonce and HMAC, host HMAC, then versions. After a lost link calls in flight end with `outcome_unknown`, nothing is repeated, the next call returns `session_ended`, grants are gone.
- A chat is a session of kind `chat`. A run is one `claude -p` process per message in a job object, with Companion tools only, joined to its chat by a ticket that works once. Skill files are written only after a preview. The list of options is in [Chat.cs](../host/native/Chat.cs).
- `router.call(..., { user: true })` opens the tools that are for the user only (`get_selection`) and waives no other check.

New in Prompt 4:

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

Windows 11 build 26300, Firefox 160.0.1 (release, headless), Claude Code 2.1.302, on 2026-11-24, for `6b0e049`. Before any edit the suites of Prompt 3 passed on `d51c615`.

| Command | Kind of evidence | Result |
|---|---|---|
| `npm test` | **simulated**: browser, storage, helper, clock, hand-written Claude events | 79 of 79 |
| `npm run test:integration` | real helper, pipes, files, links, access lists, MCP server and processes; **Firefox played by the test**; Claude Code is a test double | 36 of 36 |
| `npm run test:firefox` | **observed in Firefox**, disposable profile, temporary add-on, real clicks; the Prompt 2 checks | 33 of 33, `test-results/firefox.json` |
| `npm run test:companion` | **observed in Firefox** with the real helper; Claude Code is a test double; the Prompt 3 checks | 27 of 27, `test-results/companion.json` |
| `npm run test:control` | **observed in Firefox**, disposable profiles, local pages on two ports that report what reached them, real clicks in the sidebar; the Prompt 4 checks | 24 of 24, `test-results/control.json`, `annotated.jpg` |
| `npm run test:claude` | **live** Claude Code (haiku) as a standalone MCP client; run again because protocol, tools and the action path changed | exit 0, the page confirms one click |
| `npm run test:milestone` | **live** Claude Code (haiku), real helper, real Firefox; run again for the same reason | 6 of 6, `test-results/milestone.json` |
| `npm run test:chat` | **live** Claude Code through the real helper; Firefox played by the test; run once on the same helper, before the last change in the add-on's router, which it does not use | 7 of 7, `test-results/chat-lifecycle.json` |
| `node .opus-inbox/audit_tools.mjs check-parity` | documents | OK |

After the runs: registry key absent, no process of the helper, no temporary folder of the tests. A test run that is killed leaves the key behind; `firefox-companion-host.exe uninstall --home <that folder>` removes it. `FC_HEADED=1` shows the Firefox window.

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

AC-01, AC-02, AC-05, AC-07, AC-08 and AC-09 are met (AC-02 with the temporary add-on). Their checks in `test:firefox`, `test:companion` and `test:claude` ran again on protocol 3. No new evidence for the open ones:

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
- `cookies` and `contextualIdentities` are required permissions, because Firefox refuses the second as optional and containers need both. Nothing reads cookies. Having `contextualIdentities` turns containers on in Firefox (FC-INST-19).
- FC-TAB-32 was deferred and is built, because Prompt 4 asked for a separate grant.
- A reopened tab has no history (FC-DATA-15). Frames of the same origin are shown in pictures (FC-SHOT-08).

Not built from the areas of this prompt: custom comboboxes (FC-ACT-14), strokes, upload of a screenshot, catching a file chooser, consent banners, sign-in notice, locators as arguments, articles as Markdown, links, HTML, element details, page summary, comparison, quality check, network idle, browser events, several addresses, filters and details of tabs, moving, pinning, muting, unloading and waking tabs, viewport size, changes of tabs at the end of a reply, changing bookmarks, cookies, storage, clipboard, site rules, 120 calls per minute, a capture queue, zoom, element and full-page pictures, `expect` in a batch, `switch_browser`, `ask_user`. The optional input backends (FC-ACT-35, FC-ACT-36) are absent as decided in D6.

Limits: any program of the same user can read the key, and a run file while its run lasts (D2). Secret and personal fields are found by type, name and shape, which is a heuristic. Values of selects and checkboxes, names of clicked elements and paths of pages are still recorded. Hover needs no card. A stop cannot take back what the page already has; the report says so. Synthetic events are ignored by pages that check for trusted input. A client chooses its own name; its label in the sidebar always says that it is a client.

Still true from Prompt 3: skills and agents are listed only after the first message of a chat that may use them, and commands, connectors and the `@` list are missing (FC-AGT-09); Delete and Clear leave the transcripts that Claude Code keeps (FC-UI-03); a card can wait up to 180 s, and the documentation says that Claude Code moves an MCP call to the background after 120 s, which was not tried; only `claude.exe` on PATH or in `%USERPROFILE%\.local\bin` is found; the whole open chat is sent to the sidebar on each change.

## Blockers and open checks

1. Second Windows account (AC-03, AC-04). Use an existing second account; none was created:
   1. First user: `npm run build`, then `dist\host\firefox-companion-host.exe install --home C:\Users\Public\fc-acl-test`, load the add-on, press Connect, note the pipe name in `C:\Users\Public\fc-acl-test\profiles\<id>.json`.
   2. Second user: `Get-Content C:\Users\Public\fc-acl-test\key.bin` must be denied.
   3. Second user: `$c = New-Object IO.Pipes.NamedPipeClientStream('.', '<name>', 'InOut'); $c.Connect(2000)` must fail with "Access to the path is denied".
   4. First user: press Disconnect, then `dist\host\firefox-companion-host.exe uninstall --home C:\Users\Public\fc-acl-test`.
2. Restart of Firefox (AC-06, FC-GRANT-16, FC-UI-03): after the user signs a build, attach a tab, start a chat, press Stop everything, restart Firefox with session restore. Expected: no grant, paused, the helper reconnects, the chat is listed and goes on.
3. Visible desktop: focus and minimized windows were observed headless only (FC-TAB-11, FC-SHOT-01). Run `npm run test:control` with `FC_HEADED=1` while another window is in front.
4. Open from Prompt 3, not worked on: saved prompts (FC-AGT-10), the switch for file and shell tools in a chat (FC-AGT-02), the run of an exported skill by a model (FC-AGT-08).
5. Public distribution with a subscription sign-in: a decision for the user. Event page wake (D1): an inference, not tested.
6. Mozilla review of `incognito: spanning`, `cookies` and the other new permissions: not asked.
7. Not tried: screen reader, two windows with the sidebar, real sites with editors and drag targets (open question 16), an add-on update from protocol 2 with stored data of a real user (old recordings were seeded in a test profile).

## Try it by hand

1. `npm run build`, then `dist\host\firefox-companion-host.exe install`. `doctor` checks it, `uninstall` removes it.
2. In Firefox open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on, and pick `dist\extension\manifest.json`. It is gone after a restart of Firefox.
3. Open the sidebar with the toolbar button and press Connect. Tabs: attach this tab; Frames shows frames of other sites; Take over and Give back hold one tab; Stop everything holds all of it. Browser data has the switches, the upload folders and the name of this profile.
4. In PowerShell, `claude mcp add -s user firefox-companion -- node "$env:LOCALAPPDATA\FirefoxCompanion\mcp\server.mjs"` registers the MCP server. It needs no chat.

## What Prompt 5 can build on

- `router.mjs` holds every rule and needs no change for a new tool. Hooks for console, network or storage belong in a handler plus a content or background part, ended by `onGrantEnd` and `api.forget`, which already fire on revoke, suspension, pause and stop.
- `TOOLS[x].group` gives a user switch with a Firefox permission. New groups need the name in `set_switch` and in the sidebar.
- `r.page(call, origin, {cmd}, frame)` is the only way into a page. A new page command is one function and one entry in the table of `content.js`.
- `effect()` in `pagetools.mjs` is the place for more observed effects. An optional input backend would replace the dispatch inside `send()` and set `trusted_event`.
- `test/firefox/control.mjs` with the pages of [fixtures.mjs](../test/firefox/fixtures.mjs) is the place for further real checks; `node test/firefox/control.mjs "<part of a name>"` stops after that check.
- Not decided: whether file and shell tools in a chat get the approval card through `--permission-prompt-tool`.
