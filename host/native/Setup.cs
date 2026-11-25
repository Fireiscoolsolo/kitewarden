// install, uninstall and doctor. Per user, without administrator rights.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class Setup
{
    const string RegistryPath = @"Software\Mozilla\NativeMessagingHosts\" + Program.HostName;
    const string Exe = "firefox-companion-host.exe";
    static readonly string[] McpFiles = { "server.mjs", "serve.mjs", "link.mjs", "protocol.mjs" };

    public static int Run(string mode, string[] args)
    {
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FirefoxCompanion");
        bool dry = false, mail = false;
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--home" && i + 1 < args.Length) dir = args[++i];
            else if (args[i] == "--dry-run") dry = true;
            else if (args[i] == "--thunderbird" && mode == "install") mail = true;
            else { Console.Error.WriteLine("Unknown option " + args[i]); return 2; }
        }
        var home = new Home(dir);
        try { return mode == "install" ? Install(home, dry, mail) : mode == "uninstall" ? Uninstall(home, dry) : Doctor(home); }
        catch (Exception e) { Console.Error.WriteLine(mode + " failed: " + e.Message); return 1; }
    }

    const string MailRegistryPath = @"Software\Mozilla\NativeMessagingHosts\" + Program.MailHostName;
    static string Manifest(Home h) { return Path.Combine(h.Dir, "native-manifest.json"); }
    static string MailManifest(Home h) { return Path.Combine(h.Dir, "native-manifest-mail.json"); }

    static int Install(Home h, bool dry, bool mail)
    {
        string source = AppDomain.CurrentDomain.BaseDirectory;
        string mcpSource = Path.Combine(source, @"..\mcp");
        foreach (var f in McpFiles)
            if (!File.Exists(Path.Combine(mcpSource, f))) throw new Exception("missing " + f + " next to the host; run the build first");
        bool exists = Directory.Exists(h.Dir);
        if (exists && !File.Exists(h.Install) && Directory.GetFileSystemEntries(h.Dir).Length > 0)
            throw new Exception(h.Dir + " exists and is not a Firefox Companion folder");

        var undo = new Stack<Action>();
        Action<string, Action, Action> step = delegate(string what, Action act, Action back)
        {
            Console.WriteLine((dry ? "would: " : "") + what);
            if (dry) return;
            act();
            if (back != null) undo.Push(back);
        };
        try
        {
            if (!exists) step("create folder " + h.Dir + " (current user only)",
                delegate { Directory.CreateDirectory(h.Dir, Access.ForFolder()); }, delegate { Directory.Delete(h.Dir); });
            else step("set access list of " + h.Dir + " (current user only)", delegate { Directory.SetAccessControl(h.Dir, Access.ForFolder()); }, null);

            string mcp = Path.Combine(h.Dir, "mcp");
            if (!Directory.Exists(mcp)) step("create folder " + mcp, delegate { Directory.CreateDirectory(mcp); }, delegate { Directory.Delete(mcp); });
            Copy(step, Path.Combine(source, Exe), Path.Combine(h.Dir, Exe));
            foreach (var f in McpFiles) Copy(step, Path.Combine(mcpSource, f), Path.Combine(mcp, f));

            if (!File.Exists(h.Key)) step("create key " + h.Key + " (current user only)", delegate
            {
                var key = new byte[32];
                using (var r = System.Security.Cryptography.RandomNumberGenerator.Create()) r.GetBytes(key);
                using (var f = new FileStream(h.Key, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.Synchronize, FileShare.None, 4096, FileOptions.None, Access.ForFile()))
                    f.Write(key, 0, key.Length);
            }, delegate { File.Delete(h.Key); });
            else step("set access list of " + h.Key + " (current user only)", delegate { File.SetAccessControl(h.Key, Access.ForFile()); }, null);

            if (!File.Exists(h.Install)) step("write " + h.Install,
                delegate { File.WriteAllText(h.Install, "{\"pipe\":\"firefox-companion-" + Crypto.Nonce(16) + "\"}"); }, delegate { File.Delete(h.Install); });

            Register(h, step, Program.HostName, Program.ExtensionId, Manifest(h), RegistryPath);
            // Thunderbird reads the same place of the registry. Only when the user asks for it.
            if (mail) Register(h, step, Program.MailHostName, Program.MailExtensionId, MailManifest(h), MailRegistryPath);
            if (!dry)
            {
                string problem = h.AccessProblem();
                if (problem != null) throw new Exception(problem);
            }
        }
        catch (Exception)
        {
            while (undo.Count > 0) { try { undo.Pop()(); } catch (Exception e) { Console.Error.WriteLine("undo: " + e.Message); } }
            throw;
        }
        Console.WriteLine("MCP server: node \"" + Path.Combine(h.Dir, @"mcp\server.mjs") + "\"");
        return 0;
    }

    /// <summary>One registration allows exactly one add-on.</summary>
    static void Register(Home h, Action<string, Action, Action> step, string name, string id, string file, string key)
    {
        var manifest = new Dictionary<string, object>();
        manifest["name"] = name;
        manifest["description"] = "Firefox Companion helper";
        manifest["path"] = Path.Combine(h.Dir, Exe);
        manifest["type"] = "stdio";
        manifest["allowed_extensions"] = new[] { id };
        bool had = File.Exists(file);
        step("write " + file, delegate { File.WriteAllText(file, new JavaScriptSerializer().Serialize(manifest)); },
            had ? (Action)null : delegate { File.Delete(file); });
        string old = Registered(key);
        step(@"set HKCU\" + key + " to " + file,
            delegate { using (var k = Registry.CurrentUser.CreateSubKey(key)) k.SetValue("", file); },
            delegate
            {
                if (old == null) Registry.CurrentUser.DeleteSubKey(key, false);
                else using (var k = Registry.CurrentUser.CreateSubKey(key)) k.SetValue("", old);
            });
    }

    static void Copy(Action<string, Action, Action> step, string from, string to)
    {
        if (string.Equals(Path.GetFullPath(from), to, StringComparison.OrdinalIgnoreCase)) return;
        bool had = File.Exists(to);
        step("copy " + Path.GetFileName(from) + " to " + to, delegate { File.Copy(from, to, true); }, had ? (Action)null : delegate { File.Delete(to); });
    }

    static string Registered(string key)
    {
        using (var k = Registry.CurrentUser.OpenSubKey(key)) return k == null ? null : k.GetValue("") as string;
    }

    static int Uninstall(Home h, bool dry)
    {
        if (!File.Exists(h.Install)) throw new Exception(h.Dir + " is not a Firefox Companion folder");
        Action<string, Action> step = delegate(string what, Action act)
        {
            Console.WriteLine((dry ? "would: " : "") + what);
            if (!dry) act();
        };
        if (string.Equals(Registered(RegistryPath), Manifest(h), StringComparison.OrdinalIgnoreCase))
            step(@"delete HKCU\" + RegistryPath, delegate { Registry.CurrentUser.DeleteSubKey(RegistryPath, false); });
        if (string.Equals(Registered(MailRegistryPath), MailManifest(h), StringComparison.OrdinalIgnoreCase))
            step(@"delete HKCU\" + MailRegistryPath, delegate { Registry.CurrentUser.DeleteSubKey(MailRegistryPath, false); });
        // Only files of this program, by name. Anything else keeps its folder in place.
        var files = new List<string> { Manifest(h), MailManifest(h), Path.Combine(h.Dir, "remote", "clients.json"), h.Key, h.State, Path.Combine(h.Dir, Exe) };
        foreach (var f in McpFiles) files.Add(Path.Combine(h.Dir, "mcp", f));
        string chat = Path.Combine(h.Dir, "chat");
        files.Add(Path.Combine(chat, "rules.txt"));
        if (Directory.Exists(chat)) files.AddRange(Directory.GetFiles(chat, "run-*.json"));
        if (Directory.Exists(h.Profiles)) files.AddRange(Directory.GetFiles(h.Profiles, "*.json"));
        files.Add(h.Install);
        foreach (var f in files) if (File.Exists(f)) { string file = f; step("delete " + file, delegate { File.Delete(file); }); }
        foreach (var d in new[] { Path.Combine(h.Dir, "mcp"), Path.Combine(h.Dir, "remote"), chat, h.Profiles, h.Dir })
            if (Directory.Exists(d) && (dry || Directory.GetFileSystemEntries(d).Length == 0)) { string dir = d; step("delete folder " + dir, delegate { Directory.Delete(dir); }); }
        return 0;
    }

    static int Doctor(Home h)
    {
        int bad = 0;
        Action<string, string, string> check = delegate(string name, string problem, string fix)
        {
            Console.WriteLine((problem == null ? "ok    " : "FAIL  ") + name + (problem == null ? "" : ": " + problem + ". Fix: " + fix));
            if (problem != null) bad++;
        };
        check("firefox", Firefox(), "install Firefox 160 or later");
        check("folder", Directory.Exists(h.Dir) ? Access.Problem(h.Dir, true) : h.Dir + " is missing", "run install");
        check("key file", File.Exists(h.Key) ? Access.Problem(h.Key, false) : h.Key + " is missing", "run install");
        check("program", File.Exists(Path.Combine(h.Dir, Exe)) ? null : Exe + " is missing", "run install");
        check("registry", string.Equals(Registered(RegistryPath), Manifest(h), StringComparison.OrdinalIgnoreCase) ? null : "the key points to " + (Registered(RegistryPath) ?? "nothing"), "run install");
        check("manifest", ManifestProblem(Manifest(h), h, Program.ExtensionId), "run install");
        if (File.Exists(MailManifest(h)))
            check("thunderbird", string.Equals(Registered(MailRegistryPath), MailManifest(h), StringComparison.OrdinalIgnoreCase) ? ManifestProblem(MailManifest(h), h, Program.MailExtensionId) : "the key points to " + (Registered(MailRegistryPath) ?? "nothing"), "run install --thunderbird");
        else Console.WriteLine("info  thunderbird: not registered; install --thunderbird does it");
        string pipe = "none";
        var names = new List<string> { h.PipeName() };
        if (Directory.Exists(h.Profiles))
            foreach (var f in Directory.GetFiles(h.Profiles, "*.json")) names.Add(Bridge.Str(Bridge.Parse(File.ReadAllText(f)), "pipe"));
        foreach (var name in names) if (name != null) { string p = PipeProblem(name); if (p != "none" && (pipe == "none" || pipe == null)) pipe = p; }
        if (pipe == "none") Console.WriteLine("info  pipe: the helper is not running; open Firefox and press Connect in the sidebar");
        else check("pipe", pipe, "close other programs that use the pipe name, then press Retry in the sidebar");
        Console.WriteLine("info  Claude Code: " + (Runs.FindClaude() ?? "claude.exe was not found; the sidebar chat needs it, MCP clients do not"));
        return bad == 0 ? 0 : 1;
    }

    static string Firefox()
    {
        using (var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe"))
        {
            string path = k == null ? null : k.GetValue("") as string;
            if (path == null || !File.Exists(path)) return "Firefox was not found";
            var v = FileVersionInfo.GetVersionInfo(path);
            return v.FileMajorPart >= 160 ? null : "Firefox " + v.FileVersion + " is too old";
        }
    }

    static string ManifestProblem(string file, Home h, string id)
    {
        try
        {
            var m = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file));
            var ids = (object[])m["allowed_extensions"];
            if (ids.Length != 1 || (string)ids[0] != id) return "it does not allow exactly " + id;
            return string.Equals((string)m["path"], Path.Combine(h.Dir, Exe), StringComparison.OrdinalIgnoreCase) ? null : "it starts " + m["path"];
        }
        catch (Exception e) { return e.Message; }
    }

    static string PipeProblem(string name)
    {
        try
        {
            using (var c = new NamedPipeClientStream(".", name, PipeAccessRights.ReadWrite, PipeOptions.None,
                TokenImpersonationLevel.None, HandleInheritability.None))
            {
                c.Connect(500);
                return Access.Problem(c.GetAccessControl(), "the pipe");
            }
        }
        catch (TimeoutException) { return "none"; }
        catch (FileNotFoundException) { return "none"; }
        catch (Exception e) { return e.Message; }
    }
}
