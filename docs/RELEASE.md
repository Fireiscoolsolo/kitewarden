# Signing and distribution

Nothing is signed, submitted or published. This is the path, and what has to be decided before. Only the owner can take these steps: they need accounts, keys and agreements.

## Requirements, read on 2026-11-24

| Topic | What the official text says | What it means here |
|---|---|---|
| Signing | Extensions must be signed by Mozilla through AMO for release and beta Firefox, also when self-distributed. Unsigned ones need Developer Edition, Nightly or ESR with a preference ([Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)) | `.xpi` is marked `-unsigned`. Firefox 160.0.1 refused it: `ERROR_SIGNEDSTATE_REQUIRED` (observed) |
| Review | Automated validation first, up to 24 hours or longer; a manual review can come at any time, for self-distributed add-ons too (same page) | Plan for it; keep the reviewer notes below |
| Name | "`<Add-on name> for Firefox`" is the expected form ([Add-on Policies, 2](https://extensionworkshop.com/documentation/publish/add-on-policies/)); name, icon and developer name must be free of Mozilla trademarks except to say that it works with Firefox ([Trademark guidelines](https://www.mozilla.org/en-US/foundation/trademarks/policy/), which call "Firefox [Product]" incorrect) | **"Firefox Companion" cannot be the public name.** Also not "Claude" in the name: the names Claude Code and Anthropic may not be part of it ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) |
| Policies of 2026-12-01 | Preview of 2026-10-20: the same rules for names, native messaging, consent, remote code ([preview](https://extensionworkshop.com/documentation/publish/add-on-policies-preview-2026-12/)) | Read it again at submission |
| Native messaging | The policies, with consent, apply to what goes to the native application (6) | Data declaration in the manifest |
| Data declaration | Required from new add-ons, must be accurate; cookies and requests fall under `websiteContent`, bookmarks under `bookmarksInfo` ([consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)) | Declared: browsingActivity, websiteContent, websiteActivity. **To decide: bookmarksInfo, searchTerms, personalCommunications** for the optional switches and the mail add-on |
| Source code | Needed only for minified, bundled or generated code ([Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)) | Files are copied as they are. If asked: the repository and `npm run release` |
| Add-on ID | Fixed by the first submission ([Add-on ID](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/)) | `bridge@firefox-companion.invalid` and `mail@...` are placeholders. **Choose the final IDs first**: a change later loses all settings, and it is also in `Host.cs` |
| web-ext | 10.8.0. `web-ext sign --channel listed or unlisted`; key and secret from `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` ([commands](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)) | Never as arguments. Not run here |
| Updates | Listed: by AMO. Self-distributed: `update_url` in the manifest, otherwise AMO if listed there, otherwise by hand ([Self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/)) | No `update_url` now. Serve the file as `application/x-xpinstall` |
| Claude Desktop | `.mcpb`, a zip with `manifest.json`; specification 0.3 of 2025-12-02, CLI 2.1.2 ([MCPB](https://github.com/modelcontextprotocol/mcpb)). Private files are installed under Extensions, Advanced settings and updated by hand ([help](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)) | Manifest 0.3, strict schema. Claude Desktop 6.28899.6 on this computer names 0.4 as its newest and has Node 24.22.3 built in (read from its files, not run) |
| Claude Code | `claude mcp add -s user <name> -- <command>` ([MCP](https://code.claude.com/docs/en/mcp)) | Used as it is |

## Before the first release: decisions and prerequisites

1. Public name and icon, the two add-on IDs, the developer name.
2. License. `NOTICE.txt` says that none is chosen; AMO asks for one when a listing is made. Copyright holder.
3. Listed or self-distributed (open question 4). Privacy text; data declaration above.
4. Public distribution around a subscription sign-in of Claude (open question 3). Until then do not promote the sidebar chat as a feature of a public release.
5. Accounts: Mozilla account with AMO API key; a code-signing certificate for Windows (Authenticode); optional a certificate for `mcpb sign`.
6. Mozilla's view on `incognito: spanning`, optional `<all_urls>`, webRequest, WebMCP by an add-on (open question 5).

## Steps

1. Set the version (DEVELOPMENT.md), commit, build in a clean clone: `npm run release`, then `npm run test:integration`, `test:install`, `test:packaged` and the other Firefox suites.
2. `npx web-ext@10 lint -s dist/extension` and `npx @anthropic-ai/mcpb@2 validate` on the extracted manifest. Both are downloads, so neither ran here.
3. Firefox: in a session whose environment has the two variables, `npx web-ext@10 sign -s dist/extension --channel unlisted` (or `listed` with `--amo-metadata`). The signed file it returns is the one to publish. The same for `dist/thunderbird` through the Thunderbird add-ons site, which has its own review. Never `dist/developer`.
4. Windows: sign `dist\host\firefox-companion-host.exe` first, then `node build/release.mjs` (it takes `dist/` as it is, and the hashes in the installer follow), then sign `release\FirefoxCompanionSetup-<version>.exe`. `signtool sign /fd SHA256 /tr <timestamp server> /td SHA256 ...`; a signed file differs from the reproducible one, so keep both checksums. Signing adds data at the end and does not change the files inside.
5. MCPB: `mcpb sign` if a certificate exists. Unsigned is accepted for a private install according to the help page; not tried.
6. Replace the unsigned `.xpi` in `release/`, drop the suffix, write `SHA256SUMS.txt` again over the final files, and publish the checksums in a place apart from the files.
7. With the signed files, in a new profile: install, restart Firefox (AC-06), update from the version before, uninstall. Second Windows account: AC-03 and AC-04.
8. Publish. Keep the tag, the signed files and the checksums.

Back out: AMO can disable a version; Firefox does not go back by itself, so a fixed version needs a higher number. The installer refuses an older version unless the newer one is uninstalled first.

## Notes for reviewers of the add-on

- It sends pages only of tabs that the user attached, to a program of the same Windows user, over native messaging. No server of the developer exists, and no remote code is loaded.
- `nativeMessaging`: the only host is `firefox_companion`. `cookies`: needed by Firefox for tabs in containers, and for a switch that is off at first; one file reads cookies ([sitedata.mjs](../ext/background/sitedata.mjs)). `<all_urls>`: only asked for pictures of attached tabs; sites are asked one by one. `webRequest` and `webRequestBlocking`: a switch that is off at first.
- To test: install the helper, load the add-on, press Connect, attach a tab. No account is needed for the tab tools.
