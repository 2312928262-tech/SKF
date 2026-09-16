// M14 · SKF MCP Job Object 启动器（Windows）。
// 职责：把受管 MCP server 进程放进带 KILL_ON_JOB_CLOSE 的 Job Object，
// 保证"启动器死 => 整棵进程树死"，绝不只依赖父进程记得 child.kill。
// 用法：JobLauncher.exe [--grace-ms=N] -- <command> [args...]
// 退出码：子进程退出码；64=用法错误；3=Job 指派失败；2=父 stdin 断裂后终止树。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class JobLauncher
{
    private const int ExtendedLimitInfoClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const int ExitUsage = 64;
    private const int ExitJobAssignFailed = 3;
    private const int ExitParentLost = 2;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // CommandLineToArgvW 兼容的加引号：.NET Framework 4.8 没有 ArgumentList。
    private static string QuoteArgument(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', backslashes * 2 + 1).Append('"'); backslashes = 0; continue; }
            if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    private static int Main(string[] args)
    {
        int graceMs = 3000;
        int i = 0;
        while (i < args.Length && args[i].StartsWith("--grace-ms=", StringComparison.Ordinal))
        {
            if (!int.TryParse(args[i].Substring("--grace-ms=".Length), out graceMs) || graceMs < 0 || graceMs > 60000)
            {
                Console.Error.WriteLine("job-launcher: bad --grace-ms");
                return ExitUsage;
            }
            i++;
        }
        if (i >= args.Length || args[i] != "--" || i + 1 >= args.Length)
        {
            Console.Error.WriteLine("usage: JobLauncher [--grace-ms=N] -- <command> [args...]");
            return ExitUsage;
        }
        string command = args[i + 1];
        var sb = new StringBuilder();
        for (int k = i + 2; k < args.Length; k++)
        {
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(QuoteArgument(args[k]));
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            Console.Error.WriteLine("job-launcher: CreateJobObject failed " + Marshal.GetLastWin32Error());
            return ExitJobAssignFailed;
        }
        try
        {
            var limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            IntPtr infoPtr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, infoPtr, false);
                if (!SetInformationJobObject(job, ExtendedLimitInfoClass, infoPtr, (uint)size))
                {
                    Console.Error.WriteLine("job-launcher: SetInformationJobObject failed " + Marshal.GetLastWin32Error());
                    return ExitJobAssignFailed;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(infoPtr);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = command,
                Arguments = sb.ToString(),
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            Process child;
            try
            {
                child = Process.Start(startInfo);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("job-launcher: spawn failed: " + ex.Message);
                return ExitJobAssignFailed;
            }
            // 立即指派进 Job；失败必须杀死刚起的孩子，绝不留下不受管进程。
            if (!AssignProcessToJobObject(job, child.Handle))
            {
                Console.Error.WriteLine("job-launcher: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
                try { child.Kill(); } catch { /* 已退出则无操作 */ }
                return ExitJobAssignFailed;
            }

            Stream parentIn = Console.OpenStandardInput();
            Stream parentOut = Console.OpenStandardOutput();
            Stream parentErr = Console.OpenStandardError();
            Stream childIn = child.StandardInput.BaseStream;
            Stream childOut = child.StandardOutput.BaseStream;
            Stream childErr = child.StandardError.BaseStream;

            var parentLost = new TaskCompletionSource<bool>();
            // 父 -> 子：手动读写循环 + Flush（CopyToAsync 在该链上证实不冲刷，已排坑）。
            // 父 stdin 断裂（SKF 崩溃/被杀都算）=> 触发树终止流程。
            Task.Run(async () =>
            {
                try
                {
                    var buf = new byte[81920];
                    for (;;)
                    {
                        int n = await parentIn.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false);
                        if (n <= 0) break;
                        await childIn.WriteAsync(buf, 0, n).ConfigureAwait(false);
                        await childIn.FlushAsync().ConfigureAwait(false);
                    }
                    try { childIn.Close(); } catch { }
                }
                catch { /* child died first or pipe broken */ }
                parentLost.TrySetResult(true);
            });
            // 子 -> 父：二进制直通，绝不经过文本编码。
            Task.Run(async () => { try { await childOut.CopyToAsync(parentOut, 81920).ConfigureAwait(false); parentOut.Flush(); } catch { } });
            Task.Run(async () => { try { await childErr.CopyToAsync(parentErr, 81920).ConfigureAwait(false); parentErr.Flush(); } catch { } });

            Task<int> childExit = Task.Run(() => { child.WaitForExit(); return child.ExitCode; });
            Task first = Task.WhenAny(childExit, parentLost.Task);
            try { first.Wait(); } catch { }

            if (childExit.IsCompleted)
            {
                int code;
                try { code = childExit.Result; } catch { code = -1; }
                // 等 stdout/stderr 尽力排空（有界），避免截断最后的输出。
                Thread.Sleep(200);
                return code;
            }

            // 父进程失联：先给子进程优雅退出窗口，超时后整棵树终止。
            try { childIn.Close(); } catch { }
            bool exited = child.WaitForExit(graceMs);
            if (!exited)
            {
                TerminateJobObject(job, (uint)ExitParentLost);
                child.WaitForExit(5000);
            }
            return ExitParentLost;
        }
        finally
        {
            // 关句柄即触发 KILL_ON_JOB_CLOSE：任何残留孙进程一并清掉。
            CloseHandle(job);
        }
    }
}
