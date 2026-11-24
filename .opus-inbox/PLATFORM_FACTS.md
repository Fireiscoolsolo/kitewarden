# Platform facts (retrieved 2026-11-23)

Target: Firefox 160.0.1 x64 release channel on Windows 11 build 26300 (read from the registry of this machine).

Sources, all pinned:

- BCD: https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/webextensions/
- MDN: https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/
- EW (Extension Workshop): https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/

## Firefox version floors (BCD, desktop Firefox)

| API | Firefox | File under BCD |
|---|---|---|
| sidebar_action, sidebarAction | 54 (open 57, toggle 73) | manifest/sidebar_action.json, api/sidebarAction.json |
| Manifest V2 | 48, no removal recorded | manifest/manifest_version.json |
| Manifest V3 | 109 | manifest/manifest_version.json |
| background.service_worker | not supported | manifest/background.json |
| background.persistent | MV2 only | manifest/background.json |
| host_permissions (MV3, user controlled at runtime) | 109 | manifest/host_permissions.json |
| tabs.captureTab | 59, needs `<all_urls>` | api/tabs.json |
| tabs.captureVisibleTab | 47; from 126 `<all_urls>` or activeTab | api/tabs.json |
| tabs.saveAsPDF | 81, opens an operating-system save dialog | api/tabs.json |
| tabs.group, tabs.ungroup | 138 | api/tabs.json |
| tabGroups API and permission | 139 | api/tabGroups.json |
| tabs.executeScript | MV2 only | api/tabs.json |
| scripting.executeScript | 102 | api/scripting.json |
| scripting MAIN world | 128 | api/scripting.json |
| userScripts (MV3, optional-only permission) | 136; userScripts.execute 153 | api/userScripts.json |
| webRequest blocking, webRequest.filterResponseData | 45, 57 | api/webRequest.json |
| permissions.request, onAdded, onRemoved | 55, 77, 77 | api/permissions.json |
| contextualIdentities | 53 | api/contextualIdentities.json |
| runtime.connectNative | 50; nativeMessaging may be optional from 87 | api/runtime.json, manifest/optional_permissions.json |
| element.openOrClosedShadowRoot | 63 | api/dom.json |
| storage.session | 115 | api/storage.json |
| `debugger` permission and chrome.debugger | not supported | manifest/permissions.json |
| data_collection_permissions | 140 | manifest/browser_specific_settings.json |

## Behavior and policy facts

| ID | Fact | Pinned source |
|---|---|---|
| P1 | Extensions must be signed by Mozilla through AMO to install in release and beta Firefox, also when self-distributed. Unsigned installs need Developer Edition, Nightly or ESR with a preference. | [EW signing L51](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/signing-and-distribution-overview.md#L51) [L70](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/signing-and-distribution-overview.md#L70) |
| P2 | Add-on policies apply to listed and self-distributed add-ons. Add-ons must be self-contained and must not load remote code for execution. | [EW policies L156](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies.md#L156) |
| P3 | Add-ons must not relax page security headers such as CSP. | [EW policies L158](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies.md#L158) |
| P4 | The userScripts API is allowed for user script managers only. | [EW policies L177](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies.md#L177) |
| P5 | Data sent to a native application counts as data transmission and needs consent. Transmission of browsing activity is allowed only for the primary function. | [EW policies L198](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies.md#L198) [preview L212](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies-preview-2026-12.md#L212) |
| P6 | New extensions must declare data collection with the built-in consent system (data_collection_permissions). | [EW data consent L29](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/develop/firefox-builtin-data-consent.md#L29) |
| P7 | If an add-on name uses "Firefox", the expected form is "<Add-on name> for Firefox". The name "Firefox Companion" does not follow it. | [EW policies L89](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies.md#L89) |
| P8 | A policy revision takes effect on 2026-12-01 and keeps P2, P3, P4, P5 and P7. | [preview L31](https://github.com/mozilla/extension-workshop/blob/c5927241c03d376b87e53613821b3e73d3181e31/src/content/documentation/publish/add-on-policies-preview-2026-12.md#L31) |
| P9 | MV3 backgrounds are event pages. MV2 may be persistent. Message ports cannot keep an event page alive. | [MDN background L24](https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/background_scripts/index.md#L24) [L227](https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/background_scripts/index.md#L227) |
| P10 | Each browser window has its own sidebar document, and a panel can be set per tab. | [MDN sidebars L18](https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/user_interface/sidebars/index.md#L18) |
| P11 | Per-user native host registration on Windows is the key HKEY_CURRENT_USER\SOFTWARE\Mozilla\NativeMessagingHosts\name, whose value is the manifest path. allowed_extensions lists add-on IDs. | [MDN native manifests L380](https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/native_manifests/index.md#L380) |
| P12 | A native message to the extension is at most 1 MB and a message to the host at most 4 GB. | [MDN native messaging L240](https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/native_messaging/index.md#L240) |
| P13 | On Windows Firefox puts the native host in a Job object and kills it with the job, so children that must outlive it need to break away. | [MDN native messaging L387](https://github.com/mdn/content/blob/e4ffa5e4befde66732cad271e39154a80477a33c/files/en-us/mozilla/add-ons/webextensions/native_messaging/index.md#L387) |

Not verified here: behavior on a running Firefox 160, how AMO reviewers judge agent-supplied JavaScript or an AI agent using native messaging, and whether a claude.ai subscription may back a third-party sidebar. Treat these as open questions.
