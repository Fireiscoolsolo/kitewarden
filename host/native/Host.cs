// Native messaging host and named-pipe server. Firefox starts it; it relays opaque message bodies between
// authenticated pipe clients and the extension, and starts chat runs (Chat.cs) when the extension says so. C# 5, so that the compiler that ships with Windows builds it.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

static class Program
{
    public const string HostName = "firefox_companion";
    public const string ExtensionId = "bridge@firefox-companion.invalid";
    public const string Version = "0.3.0";
    public const int Protocol = 3;

    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0] : "";
        if (mode == "install" || mode == "uninstall" || mode == "doctor") return Setup.Run(mode, args);
        // Firefox passes the manifest path and the add-on ID.
        if (args.Length != 2 || args[1] != ExtensionId)
        {
            Console.Error.WriteLine("Usage: install | uninstall | doctor [--home <folder>] [--dry-run]. Firefox starts the host itself.");
            return 2;
        }
        return new Bridge(Home.Default()).Run();
    }
}

/// <summary>Files of one installation. The folder and the key belong to the current user only.</summary>
sealed class Home
{
    public readonly string Dir;
    public Home(string dir) { Dir = Path.GetFullPath(dir); }
    public static Home Default() { return new Home(AppDomain.CurrentDomain.BaseDirectory); }
    public string Key { get { return Path.Combine(Dir, "key.bin"); } }
    public string Install { get { return Path.Combine(Dir, "install.json"); } }
    public string State { get { return Path.Combine(Dir, "state.json"); } }
    public string Profiles { get { return Path.Combine(Dir, "profiles"); } }

    public string PipeName()
    {
        var o = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(Install));
        return (string)o["pipe"];
    }

    /// <summary>First problem with the access lists of the folder and the key, or null. The host and the doctor share it.</summary>
    public string AccessProblem()
    {
        return Access.Problem(Dir, true) ?? Access.Problem(Key, false);
    }
}

static class Access
{
    public static SecurityIdentifier Me() { using (var id = WindowsIdentity.GetCurrent()) return id.User; }

    public static string Problem(string path, bool folder)
    {
        try
        {
            var sections = AccessControlSections.Access | AccessControlSections.Owner;
            FileSystemSecurity s = folder ? (FileSystemSecurity)Directory.GetAccessControl(path, sections) : File.GetAccessControl(path, sections);
            return Problem(s, path);
        }
        catch (Exception e) { return "Cannot read the access list of " + path + ": " + e.Message; }
    }

    public static string Problem(NativeObjectSecurity s, string name)
    {
        var me = Me();
        var owner = s.GetOwner(typeof(SecurityIdentifier));
        if (!me.Equals(owner)) return name + " is owned by " + Name(owner) + ", not by the current user";
        int own = 0;
        foreach (AuthorizationRule r in Rules(s))
        {
            var a = r as AccessRule;
            if (!me.Equals(r.IdentityReference)) return name + " names " + Name(r.IdentityReference) + " in its access list";
            if (a.AccessControlType == AccessControlType.Allow) own++;
        }
        return own > 0 ? null : name + " has no entry for the current user";
    }

    static AuthorizationRuleCollection Rules(NativeObjectSecurity s)
    {
        return ((CommonObjectSecurity)s).GetAccessRules(true, true, typeof(SecurityIdentifier));
    }

    public static string Name(IdentityReference id)
    {
        try { return id.Translate(typeof(NTAccount)).Value; } catch (Exception) { return id.Value; }
    }

    public static FileSecurity ForFile()
    {
        var s = new FileSecurity();
        s.SetOwner(Me());
        s.SetAccessRuleProtection(true, false);
        s.AddAccessRule(new FileSystemAccessRule(Me(), FileSystemRights.FullControl, AccessControlType.Allow));
        return s;
    }

    public static DirectorySecurity ForFolder()
    {
        var s = new DirectorySecurity();
        s.SetOwner(Me());
        s.SetAccessRuleProtection(true, false);
        s.AddAccessRule(new FileSystemAccessRule(Me(), FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return s;
    }
}

static class Crypto
{
    public static string Nonce(int bytes)
    {
        var b = new byte[bytes];
        using (var r = RandomNumberGenerator.Create()) r.GetBytes(b);
        return Hex(b);
    }

    public static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }

    /// <summary>Both nonces, the role and the sender's protocol version are under the MAC.</summary>
    public static string Mac(byte[] key, string role, int protocol, string hostNonce, string clientNonce)
    {
        using (var h = new HMACSHA256(key))
            return Hex(h.ComputeHash(Encoding.ASCII.GetBytes("firefox-companion|" + role + "|" + protocol + "|" + hostNonce + "|" + clientNonce)));
    }

    public static bool Same(string a, string b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        int d = 0;
        for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i];
        return d == 0;
    }

    public static bool IsHex(string s, int length)
    {
        if (s == null || s.Length != length) return false;
        foreach (char c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        return true;
    }
}

/// <summary>Four-byte little-endian length, then UTF-8 JSON. Native messaging and the pipe use the same frame.</summary>
static class Frame
{
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    public static string Read(Stream s, int limit)
    {
        var head = new byte[4];
        if (!Fill(s, head)) return null;
        int n = BitConverter.ToInt32(head, 0);
        if (n < 2 || n > limit) throw new InvalidDataException("frame of " + n + " bytes");
        var body = new byte[n];
        if (!Fill(s, body)) return null;
        return Utf8.GetString(body);
    }

    public static void Write(Stream s, string json)
    {
        var body = Utf8.GetBytes(json);
        var all = new byte[body.Length + 4];
        BitConverter.GetBytes(body.Length).CopyTo(all, 0);
        body.CopyTo(all, 4);
        s.Write(all, 0, all.Length);
        s.Flush();
    }

    static bool Fill(Stream s, byte[] b)
    {
        int at = 0;
        while (at < b.Length)
        {
            int n = s.Read(b, at, b.Length - at);
            if (n <= 0) return false;
            at += n;
        }
        return true;
    }
}

static class PipeServer
{
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances,
        uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes sa);

    const uint Duplex = 3, Overlapped = 0x40000000, FirstInstance = 0x00080000, RejectRemote = 8;

    /// <summary>The access list names the current user only. Remote clients are refused. `first` fails if the name exists.</summary>
    public static NamedPipeServerStream Create(string name, bool first)
    {
        string sid = Access.Me().Value;
        var sd = new RawSecurityDescriptor("O:" + sid + "G:" + sid + "D:P(A;;FA;;;" + sid + ")");
        var bytes = new byte[sd.BinaryLength];
        sd.GetBinaryForm(bytes, 0);
        var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            var sa = new SecurityAttributes();
            sa.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            sa.Descriptor = pin.AddrOfPinnedObject();
            var h = CreateNamedPipeW(@"\\.\pipe\" + name, Duplex | Overlapped | (first ? FirstInstance : 0), RejectRemote,
                64, 65536, 65536, 0, ref sa);
            if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, h);
        }
        finally { pin.Free(); }
    }
}

sealed class Client
{
    public string Session;
    public NamedPipeServerStream Pipe;
    readonly BlockingCollection<string> queue = new BlockingCollection<string>(256);

    public void StartWriter()
    {
        var t = new Thread(delegate()
        {
            try { foreach (var m in queue.GetConsumingEnumerable()) Frame.Write(Pipe, m); } catch (Exception) { }
            Close();
        });
        t.IsBackground = true;
        t.Start();
    }

    /// <summary>A client that does not read is dropped instead of blocking the others.</summary>
    public void Send(string json) { try { if (!queue.TryAdd(json)) Close(); } catch (InvalidOperationException) { } }
    public void Finish() { try { queue.CompleteAdding(); } catch (ObjectDisposedException) { } }
    public void Close() { try { Pipe.Dispose(); } catch (Exception) { } }
}

sealed class Bridge
{
    const int PreAuthBytes = 8192, ToBrowser = 256 * 1024, FromBrowser = 64 * 1024 * 1024, AuthMs = 4500, MaxWaiting = 32;

    readonly Home home;
    readonly Stream input = Console.OpenStandardInput();
    readonly Stream output = Console.OpenStandardOutput();
    readonly object outLock = new object();
    readonly ConcurrentDictionary<string, Client> clients = new ConcurrentDictionary<string, Client>();
    byte[] key;
    int waiting;
    string profile, label, pipeName;

    public Bridge(Home h) { home = h; }

    public static string Json(params object[] kv)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        var s = new JavaScriptSerializer();
        s.MaxJsonLength = int.MaxValue;
        return s.Serialize(d);
    }

    public static object ParseAny(string json)
    {
        var s = new JavaScriptSerializer();
        s.MaxJsonLength = int.MaxValue;
        return s.DeserializeObject(json);
    }

    public static Dictionary<string, object> Parse(string json) { return ParseAny(json) as Dictionary<string, object>; }

    public static bool Flag(Dictionary<string, object> m, string name)
    {
        object v;
        return m != null && m.TryGetValue(name, out v) && v is bool && (bool)v;
    }

    public static string Str(Dictionary<string, object> m, string name)
    {
        object v;
        return m != null && m.TryGetValue(name, out v) ? v as string : null;
    }

    /// <summary>One plain line.</summary>
    static string Label(string s)
    {
        if (s == null) return "Firefox";
        var b = new StringBuilder();
        foreach (char c in s) if (!char.IsControl(c) && b.Length < 40) b.Append(c);
        return b.ToString();
    }

    public static int Int(Dictionary<string, object> m, string name)
    {
        object v;
        return m != null && m.TryGetValue(name, out v) && v is int ? (int)v : -1;
    }

    void ToFirefox(string json) { lock (outLock) Frame.Write(output, json); }

    int Fatal(string code, string message, int exit)
    {
        Console.Error.WriteLine(code + ": " + message);
        try { ToFirefox(Json("type", "fatal", "code", code, "message", message)); } catch (IOException) { }
        return exit;
    }

    void WriteState(string state)
    {
        try
        {
            string json = Json("state", state, "pid", Process.GetCurrentProcess().Id, "at", DateTime.UtcNow.ToString("o"),
                "host", Program.Version, "protocol", Program.Protocol, "id", profile, "label", label, "pipe", pipeName);
            File.WriteAllText(home.State, json);
            if (profile == null) return;
            Directory.CreateDirectory(home.Profiles); // inherits the access list of the home folder
            File.WriteAllText(Path.Combine(home.Profiles, profile + ".json"), json);
        }
        catch (Exception e) { Console.Error.WriteLine("state: " + e.Message); }
    }

    public int Run()
    {
        try
        {
            string problem = home.AccessProblem();
            if (problem != null) return Fatal("unsafe_permissions", problem, 3);
            key = File.ReadAllBytes(home.Key);
            if (key.Length != 32) return Fatal("bad_key", "The key file does not hold 32 bytes.", 3);
            pipeName = home.PipeName();
        }
        catch (Exception e) { return Fatal("not_installed", e.Message, 3); }

        var hello = Parse(Frame.Read(input, FromBrowser) ?? "{}");
        if (Str(hello, "type") != "hello") return Fatal("bad_hello", "The first message was not a hello.", 2);
        // Each Firefox profile has a pipe of its own, so that two profiles never share one.
        profile = Str(hello, "profile");
        if (profile != null && !System.Text.RegularExpressions.Regex.IsMatch(profile, @"\A[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\z")) return Fatal("bad_hello", "The profile ID is not valid.", 2);
        label = Label(Str(hello, "label"));
        if (profile != null) pipeName += "-" + profile.Replace("-", "").Substring(0, 16);
        if (Int(hello, "protocol") != Program.Protocol)
        {
            ToFirefox(Json("type", "hello", "protocol", Program.Protocol, "host", Program.Version));
            WriteState("version_mismatch");
            return 5;
        }

        NamedPipeServerStream first;
        try { first = PipeServer.Create(pipeName, true); }
        catch (Win32Exception e) { return Fatal("pipe_in_use", "The pipe name is taken: " + e.Message, 4); }

        Runs.Clean(home);
        var runs = new Runs(home, profile, delegate(object[] kv) { ToFirefox(Json(kv)); });
        WriteState("running");
        ToFirefox(Json("type", "hello", "protocol", Program.Protocol, "host", Program.Version));
        var accept = new Thread(delegate() { Accept(pipeName, first); });
        accept.IsBackground = true;
        accept.Start();

        string end = "firefox_closed";
        try
        {
            string line;
            while ((line = Frame.Read(input, FromBrowser)) != null)
            {
                var m = Parse(line);
                string type = Str(m, "type");
                if (type == "to_client")
                {
                    Client c;
                    if (clients.TryGetValue(Str(m, "session") ?? "", out c)) c.Send(Str(m, "body") ?? "{}");
                }
                else if (type == "close_session")
                {
                    Client c;
                    if (clients.TryGetValue(Str(m, "session") ?? "", out c)) c.Finish(); // the writer sends what is queued, then closes
                }
                else if (type == "chat_run") runs.Start(m);
                else if (type == "file_stat" || type == "file_read" || type == "folder_check")
                    ToFirefox(Json("type", "reply", "id", Str(m, "id"), "result", Files.Answer(type, m, home)));
                else if (type == "label") { label = Label(Str(m, "label")); WriteState("running"); }
                else if (type == "chat_stop") runs.Stop(Str(m, "run"));
                else if (type == "claude_info") runs.Info(Str(m, "id"));
                else if (type == "skill_write") ToFirefox(Json("type", "reply", "id", Str(m, "id"), "result", Skill.Write(m)));
                else if (type == "bye") { end = "disconnected_by_user"; break; }
                else Console.Error.WriteLine("refused message of type " + (type ?? "?"));
            }
        }
        catch (Exception e) { Console.Error.WriteLine("stdin: " + e.Message); }

        runs.StopAll();
        WriteState(end);
        foreach (var c in clients.Values) c.Close();
        return 0;
    }

    void Accept(string name, NamedPipeServerStream pipe)
    {
        while (true)
        {
            try
            {
                pipe.WaitForConnection();
                var connected = pipe;
                // The next instance exists before this one is served, so the name is never free.
                pipe = PipeServer.Create(name, false);
                if (Interlocked.Increment(ref waiting) > MaxWaiting) { Interlocked.Decrement(ref waiting); connected.Dispose(); continue; }
                var t = new Thread(delegate() { Serve(connected); });
                t.IsBackground = true;
                t.Start();
            }
            catch (Exception e)
            {
                // Out of instances or a client that left while connecting: keep the name and try again.
                Console.Error.WriteLine("accept: " + e.Message);
                Thread.Sleep(50);
                if (!pipe.IsConnected)
                {
                    try { var next = PipeServer.Create(name, false); pipe.Dispose(); pipe = next; } catch (Exception) { }
                }
            }
        }
    }

    void Serve(NamedPipeServerStream pipe)
    {
        var c = new Client();
        c.Pipe = pipe;
        bool counted = true;
        try
        {
            using (var timer = new Timer(delegate { c.Close(); }, null, AuthMs, Timeout.Infinite))
            {
                string hostNonce = Crypto.Nonce(32);
                Frame.Write(pipe, Json("type", "challenge", "nonce", hostNonce));
                var m = Parse(Frame.Read(pipe, PreAuthBytes) ?? "{}");
                string clientNonce = Str(m, "nonce");
                int protocol = Int(m, "protocol");
                // Nothing but the challenge is told before this check passes.
                if (Str(m, "type") != "auth" || !Crypto.IsHex(clientNonce, 64) ||
                    !Crypto.Same(Str(m, "mac"), Crypto.Mac(key, "client", protocol, hostNonce, clientNonce))) return;
                Frame.Write(pipe, Json("type", "auth_ok", "protocol", Program.Protocol,
                    "mac", Crypto.Mac(key, "host", Program.Protocol, hostNonce, clientNonce)));
                if (protocol != Program.Protocol) { Frame.Read(pipe, PreAuthBytes); return; }
                timer.Change(Timeout.Infinite, Timeout.Infinite);
            }
            Interlocked.Decrement(ref waiting);
            counted = false;

            c.Session = Crypto.Nonce(8); // the client never chooses or reuses an ID
            clients[c.Session] = c;
            c.StartWriter();
            ToFirefox(Json("type", "session_open", "session", c.Session));
            string body;
            while ((body = Frame.Read(pipe, ToBrowser)) != null)
                ToFirefox(Json("type", "from_client", "session", c.Session, "body", body));
        }
        catch (Exception e) { if (c.Session != null) Console.Error.WriteLine("session: " + e.Message); }
        finally
        {
            if (counted) Interlocked.Decrement(ref waiting);
            c.Finish();
            c.Close();
            Client gone;
            if (c.Session != null && clients.TryRemove(c.Session, out gone))
            {
                try { ToFirefox(Json("type", "session_close", "session", c.Session)); } catch (Exception) { }
            }
        }
    }
}
