using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

internal static class TerminalFocus
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    const int SW_RESTORE = 9;
    const string WtClass = "CASCADIA_HOSTING_WINDOW_CLASS";
    const string VsCodeClass = "Chrome_WidgetWin_1";

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    // Must bind the W exports: the ANSI ones fill szExeFile with ANSI bytes, which the
    // CharSet.Unicode struct then decodes into mojibake that matches no process name.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr hObject);
    const uint TH32CS_SNAPPROCESS = 0x2;

    static Dictionary<string, List<string>>? _profileMap;

    static string Normalize(string dir) => dir.TrimEnd('\\', '/').ToLowerInvariant();

    static Dictionary<string, List<string>> LoadProfileMap()
    {
        var map = new Dictionary<string, List<string>>();
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "Windows Terminal", "settings.json"),
        };
        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                if (!doc.RootElement.TryGetProperty("profiles", out var profiles)) continue;
                if (!profiles.TryGetProperty("list", out var list)) continue;
                foreach (var p in list.EnumerateArray())
                {
                    var name = p.TryGetProperty("name", out var n) ? n.GetString() : null;
                    var dir = p.TryGetProperty("startingDirectory", out var d) ? d.GetString() : null;
                    if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(dir)) continue;
                    var key = Normalize(dir);
                    if (!map.TryGetValue(key, out var names)) map[key] = names = new List<string>();
                    if (!names.Contains(name)) names.Add(name);
                }
            }
            catch
            {
            }
        }
        return map;
    }

    static string Basename(string dir) => Normalize(dir).Split('\\', '/').LastOrDefault(s => s.Length > 0) ?? dir;

    enum Host { Unknown, Terminal, VsCode }

    public static void Log(string line)
    {
        try
        {
            var p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MissionControl", "focus.log");
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.AppendAllText(p, $"{DateTime.Now:HH:mm:ss.fff} {line}\n");
        }
        catch
        {
        }
    }

    // Folder-name matching can't tell apart two same-clone sessions in different
    // hosts, so walk claude.exe's parent chain to see which app actually spawned it.
    public static void FocusSessionByCwd(int ownerPid, string cwd)
    {
        if (string.IsNullOrEmpty(cwd)) return;
        var host = DetectHost(ownerPid);
        Log($"focus ownerPid={ownerPid} cwd={cwd} host={host} chain={DescribeChain(ownerPid)}");
        switch (host)
        {
            case Host.Terminal: FocusByCwd(cwd); return;
            case Host.VsCode: FocusVsCodeByCwd(cwd); return;
            default:
                FocusByCwd(cwd);
                FocusVsCodeByCwd(cwd);
                return;
        }
    }

    static bool TryReadProcessTable(out Dictionary<uint, uint> parentOf, out Dictionary<uint, string> nameOf)
    {
        parentOf = new Dictionary<uint, uint>();
        nameOf = new Dictionary<uint, string>();
        var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return false;
        try
        {
            var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
            if (!Process32First(snapshot, ref entry)) return false;
            do
            {
                parentOf[entry.th32ProcessID] = entry.th32ParentProcessID;
                nameOf[entry.th32ProcessID] = entry.szExeFile;
            } while (Process32Next(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return nameOf.Count > 0;
    }

    static IEnumerable<string> WalkChain(int ownerPid)
    {
        if (ownerPid <= 0) yield break;
        if (!TryReadProcessTable(out var parentOf, out var nameOf)) yield break;
        var pid = (uint)ownerPid;
        for (var hops = 0; hops < 32 && nameOf.ContainsKey(pid); hops++)
        {
            yield return nameOf[pid];
            if (!parentOf.TryGetValue(pid, out var parent) || parent == pid) break;
            pid = parent;
        }
    }

    static string DescribeChain(int ownerPid) => string.Join(" <- ", WalkChain(ownerPid));

    static Host DetectHost(int ownerPid)
    {
        foreach (var name in WalkChain(ownerPid))
        {
            if (name.Equals("WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("OpenConsole.exe", StringComparison.OrdinalIgnoreCase))
                return Host.Terminal;
            if (name.Equals("Code.exe", StringComparison.OrdinalIgnoreCase))
                return Host.VsCode;
        }
        return Host.Unknown;
    }

    public static bool FocusByCwd(string cwd)
    {
        _profileMap ??= LoadProfileMap();
        if (string.IsNullOrEmpty(cwd)) return false;

        if (_profileMap.TryGetValue(Normalize(cwd), out var tabTitles))
            foreach (var title in tabTitles)
                if (FocusTabByPredicate(name => name.StartsWith(title, StringComparison.OrdinalIgnoreCase))) return true;

        // Most tabs aren't opened via a per-directory profile (e.g. `wt -d`, or a
        // generic profile followed by `cd`), so fall back to a looser title match.
        var basename = Basename(cwd);
        if (string.IsNullOrEmpty(basename)) return false;
        return FocusTabByPredicate(name => name.IndexOf(basename, StringComparison.OrdinalIgnoreCase) >= 0);
    }

    static bool FocusTabByPredicate(Func<string, bool> matches)
    {
        var wtWindows = new List<IntPtr>();
        EnumWindows((hWnd, _) =>
        {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, sb.Capacity);
            if (sb.ToString() == WtClass && IsWindowVisible(hWnd)) wtWindows.Add(hWnd);
            return true;
        }, IntPtr.Zero);

        var tabCondition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem);

        foreach (var hWnd in wtWindows)
        {
            AutomationElement? root;
            try { root = AutomationElement.FromHandle(hWnd); }
            catch { continue; }
            if (root == null) continue;

            AutomationElementCollection tabs;
            try { tabs = root.FindAll(TreeScope.Descendants, tabCondition); }
            catch { continue; }

            foreach (AutomationElement tab in tabs)
            {
                string name;
                try { name = tab.Current.Name; }
                catch { continue; }
                if (!matches(name)) continue;

                if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
                SetForegroundWindow(hWnd);
                if (tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var patternObj) &&
                    patternObj is SelectionItemPattern sip)
                    sip.Select();
                return true;
            }
        }
        return false;
    }

    // The folder VS Code has open may be an ancestor of the session's cwd (e.g. the
    // repo root while the session runs in a subfolder), so this tries the cwd's own
    // name first, then up to two parent folder names.
    static bool FocusVsCodeByCwd(string cwd)
    {
        if (string.IsNullOrEmpty(cwd)) return false;
        var segments = Normalize(cwd).Split('\\', '/').Where(s => s.Length > 0).Reverse().Take(3).ToList();
        if (segments.Count == 0) return false;

        var codeWindows = new List<(IntPtr hWnd, string title)>();
        EnumWindows((hWnd, _) =>
        {
            var cls = new StringBuilder(256);
            GetClassName(hWnd, cls, cls.Capacity);
            if (cls.ToString() != VsCodeClass || !IsWindowVisible(hWnd)) return true;

            GetWindowThreadProcessId(hWnd, out var pid);
            try
            {
                using var proc = Process.GetProcessById((int)pid);
                if (!proc.ProcessName.Equals("Code", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch { return true; }

            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, sb.Capacity);
            var title = sb.ToString();
            if (title.EndsWith("Visual Studio Code", StringComparison.OrdinalIgnoreCase)) codeWindows.Add((hWnd, title));
            return true;
        }, IntPtr.Zero);

        foreach (var segment in segments)
        {
            var match = codeWindows.FirstOrDefault(w => w.title.IndexOf(segment, StringComparison.OrdinalIgnoreCase) >= 0);
            if (match.hWnd == IntPtr.Zero) continue;
            if (IsIconic(match.hWnd)) ShowWindow(match.hWnd, SW_RESTORE);
            SetForegroundWindow(match.hWnd);
            return true;
        }
        return false;
    }
}
