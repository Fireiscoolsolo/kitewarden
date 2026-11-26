# Signing and distribution

Nothing is signed, submitted or published. This is the path, and what has to be decided before. Only the owner can take these steps: they need accounts, keys and agreements.

## Requirements, read on 2026-11-24 and again on 2026-11-25

| Topic | What the official text says | What it means here |
|---|---|---|
| Signing | Extensions must be signed by Mozilla through AMO for release and beta Firefox, also when self-distributed. Unsigned ones need Developer Edition, Nightly or ESR with a preference ([Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)) | `.xpi` is marked `-unsigned`. Firefox 160.0.1 refused it: `ERROR_SIGNEDSTATE_REQUIRED` (observed) |
| Review | Automated validation first, up to 24 hours or longer; a manual review can come at any time, for self-distributed add-ons too (same page) | Plan for it; keep the reviewer notes below |
| Name | "`<Add-on name> for Firefox`" is the expected form ([Add-on Policies, 2](https://extensionworkshop.com/documentation/publish/add-on-policies/)); name, icon and developer name must be free of Mozilla trademarks except to say that it works with Firefox ([Trademark guidelines](https://www.mozilla.org/en-US/foundation/trademarks/policy/), which call "Firefox [Product]" incorrect) | **"Firefox Companion" could not be the public name; it is now Kitewarden (D10).** Also not "Claude" in the name: the names Claude Code and Anthropic may not be part of it ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) |
| Policies of 2026-12-01 | They take effect in days. Preview, last update 2026-10-20, read again on 2026-11-25: the same rules for names, native messaging, consent, remote code; new is that a fork needs a clearly different name, which does not apply (D8) ([preview](https://extensionworkshop.com/documentation/publish/add-on-policies-preview-2026-12/)) | Read it again at submission |
| Native messaging | The policies, with consent, apply to what goes to the native application (6) | Data declaration in the manifest |
| Data declaration | Required from new add-ons, must be accurate; cookies and requests fall under `websiteContent`, bookmarks under `bookmarksInfo` ([consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)) | Required: browsingActivity, websiteContent, websiteActivity. Optional: bookmarksInfo, asked together with the permission when the user turns on Bookmarks (1.0.0, `asksFor` in `shared/protocol.mjs`). **To decide: personalCommunications** for the mail add-on. `clipboardWrite` (0.6.0) sends nothing anywhere and reads nothing. File, shell and web tools run in Claude Code, not in the add-on |
| Source code | Needed only for minified, bundled or generated code ([Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)) | Files are copied as they are. If asked: the repository and `npm run release` |
| Add-on ID | Fixed by the first submission ([Add-on ID](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/)) | `firefox@fireiscoolsolo.github.io` and `thunderbird@fireiscoolsolo.github.io`, chosen 2026-11-25 (D10). A change after the first submission loses all settings; they are also in `Host.cs`. They name the GitHub Pages domain of the owner, which costs nothing |
| web-ext | 10.8.0. `web-ext sign --channel listed or unlisted`; key and secret from `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` ([commands](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)) | Never as arguments. `sign` was not run; `lint` was (step 2) |
| Updates | Listed: by AMO. Self-distributed: `update_url` in the manifest, otherwise AMO if listed there, otherwise by hand ([Self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/)) | From 1.0.0 `update_url` is https://fireiscoolsolo.github.io/kitewarden/updates.json (`site/updates.json`). For each new signed version add `{"version", "update_link", "update_hash": "sha256:…"}` there, with the link to the `.xpi` of the GitHub release |
| Claude Desktop | `.mcpb`, a zip with `manifest.json`; specification 0.3 of 2025-12-02, CLI 2.1.2 ([MCPB](https://github.com/modelcontextprotocol/mcpb)). Private files are installed under Extensions, Advanced settings and updated by hand ([help](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)) | Manifest 0.3, strict schema. Claude Desktop 6.28899.6 on this computer names 0.4 as its newest and has Node 24.22.3 built in (read from its files, not run) |
| Claude Code | `claude mcp add -s user <name> -- <command>` ([MCP](https://code.claude.com/docs/en/mcp)) | Used as it is |

## Before the first release: decisions and prerequisites

1. Public name Kitewarden and the two add-on IDs: decided 2026-11-25 (D10). Open: a trademark office search for the name, the developer name. Website and privacy policy: https://fireiscoolsolo.github.io/kitewarden/ (`site/`).
2. License: MPL-2.0, decided 2026-11-25 (`LICENSE`, `NOTICE.txt`). Choose the same in the listing of AMO. Source: https://github.com/Fireiscoolsolo/kitewarden, named in `NOTICE.txt` (MPL-2.0, 3.2). Open: the copyright holder. Terms of the AI tool that made the icons and pictures: whether they may be distributed, and under what license.
3. Self-distributed from GitHub, signed through AMO as unlisted (2026-11-26, the owner's "Yes, prepare 1.0.0" after the plan to self-distribute). Privacy policy: https://fireiscoolsolo.github.io/kitewarden/privacy.html. Data declaration above. Mozilla account with two-step login and AMO API key: made by the owner on 2026-11-26, the key kept by the owner.
4. Public distribution around a subscription sign-in of Claude (open question 3; [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) read again on 2026-11-25: unchanged in this point). Until then do not promote the sidebar chat as a feature of a public release. From 1.0.0 the sidebar marks it experimental.
5. Accounts: Mozilla account with AMO API key; a code-signing certificate for Windows (Authenticode); optional a certificate for `mcpb sign`.
6. Mozilla's view on `incognito: spanning`, optional `<all_urls>`, webRequest, WebMCP by an add-on (open question 5).

## Steps

1. Set the version (DEVELOPMENT.md), commit, build in a clean clone: `npm run release`, then `npm run test:integration`, `test:install`, `test:packaged` and the other Firefox suites.
2. `npx web-ext@10 lint -s dist/extension --warnings-as-errors --self-hosted` (without the first option it exits 0 on warnings; without the second it refuses `update_url`, which only listed add-ons may not have) and `npx @anthropic-ai/mcpb@2 validate` on the extracted manifest. Run on 2026-11-25 with 10.8.0 and 2.1.2 on the packaged files: no error, warning or notice in the Firefox package, and the bundle is valid. The Thunderbird package has four warnings that a Firefox linter gives to a mail add-on, one of them the missing data declaration, which is to be decided for Thunderbird.
3. Firefox: in a session whose environment has the two variables, `npx web-ext@10 sign -s dist/extension --channel unlisted` (or `listed` with `--amo-metadata`). The signed file it returns is the one to publish. The same for `dist/thunderbird` through the Thunderbird add-ons site, which has its own review. Never `dist/developer`.
4. Windows: sign `dist\host\kitewarden-host.exe` first, then `node build/release.mjs` (it takes `dist/` as it is, and the hashes in the installer follow), then sign `release\KitewardenSetup-<version>.exe`. `signtool sign /fd SHA256 /tr <timestamp server> /td SHA256 ...`; a signed file differs from the reproducible one, so keep both checksums. Signing adds data at the end and does not change the files inside.
5. MCPB: `mcpb sign` if a certificate exists. Unsigned is accepted for a private install according to the help page; not tried.
6. Replace the unsigned `.xpi` in `release/`, drop the suffix, write `SHA256SUMS.txt` again over the final files, and publish the checksums in a place apart from the files.
7. With the signed files, in a new profile: install, restart Firefox (AC-06), update from the version before, uninstall. Second Windows account: AC-03 and AC-04.
8. Publish. Keep the tag, the signed files and the checksums.

Back out: AMO can disable a version; Firefox does not go back by itself, so a fixed version needs a higher number. The installer refuses an older version unless the newer one is uninstalled first.

## Notes for reviewers of the add-on

- It sends pages only of tabs that the user attached, to a program of the same Windows user, over native messaging. No server of the developer exists, and no remote code is loaded.
- The content policy of the add-on is `default-src 'none'` with scripts and styles of its own only, and `connect-src data: blob:`: no server can be reached from its pages.
- `nativeMessaging`: the only host is `kitewarden`. `cookies`: needed by Firefox for tabs in containers, and for a switch that is off at first; one file reads cookies ([sitedata.mjs](../ext/background/sitedata.mjs)). `<all_urls>`: only asked for pictures of attached tabs; sites are asked one by one. `webRequest`, `webRequestBlocking` and `clipboardWrite`: switches that are off at first. Nothing reads the clipboard.
- To test: install the helper, load the add-on, press Connect, attach a tab. No account is needed for the tab tools.
