# Changelog

## 1.0.0 (not released yet)

The first public version.

- **Name and IDs.** The product is Kitewarden (formerly Firefox Companion). The add-on IDs are `firefox@fireiscoolsolo.github.io` and `thunderbird@fireiscoolsolo.github.io`. Earlier test builds used other IDs, so remove them in `about:addons` and run the new setup program.
- **Updates.** The Firefox add-on checks https://fireiscoolsolo.github.io/kitewarden/updates.json for newer versions.
- **Bookmarks.** Turning on the Bookmarks switch now also asks Firefox for the optional "bookmarks" data permission, because Claude then receives bookmark titles and addresses.
- **Before Connect.** The sidebar says what goes where: Claude sees only the tabs you attach, and what it reads goes to Anthropic through your own Claude app.
- **The sidebar chat is experimental.** It runs your own signed-in Claude Code.
- **Windows input** clicks only after 2 seconds without mouse or keyboard input, and stops if you start using them.
- **License** MPL-2.0. Source: https://github.com/Fireiscoolsolo/kitewarden. Privacy policy: https://fireiscoolsolo.github.io/kitewarden/privacy.html

Known limits: Windows 11 only. Not tested yet: a second Windows account, Thunderbird, the remote link between two computers, and Claude Desktop itself. The Thunderbird add-on, the remote link, the isolated Firefox and Windows input are separate, optional downloads.
