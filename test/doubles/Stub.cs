// TEST DOUBLE. Compiled to claude.exe by the tests: runs claude.mjs next to it with the same arguments and streams.
using System;
using System.Diagnostics;
using System.IO;

static class Stub
{
    static int Main(string[] args)
    {
        string line = Environment.CommandLine;
        int at = line[0] == '"' ? line.IndexOf('"', 1) + 1 : line.IndexOf(' ');
        string rest = at > 0 && at < line.Length ? line.Substring(at) : "";
        var info = new ProcessStartInfo("node.exe", "\"" + Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "claude.mjs") + "\"" + rest);
        info.UseShellExecute = false;
        using (var p = Process.Start(info))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
