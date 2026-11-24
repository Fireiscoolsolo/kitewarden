// Files for uploads. Only plain files inside folders that the user listed in the sidebar. A path is resolved by opening it,
// so that links, junctions and ".." end at the real file, and every read opens and checks it again.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

static class Files
{
    const int MaxFiles = 101, MaxChunk = 512 * 1024;

    [StructLayout(LayoutKind.Sequential)]
    struct Info
    {
        public uint Attributes; public uint C1, C2, A1, A2; public uint W1, W2;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder path, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);

    static readonly Regex Secret = new Regex(@"^(\.|id_(rsa|dsa|ecdsa|ed25519)|credentials|secrets?\b|logins\.json|key[34]\.db|cookies\.sqlite|cert9\.db|ntuser)|\.(pem|key|pfx|p12|ppk|kdbx?|jks|keystore|ovpn|rdp|gpg|asc)$|^\.?env(\.|$)", RegexOptions.IgnoreCase);

    sealed class Refused : Exception
    {
        public readonly string Code;
        public Refused(string code, string message) : base(message) { Code = code; }
    }

    static Dictionary<string, object> Map(params object[] kv)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    public static Dictionary<string, object> Answer(string type, Dictionary<string, object> m, Home home)
    {
        try
        {
            if (type == "folder_check") return Map("path", Folder(Bridge.Str(m, "path"), home));
            var folders = new List<string>();
            foreach (var f in List(m, "folders")) folders.Add(Folder(f, home));
            return type == "file_read" ? Read(m, folders) : Stat(m, folders);
        }
        catch (Refused e) { return Map("code", e.Code, "message", e.Message); }
        catch (Exception e) { return Map("code", "path_not_allowed", "message", e is UnauthorizedAccessException ? "Windows does not allow reading it." : e.Message); }
    }

    static List<string> List(Dictionary<string, object> m, string name)
    {
        object v;
        var list = new List<string>();
        if (m.TryGetValue(name, out v) && v is object[]) foreach (var x in (object[])v) if (x is string) list.Add((string)x);
        return list;
    }

    /// <summary>A path on a local drive, as it was written. Device names, streams, shares and relative paths are refused.</summary>
    static string Plain(string path)
    {
        if (path == null || !Regex.IsMatch(path, @"\A[A-Za-z]:\\[^:*?""<>|\x00-\x1f]*\z")) throw new Refused("path_not_allowed", "Only full paths on a local drive are allowed.");
        return Path.GetFullPath(path);
    }

    static SafeFileHandle Open(string path, bool folder)
    {
        var h = CreateFileW(@"\\?\" + path, folder ? 0x80u : 0x80000000u, 3, IntPtr.Zero, 3, folder ? 0x02000000u : 0u, IntPtr.Zero);
        if (h.IsInvalid) throw new Refused("path_not_allowed", "It does not exist, or Windows does not allow reading it: " + path);
        return h;
    }

    static string Final(SafeFileHandle h)
    {
        var s = new StringBuilder(4096);
        uint n = GetFinalPathNameByHandleW(h, s, 4096, 0);
        if (n == 0 || n >= 4096) throw new Refused("path_not_allowed", "The path could not be resolved.");
        string p = s.ToString();
        if (!p.StartsWith(@"\\?\") || p.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw new Refused("path_not_allowed", "Network paths are not allowed.");
        return p.Substring(4);
    }

    static bool Inside(string path, string folder)
    {
        return path.StartsWith(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>A folder that may be listed: not a drive, not the profile of the user, not a folder of this program or of Firefox.</summary>
    static string Folder(string path, Home home)
    {
        string real;
        using (var h = Open(Plain(path), true)) real = Final(h).TrimEnd('\\');
        if (!Directory.Exists(real)) throw new Refused("path_not_allowed", "That is not a folder.");
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string[] never = { home.Dir, Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Path.Combine(user, ".claude"), Path.Combine(user, ".ssh") };
        string temp = Path.GetTempPath().TrimEnd('\\');
        foreach (var n in never)
        {
            // A folder above a closed one would open it as well. The temporary folder is the user's to share.
            if (Inside(n, real) || string.Equals(n, real, StringComparison.OrdinalIgnoreCase) || (Inside(real, n) && !Inside(real, temp)))
                throw new Refused("path_not_allowed", real + " holds settings or keys, or is above such a folder. Choose a folder of its own.");
            if (n == home.Dir && Inside(real, n)) throw new Refused("path_not_allowed", "That folder belongs to the helper.");
        }
        if (real.Length < 4) throw new Refused("path_not_allowed", "A whole drive cannot be listed.");
        return real;
    }

    /// <summary>Opens a file and says where it really is, or refuses it.</summary>
    static FileStream Allowed(string path, List<string> folders, out string real, out string stamp)
    {
        var h = Open(Plain(path), false);
        try
        {
            real = Final(h);
            Info i;
            if (!GetFileInformationByHandle(h, out i)) throw new Refused("path_not_allowed", "The file could not be checked.");
            string folder = null;
            foreach (var f in folders) if (Inside(real, f)) folder = f;
            if (folder == null) throw new Refused("path_not_allowed", "The file is not in a folder that the user listed.");
            if ((i.Attributes & (uint)(FileAttributes.Directory | FileAttributes.Hidden | FileAttributes.System | FileAttributes.Device | FileAttributes.ReparsePoint)) != 0)
                throw new Refused("path_not_allowed", "Hidden files, system files, links and folders are not uploaded.");
            if (i.Links > 1) throw new Refused("path_not_allowed", "A file with a second name elsewhere is not uploaded.");
            foreach (var part in real.Substring(folder.Length + 1).Split('\\'))
                if (Secret.IsMatch(part)) throw new Refused("path_not_allowed", "Files that look like keys or credentials are not uploaded: " + part);
            stamp = i.Volume + ":" + i.IndexHigh + ":" + i.IndexLow + ":" + i.W1 + ":" + i.W2 + ":" + i.SizeLow;
            return new FileStream(h, FileAccess.Read);
        }
        catch (Exception) { h.Dispose(); throw; }
    }

    static Dictionary<string, object> One(string path, List<string> folders, string relative)
    {
        string real, stamp;
        using (var f = Allowed(path, folders, out real, out stamp))
            return Map("path", real, "name", Path.GetFileName(real), "size", f.Length, "stamp", stamp, "relative", relative);
    }

    static Dictionary<string, object> Stat(Dictionary<string, object> m, List<string> folders)
    {
        var files = new List<object>();
        var paths = List(m, "paths");
        if (!Bridge.Flag(m, "folder")) { foreach (var p in paths) files.Add(One(p, folders, null)); return Map("files", files); }
        string root;
        using (var h = Open(Plain(paths[0]), true)) root = Final(h).TrimEnd('\\');
        bool ok = false;
        foreach (var f in folders) if (string.Equals(root, f, StringComparison.OrdinalIgnoreCase) || Inside(root, f)) ok = true;
        if (!ok || !Directory.Exists(root)) throw new Refused("path_not_allowed", "The folder is not in a folder that the user listed.");
        Walk(root, Path.GetFileName(root), folders, files);
        return Map("files", files);
    }

    /// <summary>Links are not followed. A file that may not go refuses the whole folder, so that nothing is left out in silence.</summary>
    static void Walk(string dir, string relative, List<string> folders, List<object> files)
    {
        foreach (var e in new DirectoryInfo(dir).GetFileSystemInfos())
        {
            if (files.Count >= MaxFiles) return; // the add-on refuses more than it takes
            if ((e.Attributes & FileAttributes.ReparsePoint) != 0) throw new Refused("path_not_allowed", "The folder holds a link: " + e.Name);
            if (e is DirectoryInfo) Walk(e.FullName, relative + "/" + e.Name, folders, files);
            else files.Add(One(e.FullName, folders, relative + "/" + e.Name));
        }
    }

    static Dictionary<string, object> Read(Dictionary<string, object> m, List<string> folders)
    {
        string real, stamp;
        using (var f = Allowed(Bridge.Str(m, "path"), folders, out real, out stamp))
        {
            if (stamp != Bridge.Str(m, "stamp")) throw new Refused("path_not_allowed", "The file changed after the approval.");
            int offset = Bridge.Int(m, "offset"), count = Bridge.Int(m, "count");
            if (offset < 0 || count < 0 || count > MaxChunk) throw new Refused("invalid_argument", "The part is not valid.");
            f.Seek(offset, SeekOrigin.Begin);
            var buf = new byte[count];
            int n = 0, got;
            while (n < count && (got = f.Read(buf, n, count - n)) > 0) n += got;
            return Map("data", Convert.ToBase64String(buf, 0, n));
        }
    }
}
