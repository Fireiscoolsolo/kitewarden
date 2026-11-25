// install, uninstall and doctor. Per user, without administrator rights. The same program is the helper (it installs from the
// folders beside it, for developers) and, with the files inside it, FirefoxCompanionSetup.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class Setup
{
    const string RegistryPath = @"Software\Mozilla\NativeMessagingHosts\" + Program.HostName;
    const string MailRegistryPath = @"Software\Mozilla\NativeMessagingHosts\" + Program.MailHostName;
    const string AppsPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\FirefoxCompanion";
    const string Exe = "firefox-companion-host.exe";
    const string ClientName = "firefox-companion"; // in Claude Code
    const int Windows11 = 22000;
    /// <summary>Every program file, by its place in the installation.</summary>
    static readonly string[] Names = { Exe, @"mcp\server.mjs", @"mcp\serve.mjs", @"mcp\link.mjs", @"mcp\protocol.mjs", "NOTICE.txt" };

    static string removeLater; // this program itself, moved out of the folder that it uninstalls

    public static bool Bundled { get { return Assembly.GetExecutingAssembly().GetManifestResourceInfo("payload.txt") != null; } }
    static string Self { get { return Assembly.GetExecutingAssembly().Location; } }
    static string DefaultDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FirefoxCompanion"); } }

    static string Manifest(Home h) { return Path.Combine(h.Dir, "native-manifest.json"); }
    static string MailManifest(Home h) { return Path.Combine(h.Dir, "native-manifest-mail.json"); }
    static string Installed(Home h) { return Path.Combine(h.Dir, "installed.json"); }
    static string Server(Home h) { return Path.Combine(h.Dir, @"mcp\server.mjs"); }
    static string ClaudeMark(Home h) { return Path.Combine(h.Dir, "claude-code.txt"); }
    static string Work(Home h) { return Path.Combine(h.Dir, "setup"); }
    static string Journal(Home h) { return Path.Combine(Work(h), "journal.txt"); }

    public static int Run(string mode, string[] args)
    {
        string dir = DefaultDir;
        bool dry = false, mail = false, claude = false, ask = false;
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--home" && i + 1 < args.Length) dir = args[++i];
            else if (args[i] == "--dry-run" && mode != "doctor") dry = true;
            else if (args[i] == "--thunderbird" && mode == "install") mail = true;
            else if (args[i] == "--claude-code" && mode != "uninstall") claude = true;
            else if (args[i] == "--ask" && mode == "uninstall") ask = true;
            else { Console.Error.WriteLine("Unknown option " + args[i]); return 2; }
        }
        var home = new Home(dir);
        if (ask && !Yes("Remove Firefox Companion from " + home.Dir + "? Firefox keeps the add-on and its data.")) return 1;
        int code;
        try { code = mode == "install" ? Install(home, dry, mail, claude) : mode == "uninstall" ? Uninstall(home, dry) : Doctor(home, claude); }
        catch (Exception e) { Console.Error.WriteLine(mode + " failed: " + e.Message); code = 1; }
        if (ask) Pause();
        // Windows does not delete a running program, so a hidden command does it when this one has ended.
        if (removeLater != null)
        {
            var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d /s /c \"ping -n 3 127.0.0.1 >nul & del /f /q \"" + removeLater + "\"\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WorkingDirectory = Environment.SystemDirectory;
            Process.Start(info).Dispose();
        }
        return code;
    }

    // ---- FirefoxCompanionSetup without arguments: a person has started it

    public static int Ask()
    {
        var h = new Home(DefaultDir);
        Console.WriteLine("Firefox Companion " + Program.Version + " (working name), helper for Firefox.");
        Console.WriteLine("For this Windows user only, without administrator rights. This program is not signed.");
        Console.WriteLine(File.Exists(h.Install) ? "Installed here: version " + (InstalledVersion(h) ?? "unknown") + " in " + h.Dir : "Not installed yet. Folder: " + h.Dir);
        Console.Write("[i] install, upgrade or repair   [d] diagnose   [u] uninstall   [q] quit: ");
        string choice = (Console.ReadLine() ?? "q").Trim().ToLowerInvariant();
        int code = 1;
        if (choice == "d") code = Run("doctor", new[] { "doctor", "--claude-code" });
        else if (choice == "u") return Run("uninstall", new[] { "uninstall", "--ask" });
        else if (choice == "i" && Run("install", new[] { "install", "--dry-run" }) == 0 && Yes("Do this?"))
        {
            code = Run("install", new[] { "install" });
            if (code == 0 && Runs.FindClaude() != null && Yes("Register the MCP server with Claude Code for this user (claude mcp add)?"))
                code = ClaudeAdd(h, false);
            if (code == 0) Console.WriteLine("Next: open Firefox, open the Firefox Companion sidebar and press Connect. See SETUP.md.");
        }
        Pause();
        return code;
    }

    static bool Yes(string question)
    {
        Console.Write(question + " [y/N]: ");
        return (Console.ReadLine() ?? "").Trim().ToLowerInvariant() == "y";
    }

    static void Pause()
    {
        Console.Write("Press Enter to close.");
        Console.ReadLine();
    }

    // ---- install

    /// <summary>The program files. The ones inside FirefoxCompanionSetup must have the hashes that were written when it was made.</summary>
    static SortedDictionary<string, byte[]> Payload()
    {
        var files = new SortedDictionary<string, byte[]>(StringComparer.Ordinal);
        if (Bundled)
        {
            var asm = Assembly.GetExecutingAssembly();
            foreach (var line in Encoding.UTF8.GetString(Resource(asm, "payload.txt")).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string hash = line.Substring(0, 64), name = line.Substring(66);
                byte[] data = Resource(asm, name);
                if (Hash(data) != hash) throw new Exception("this installer is damaged: " + name + " does not have the expected hash. Nothing was changed; get the installer again");
                files[name] = data;
            }
            foreach (var n in Names) if (!files.ContainsKey(n)) throw new Exception("this installer is damaged: " + n + " is missing. Nothing was changed");
            if (files.Count != Names.Length) throw new Exception("this installer is damaged: it holds other files. Nothing was changed");
            return files;
        }
        string source = AppDomain.CurrentDomain.BaseDirectory;
        foreach (var n in Names)
        {
            string file = n.StartsWith(@"mcp\") ? Path.Combine(source, @"..\" + n) : Path.Combine(source, n);
            if (!File.Exists(file)) throw new Exception("missing " + Path.GetFileName(n) + " next to the host; use FirefoxCompanionSetup, or run the build first");
            files[n] = File.ReadAllBytes(file);
        }
        return files;
    }

    static byte[] Resource(Assembly asm, string name)
    {
        using (var s = asm.GetManifestResourceStream(name))
        using (var m = new MemoryStream())
        {
            if (s == null) throw new Exception("this installer is damaged: " + name + " is missing. Nothing was changed");
            s.CopyTo(m);
            return m.ToArray();
        }
    }

    static string Hash(byte[] data) { using (var s = SHA256.Create()) return Crypto.Hex(s.ComputeHash(data)); }

    static string InstalledVersion(Home h)
    {
        try { return Bridge.Str(Bridge.Parse(File.ReadAllText(Installed(h))), "version"); } catch (Exception) { return null; }
    }

    static int Install(Home h, bool dry, bool mail, bool claude)
    {
        if (WindowsBuild() < Windows11) throw new Exception("Firefox Companion needs Windows 11");
        var files = Payload();
        bool exists = Directory.Exists(h.Dir);
        if (exists && !Ours(h)) throw new Exception(h.Dir + " exists and is not a Firefox Companion folder");
        Version now;
        if (Version.TryParse(InstalledVersion(h) ?? "", out now) && now > new Version(Program.Version))
            throw new Exception("version " + now + " is installed, which is newer than " + Program.Version + ". Uninstall it first if you want the older one");

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
            // First of all, because it marks the folder as ours if this run is cut off.
            if (PipeOf(h) == null) step("write " + h.Install,
                delegate { WriteWhole(h.Install, Encoding.UTF8.GetBytes("{\"pipe\":\"firefox-companion-" + Crypto.Nonce(16) + "\"}")); }, delegate { File.Delete(h.Install); });
            if (File.Exists(Journal(h))) step("undo an installation that was interrupted", delegate { Recover(h); }, null);

            // A key that is not whole has never let anybody in, so it can go.
            if (File.Exists(h.Key) && new FileInfo(h.Key).Length != 32) step("delete incomplete key " + h.Key, delegate { File.Delete(h.Key); }, null);
            if (!File.Exists(h.Key) || (dry && new FileInfo(h.Key).Length != 32)) step("create key " + h.Key + " (current user only)", delegate
            {
                var key = new byte[32];
                using (var r = RandomNumberGenerator.Create()) r.GetBytes(key);
                using (var f = new FileStream(h.Key, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.Synchronize, FileShare.None, 4096, FileOptions.None, Access.ForFile()))
                    f.Write(key, 0, key.Length);
            }, delegate { File.Delete(h.Key); });
            else step("set access list of " + h.Key + " (current user only)", delegate { File.SetAccessControl(h.Key, Access.ForFile()); }, null);

            var hashes = new Dictionary<string, object>();
            foreach (var f in files) hashes[f.Key] = Hash(f.Value);
            files["native-manifest.json"] = NativeManifest(h, Program.HostName, Program.ExtensionId);
            // Thunderbird reads the same place of the registry. Only when the user asks for it; an upgrade leaves it as it is.
            if (mail) files["native-manifest-mail.json"] = NativeManifest(h, Program.MailHostName, Program.MailExtensionId);
            files["installed.json"] = Encoding.UTF8.GetBytes(Bridge.Json("version", Program.Version, "protocol", Program.Protocol, "files", hashes));

            foreach (var f in files) Console.WriteLine((dry ? "would: " : "") + (File.Exists(Path.Combine(h.Dir, f.Key)) ? "replace " : "write ") + Path.Combine(h.Dir, f.Key));
            if (!dry)
            {
                undo.Push(delegate { Recover(h); });
                Swap(h, files);
            }
            Register(step, RegistryPath, Manifest(h));
            if (mail) Register(step, MailRegistryPath, MailManifest(h));
            if (Bundled) ListInApps(h, step);
            if (!dry)
            {
                string problem = h.AccessProblem();
                if (problem != null) throw new Exception(problem);
                File.Delete(Journal(h)); // from here on the new version counts
                undo.Clear();
            }
        }
        catch (Exception)
        {
            while (undo.Count > 0) { try { undo.Pop()(); } catch (Exception e) { Console.Error.WriteLine("undo: " + e.Message); } }
            throw;
        }
        StopHelpers(h, dry, "Firefox starts it again");
        if (!dry) Clean(h);
        Console.WriteLine("MCP server: node \"" + Server(h) + "\"");
        Console.WriteLine("Claude Code: claude mcp add -s user " + ClientName + " -- node \"" + Server(h) + "\"");
        Console.WriteLine("Claude Desktop: install the .mcpb file of this release under Settings, Extensions, Advanced settings, Install Extension.");
        Console.WriteLine("Other clients: " + Bridge.Json("mcpServers", Map(ClientName, Map("command", "node", "args", new[] { Server(h) }))));
        return claude ? ClaudeAdd(h, dry) : 0;
    }

    static Dictionary<string, object> Map(params object[] kv)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    /// <summary>A folder of ours has install.json, or nothing but the beginning of one.</summary>
    static bool Ours(Home h)
    {
        if (File.Exists(h.Install)) return true;
        foreach (var f in Directory.GetFileSystemEntries(h.Dir)) if (f != h.Install + ".new") return false;
        return true;
    }

    static string PipeOf(Home h)
    {
        try { return string.IsNullOrEmpty(h.PipeName()) ? null : h.PipeName(); } catch (Exception) { return null; }
    }

    /// <summary>The file is there with all of its content, or not at all.</summary>
    static void WriteWhole(string file, byte[] data)
    {
        using (var f = new FileStream(file + ".new", FileMode.Create))
        {
            f.Write(data, 0, data.Length);
            f.Flush(true);
        }
        if (File.Exists(file)) File.Replace(file + ".new", file, null);
        else File.Move(file + ".new", file);
    }

    static byte[] NativeManifest(Home h, string name, string id)
    {
        // One registration allows exactly one add-on.
        return Encoding.UTF8.GetBytes(Bridge.Json("name", name, "description", "Firefox Companion helper", "path", Path.Combine(h.Dir, Exe), "type", "stdio", "allowed_extensions", new[] { id }));
    }

    /// <summary>All new files are complete in the work folder before the first old one is touched. The journal says how to go back;
    /// as long as it exists, the old version counts. A running program can be moved, but not overwritten.</summary>
    static void Swap(Home h, SortedDictionary<string, byte[]> files)
    {
        Clean(h);
        string run = Crypto.Nonce(4), fresh = Path.Combine(Work(h), "new-" + run), old = Path.Combine(Work(h), "old-" + run);
        var lines = new StringBuilder("old-" + run + "\n");
        foreach (var f in files)
        {
            string at = Path.Combine(fresh, f.Key);
            Directory.CreateDirectory(Path.GetDirectoryName(at)); // inherits the access list of the home folder
            WriteWhole(at, f.Value);
            lines.Append(File.Exists(Path.Combine(h.Dir, f.Key)) ? "=" : "+").Append(f.Key).Append("\n");
        }
        WriteWhole(Journal(h), Encoding.UTF8.GetBytes(lines.ToString()));
        foreach (var name in files.Keys)
        {
            string target = Path.Combine(h.Dir, name), back = Path.Combine(old, name);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            Directory.CreateDirectory(Path.GetDirectoryName(back));
            if (File.Exists(target)) File.Move(target, back);
            File.Move(Path.Combine(fresh, name), target);
        }
    }

    /// <summary>Back to what was there before the journal was written. Can be cut off and run again.</summary>
    static void Recover(Home h)
    {
        if (!File.Exists(Journal(h))) { Clean(h); return; }
        var lines = File.ReadAllText(Journal(h)).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
        for (int i = 1; i < lines.Length; i++)
        {
            string name = lines[i].Substring(1), target = Path.Combine(h.Dir, name), back = Path.Combine(Work(h), lines[0], name);
            bool had = lines[i][0] == '=';
            if (had && !File.Exists(back)) continue; // not touched yet, or already back
            if (File.Exists(target)) File.Move(target, Path.Combine(Work(h), "gone-" + Crypto.Nonce(4)));
            if (had) File.Move(back, target);
        }
        string mcp = Path.Combine(h.Dir, "mcp");
        if (Directory.Exists(mcp) && Directory.GetFileSystemEntries(mcp).Length == 0) Directory.Delete(mcp);
        File.Delete(Journal(h));
        StopHelpers(h, false, "Firefox starts it again");
        Clean(h);
    }

    /// <summary>Removes the work folder. What still runs from it stays for the next time.</summary>
    static void Clean(Home h)
    {
        for (int i = 0; Directory.Exists(Work(h)); i++)
        {
            try { Directory.Delete(Work(h), true); return; }
            catch (Exception e)
            {
                if (!(e is IOException) && !(e is UnauthorizedAccessException)) throw;
                if (i == 10) return;
                System.Threading.Thread.Sleep(100);
            }
        }
    }

    static void Register(Action<string, Action, Action> step, string key, string file)
    {
        string old = Registered(key);
        step(@"set HKCU\" + key + " to " + file + (old == null || string.Equals(old, file, StringComparison.OrdinalIgnoreCase) ? "" : " (was " + old + ")"),
            delegate { using (var k = Registry.CurrentUser.CreateSubKey(key)) k.SetValue("", file); },
            delegate
            {
                if (old == null) Registry.CurrentUser.DeleteSubKey(key, false);
                else using (var k = Registry.CurrentUser.CreateSubKey(key)) k.SetValue("", old);
            });
    }

    static string Registered(string key)
    {
        using (var k = Registry.CurrentUser.OpenSubKey(key)) return k == null ? null : k.GetValue("") as string;
    }

    /// <summary>The entry in Settings, Apps. An installation in another folder has one of its own.</summary>
    static string AppsKey(Home h)
    {
        if (string.Equals(h.Dir, new Home(DefaultDir).Dir, StringComparison.OrdinalIgnoreCase)) return AppsPath;
        return AppsPath + "-" + Hash(Encoding.UTF8.GetBytes(h.Dir.ToLowerInvariant())).Substring(0, 8);
    }

    static void ListInApps(Home h, Action<string, Action, Action> step)
    {
        string path = AppsKey(h), remove = "\"" + Path.Combine(h.Dir, Exe) + "\" uninstall --home \"" + h.Dir + "\"";
        var values = Map("DisplayName", "Firefox Companion (working name)", "DisplayVersion", Program.Version, "InstallLocation", h.Dir,
            "UninstallString", remove + " --ask", "QuietUninstallString", remove, "NoModify", 1, "NoRepair", 1);
        var before = new Dictionary<string, object>();
        using (var k = Registry.CurrentUser.OpenSubKey(path)) if (k != null) foreach (var n in k.GetValueNames()) before[n] = k.GetValue(n);
        Action<Dictionary<string, object>> set = delegate(Dictionary<string, object> all) { using (var k = Registry.CurrentUser.CreateSubKey(path)) foreach (var v in all) k.SetValue(v.Key, v.Value); };
        step("list it in Settings, Apps", delegate { set(values); },
            delegate { if (before.Count == 0) Registry.CurrentUser.DeleteSubKey(path, false); else set(before); });
    }

    /// <summary>Only helpers that were started from this folder.</summary>
    static void StopHelpers(Home h, bool dry, string after)
    {
        int me = Process.GetCurrentProcess().Id;
        foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Exe)))
            using (p)
            {
                try
                {
                    if (p.Id == me || !p.MainModule.FileName.StartsWith(h.Dir + @"\", StringComparison.OrdinalIgnoreCase)) continue;
                    Console.WriteLine((dry ? "would: " : "") + "stop the running helper, process " + p.Id + "; chats that it runs end. " + after);
                    if (dry) continue;
                    p.Kill();
                    p.WaitForExit(5000);
                }
                catch (InvalidOperationException) { } // it has ended
                catch (System.ComponentModel.Win32Exception) { } // a process of another user
            }
    }

    // ---- Claude Code, by its own command only

    static string Tool(string exe, string configDir, out int exit, params string[] args)
    {
        var list = new List<string>();
        foreach (var a in args) list.Add(Runs.Quote(a));
        var info = new ProcessStartInfo(exe, string.Join(" ", list.ToArray()));
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WorkingDirectory = Environment.SystemDirectory; // no project settings
        info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
        info.StandardOutputEncoding = info.StandardErrorEncoding = new UTF8Encoding(false);
        if (!string.IsNullOrEmpty(configDir)) info.EnvironmentVariables["CLAUDE_CONFIG_DIR"] = configDir;
        using (var p = Process.Start(info))
        {
            p.StandardInput.Close();
            var err = p.StandardError.ReadToEndAsync();
            var text = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(60000)) { try { p.Kill(); } catch (InvalidOperationException) { } exit = -1; return "no answer within 60 s"; }
            exit = p.ExitCode;
            return text.Result + err.Result;
        }
    }

    static int ClaudeAdd(Home h, bool dry)
    {
        string exe = Runs.FindClaude();
        if (exe == null) { Console.Error.WriteLine("WARN  claude.exe was not found, so nothing was registered"); return 3; }
        Console.WriteLine((dry ? "would: " : "") + "run claude mcp add -s user " + ClientName + " -- node \"" + Server(h) + "\"");
        if (dry) return 0;
        int exit;
        string text = Tool(exe, null, out exit, "mcp", "add", "-s", "user", ClientName, "--", "node", Server(h));
        if (exit != 0)
        {
            if (text.IndexOf("already exists", StringComparison.Ordinal) < 0) { Console.Error.WriteLine("WARN  Claude Code did not register it: " + text.Trim()); return 3; }
            if (!ClaudeHas(exe, null, h)) { Console.Error.WriteLine("WARN  Claude Code has another entry named " + ClientName + ", which was left as it is"); return 3; }
            Console.WriteLine("Claude Code has this entry already");
            return 0; // not marked: if somebody else made it, uninstalling leaves it
        }
        File.WriteAllText(ClaudeMark(h), Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? "");
        Console.WriteLine("registered with Claude Code");
        return 0;
    }

    static bool ClaudeHas(string exe, string configDir, Home h)
    {
        int exit;
        return Tool(exe, configDir, out exit, "mcp", "get", ClientName).IndexOf(Server(h), StringComparison.OrdinalIgnoreCase) >= 0 && exit == 0;
    }

    static void ClaudeRemove(Home h, bool dry)
    {
        if (!File.Exists(ClaudeMark(h))) return;
        string exe = Runs.FindClaude(), dir = File.ReadAllText(ClaudeMark(h));
        Console.WriteLine((dry ? "would: " : "") + "run claude mcp remove -s user " + ClientName);
        if (dry) return;
        int exit = -1;
        string text = "claude.exe was not found";
        if (exe != null)
        {
            if (!ClaudeHas(exe, dir, h)) { Console.WriteLine("Claude Code has no such entry for this folder; nothing to remove there"); return; }
            text = Tool(exe, dir, out exit, "mcp", "remove", "-s", "user", ClientName);
        }
        if (exit != 0) Console.Error.WriteLine("WARN  run this yourself: claude mcp remove -s user " + ClientName + " (" + text.Trim() + ")");
    }

    // ---- uninstall

    static int Uninstall(Home h, bool dry)
    {
        if (!File.Exists(h.Install)) throw new Exception(h.Dir + " is not a Firefox Companion folder");
        Action<string, Action> step = delegate(string what, Action act)
        {
            Console.WriteLine((dry ? "would: " : "") + what);
            if (!dry) act();
        };
        // The registration goes first, so that Firefox does not start the helper again.
        if (string.Equals(Registered(RegistryPath), Manifest(h), StringComparison.OrdinalIgnoreCase))
            step(@"delete HKCU\" + RegistryPath, delegate { Registry.CurrentUser.DeleteSubKey(RegistryPath, false); });
        if (string.Equals(Registered(MailRegistryPath), MailManifest(h), StringComparison.OrdinalIgnoreCase))
            step(@"delete HKCU\" + MailRegistryPath, delegate { Registry.CurrentUser.DeleteSubKey(MailRegistryPath, false); });
        StopHelpers(h, dry, "");
        ClaudeRemove(h, dry);
        // Only files of this program, by name. Anything else keeps its folder in place.
        var files = new List<string> { Manifest(h), MailManifest(h), Path.Combine(h.Dir, "remote", "clients.json"), h.Key, h.State, Installed(h), ClaudeMark(h), h.Install + ".new" };
        foreach (var n in Names) files.Add(Path.Combine(h.Dir, n));
        string chat = Path.Combine(h.Dir, "chat");
        files.Add(Path.Combine(chat, "rules.txt"));
        if (Directory.Exists(chat)) files.AddRange(Directory.GetFiles(chat, "run-*.json"));
        if (Directory.Exists(h.Profiles)) files.AddRange(Directory.GetFiles(h.Profiles, "*.json"));
        foreach (var f in files) if (File.Exists(f)) { string file = f; step("delete " + file, delegate { Delete(h, file); }); }
        if (Directory.Exists(Work(h))) step("delete folder " + Work(h), delegate { Clean(h); });
        bool listed;
        using (var k = Registry.CurrentUser.OpenSubKey(AppsKey(h)))
            listed = k != null && string.Equals(k.GetValue("InstallLocation") as string, h.Dir, StringComparison.OrdinalIgnoreCase);
        if (listed) step(@"delete HKCU\" + AppsKey(h), delegate { Registry.CurrentUser.DeleteSubKey(AppsKey(h), false); });
        // Last of the files: until here a second run can finish what this one did not.
        step("delete " + h.Install, delegate { File.Delete(h.Install); });
        foreach (var d in new[] { Path.Combine(h.Dir, "mcp"), Path.Combine(h.Dir, "remote"), chat, h.Profiles, h.Dir })
            if (Directory.Exists(d) && (dry || Directory.GetFileSystemEntries(d).Length == 0)) { string dir = d; step("delete folder " + dir, delegate { Directory.Delete(dir); }); }
        if (!dry && Directory.Exists(h.Dir)) Console.WriteLine("left, because it holds other files: " + h.Dir);
        return 0;
    }

    static void Delete(Home h, string file)
    {
        if (!string.Equals(file, Self, StringComparison.OrdinalIgnoreCase)) { File.Delete(file); return; }
        string name = "firefox-companion-removed-" + Crypto.Nonce(4) + ".exe", temp = Path.GetTempPath();
        // A running program can be moved only within its drive.
        string to = Path.Combine(string.Equals(Path.GetPathRoot(temp), Path.GetPathRoot(h.Dir), StringComparison.OrdinalIgnoreCase) ? temp : Path.GetDirectoryName(h.Dir), name);
        File.Move(file, to);
        removeLater = to;
    }

    // ---- doctor

    static int Doctor(Home h, bool claude)
    {
        int bad = 0;
        Action<string, string, string> check = delegate(string name, string problem, string fix)
        {
            Console.WriteLine((problem == null ? "ok    " : "FAIL  ") + name + (problem == null ? "" : ": " + problem + ". Fix: " + fix));
            if (problem != null) bad++;
        };
        Console.WriteLine("info  this program: version " + Program.Version + ", protocol " + Program.Protocol);
        check("windows", WindowsBuild() >= Windows11 ? null : "build " + WindowsBuild() + " is older than Windows 11", "use Windows 11");
        check("firefox", Firefox(), "install Firefox 160 or later");
        check("folder", Directory.Exists(h.Dir) ? Access.Problem(h.Dir, true) : h.Dir + " is missing", "run install");
        check("key file", File.Exists(h.Key) ? Access.Problem(h.Key, false) ?? (new FileInfo(h.Key).Length == 32 ? null : h.Key + " is not complete") : h.Key + " is missing", "run install");
        check("pipe name", PipeOf(h) != null ? null : h.Install + " is missing or not complete", "run install");
        check("program", File.Exists(Path.Combine(h.Dir, Exe)) ? null : Exe + " is missing", "run install");
        if (File.Exists(Journal(h))) check("installation", "the last one was interrupted", "run install, which first undoes it");
        else check("files", FilesProblem(h), "run install");
        check("registry", string.Equals(Registered(RegistryPath), Manifest(h), StringComparison.OrdinalIgnoreCase) ? null : "the key points to " + (Registered(RegistryPath) ?? "nothing"), "run install");
        check("manifest", ManifestProblem(Manifest(h), h, Program.ExtensionId), "run install");
        if (File.Exists(MailManifest(h)))
            check("thunderbird", string.Equals(Registered(MailRegistryPath), MailManifest(h), StringComparison.OrdinalIgnoreCase) ? ManifestProblem(MailManifest(h), h, Program.MailExtensionId) : "the key points to " + (Registered(MailRegistryPath) ?? "nothing"), "run install --thunderbird");
        else Console.WriteLine("info  thunderbird: not registered; install --thunderbird does it");
        string pipe = "none";
        var names = new List<string> { PipeOf(h) };
        if (Directory.Exists(h.Profiles))
            foreach (var f in Directory.GetFiles(h.Profiles, "*.json"))
            {
                Dictionary<string, object> p;
                try { p = Bridge.Parse(File.ReadAllText(f)); } catch (Exception) { continue; } // written at this moment
                names.Add(Bridge.Str(p, "pipe"));
                Console.WriteLine("info  profile " + Bridge.Str(p, "label") + " (" + (Bridge.Str(p, "kind") ?? "firefox") + "): last state " + Bridge.Str(p, "state") + ", helper " + Bridge.Str(p, "host"));
            }
        foreach (var name in names) if (name != null) { string p = PipeProblem(name, h); if (p != "none" && (pipe == "none" || pipe == null)) pipe = p; }
        if (pipe == "none") Console.WriteLine("info  pipe: the helper is not running; open Firefox and press Connect in the sidebar");
        else check("pipe", pipe, "close other programs that use the pipe name, then press Retry in the sidebar; after an update run install again");
        string node = Runs.Find("node.exe");
        int exit = 0;
        Console.WriteLine("info  Node: " + (node == null ? "not found; Claude Code and the sidebar chat need Node 22 or later, Claude Desktop brings its own" : node + " " + Tool(node, null, out exit, "--version").Trim()));
        Console.WriteLine("info  Claude Code: " + (Runs.FindClaude() ?? "claude.exe was not found; the sidebar chat needs it, MCP clients do not"));
        if (claude && Runs.FindClaude() != null)
        {
            string text = Tool(Runs.FindClaude(), null, out exit, "mcp", "get", ClientName);
            check("claude code entry", exit != 0 ? "there is none" : text.IndexOf(Server(h), StringComparison.OrdinalIgnoreCase) < 0 ? "it starts something else" : text.IndexOf("Connected", StringComparison.Ordinal) < 0 ? "the server does not start" : null,
                "run install --claude-code, or claude mcp get " + ClientName + " to see it");
        }
        return bad == 0 ? 0 : 1;
    }

    static int WindowsBuild()
    {
        using (var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
        {
            int n;
            return k != null && int.TryParse(k.GetValue("CurrentBuild") as string, out n) ? n : 0;
        }
    }

    static string Firefox()
    {
        const string key = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe";
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine }) // a Firefox for this user only, or for all
            using (var k = root.OpenSubKey(key))
            {
                string path = k == null ? null : k.GetValue("") as string;
                if (path == null || !File.Exists(path)) continue;
                var v = FileVersionInfo.GetVersionInfo(path);
                return v.FileMajorPart >= 160 ? null : "Firefox " + v.FileVersion + " is too old";
            }
        return "Firefox was not found";
    }

    /// <summary>First program file that is not the one that was installed, or null.</summary>
    static string FilesProblem(Home h)
    {
        try
        {
            object v;
            var all = Bridge.Parse(File.ReadAllText(Installed(h)));
            if (!all.TryGetValue("files", out v)) return Installed(h) + " names no files";
            foreach (var f in (Dictionary<string, object>)v)
            {
                string file = Path.Combine(h.Dir, f.Key);
                if (!File.Exists(file)) return file + " is missing";
                if (Hash(File.ReadAllBytes(file)) != (string)f.Value) return file + " was changed";
            }
            return null;
        }
        catch (Exception e) { return e.Message.TrimEnd('.'); }
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
        catch (Exception e) { return e.Message.TrimEnd('.'); }
    }

    /// <summary>Access list of the pipe, then a login with protocol 0: the helper proves the key and names its protocol, and no session
    /// begins. "none" when nothing runs.</summary>
    static string PipeProblem(string name, Home h)
    {
        try
        {
            using (var c = new NamedPipeClientStream(".", name, PipeAccessRights.ReadWrite, PipeOptions.Asynchronous,
                TokenImpersonationLevel.None, HandleInheritability.None))
            using (new System.Threading.Timer(delegate { c.Dispose(); }, null, 5000, System.Threading.Timeout.Infinite))
            {
                c.Connect(500);
                string problem = Access.Problem(c.GetAccessControl(), "the pipe");
                if (problem != null) return problem;
                byte[] key = File.ReadAllBytes(h.Key);
                string hostNonce = Bridge.Str(Bridge.Parse(Frame.Read(c, 8192) ?? "{}"), "nonce"), mine = Crypto.Nonce(32);
                if (!Crypto.IsHex(hostNonce, 64)) return "the helper did not answer";
                Frame.Write(c, Bridge.Json("type", "auth", "nonce", mine, "protocol", 0, "mac", Crypto.Mac(key, "client", 0, hostNonce, mine)));
                var m = Bridge.Parse(Frame.Read(c, 8192) ?? "{}");
                int protocol = Bridge.Int(m, "protocol");
                if (!Crypto.Same(Bridge.Str(m, "mac"), Crypto.Mac(key, "host", protocol, hostNonce, mine))) return "the helper has another key";
                return protocol == Program.Protocol ? null : "the running helper speaks protocol " + protocol + ", this program " + Program.Protocol;
            }
        }
        catch (TimeoutException) { return "none"; }
        catch (FileNotFoundException) { return "none"; }
        catch (Exception e) { return e.Message.TrimEnd('.'); }
    }
}
