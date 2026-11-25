// Posts mouse messages to one window of one Firefox. It is started by input.mjs for a single click, and refuses unless exactly
// one window of that Firefox fits. Nothing goes to another program, the pointer of the user does not move, and no key is sent.
// C# 5, so that the compiler that ships with Windows builds it.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Input
{
    delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint Size, Usage, Id; public IntPtr Heap; public uint Module, Threads, Parent; public int Priority; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string File;
    }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref Point p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint kind);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput i);
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref ProcessEntry e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref ProcessEntry e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    const uint Move = 0x200, Down = 0x201, Up = 0x202, DoubleClick = 0x203;
    const int IdleMs = 700, WaitMs = 8000;

    static int Refuse(string why)
    {
        Console.Out.Write("refused: " + why);
        return 1;
    }

    static int Main(string[] a)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        int helper, x, y, count;
        if (a.Length != 4 || !int.TryParse(a[0], out helper) || !int.TryParse(a[1], out x) || !int.TryParse(a[2], out y) || !int.TryParse(a[3], out count) || count < 1 || count > 2)
            return Refuse("wrong arguments");
        // The title comes over the input, not in the command line, which every program of this user can read.
        string title = Console.In.ReadToEnd();
        SetProcessDpiAwarenessContext(new IntPtr(-4)); // real pixels on every screen
        uint firefox = Parent((uint)helper, "firefox.exe");
        if (firefox == 0) return Refuse("the Firefox of this profile was not found");

        var fit = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != firefox || !IsWindowVisible(h)) return true;
            var cls = new StringBuilder(64);
            var text = new StringBuilder(1024);
            GetClassName(h, cls, 64);
            GetWindowText(h, text, 1024);
            if (cls.ToString() == "MozillaWindowClass" && title.Length > 0 && text.ToString() == title) fit.Add(h);
            return true;
        }, IntPtr.Zero);
        if (fit.Count != 1) return Refuse(fit.Count == 0 ? "no window of that Firefox has this title" : "several windows have this title");
        IntPtr win = fit[0];

        // The user presses Allow in the sidebar right before this, so it waits until hand and keyboard rest.
        var clock = Stopwatch.StartNew();
        while (Idle() < IdleMs)
        {
            if (clock.ElapsedMilliseconds > WaitMs) return Refuse("the user is using mouse or keyboard");
            Thread.Sleep(50);
        }
        if (IsIconic(win) || !IsWindowEnabled(win)) return Refuse("the window is minimized or blocked by a dialog");
        Rect r;
        GetWindowRect(win, out r);
        if (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom) return Refuse("the point is outside the window");
        var at = new Point { X = x, Y = y };
        if (GetAncestor(WindowFromPoint(at), 2) != win) return Refuse("another window covers the point");
        if (!ScreenToClient(win, ref at)) return Refuse("the point is not in the window");
        IntPtr l = new IntPtr((at.Y << 16) | (at.X & 0xFFFF));
        if (!PostMessage(win, Move, IntPtr.Zero, l)) return Refuse("Windows did not take the message");
        Thread.Sleep(40);
        for (int n = 1; n <= count; n++)
        {
            PostMessage(win, n == 1 ? Down : DoubleClick, new IntPtr(1), l);
            Thread.Sleep(40);
            PostMessage(win, Up, IntPtr.Zero, l);
            Thread.Sleep(40);
        }
        Console.Out.Write("sent");
        return 0;
    }

    static uint Idle()
    {
        var i = new LastInput();
        i.Size = (uint)Marshal.SizeOf(typeof(LastInput));
        return GetLastInputInfo(ref i) ? unchecked((uint)Environment.TickCount - i.Time) : 0;
    }

    /// <summary>The parent of a process, if it is the program named.</summary>
    static uint Parent(uint pid, string name)
    {
        IntPtr s = CreateToolhelp32Snapshot(2, 0);
        try
        {
            var all = new Dictionary<uint, ProcessEntry>();
            var e = new ProcessEntry();
            e.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            for (bool ok = Process32FirstW(s, ref e); ok; ok = Process32NextW(s, ref e)) all[e.Id] = e;
            ProcessEntry mine, parent;
            return all.TryGetValue(pid, out mine) && all.TryGetValue(mine.Parent, out parent) && string.Equals(parent.File, name, StringComparison.OrdinalIgnoreCase) ? parent.Id : 0;
        }
        finally { CloseHandle(s); }
    }
}
