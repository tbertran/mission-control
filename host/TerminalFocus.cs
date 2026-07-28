using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

internal static class TerminalFocus
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    const int SW_RESTORE = 9;
    const string WtClass = "CASCADIA_HOSTING_WINDOW_CLASS";

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

    public static bool FocusByCwd(string cwd)
    {
        _profileMap ??= LoadProfileMap();
        if (string.IsNullOrEmpty(cwd)) return false;
        if (!_profileMap.TryGetValue(Normalize(cwd), out var tabTitles)) return false;
        foreach (var title in tabTitles)
            if (FocusTabByTitle(title)) return true;
        return false;
    }

    static bool FocusTabByTitle(string title)
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
                if (!name.StartsWith(title, StringComparison.OrdinalIgnoreCase)) continue;

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
}
