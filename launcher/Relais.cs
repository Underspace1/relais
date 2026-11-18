// Relais.exe — application Windows.
// Démarre le serveur Relais en arrière-plan (sans console) et l'affiche dans sa propre
// fenêtre WebView2, sans barre de titre Windows : la barre est dessinée par l'interface.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    public static string Root;
    public static string Lib;
    public static int Port = 4321;
    static Process Server;

    [STAThread]
    static void Main()
    {
        Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Lib = Path.Combine(Root, "launcher", "lib");
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            var f = Path.Combine(Lib, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(f) ? Assembly.LoadFrom(f) : null;
        };
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // net à 125 %, 150 %…
        ReadPort();

        bool first;
        using (var mutex = new Mutex(true, "Relais.App.SingleInstance", out first))
        using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Relais.App.Show"))
        {
            if (!first) { show.Set(); return; } // déjà lancé : on affiche la fenêtre existante
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (!EnsureServer()) return;
            RunApp(show);
            Shutdown();
        }
    }

    public static string Url { get { return "http://127.0.0.1:" + Port; } }

    [MethodImpl(MethodImplOptions.NoInlining)]
    static void RunApp(EventWaitHandle show)
    {
        var form = new MainForm();
        // Une 2e ouverture de Relais.exe réaffiche cette fenêtre
        var t = new Thread(() => { while (show.WaitOne()) { try { form.BeginInvoke((Action)form.ShowFront); } catch { return; } } }) { IsBackground = true };
        t.Start();
        Application.Run(form);
    }

    static void ReadPort()
    {
        try
        {
            var cfg = Path.Combine(Root, "data", "config.json");
            if (!File.Exists(cfg)) return;
            var m = Regex.Match(File.ReadAllText(cfg), "\"PORT\"\\s*:\\s*\"?(\\d+)");
            if (m.Success) Port = int.Parse(m.Groups[1].Value);
        }
        catch { }
    }

    static bool IsUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Url + "/api/skills");
            req.Timeout = 800;
            using (var res = (HttpWebResponse)req.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static bool EnsureServer()
    {
        if (IsUp()) return true;
        var node = Path.Combine(Root, "node", "node.exe");
        var server = Path.Combine(Root, "server.js");
        if (!File.Exists(node) || !File.Exists(server))
        {
            MessageBox.Show("Fichiers introuvables à côté de Relais.exe :\n" + node + "\n" + server + "\n\nGarde Relais.exe dans le dossier relais.", "Relais", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        Directory.CreateDirectory(Path.Combine(Root, "data"));
        var log = Path.Combine(Root, "data", "relais.log");
        var psi = new ProcessStartInfo(node, "\"" + server + "\"")
        {
            WorkingDirectory = Root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        try
        {
            File.WriteAllText(log, "");
            Server = Process.Start(psi);
            DataReceivedEventHandler write = (s, e) => { if (e.Data != null) try { File.AppendAllText(log, e.Data + Environment.NewLine); } catch { } };
            Server.OutputDataReceived += write;
            Server.ErrorDataReceived += write;
            Server.BeginOutputReadLine();
            Server.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            MessageBox.Show("Impossible de démarrer Relais :\n" + ex.Message, "Relais", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        for (int i = 0; i < 60; i++)
        {
            if (IsUp()) return true;
            if (Server.HasExited) break;
            Thread.Sleep(250);
        }
        MessageBox.Show("Relais n'a pas démarré. Détails dans :\n" + log, "Relais", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return false;
    }

    static void Shutdown()
    {
        try
        {
            if (Server != null && !Server.HasExited)
            {
                var kill = new ProcessStartInfo("taskkill", "/PID " + Server.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false };
                Process.Start(kill).WaitForExit(5000);
            }
        }
        catch { }
    }
}

/* ======================================================================
   Fenêtre principale : sans barre Windows, mais avec ombre, coins arrondis,
   redimensionnement et ancrage (Win+flèches, glisser vers les bords).
   ====================================================================== */
class MainForm : Form
{
    readonly Microsoft.Web.WebView2.WinForms.WebView2 web;
    readonly NotifyIcon tray;
    bool quitting;
    bool hintShown;

    public MainForm()
    {
        Text = "Relais";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        BackColor = Color.FromArgb(11, 11, 12);
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.Sizable;
        MinimumSize = new Size(Scale(720), Scale(480));
        RestoreBounds_();

        web = new Microsoft.Web.WebView2.WinForms.WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
        web.CreationProperties = new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
        {
            UserDataFolder = Path.Combine(Program.Root, "data", "webview"),
        };
        Controls.Add(web);
        UpdatePadding();

        tray = new NotifyIcon { Icon = Icon, Text = "Relais", Visible = true, ContextMenuStrip = BuildMenu() };
        tray.DoubleClick += (s, e) => ShowFront();

        Load += async (s, e) =>
        {
            try
            {
                Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(Program.Lib);
                await web.EnsureCoreWebView2Async(null);
                var cw = web.CoreWebView2;
                cw.Settings.IsStatusBarEnabled = false;
                cw.Settings.AreDevToolsEnabled = false;
                cw.Settings.IsZoomControlEnabled = true;
                cw.WebMessageReceived += OnMessage;
                cw.NewWindowRequested += (o, a) => { a.Handled = true; OpenExternal(a.Uri); };
                cw.NavigationStarting += (o, a) =>
                {
                    if (!a.Uri.StartsWith(Program.Url) && !a.Uri.StartsWith("about:")) { a.Cancel = true; OpenExternal(a.Uri); }
                };
                cw.DocumentTitleChanged += (o, a) => { Text = cw.DocumentTitle; };
                // Saisie vocale, notifications et presse-papiers : autorisés pour l'interface locale uniquement.
                cw.PermissionRequested += (o, a) =>
                {
                    if (!a.Uri.StartsWith(Program.Url)) return;
                    var k = a.PermissionKind;
                    if (k == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Microphone
                        || k == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.Notifications
                        || k == Microsoft.Web.WebView2.Core.CoreWebView2PermissionKind.ClipboardRead)
                        a.State = Microsoft.Web.WebView2.Core.CoreWebView2PermissionState.Allow;
                };
                web.Source = new Uri(Program.Url);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Le moteur d'affichage WebView2 est introuvable.\nIl est normalement fourni avec Windows 11 / Microsoft Edge.\n\n" + ex.Message, "Relais", MessageBoxButtons.OK, MessageBoxIcon.Error);
                quitting = true;
                Close();
            }
        };
        Resize += (s, e) => { UpdatePadding(); Post("{\"window\":\"" + (WindowState == FormWindowState.Maximized ? "max" : "normal") + "\"}"); };
        FormClosing += (s, e) =>
        {
            SaveBounds();
            if (!quitting && e.CloseReason == CloseReason.UserClosing)
            {
                // Fermer la fenêtre garde Relais actif près de l'horloge (les IA continuent).
                e.Cancel = true;
                Hide();
                if (!hintShown) { hintShown = true; tray.ShowBalloonTip(3000, "Relais reste ouvert", "Il continue près de l'horloge. Clic droit → Quitter Relais pour l'arrêter.", ToolTipIcon.None); }
            }
        };
        FormClosed += (s, e) => { tray.Visible = false; tray.Dispose(); };
    }

    int Scale(int v) { using (var g = CreateGraphics()) return (int)(v * g.DpiX / 96f); }

    ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Ouvrir Relais", null, (s, e) => ShowFront());
        menu.Items.Add("Ouvrir le dossier", null, (s, e) => Process.Start("explorer.exe", "\"" + Program.Root + "\""));
        menu.Items.Add("Journal", null, (s, e) => { var l = Path.Combine(Program.Root, "data", "relais.log"); if (File.Exists(l)) Process.Start("notepad.exe", "\"" + l + "\""); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quitter Relais", null, (s, e) => Quit());
        return menu;
    }

    public void ShowFront()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    void Quit() { quitting = true; SaveBounds(); Close(); Application.Exit(); }

    static void OpenExternal(string uri)
    {
        try { if (uri.StartsWith("http://") || uri.StartsWith("https://")) Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    void Post(string json)
    {
        try { if (web != null && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json); } catch { }
    }

    /* ---------- Messages venant de la barre de titre de l'interface ---------- */
    void OnMessage(object sender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
    {
        string msg;
        try { msg = e.TryGetWebMessageAsString(); } catch { return; }
        switch (msg)
        {
            case "drag":
                Native.ReleaseCapture();
                Native.SendMessage(Handle, 0xA1 /* WM_NCLBUTTONDOWN */, new IntPtr(2) /* HTCAPTION */, IntPtr.Zero);
                break;
            case "min": WindowState = FormWindowState.Minimized; break;
            case "max": WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized; break;
            case "close": Close(); break;
            case "quit": Quit(); break;
            case "ready": Post("{\"window\":\"" + (WindowState == FormWindowState.Maximized ? "max" : "normal") + "\",\"native\":true}"); break;
            default:
                if (msg.StartsWith("bg:#") && msg.Length == 10)
                {
                    try { BackColor = ColorTranslator.FromHtml(msg.Substring(3)); web.DefaultBackgroundColor = BackColor; } catch { }
                }
                break;
        }
    }

    /* ---------- Fenêtre sans bordure, avec les comportements Windows ---------- */
    const int WM_NCCALCSIZE = 0x83, WM_NCHITTEST = 0x84;

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
        {
            // Supprime la barre de titre ; en plein écran, évite que la fenêtre déborde de l'écran.
            if (WindowState == FormWindowState.Maximized)
            {
                var p = (Native.NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(Native.NCCALCSIZE_PARAMS));
                int b = Native.GetSystemMetricsForDpi(32 /* SM_CXSIZEFRAME */, (uint)DeviceDpi) + Native.GetSystemMetricsForDpi(92 /* SM_CXPADDEDBORDER */, (uint)DeviceDpi);
                p.rgrc0.Left += b; p.rgrc0.Top += b; p.rgrc0.Right -= b; p.rgrc0.Bottom -= b;
                Marshal.StructureToPtr(p, m.LParam, false);
            }
            m.Result = IntPtr.Zero;
            return;
        }
        if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal)
        {
            var pt = PointToClient(new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16))));
            int g = Edge;
            bool l = pt.X < g, r = pt.X >= ClientSize.Width - g, t = pt.Y < g, b = pt.Y >= ClientSize.Height - g;
            int hit = t && l ? 13 : t && r ? 14 : b && l ? 16 : b && r ? 17 : l ? 10 : r ? 11 : t ? 12 : b ? 15 : 1;
            m.Result = new IntPtr(hit);
            return;
        }
        base.WndProc(ref m);
    }

    int Edge { get { return Math.Max(4, (int)(5 * DeviceDpi / 96f)); } }

    // Une fine marge autour de la page permet d'attraper les bords pour redimensionner.
    void UpdatePadding()
    {
        int p = WindowState == FormWindowState.Normal ? Edge : 0;
        if (Padding.All != p) Padding = new Padding(p);
    }

    /* ---------- Taille et position mémorisées ---------- */
    string BoundsFile { get { return Path.Combine(Program.Root, "data", "window.txt"); } }

    void RestoreBounds_()
    {
        var area = Screen.PrimaryScreen.WorkingArea;
        var w = Math.Min(Scale(1320), area.Width - 40);
        var h = Math.Min(Scale(880), area.Height - 40);
        Bounds = new Rectangle(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h);
        try
        {
            var parts = File.ReadAllText(BoundsFile).Split(',');
            var r = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
            foreach (var s in Screen.AllScreens) if (s.WorkingArea.IntersectsWith(r) && r.Width >= 600 && r.Height >= 400) { Bounds = r; break; }
            if (parts.Length > 4 && parts[4] == "max") WindowState = FormWindowState.Maximized;
        }
        catch { }
    }

    void SaveBounds()
    {
        try
        {
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            File.WriteAllText(BoundsFile, r.X + "," + r.Y + "," + r.Width + "," + r.Height + "," + (WindowState == FormWindowState.Maximized ? "max" : "normal"));
        }
        catch { }
    }
}

static class Native
{
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetSystemMetricsForDpi(int nIndex, uint dpi);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct NCCALCSIZE_PARAMS { public RECT rgrc0, rgrc1, rgrc2; public IntPtr lppos; }
}
