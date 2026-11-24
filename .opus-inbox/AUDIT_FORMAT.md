# Audit findings format

One file per source, at the `file` path in `.opus-inbox/manifest.json`. Use the `dir` in the manifest to find the pinned checkout (read-only; never build, install, run or modify it) and the `sha` and `date` for the header.

Write citations as `@@path/in/repo.ts#L10-L20@@` (or `@@path#L10@@`, or `@@path@@` for a whole file). Then run `node .opus-inbox/audit_tools.mjs expand NN`, which turns each into a commit-pinned GitHub link and refuses paths or line numbers that do not exist. Finish with `node .opus-inbox/audit_tools.mjs check NN` and fix what it reports. Never hand-write GitHub links.

Required shape (keep headings, field names and table columns exactly):

```
# NN owner/repo

- Repository: https://github.com/owner/repo
- Reviewed commit: <40-hex sha>
- Commit date: YYYY-MM-DD
- License: <SPDX id, or "other: ...", or "none found"> (@@LICENSE@@), copyright holder; conflicts with package.json, README or manifest; vendored third-party code and its license
- Derived from: <fork or copied-code relationship with evidence, or "none evident">
- Summary: two to four sentences on what it is and how it works.

## Architecture

Transport and every hop from the MCP client to the page; server language and SDK; browser side (WebExtension MV2/MV3, WebDriver BiDi, Marionette, CDP, ...); Claude/LLM sidebar UI if any; installer and supported platforms. Cite each claim.

## Permission boundaries

- Manifest permissions: the exact list, with citation
- Host permissions: the exact list
- Per-tab or per-site grant: what the user must grant, and the code that enforces it, or "none enforced"
- Authentication: between client, server, native host and extension; token storage; origin checks; bind address
- Sensitive-action gating: confirmations, redaction, deny lists, audit log
- Gaps: what docs claim but code does not enforce, and risky defaults

## Tool inventory

Count: <N>
Tools: `name_one`, `name_two`, ...

## Features

| ID | Capability | Observable behavior | Evidence | Firefox fit | Verification |
|---|---|---|---|---|---|
| NN-F01 | Short name (`tool_name`) | What a user or client sees: inputs, outputs, limits | @@server/tools.ts#L10-L40@@ @@extension/background.js#L200-L240@@ | native | verified |

## Tests

What the test suite asserts, with citations to the test files (read the test titles and the cases for tools, permissions, transport and authentication), which tools have no test, or "none".

## Claimed but not verified

Docs-only claims without code, with citations, or "none".

## Firefox implementation notes

Which features need a different implementation in a stable-Firefox WebExtension, and why (CDP, Marionette/BiDi, Chrome-only APIs, separate profile, unsigned add-on, and so on).
```

Rules:

- Tool inventory is the complete list of registered MCP tools in the code (registration, not README). With no MCP tools write `Count: 0` and `Tools: none`. Every inventory tool must appear in backticks in the Capability or Observable behavior cell of at least one feature row. Near-duplicates may share a row.
- Also give rows to non-tool features: sidebar UI, chat, permission prompts, visual indicators, recording, shortcuts, connection status, reconnect, multi-browser or multi-session, installers, packaging and signing, audit log, settings, rate limits, skills or prompts, MCP resources.
- Firefox fit: `native` (works in a signed WebExtension on stable Firefox in the user's existing profile), `adapt: <why>` or `unavailable: <why>`.
- Verification: `verified` (you read both the registration and the handler that does the work, cite both with line ranges), `partial: <what is missing or broken>`, or `claimed-only`.
- A verified row needs at least one citation with a line range.
- Exactly six cells per row. Write a literal pipe inside a cell as `\|`.
- Describe what the code does, not what the README says. If they disagree, say so.
- Describe behavior in your own words. Do not paste source code; naming identifiers is fine.
- If something cannot be read, write that in "Claimed but not verified" and keep going.
