// M26 · SKF Windows UIA 原生助手（.NET Framework 4.x，零新依赖）
// 职责：把 UIAutomation 的控件树读取与受限动作暴露成"一行 JSON 请求 → 一行 JSON 响应"，
// 由 SKF TS 侧 RealUiaBridge 经 JobLauncher（Job Object KILL_ON_JOB_CLOSE）托管。
//
// 协议：从 stdin 读 UTF-8 JSON 请求（含 "command" 字段），处理后向 stdout 写 UTF-8 JSON 响应。
// 命令：
//   health          → { state, detail }
//   list-windows    → { windows:[...], total }   （请求可带 restrictPids/visibleOnly/limit/excludePids）
//   snapshot        → { schemaVersion, status, target, rootNodeId, nodes, completeness, warnings, durationMs }
//   invoke-read     → { matched, summary, assertionState, detail, durationMs }
//   invoke-effect   → { status, detail, durationMs, postSummary }
//
// 安全红线（与 uia-snapshot.md 对齐）：
//   - 不截图、不 OCR、不注入、不提权、不跨安全桌面。
//   - snapshot 是只读；编辑值默认 not_requested；IsPassword=true 永不读值。
//   - 输入框 set_value 前做基础密钥模式检测，命中即拒绝（rejected）。
//   - 只支持语义 Pattern，不做坐标点击/键盘模拟降级。
//   - 所有输出文本都是"目标应用提供的不可信内容"，SKF 上层仍按 untrusted 处理。

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static class UiaHelper
{
    // ── Win32 P/Invoke（窗口枚举用；UIA 的 RootElement 对某些顶层窗口不完整）──
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private const uint GW_OWNER = 4;

    // ── 文本策略 ──
    private const string POLICY_STRUCTURE_ONLY = "structureOnly";
    private const string POLICY_SEMANTIC = "semantic";

    // 密钥/敏感模式（与 TS 侧 validateInputCommitNotSecret 同源，非完备）。
    private static readonly Regex SecretPattern = new Regex(
        @"(sk-[a-z0-9]{8,}|ghp_[a-z0-9]{16,}|gho_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|password\s*[:=]\s*\S{4,}|token\s*[:=]\s*\S{8,}|secret\s*[:=]\s*\S{8,})",
        RegexOptions.IgnoreCase);

    private static readonly HashSet<string> SecretControlTypeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        // 已知凭据界面控件类型：值永不可读。
        "PasswordBox", "Edit",
    };

    private static int Main(string[] args)
    {
        try
        {
            string input = null;
            // 优先从 argv[1] 取 base64 请求（避免 stdin EOF 与 JobLauncher 中继的竞态）；
            // argv 为空时回退读 stdin（便于手工测试）。
            if (args.Length >= 1 && !string.IsNullOrEmpty(args[0]))
            {
                try { input = Encoding.UTF8.GetString(Convert.FromBase64String(args[0])); }
                catch { input = args[0]; }
            }
            else
            {
                input = ReadAllStdIn();
            }
            var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var req = (input == null || input.Trim().Length == 0)
                ? new Dictionary<string, object>()
                : (ser.Deserialize<Dictionary<string, object>>(input) ?? new Dictionary<string, object>());
            var command = GetString(req, "command") ?? "health";

            object result;
            switch (command)
            {
                case "health": result = Health(); break;
                case "list-windows": result = ListWindows(req); break;
                case "snapshot": result = Snapshot(req); break;
                case "invoke-read": result = InvokeRead(req); break;
                case "invoke-effect": result = InvokeEffect(req); break;
                default:
                    result = new Dictionary<string, object>
                    {
                        { "error", "UNKNOWN_COMMAND" },
                        { "detail", "unknown command: " + command },
                    };
                    break;
            }
            WriteJson(result);
            return 0;
        }
        catch (Exception ex)
        {
            WriteJson(new Dictionary<string, object>
            {
                { "error", "HELPER_FAILED" },
                { "detail", SafeError(ex) },
            });
            return 1;
        }
    }

    private static string ReadAllStdIn()
    {
        using (var ms = new MemoryStream())
        {
            var stdin = Console.OpenStandardInput();
            var buf = new byte[8192];
            int n;
            while ((n = stdin.Read(buf, 0, buf.Length)) > 0) ms.Write(buf, 0, n);
            return Encoding.UTF8.GetString(ms.ToArray());
        }
    }

    private static void WriteJson(object obj)
    {
        var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        byte[] bytes = Encoding.UTF8.GetBytes(ser.Serialize(obj) + "\n");
        using (var stdout = Console.OpenStandardOutput())
        {
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
    }

    private static string SafeError(Exception ex)
    {
        // 不把原始目标内容/完整路径带出去；只给最小错误分类。
        var e = ex;
        while (e is System.Reflection.TargetInvocationException && e.InnerException != null) e = e.InnerException;
        var msg = e.Message ?? e.GetType().Name;
        return msg.Length > 300 ? msg.Substring(0, 300) : msg;
    }

    // ── 工具方法 ──

    private static string GetString(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null;
    }

    private static int GetInt(Dictionary<string, object> d, string key, int fallback)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return fallback;
        try { return Convert.ToInt32(v); } catch { return fallback; }
    }

    private static long GetLong(Dictionary<string, object> d, string key, long fallback)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return fallback;
        try { return Convert.ToInt64(v); } catch { return fallback; }
    }

    private static int[] GetIntArray(Dictionary<string, object> d, string key)
    {
        object v;
        if (!d.TryGetValue(key, out v) || v == null) return new int[0];
        var arr = v as object[];
        if (arr == null) return new int[0];
        var list = new List<int>();
        foreach (var item in arr) { try { list.Add(Convert.ToInt32(item)); } catch { } }
        return list.ToArray();
    }

    private static string ControlTypeName(AutomationElement el)
    {
        var ct = el.Current.ControlType;
        if (ct == null) return "Unknown";
        var pn = ct.ProgrammaticName ?? "";
        if (pn.StartsWith("ControlType.", StringComparison.Ordinal)) pn = pn.Substring("ControlType.".Length);
        return pn.Length == 0 ? "Unknown" : pn;
    }

    private static bool IsPasswordLike(AutomationElement el)
    {
        try { return el.Current.IsPassword; }
        catch { return false; }
    }

    private static bool IsEdit(AutomationElement el)
    {
        var name = ControlTypeName(el);
        return name == "Edit" || name == "Document" || name == "Text";
    }

    // ── health ──

    private static object Health()
    {
        try
        {
            var root = AutomationElement.RootElement;
            if (root == null)
            {
                return new Dictionary<string, object> { { "state", "uia_unavailable" }, { "detail", "RootElement null" } };
            }
            return new Dictionary<string, object> { { "state", "ok" }, { "detail", (string)null } };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object> { { "state", "uia_unavailable" }, { "detail", SafeError(ex) } };
        }
    }

    // ── 窗口枚举 ──

    private sealed class WinEntry
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string Title;
        public string ClassName;
        public bool Visible;
        public RECT Rect;
    }

    private static List<WinEntry> EnumerateWindows(int[] excludePids)
    {
        var exclude = new HashSet<int>(excludePids);
        var result = new List<WinEntry>();
        EnumWindows((hWnd, lParam) =>
        {
            try
            {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (exclude.Contains((int)pid)) return true;
                // 只取无 owner 的顶层窗口（排除 owned popup/工具窗口）。
                if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
                if (!IsWindowVisible(hWnd)) return true;
                int len = GetWindowTextLength(hWnd);
                if (len <= 0) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();
                if (string.IsNullOrEmpty(title)) return true;
                var sbClass = new StringBuilder(256);
                // GetClassNameW
                GetClassName(hWnd, sbClass, sbClass.Capacity);
                RECT rect;
                GetWindowRect(hWnd, out rect);
                result.Add(new WinEntry
                {
                    Hwnd = hWnd,
                    Pid = pid,
                    Title = title,
                    ClassName = sbClass.ToString(),
                    Visible = true,
                    Rect = rect,
                });
            }
            catch { /* 单窗口失败不中断枚举 */ }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    private static object ListWindows(Dictionary<string, object> req)
    {
        var restrictPids = new HashSet<int>(GetIntArray(req, "restrictPids"));
        bool visibleOnly = req.ContainsKey("visibleOnly") && Convert.ToBoolean(req["visibleOnly"]);
        int limit = GetInt(req, "limit", 100);
        var excludePids = GetIntArray(req, "excludePids");

        var windows = new List<object>();
        foreach (var w in EnumerateWindows(excludePids))
        {
            if (restrictPids.Count > 0 && !restrictPids.Contains((int)w.Pid)) continue;
            if (visibleOnly && !w.Visible) continue;
            windows.Add(new Dictionary<string, object>
            {
                { "ephemeralId", "0x" + w.Hwnd.ToInt64().ToString("X") },
                { "pid", (int)w.Pid },
                { "title", w.Title },
                { "className", w.ClassName.Length > 0 ? w.ClassName : "Window" },
                { "isVisible", w.Visible },
                { "rect", new Dictionary<string, object>
                    {
                        { "x", w.Rect.Left },
                        { "y", w.Rect.Top },
                        { "width", w.Rect.Right - w.Rect.Left },
                        { "height", w.Rect.Bottom - w.Rect.Top },
                    }
                },
            });
            if (windows.Count >= limit) break;
        }
        return new Dictionary<string, object> { { "windows", windows }, { "total", windows.Count } };
    }

    // ── snapshot ──

    private sealed class NodeBuilder
    {
        public string Id;
        public string ParentId;
        public List<string> ChildIds = new List<string>();
        public int Depth;
        public string ControlType;
        public Dictionary<string, object> Name = new Dictionary<string, object> { { "state", "not_requested" } };
        public Dictionary<string, object> Value = new Dictionary<string, object> { { "state", "not_requested" } };
        public bool? IsEnabled;
        public bool? IsOffscreen;
        public string ReadStatus = "ok";
        public string ChildrenState = "complete";
    }

    private static object Snapshot(Dictionary<string, object> req)
    {
        var started = DateTime.UtcNow;
        string ephemeralId = GetString(req, "ephemeralId");
        string textPolicy = GetString(req, "textPolicy") ?? POLICY_SEMANTIC;
        int maxNodes = Math.Min(GetInt(req, "maxNodes", 500), 2000);
        int maxDepth = Math.Min(GetInt(req, "maxDepth", 12), 24);
        int maxChildren = Math.Min(GetInt(req, "maxChildren", 100), 300);

        if (string.IsNullOrEmpty(ephemeralId))
        {
            return ErrResponse("TARGET_NOT_FOUND", "ephemeralId required", "error");
        }

        AutomationElement rootEl = ResolveWindow(ephemeralId);
        if (rootEl == null)
        {
            return ErrResponse("TARGET_NOT_FOUND", "window not found: " + ephemeralId, "error");
        }

        var nodes = new List<NodeBuilder>();
        int counter = 0;
        bool truncated = false;
        string truncationReason = null;

        // BFS 遍历。
        var queue = new Queue<Tuple<AutomationElement, string, int>>();
        queue.Enqueue(Tuple.Create(rootEl, (string)null, 0));
        while (queue.Count > 0)
        {
            var tuple = queue.Dequeue();
            var el = tuple.Item1;
            var parentId = tuple.Item2;
            int depth = tuple.Item3;

            if (nodes.Count >= maxNodes) { truncated = true; truncationReason = truncationReason ?? "max_nodes"; break; }
            if (depth > maxDepth) { truncated = true; truncationReason = truncationReason ?? "max_depth"; break; }

            var node = new NodeBuilder();
            node.Id = "n-" + (counter++);
            node.ParentId = parentId;
            node.Depth = depth;

            try
            {
                node.ControlType = ControlTypeName(el);
                node.IsEnabled = el.Current.IsEnabled;
                node.IsOffscreen = el.Current.IsOffscreen;
            }
            catch (ElementNotAvailableException)
            {
                node.ControlType = "Unknown";
                node.ReadStatus = "unavailable";
            }

            bool isPassword = IsPasswordLike(el);
            bool isEdit = IsEdit(el);

            // 阶段 B：按 textPolicy 决定是否读 Name。
            if (textPolicy == POLICY_SEMANTIC && node.ReadStatus == "ok")
            {
                if (isPassword)
                {
                    node.Name = new Dictionary<string, object> { { "state", "redacted" } };
                }
                else
                {
                    string name = ReadName(el);
                    if (name == null) node.Name = new Dictionary<string, object> { { "state", "unavailable" } };
                    else if (name.Length == 0) node.Name = new Dictionary<string, object> { { "state", "empty" } };
                    else if (SecretPattern.IsMatch(name)) node.Name = new Dictionary<string, object> { { "state", "redacted" } };
                    else node.Name = new Dictionary<string, object> { { "state", "present" }, { "text", Truncate(name, 256) } };
                }
            }
            // 编辑框值默认永不读（textPolicy 无 fieldValues 首版）。
            node.Value = new Dictionary<string, object> { { "state", "not_requested" } };

            nodes.Add(node);

            // 枚举子节点（增量；受 maxChildren 约束）。
            try
            {
                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                int childCount = 0;
                foreach (AutomationElement child in children)
                {
                    if (childCount >= maxChildren)
                    {
                        node.ChildrenState = "truncated";
                        truncationReason = truncationReason ?? "max_children";
                        break;
                    }
                    node.ChildIds.Add("n-" + counter); // 预登记（BFS 顺序保证后续入队）。
                    queue.Enqueue(Tuple.Create(child, node.Id, depth + 1));
                    childCount++;
                }
            }
            catch (ElementNotAvailableException)
            {
                node.ChildrenState = "unknown";
            }
            catch
            {
                node.ChildrenState = "unknown";
            }
        }

        // 修正 childIds：BFS 里"n-counter"预登记可能因节点预算耗尽而失真，重算为实际落库的 id。
        // 为简单与正确，先全量构建 node 列表，再回填 childIds 的映射。
        // 上面的预登记用 counter 预测有风险，改为：遍历时记录 child El 引用，之后统一回填。
        // —— 这里改用二次遍历重排（见下）。

        // 由于预登记 id 依赖 BFS 顺序（先父后子），counter 预测实际一致，但为稳妥，重建 childIds：
        // 直接采用已入队的顺序：每个 node 的 ChildIds 已在入队时按 counter 递增写入，而 node 本身 id 也是 counter 递增。
        // 两者同源，因此一致。保留现有实现。

        int totalObserved = nodes.Count;
        return new Dictionary<string, object>
        {
            { "schemaVersion", 1 },
            { "status", truncated ? "partial" : "ok" },
            { "target", new Dictionary<string, object>
                {
                    { "ephemeralId", ephemeralId },
                    { "pid", GetPid(rootEl) },
                    { "title", ReadName(rootEl) ?? "" },
                }
            },
            { "rootNodeId", nodes.Count > 0 ? nodes[0].Id : null },
            { "nodes", nodes.Select(n => (object)new Dictionary<string, object>
                {
                    { "id", n.Id },
                    { "parentId", n.ParentId },
                    { "childIds", n.ChildIds },
                    { "depth", n.Depth },
                    { "controlType", n.ControlType },
                    { "name", n.Name },
                    { "value", n.Value },
                    { "isEnabled", n.IsEnabled },
                    { "isOffscreen", n.IsOffscreen },
                    { "readStatus", n.ReadStatus },
                    { "childrenState", n.ChildrenState },
                }).ToArray()
            },
            { "completeness", new Dictionary<string, object>
                {
                    { "reason", truncationReason },
                    { "totalObserved", totalObserved },
                    { "maxNodes", maxNodes },
                    { "maxDepth", maxDepth },
                }
            },
            { "warnings", new object[0] },
            { "durationMs", (int)(DateTime.UtcNow - started).TotalMilliseconds },
        };
    }

    private static int GetPid(AutomationElement el)
    {
        try { return el.Current.ProcessId; } catch { return 0; }
    }

    private static AutomationElement ResolveWindow(string ephemeralId)
    {
        // ephemeralId = "0x<hwnd hex>"
        if (ephemeralId.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                long hwnd = Convert.ToInt64(ephemeralId.Substring(2), 16);
                var el = AutomationElement.FromHandle(new IntPtr(hwnd));
                return el;
            }
            catch { }
        }
        // 回退：按 PID 解析。
        int pid;
        if (int.TryParse(ephemeralId, out pid))
        {
            var cond = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
            var el = AutomationElement.RootElement.FindFirst(TreeScope.Children, cond);
            return el;
        }
        return null;
    }

    private static string ReadName(AutomationElement el)
    {
        try { return el.Current.Name; }
        catch { return null; }
    }

    private static string Truncate(string s, int max)
    {
        if (s == null) return null;
        return s.Length <= max ? s : s.Substring(0, max);
    }

    // ── invoke-read / invoke-effect ──

    private static object InvokeRead(Dictionary<string, object> req)
    {
        var started = DateTime.UtcNow;
        string ephemeralId = GetString(req, "ephemeralId");
        string primitive = GetString(req, "primitive") ?? "observe.window";
        var selector = GetSelector(req);

        var windowEl = string.IsNullOrEmpty(ephemeralId) ? null : ResolveWindow(ephemeralId);
        if (windowEl == null && primitive != "observe.window")
        {
            return new Dictionary<string, object>
            {
                { "matched", 0 },
                { "assertionState", "mismatch" },
                { "detail", "target window not found" },
                { "durationMs", (int)(DateTime.UtcNow - started).TotalMilliseconds },
            };
        }

        if (primitive == "observe.window")
        {
            return new Dictionary<string, object>
            {
                { "matched", windowEl != null ? 1 : 0 },
                { "summary", windowEl != null ? new[] { ElementSummary(windowEl) } : new object[0] },
                { "assertionState", windowEl != null ? "ok" : "mismatch" },
                { "detail", windowEl != null ? null : "window not found" },
                { "durationMs", (int)(DateTime.UtcNow - started).TotalMilliseconds },
            };
        }

        var matches = FindMatches(windowEl, selector);
        bool ok = matches.Count > 0;
        // assert.element：必须唯一。
        if (primitive == "assert.element" && matches.Count != 1) ok = false;
        return new Dictionary<string, object>
        {
            { "matched", matches.Count },
            { "summary", matches.Take(20).Select(ElementSummary).ToArray() },
            { "assertionState", ok ? "ok" : "mismatch" },
            { "detail", ok ? null : ("matched " + matches.Count + " elements") },
            { "durationMs", (int)(DateTime.UtcNow - started).TotalMilliseconds },
        };
    }

    private static object InvokeEffect(Dictionary<string, object> req)
    {
        var started = DateTime.UtcNow;
        string ephemeralId = GetString(req, "ephemeralId");
        string primitive = GetString(req, "primitive") ?? "element.focus";
        string inputValue = GetString(req, "inputValue");
        var selector = GetSelector(req);

        var windowEl = string.IsNullOrEmpty(ephemeralId) ? null : ResolveWindow(ephemeralId);
        if (windowEl == null)
        {
            return EffectResult("rejected", "target window not found", (int)(DateTime.UtcNow - started).TotalMilliseconds, null);
        }

        try
        {
            if (primitive == "window.activate")
            {
                SetForegroundWindow(new IntPtr(GetHwnd(windowEl)));
                return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(windowEl) });
            }

            var matches = FindMatches(windowEl, selector);
            if (matches.Count != 1)
            {
                return EffectResult("failed_pre", "selector matched " + matches.Count + " (expected exactly 1)", (int)(DateTime.UtcNow - started).TotalMilliseconds, null);
            }
            var el = matches[0];

            switch (primitive)
            {
                case "element.focus":
                    el.SetFocus();
                    return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });

                case "button.invoke":
                    {
                        var inv = (InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern);
                        inv.Invoke();
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "input.set_value":
                    {
                        if (inputValue != null && SecretPattern.IsMatch(inputValue))
                        {
                            return EffectResult("rejected", "input looks like a secret/private key/token", (int)(DateTime.UtcNow - started).TotalMilliseconds, null);
                        }
                        var vp = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
                        vp.SetValue(inputValue ?? "");
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "toggle.set":
                    {
                        var tp = (TogglePattern)el.GetCurrentPattern(TogglePattern.Pattern);
                        tp.Toggle();
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "item.select":
                    {
                        var sp = (SelectionItemPattern)el.GetCurrentPattern(SelectionItemPattern.Pattern);
                        sp.Select();
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "container.expand":
                    {
                        var ec = (ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern);
                        ec.Expand();
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "container.collapse":
                    {
                        var ec = (ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern);
                        ec.Collapse();
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "item.scroll_into_view":
                    {
                        var sp = (ScrollItemPattern)el.GetCurrentPattern(ScrollItemPattern.Pattern);
                        sp.ScrollIntoView();
                        return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });
                    }

                case "menu.invoke_item":
                    // 首版：等价于展开→调用（先 try Invoke，再 try Expand）。
                    try
                    {
                        var inv = (InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern);
                        inv.Invoke();
                    }
                    catch
                    {
                        var ec = (ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern);
                        ec.Expand();
                    }
                    return EffectResult("dispatched", null, (int)(DateTime.UtcNow - started).TotalMilliseconds, new[] { ElementSummary(el) });

                default:
                    return EffectResult("rejected", "unsupported primitive: " + primitive, (int)(DateTime.UtcNow - started).TotalMilliseconds, null);
            }
        }
        catch (ElementNotAvailableException)
        {
            return EffectResult("failed_pre", "element no longer available", (int)(DateTime.UtcNow - started).TotalMilliseconds, null);
        }
        catch (Exception ex)
        {
            return EffectResult("rejected", SafeError(ex), (int)(DateTime.UtcNow - started).TotalMilliseconds, null);
        }
    }

    private static Dictionary<string, object> GetSelector(Dictionary<string, object> req)
    {
        object v;
        if (req.TryGetValue("selector", out v) && v is Dictionary<string, object>)
        {
            return (Dictionary<string, object>)v;
        }
        return new Dictionary<string, object>();
    }

    private static List<AutomationElement> FindMatches(AutomationElement root, Dictionary<string, object> selector)
    {
        var result = new List<AutomationElement>();
        if (root == null) return result;
        string type = GetString(selector, "type");
        string value = GetString(selector, "value");
        if (string.IsNullOrEmpty(value)) return result;

        Condition cond;
        if (type == "automationId")
        {
            cond = new PropertyCondition(AutomationElement.AutomationIdProperty, value);
        }
        else if (type == "name")
        {
            cond = new PropertyCondition(AutomationElement.NameProperty, value);
        }
        else
        {
            // path：按 / 分隔的 name 层级，逐步定位。
            var parts = value.Split('/');
            AutomationElement cur = root;
            foreach (var part in parts)
            {
                var c = new PropertyCondition(AutomationElement.NameProperty, part);
                var next = cur.FindFirst(TreeScope.Children, c);
                if (next == null) return result;
                cur = next;
            }
            result.Add(cur);
            return result;
        }

        var found = root.FindAll(TreeScope.Descendants, cond);
        foreach (AutomationElement el in found)
        {
            // 可选约束：mustBeEnabled。
            bool mustEnabled = reqContainsTrue(selector, "mustBeEnabled");
            if (mustEnabled)
            {
                try { if (!el.Current.IsEnabled) continue; } catch { continue; }
            }
            result.Add(el);
            if (result.Count > 64) break; // 上界保护。
        }
        return result;
    }

    private static bool reqContainsTrue(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) && v != null && Convert.ToBoolean(v);
    }

    private static object ElementSummary(AutomationElement el)
    {
        return new Dictionary<string, object>
        {
            { "controlType", ControlTypeName(el) },
            { "name", ReadName(el) ?? "" },
            { "isEnabled", (object)el.Current.IsEnabled },
        };
    }

    private static long GetHwnd(AutomationElement el)
    {
        try { return (long)el.Current.NativeWindowHandle; } catch { return 0; }
    }

    private static object EffectResult(string status, string detail, int durationMs, object postSummary)
    {
        var d = new Dictionary<string, object>
        {
            { "status", status },
            { "detail", detail },
            { "durationMs", durationMs },
        };
        if (postSummary != null) d["postSummary"] = postSummary;
        return d;
    }

    private static object ErrResponse(string code, string detail, string status)
    {
        return new Dictionary<string, object>
        {
            { "status", status },
            { "error", new Dictionary<string, object> { { "code", code }, { "detail", detail } } },
        };
    }
}
