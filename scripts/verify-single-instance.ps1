$ErrorActionPreference = "Continue"
# Resolve the debug/release exes relative to this script so the check runs
# from any checkout location (script lives in <repo>/scripts/).
$repoRoot = Split-Path -Parent $PSScriptRoot
$debugExe = Join-Path $repoRoot "src-tauri/target/debug/snippets.exe"
$releaseExe = Join-Path $repoRoot "src-tauri/target/release/snippets.exe"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinEnum {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public static string[] TitlesOfPid(uint pid) {
        var result = new List<string>();
        EnumWindows((h, l) => {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid && IsWindowVisible(h)) {
                var sb = new StringBuilder(256);
                GetWindowText(h, sb, 256);
                if (sb.Length > 0) result.Add(sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
"@

function Dump($label) {
    Write-Output "== $label =="
    $procs = Get-Process snippets -ErrorAction SilentlyContinue
    if (-not $procs) { Write-Output "  (none)"; return }
    foreach ($p in $procs) {
        $titles = [WinEnum]::TitlesOfPid([uint32]$p.Id)
        Write-Output ("  pid=" + $p.Id + " exe=" + (Split-Path $p.Path -Leaf) + " titles=[" + ($titles -join " | ") + "]")
    }
}

# 1. first debug instance
Start-Process $debugExe
Start-Sleep 2
Dump "after 1st debug"

# 2. second debug instance must die, first one stays
Start-Process $debugExe
Start-Sleep 2
Dump "after 2nd debug (expect still 1 debug)"

# 3. release instance must coexist with debug
Start-Process $releaseExe
Start-Sleep 2
Dump "after 1st release (expect 2 total: 1 debug + 1 release)"

# 4. second release instance must die
Start-Process $releaseExe
Start-Sleep 2
Dump "after 2nd release (expect still 2 total)"

# cleanup
Get-Process snippets -ErrorAction SilentlyContinue | Stop-Process
Write-Output "cleaned up"
