# Building and testing

Windows 11, Node 22.2 or later, Git, and the C# compiler that ships with Windows (`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). No package is installed: `package.json` has no dependency.

## Build

| Command | Result |
|---|---|
| `npm run build` | `dist/`: `extension`, `mcp`, `host`, and apart from them `backends`, `remote`, `thunderbird` |
| `npm run release` | unit tests and package checks, then `release/` with checksums. Nothing is signed or sent |
| `npm run build:developer` | also `dist/developer`, with the page-scripting tool. Never packed, signed or published; `release.mjs` stops if it finds a trace of it |

`dist/` and `release/` are not in Git. `dist\host\kitewarden-host.exe install` installs from `dist/` without an entry in Settings, Apps; load `dist\extension\manifest.json` as a temporary add-on.

### Same bytes from the same commit

Archives are written by `build/release.mjs`: sorted names, no compression, date 1980. `build/compile.mjs` replaces the time and the module ID that the compiler puts into each program. `.gitattributes` keeps line endings. To compare with another build:

```powershell
git clone . ..\fc-check; cd ..\fc-check; npm run build; node build/release.mjs; Get-FileHash release\* -Algorithm SHA256
```

The programs depend on the version of `csc.exe`; the archives do not depend on the version of Node.

### Versions

One version in `shared/protocol.mjs`, `host/native/Host.cs`, `ext/manifest.json`, `thunderbird/manifest.json` and `package.json`; the build stops if they differ. Raise `PROTOCOL` only when messages between the parts change.

## Install, upgrade, recovery

[Setup.cs](../host/native/Setup.cs) is part of the helper; with the files inside it, it is `KitewardenSetup`. It writes new files to `<home>\setup\new-*`, then `journal.txt`, then moves each old file to `setup\old-*` and the new one into its place. As long as the journal exists the old version counts: a failure or the next run moves everything back. Deleting the journal commits. `install.json` (pipe name) and `key.bin` are made once and kept; `installed.json` holds version and hashes. A running program can be moved, so Firefox may stay open.

Add a program file in `Names` (Setup.cs) and, for `mcp/`, in `build.mjs`. A file that a version no longer has must be deleted by the installer; nothing does that yet.

## Tests

| Command | What runs | Firefox | Claude |
|---|---|---|---|
| `npm test` | units, package checks | simulated | no |
| `npm run test:integration` | real helper, pipes, registry, server | played by the test | test double |
| `npm run test:install` | **packaged artifacts**: setup program, `.xpi`, `.mcpb`, optional zip; upgrade from 0.4.0, interruption, doctor, uninstall | played by the test | installed Claude Code, own configuration folder, no model |
| `npm run test:packaged` | **packaged artifacts** in real Firefox, headless | real, disposable profile | test double |
| `npm run test:firefox`, `:companion`, `:control`, `:audit`, `:advanced`, `:developer` | `dist/` in real Firefox | real, disposable profile | none or test double |
| `npm run test:desktop` | focus and Windows input on the visible desktop | real | none |
| `npm run test:claude`, `:chat`, `:milestone`, `:live-audit` | **live and paid**; `:live-audit` runs an exported skill, the file and shell tools, and attachments | real | live |

Run the live ones only when the way Claude or the server is started changes. Tests that use the registration restore it. `test:packaged` and one check of `test:install` do not run while this user has an installation. A run that was killed can leave an installation in the temp folder: `uninstall --home <that folder>`. Tests start Firefox with `-no-remote` and a profile in the temp folder.

A client may make 120 calls a minute, so the checks of `:control` and `:audit` pace themselves. Two suites must not run at the same time: they share the registration.

`test:install` and `test:packaged` build earlier commits (`8bfefbe`, `7bb7f27`, `d34fba3`) from Git, so they need the history.
