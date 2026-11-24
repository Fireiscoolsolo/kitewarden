# docs/feature-parity.md format

Readers are later implementation runs. They use this document instead of the sources, and open a source only for a specific implementation question. Write plain, exact English. Describe behavior in your own words.

## Product

Firefox Companion (working name, see decision D9) is an original Firefox-native Claude sidebar plus MCP bridge for stable Firefox on Windows 11 (160.0.1 installed here). Claude works only with tabs the user explicitly grants, in the existing signed-in profile. Claude in Chrome (source 24) is the workflow benchmark. The result covers the combined useful features of the 23 reference projects. Prompt 2 built the browser bridge slice; see docs/project-state.md.

## Document outline (exact level-2 headings, in this order)

1. How to use this document
2. Pinned sources and licenses (table: number, repository link, full 40-hex commit, date, license with holder, derived from, reuse obligation; source 24 with both snapshot hashes; note that nothing from the sources may be copied without meeting its license, MPL-2.0 is file-level copyleft in 03 and 11, GPL-3.0 cursor shapes in 11 must not be reused)
3. Platform prerequisites (facts P1 to P13 and the version-floor table, with their pinned links)
4. Permission boundaries (table per source: grant model, authentication and bind, gating, main gap; then the Firefox Companion permission model, see below)
5. Architecture and component map (the component vocabulary below, the hops, and which sources prove each hop)
6. Decisions (D1 to D9 with evidence IDs, approved by the user on 2026-11-24 with clarifications; docs/feature-parity.md wins over the list below)
7. Capability matrix (one level-3 heading per area, each with the table below)
8. Features that need a different Firefox implementation (upstream mechanism, why it does not fit, replacement, FC IDs, finding IDs)
9. Excluded and blocked capabilities (FC IDs, reason, what the user sees instead)
10. Findings not carried as capabilities (finding IDs and reason: absence record, out of scope, duplicate of documentation)
11. Claude in Chrome benchmark coverage (every 24-F row: FC IDs, coverage full, partial, different, or none with reason)
12. Open questions
13. Audit limits (what was not verified: nothing was run on Firefox 160, unread items listed in the findings files, worker spot-check basis)

## Matrix table (exact columns)

```
| ID | Capability | Observable behavior | Sources | Platform prerequisites | Target | Acceptance test | Status |
|---|---|---|---|---|---|---|---|
| FC-TAB-01 | List granted tabs | What the user or MCP client sees, inputs, outputs, limits, errors | 24-F29 10-F01 03-F02 | Firefox 160; tabs permission; P5 | ext/grants, mcp/server `tabs_context` | Grant one of two open tabs and call tabs_context. It returns exactly that tab. | planned |
```

- ID: FC-AREA-NN. Areas: TAB (tabs, windows, groups, containers, navigation), READ, ACT (input, forms, upload, dialogs, waits that belong to actions), SHOT (screenshots, recording, PDF), DBG (console, network, page script, debugger, profiler), DATA (cookies, storage, history, bookmarks, downloads, fetch, sessions, clipboard), GRANT (grants, approvals, rules, redaction, audit, pause), CONN (transport, authentication, reconnect, multi-session, multi-browser), UI (sidebar, chat, indicators, shortcuts, settings), AGT (skills, workflows, batch, instructions, limits), INST (installer, packaging, signing, updates).
- One row per distinct observable capability. Merge duplicates across sources into one row, and split rows that can succeed or fail separately. Expect 130 to 190 rows in all.
- Observable behavior: the Firefox Companion behavior to build, taken from the best reference, including limits and error replies. Name a source defect that must not be repeated.
- Sources: bare finding IDs separated by spaces, strongest reference first. `node .opus-inbox/audit_tools.mjs expand-parity` turns them into commit-pinned links. Never hand-write these links. Every finding ID of the digest must appear in some Sources cell, or in section 10 with a reason. IDs may appear in several rows.
- Platform prerequisites: Firefox version floor, permissions, APIs, Windows parts and P facts.
- Target: one or more components below, plus the MCP tool name in backticks when it is a tool. Use `none` for excluded rows.
- Acceptance test: one concrete, observable check that can fail (setup, action, expected result). For excluded rows, test the refusal or the absence.
- Status: `planned`, `planned-adapted: <what differs>`, `deferred: <reason>`, `excluded: <reason>`, `platform-blocked: <reason>`, and since Prompt 2 `implemented: <evidence>` (the acceptance test of the row was shown) and `partial: <what was shown, what is missing or open>`.
- The Firefox fit in the findings judges the upstream implementation. Decide the Firefox Companion status from the capability itself: a tool that upstream runs through Playwright, Marionette or BiDi can still be planned-adapted with WebExtension APIs. Check the fit against PLATFORM_FACTS.md (for example tabs.saveAsPDF exists, although 13-F12 says a WebExtension cannot print to PDF).
- Security defects in sources become acceptance tests (Origin and token checks, loopback or pipe only, no all-interfaces bind, no unauthenticated command endpoint, password masking on every read and key path, page script cannot click an approval, no hidden test actions in the release build).

## Component vocabulary

- ext/manifest, ext/background (router, sessions, native port, lifecycle), ext/grants (grant store and enforcement), ext/page (content scripts: snapshot, text, actions, page-world hooks), ext/sidebar (chat, grants, approvals, activity), ext/overlay (page indicator, stop pill), ext/capture (screenshots, recording, console and network buffers), ext/options
- host/native (native messaging host and named-pipe server), host/claude-runner (local Claude Code session for the sidebar chat)
- mcp/server (stdio MCP server for Claude Code and other clients)
- shared/protocol (message schema, versions, limits)
- install/windows (per-user installer, registry, doctor, uninstall)
- build/release (packaging, lint, AMO signing)
- test/ (unit, integration, Firefox end to end)
- docs/

Hops: Claude Code starts mcp/server over stdio; mcp/server talks to host/native over a Windows named pipe with a current-user ACL and a mutual HMAC challenge; host/native talks to ext/background over native messaging; ext/background checks ext/grants and dispatches to ext/page. The sidebar chat uses host/claude-runner on the same host. No TCP listener.

## Firefox Companion permission model (write it out in section 4)

- A grant is made only by a user gesture in the sidebar, the tab context menu or the toolbar. It names a tab, an origin and a level (read, act), and lasts for the tab session unless the user shortens it.
- ext/background refuses any tool call on a tab without a matching grant, and ext/page checks the origin again just before acting. Navigation to another origin suspends the grant until the user approves. Tabs that Claude opens belong to the session and start with a grant only for the origin the user approved.
- Tab listing shows granted and session-owned tabs only. Other tabs show as a count.
- Firefox host permission is separate from a grant and is requested per origin from a user gesture. `<all_urls>` is optional.
- Sensitive actions (submit, purchase-like, delete, download, upload, leaving the origin, reading cookies or history) need an approval shown in extension UI, never in page DOM. Approvals bind to tool, tab, origin and an argument hash, and expire.
- Password, one-time-code and payment fields are masked in every read path and refused in every typing and key path.
- A pause switch and a per-tab stop end running work. Every decision is logged locally without page content or secrets.

## Proposed decisions

- D1 Manifest V2 with a persistent background page for the first release, host access as optional origins. Reason: message ports cannot keep an event page alive and the native host cannot wake one (P9); BCD records no MV2 removal. Reconsider when AMO stops accepting MV2.
- D2 Named pipe plus native messaging only, no TCP port. Evidence: 10 and 04 use a Unix socket or Windows named pipe with a key or token (neither sets an ACL on the pipe or key file everywhere, so set one); 07 uses loopback TCP with HMAC and a mutual challenge; 15 binds all interfaces; 19, 20 and 23 have no authentication on the extension socket.
- D3 Explicit tab grants as above. Evidence: 06 (user tab selection, leases), 18 (per-tab consent), 23 (armed tab), 07 (approval bound to arguments, origin recheck), 10 (session ownership), 01 (site trust levels).
- D4 Sidebar chat runs the user's own installed Claude Code through host/claude-runner. The extension stores no API key or claude.ai credential. Evidence: 01.
- D5 No agent-supplied page JavaScript in the signed build (P2, P4). Provide typed page queries instead. A developer build may add it. Evidence: 01 javascript_exec.
- D6 Synthetic DOM input by default. The Windows real-input helper that posts window messages (05) is opt-in and deferred. Remote-debugging paths (BiDi, Marionette, geckodriver) are excluded for the everyday profile because they need special launch flags.
- D7 No CDP, no debugger permission.
- D8 Original code. Sources are references for behavior only.
- D9 The released name must follow "<Name> for Firefox" (P7). Firefox Companion stays a working name until the user picks one.
