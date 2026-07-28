using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Wpf;
using WinForms = System.Windows.Forms;
using Drawing = System.Drawing;
using Drawing2D = System.Drawing.Drawing2D;

internal static class Program
{
    const int Port = 4174;
    static readonly string PanelUrl = $"http://127.0.0.1:{Port}/panel";
    static readonly string UsagePanelUrl = $"http://127.0.0.1:{Port}/usage-panel";
    static readonly string UsageDashboardUrl = $"http://127.0.0.1:{Port}/usage";
    static string Root = "";
    static Window _win = null!;
    static WebView2 _web = null!;
    static WinForms.NotifyIcon _tray = null!;
    static WinForms.ToolStripMenuItem _topmostItem = null!;
    static WinForms.ToolStripMenuItem _viewItem = null!;
    enum PanelView { Sessions, Usage }
    static PanelView _panelView = PanelView.Sessions;
    static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
    static DispatcherTimer? _iconTimer;
    static DispatcherTimer? _saveTimer;
    static IntPtr _lastIcon = IntPtr.Zero;
    static Process? _serverProc;
    static Settings _settings = new();

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyIcon(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_POWER_THROTTLING_STATE
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    const uint PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
    const uint PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
    const int ProcessPowerThrottling = 4;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessInformation(IntPtr hProcess, int processInformationClass, ref PROCESS_POWER_THROTTLING_STATE processInformation, uint processInformationSize);

    [STAThread]
    static void Main()
    {
        // Windows 11's Efficiency Mode (EcoQoS) throttles background apps without a
        // taskbar presence after a period of inactivity — this app is exactly that
        // shape (ShowInTaskbar=false), and throttling can delay/drop tray-icon input
        // processing without the process ever showing as "not responding". Opting
        // out here is the standard fix, same as apps like Slack/Discord apply.
        var throttleState = new PROCESS_POWER_THROTTLING_STATE
        {
            Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask = 0,
        };
        var throttleOk = SetProcessInformation(Process.GetCurrentProcess().Handle, ProcessPowerThrottling, ref throttleState, (uint)Marshal.SizeOf(throttleState));
        var throttleErr = Marshal.GetLastWin32Error();
        try
        {
            var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MissionControl", "crash.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            File.AppendAllText(logPath, $"{DateTime.Now:O} SetProcessInformation(PowerThrottling) ok={throttleOk} win32Error={throttleErr}\n");
        }
        catch
        {
        }

        Root = FindRoot();
        _settings = Settings.Load();
        EnsureServer();

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.DispatcherUnhandledException += (_, e) =>
        {
            try
            {
                var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MissionControl", "crash.log");
                Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
                File.AppendAllText(logPath, $"{DateTime.Now:O}\n{e.Exception}\n\n");
            }
            catch
            {
            }
            e.Handled = true;
        };
        BuildWindow();
        BuildTray();
        _win.Show();
        app.Run();
    }

    static System.Windows.Controls.TextBlock _hdrCount = null!;
    static System.Windows.Controls.TextBlock _hdrAspire = null!;
    static System.Windows.Controls.Border _flashBorder = null!;
    const double HeaderHeight = 52;
    const double GripHeight = 8;
    const double MinHeight = 150;

    static void BuildWindow()
    {
        _web = new WebView2();

        // WebView2 is a windowed (HWND) control: it always wins hit-testing over a
        // sibling WPF element stacked on top of it, regardless of z-order ("airspace"
        // problem), so drag/resize only works from strips that don't overlap it.
        var header = new System.Windows.Controls.Border
        {
            Height = HeaderHeight,
            Background = new System.Windows.Media.LinearGradientBrush(
                System.Windows.Media.Color.FromRgb(0x14, 0x1b, 0x26),
                System.Windows.Media.Color.FromRgb(0x0f, 0x14, 0x1c), 90),
            BorderBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x1e, 0x27, 0x33)),
            BorderThickness = new Thickness(0, 0, 0, 1),
            Cursor = System.Windows.Input.Cursors.SizeAll,
        };
        var headerStack = new System.Windows.Controls.StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Vertical,
            Margin = new Thickness(10, 0, 10, 0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        var headerRow = new System.Windows.Controls.StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal };
        var title = new System.Windows.Controls.TextBlock
        {
            Text = "MISSION CONTROL",
            Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xd6, 0xe0, 0xea)),
            FontWeight = FontWeights.Bold,
            FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
        };
        _hdrCount = new System.Windows.Controls.TextBlock
        {
            Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x6b, 0x7d, 0x8f)),
            FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(8, 0, 0, 0),
        };
        headerRow.Children.Add(title);
        headerRow.Children.Add(_hdrCount);
        _hdrAspire = new System.Windows.Controls.TextBlock
        {
            FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"),
            FontSize = 11,
            Margin = new Thickness(0, 2, 0, 0),
        };
        headerStack.Children.Add(headerRow);
        headerStack.Children.Add(_hdrAspire);
        header.Child = headerStack;
        header.MouseLeftButtonDown += (_, __) =>
        {
            try { _win.DragMove(); } catch { }
            QueueSaveSettings();
        };

        var grip = new System.Windows.Controls.Border
        {
            Height = GripHeight,
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x14, 0x1b, 0x26)),
            Cursor = System.Windows.Input.Cursors.SizeNS,
        };
        var gripDot = new System.Windows.Controls.Border
        {
            Width = 32,
            Height = 3,
            CornerRadius = new CornerRadius(2),
            Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x35, 0x42, 0x54)),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        grip.Child = gripDot;

        var dock = new System.Windows.Controls.DockPanel();
        System.Windows.Controls.DockPanel.SetDock(header, System.Windows.Controls.Dock.Top);
        System.Windows.Controls.DockPanel.SetDock(grip, System.Windows.Controls.Dock.Bottom);
        dock.Children.Add(header);
        dock.Children.Add(grip);
        dock.Children.Add(_web);

        var wa = SystemParameters.WorkArea;
        const double margin = 8;
        const double width = 380;
        var height = MinHeight;
        var defaultLeft = wa.Right - width - 16;
        var defaultTop = wa.Top + margin;
        var left = _settings.Left ?? defaultLeft;
        var top = _settings.Top ?? defaultTop;
        if (left + width < SystemParameters.VirtualScreenLeft || left > SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth ||
            top + height < SystemParameters.VirtualScreenTop || top > SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight)
        {
            left = defaultLeft;
            top = defaultTop;
        }
        _flashBorder = new System.Windows.Controls.Border
        {
            BorderThickness = new Thickness(4),
            BorderBrush = System.Windows.Media.Brushes.Transparent,
            Child = dock,
        };
        _win = new Window
        {
            Width = width,
            Height = height,
            MinWidth = width,
            MaxWidth = width,
            MinHeight = MinHeight,
            MaxHeight = wa.Height - 16,
            Left = left,
            Top = top,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.CanResize,
            Topmost = _settings.Topmost,
            ShowInTaskbar = false,
            ShowActivated = false,
            Title = "Mission Control",
            Content = _flashBorder,
        };
        System.Windows.Shell.WindowChrome.SetWindowChrome(_win, new System.Windows.Shell.WindowChrome
        {
            CaptionHeight = 0,
            ResizeBorderThickness = new Thickness(0, 0, 0, GripHeight),
            GlassFrameThickness = new Thickness(0),
            CornerRadius = new CornerRadius(0),
            UseAeroCaptionButtons = false,
        });
        _win.SourceInitialized += (_, __) =>
        {
            var hwnd = new System.Windows.Interop.WindowInteropHelper(_win).Handle;
            var preference = DWMWCP_ROUND;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));

            const int WM_EXITSIZEMOVE = 0x0232;
            var taskbarCreatedMsg = RegisterWindowMessage("TaskbarCreated");
            System.Windows.Interop.HwndSource.FromHwnd(hwnd)!.AddHook((IntPtr _, int msg, IntPtr __, IntPtr ___, ref bool handled) =>
            {
                if (msg == WM_EXITSIZEMOVE)
                {
                    _settings.Left = _win.Left;
                    _settings.Top = _win.Top;
                    _settings.Save();
                }
                // Explorer broadcasts this when the taskbar/tray reinitializes (display
                // changes, Explorer restarts) — NotifyIcon doesn't reliably re-register
                // itself on this, so a stale-but-present icon stops routing clicks.
                else if (msg == taskbarCreatedMsg)
                {
                    TrayLog("TaskbarCreated broadcast received");
                    _tray.Visible = false;
                    _tray.Visible = true;
                }
                return IntPtr.Zero;
            });
        };
        _win.Loaded += async (_, __) =>
        {
            await _web.EnsureCoreWebView2Async();
            var core = _web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.WebMessageReceived += (_, e) => OnMessage(e.TryGetWebMessageAsString());
            _web.Source = new Uri(PanelUrl);
        };
        _win.LocationChanged += (_, __) => QueueSaveSettings();
    }

    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWCP_ROUND = 2;

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern int RegisterWindowMessage(string lpString);

    static void OnMessage(string? msg)
    {
        if (string.IsNullOrEmpty(msg)) return;
        if (msg.StartsWith("focus:"))
        {
            var cwd = msg.Substring("focus:".Length);
            Task.Run(() => TerminalFocus.FocusByCwd(cwd));
        }
        else if (msg == "open-dashboard")
        {
            Process.Start(new ProcessStartInfo { FileName = UsageDashboardUrl, UseShellExecute = true });
        }
        else if (msg == "hide")
        {
            _win.Hide();
            _lastManualHideAt = DateTime.Now;
        }
        else if (msg.StartsWith("h:") && double.TryParse(msg.AsSpan(2), out var contentHeight))
        {
            var wa = SystemParameters.WorkArea;
            var target = Math.Max(MinHeight, Math.Min(wa.Height - 16, contentHeight + HeaderHeight + GripHeight + 4));
            _win.Height = target;
        }
    }

    static void QueueSaveSettings()
    {
        _saveTimer?.Stop();
        _saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        _saveTimer.Tick += (_, __) =>
        {
            _saveTimer!.Stop();
            _settings.Left = _win.Left;
            _settings.Top = _win.Top;
            _settings.Save();
        };
        _saveTimer.Start();
    }

    static readonly object _trayLogLock = new();
    static DateTime _lastMoveLog = DateTime.MinValue;

    static void TrayLog(string line)
    {
        try
        {
            var p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MissionControl", "tray.log");
            lock (_trayLogLock) File.AppendAllText(p, $"{DateTime.Now:HH:mm:ss.fff} {line}\n");
        }
        catch
        {
        }
    }

    static void WriteProbeInfo()
    {
        try
        {
            var t = typeof(WinForms.NotifyIcon);
            const System.Reflection.BindingFlags f = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
            var idField = t.GetField("_id", f) ?? t.GetField("id", f);
            var winField = t.GetField("_window", f) ?? t.GetField("window", f);
            var idValue = idField?.GetValue(_tray);
            var id = idValue == null ? -1L : Convert.ToInt64(idValue);
            var hwnd = (winField?.GetValue(_tray) as WinForms.NativeWindow)?.Handle ?? IntPtr.Zero;
            TrayLog($"icon registered hwnd=0x{hwnd.ToInt64():X} id={id}");
            var probePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MissionControl", "probe.json");
            File.WriteAllText(probePath, JsonSerializer.Serialize(new { hwnd = hwnd.ToInt64(), id, at = DateTime.Now.ToString("O") }));
        }
        catch (Exception ex)
        {
            TrayLog($"WriteProbeInfo failed: {ex.Message}");
        }
    }

    static void BuildTray()
    {
        var menu = new WinForms.ContextMenuStrip();
        menu.Items.Add("Show / hide", null, (_, __) => Toggle());
        menu.Items.Add("Open in browser", null, (_, __) => OpenBrowser());
        menu.Items.Add("Refresh", null, (_, __) => _web.CoreWebView2?.Reload());
        menu.Items.Add(new WinForms.ToolStripSeparator());

        _viewItem = new WinForms.ToolStripMenuItem("Switch to usage view");
        _viewItem.Click += (_, __) => SetView(_panelView == PanelView.Sessions ? PanelView.Usage : PanelView.Sessions);
        menu.Items.Add(_viewItem);
        menu.Items.Add(new WinForms.ToolStripSeparator());

        _topmostItem = new WinForms.ToolStripMenuItem("Always on top")
        {
            CheckOnClick = true,
            Checked = _settings.Topmost,
        };
        _topmostItem.CheckedChanged += (_, __) =>
        {
            _settings.Topmost = _topmostItem.Checked;
            _win.Topmost = _settings.Topmost;
            _settings.Save();
        };
        menu.Items.Add(_topmostItem);

        var autostart = new WinForms.ToolStripMenuItem("Start with Windows")
        {
            CheckOnClick = true,
            Checked = AutoStartEnabled(),
        };
        autostart.CheckedChanged += (_, __) => SetAutoStart(autostart.Checked);
        menu.Items.Add(autostart);
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("Quit", null, (_, __) => Quit());

        _trayMenu = menu;
        CreateTrayIcon();
        StartIconUpdates();

        // Win11 26200: Explorer stops forwarding tray callbacks to icons ~10 min after
        // NIM_ADD. Re-adding the SAME NotifyIcon resets routing; never create a new
        // instance — a new uID is a new identity and loses taskbar promotion.
        var reregisterTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(2) };
        reregisterTimer.Tick += (_, __) =>
        {
            TrayLog("re-register same identity");
            _tray.Visible = false;
            _tray.Visible = true;
        };
        reregisterTimer.Start();
        TrayLog($"BuildTray done, pid={Environment.ProcessId}");
    }

    static WinForms.ContextMenuStrip _trayMenu = null!;

    static void CreateTrayIcon()
    {
        var old = _tray;
        _tray = new WinForms.NotifyIcon
        {
            Text = "Mission Control",
            Visible = false,
            ContextMenuStrip = _trayMenu,
        };
        _tray.MouseMove += (_, __) =>
        {
            if ((DateTime.Now - _lastMoveLog).TotalMilliseconds < 750) return;
            _lastMoveLog = DateTime.Now;
            TrayLog("MouseMove");
        };
        _tray.MouseDown += (_, e) => TrayLog($"MouseDown {e.Button}");
        _tray.MouseUp += (_, e) => TrayLog($"MouseUp {e.Button}");
        _tray.MouseDoubleClick += (_, e) => TrayLog($"MouseDoubleClick {e.Button}");
        _tray.MouseClick += (_, e) =>
        {
            TrayLog($"MouseClick {e.Button}");
            if (e.Button == WinForms.MouseButtons.Left) Toggle();
        };
        if (_lastIconState.HasValue)
        {
            var (icon, handle) = BuildIcon(_lastIconState.Value);
            _tray.Icon = icon;
            _tray.Text = _lastIconState.Value switch
            {
                IconState.NeedsInput => "Mission Control — needs your input",
                IconState.Working => "Mission Control — sessions working",
                IconState.Idle => "Mission Control — all on station",
                _ => "Mission Control",
            };
            if (_lastIcon != IntPtr.Zero) DestroyIcon(_lastIcon);
            _lastIcon = handle;
        }
        _tray.Visible = true;
        WriteProbeInfo();
        if (old != null)
        {
            old.Visible = false;
            old.Dispose();
            TrayLog("old tray icon disposed");
        }
    }

    static DateTime _lastManualHideAt = DateTime.MinValue;

    static void Toggle()
    {
        TrayLog($"Toggle enter, IsVisible={_win.IsVisible}");
        if (_win.IsVisible)
        {
            _win.Hide();
            _lastManualHideAt = DateTime.Now;
        }
        else
        {
            _win.Show();
            _win.Topmost = true;
            _win.Activate();
            if (!_settings.Topmost)
            {
                var dropTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(300) };
                dropTimer.Tick += (_, __) =>
                {
                    dropTimer.Stop();
                    _win.Topmost = false;
                };
                dropTimer.Start();
            }
        }
        TrayLog($"Toggle exit, IsVisible={_win.IsVisible}");
    }

    static void OpenBrowser() =>
        Process.Start(new ProcessStartInfo { FileName = PanelUrl, UseShellExecute = true });

    static void SetView(PanelView view)
    {
        _panelView = view;
        _viewItem.Text = view == PanelView.Sessions ? "Switch to usage view" : "Switch to sessions view";
        _web.Source = new Uri(view == PanelView.Sessions ? PanelUrl : UsagePanelUrl);
    }

    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "MissionControl";

    static bool AutoStartEnabled()
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey);
        return k?.GetValue(RunName) != null;
    }

    static void SetAutoStart(bool on)
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey, true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
        if (on) k!.SetValue(RunName, $"\"{Environment.ProcessPath}\"");
        else k!.DeleteValue(RunName, false);
    }

    static void Quit()
    {
        _iconTimer?.Stop();
        _tray.Visible = false;
        _tray.Dispose();
        if (_lastIcon != IntPtr.Zero) DestroyIcon(_lastIcon);
        try
        {
            if (_serverProc is { HasExited: false }) _serverProc.Kill(true);
        }
        catch
        {
        }
        Application.Current.Shutdown();
    }

    static void StartIconUpdates()
    {
        SetIcon(IconState.None);
        _iconTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
        _iconTimer.Tick += async (_, __) =>
        {
            _iconTimer!.Interval = TimeSpan.FromSeconds(8);
            try { await UpdateIcon(); }
            catch (Exception ex)
            {
                try
                {
                    var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MissionControl", "crash.log");
                    Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
                    File.AppendAllText(logPath, $"{DateTime.Now:O} UpdateIcon\n{ex}\n\n");
                }
                catch
                {
                }
            }
        };
        _iconTimer.Start();
    }

    enum IconState { None, Idle, Working, NeedsInput }

    static readonly HashSet<string> _alertedSessions = new();

    static async Task UpdateIcon()
    {
        var (state, count, needsInputIds) = await FetchFleetState();
        SetIcon(state);
        _hdrCount.Text = count > 0 ? $"· {count} active" : "";

        if (needsInputIds.Any(id => !_alertedSessions.Contains(id))) TriggerNeedsInputAlert();
        _alertedSessions.Clear();
        _alertedSessions.UnionWith(needsInputIds);

        var aspireClone = DetectAspireClone();
        if (aspireClone != null)
        {
            _hdrAspire.Text = $"⚡ Aspire running — {aspireClone}";
            _hdrAspire.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x57, 0xd9, 0xa3));
        }
        else
        {
            _hdrAspire.Text = "⚡ Aspire not running";
            _hdrAspire.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x6b, 0x7d, 0x8f));
        }
    }

    static void TriggerNeedsInputAlert()
    {
        System.Media.SystemSounds.Exclamation.Play();

        var recentlyHiddenByUser = (DateTime.Now - _lastManualHideAt).TotalSeconds < 30;
        if (!_win.IsVisible && recentlyHiddenByUser) return;
        if (!_win.IsVisible) _win.Show();
        var wasTopmost = _win.Topmost;
        _win.Topmost = true;
        _win.Activate();
        if (!wasTopmost)
        {
            var restoreTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            restoreTimer.Tick += (_, __) =>
            {
                restoreTimer.Stop();
                _win.Topmost = _settings.Topmost;
            };
            restoreTimer.Start();
        }

        var magenta = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xff, 0x7e, 0xdb));
        var transparent = System.Windows.Media.Brushes.Transparent;
        var pulses = 6;
        var flashTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        var tick = 0;
        flashTimer.Tick += (_, __) =>
        {
            _flashBorder.BorderBrush = tick % 2 == 0 ? magenta : transparent;
            tick++;
            if (tick >= pulses)
            {
                flashTimer.Stop();
                _flashBorder.BorderBrush = transparent;
            }
        };
        flashTimer.Start();
    }

    static string? DetectAspireClone()
    {
        foreach (var p in Process.GetProcessesByName("Apollo.AppHost"))
        {
            try
            {
                var path = p.MainModule?.FileName;
                if (string.IsNullOrEmpty(path)) continue;
                const string marker = @"\src\Deployment\Apollo.AppHost\";
                var idx = path.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) continue;
                return Path.GetFileName(path[..idx]);
            }
            catch
            {
            }
            finally
            {
                p.Dispose();
            }
        }
        return null;
    }

    static async Task<(IconState, int, HashSet<string>)> FetchFleetState()
    {
        var needsInputIds = new HashSet<string>();
        try
        {
            var json = await _http.GetStringAsync($"http://127.0.0.1:{Port}/api/sessions");
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("sessions", out var sessions) || sessions.ValueKind != JsonValueKind.Array)
                return (IconState.None, 0, needsInputIds);
            var count = 0;
            var working = false;
            foreach (var s in sessions.EnumerateArray())
            {
                count++;
                var state = s.TryGetProperty("state", out var st) ? st.GetString() : null;
                var needsInput = s.TryGetProperty("needsInput", out var ni) && ni.ValueKind == JsonValueKind.True;
                var sessionId = s.TryGetProperty("sessionId", out var sid) ? sid.GetString() : null;
                if (needsInput && sessionId != null) needsInputIds.Add(sessionId);
                else if (state == "working") working = true;
            }
            var iconState = needsInputIds.Count > 0 ? IconState.NeedsInput : working ? IconState.Working : count > 0 ? IconState.Idle : IconState.None;
            return (iconState, count, needsInputIds);
        }
        catch
        {
            return (IconState.None, 0, needsInputIds);
        }
    }

    static IconState? _lastIconState;

    static void SetIcon(IconState state)
    {
        if (_lastIconState == state) return;
        _lastIconState = state;

        var (icon, handle) = BuildIcon(state);
        _tray.Icon = icon;
        _tray.Text = state switch
        {
            IconState.NeedsInput => "Mission Control — needs your input",
            IconState.Working => "Mission Control — sessions working",
            IconState.Idle => "Mission Control — all on station",
            _ => "Mission Control",
        };
        if (_lastIcon != IntPtr.Zero) DestroyIcon(_lastIcon);
        _lastIcon = handle;
    }

    static (Drawing.Icon, IntPtr) BuildIcon(IconState state)
    {
        var col = state switch
        {
            IconState.NeedsInput => Drawing.Color.FromArgb(0xff, 0x7e, 0xdb),
            IconState.Working => Drawing.Color.FromArgb(0xff, 0xb4, 0x54),
            IconState.Idle => Drawing.Color.FromArgb(0x57, 0xd9, 0xa3),
            _ => Drawing.Color.FromArgb(0x4a, 0x5a, 0x6a),
        };
        var bmp = new Drawing.Bitmap(32, 32);
        using (var g = Drawing.Graphics.FromImage(bmp))
        {
            g.SmoothingMode = Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Drawing.Color.Transparent);
            using (var path = Rounded(new Drawing.Rectangle(0, 0, 31, 31), 7))
            using (var b = new Drawing.SolidBrush(Drawing.Color.FromArgb(0x10, 0x15, 0x1d)))
                g.FillPath(b, path);
            using var dot = new Drawing.SolidBrush(col);
            g.FillEllipse(dot, 9, 9, 14, 14);
        }
        var h = bmp.GetHicon();
        bmp.Dispose();
        return (Drawing.Icon.FromHandle(h), h);
    }

    static Drawing2D.GraphicsPath Rounded(Drawing.Rectangle r, int radius)
    {
        var d = radius * 2;
        var p = new Drawing2D.GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static bool PortOpen()
    {
        try
        {
            using var c = new TcpClient();
            var ar = c.BeginConnect("127.0.0.1", Port, null, null);
            return ar.AsyncWaitHandle.WaitOne(250) && c.Connected;
        }
        catch
        {
            return false;
        }
    }

    static void EnsureServer()
    {
        if (PortOpen()) return;
        var script = Path.Combine(Root, "src", "server.js");
        if (!File.Exists(script)) return;
        var psi = new ProcessStartInfo
        {
            FileName = FindNode(),
            Arguments = $"\"{script}\"",
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        try
        {
            _serverProc = Process.Start(psi);
        }
        catch
        {
            return;
        }
        for (var i = 0; i < 60 && !PortOpen(); i++) Thread.Sleep(100);
    }

    static string FindNode()
    {
        var candidates = new[]
        {
            @"C:\nvm4w\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
        };
        foreach (var c in candidates)
            if (File.Exists(c)) return c;
        return "node";
    }

    static string FindRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "src", "server.js"))) return dir.FullName;
            dir = dir.Parent;
        }
        return AppContext.BaseDirectory;
    }
}

internal sealed class Settings
{
    public bool Topmost { get; set; } = true;
    public double? Left { get; set; }
    public double? Top { get; set; }

    static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MissionControl", "settings.json");

    public static Settings Load()
    {
        try
        {
            var json = File.ReadAllText(FilePath);
            return JsonSerializer.Deserialize<Settings>(json) ?? new Settings();
        }
        catch
        {
            return new Settings();
        }
    }

    public void Save()
    {
        try
        {
            var dir = Path.GetDirectoryName(FilePath)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
        }
        catch
        {
        }
    }
}
