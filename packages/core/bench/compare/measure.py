# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Runs one process and reports wall time, peak memory and CPU time."""
import os
import subprocess
import sys
import time


def run(cmd, stdout=None, stderr=None, cwd=None, timeout=None):
    """Returns a dict: wall_ms, rc, rss_mb and cpu_s (None where the platform gives no data). With `timeout`
    (seconds) the process is stopped when it runs longer, and rc is None.

    On POSIX the child's resource usage comes from wait4, so it covers only this process. On
    Windows it reads the finished process through its handle (psutil, when installed, samples it instead).
    """
    t0 = time.perf_counter()
    p = subprocess.Popen(cmd, stdout=stdout, stderr=stderr, cwd=cwd)
    late = []
    if timeout:
        import threading

        def stop():
            late.append(True)
            p.kill()

        timer = threading.Timer(timeout, stop)
        timer.daemon = True
        timer.start()
    rss = cpu = None
    if hasattr(os, "wait4"):
        _, status, ru = os.wait4(p.pid, 0)
        p.returncode = os.waitstatus_to_exitcode(status)
        # ru_maxrss is bytes on macOS and kilobytes elsewhere.
        rss = ru.ru_maxrss / (2**20 if sys.platform == "darwin" else 1024)
        cpu = ru.ru_utime + ru.ru_stime
    else:
        try:
            import psutil
            ps = psutil.Process(p.pid)
            peak = 0
            while p.poll() is None:
                try:
                    peak = max(peak, ps.memory_info().rss)
                    t = ps.cpu_times()
                    cpu = t.user + t.system
                except psutil.Error:
                    break
                time.sleep(0.005)
            rss = peak / 2**20 if peak else None
        except ImportError:
            p.wait()
            rss, cpu = _windows_usage(p)
    wall = (time.perf_counter() - t0) * 1000
    if timeout:
        timer.cancel()
    return {"wall_ms": wall, "rc": None if late else p.returncode, "rss_mb": rss, "cpu_s": cpu}


def _windows_usage(p):
    """Peak working set (MB) and CPU seconds of a finished child on Windows, read through the process handle
    Popen keeps open, so no package is needed. (None, None) where that is not available."""
    try:
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (n, ctypes.c_size_t) for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                               "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                                               "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

        handle = wintypes.HANDLE(int(p._handle))
        c = Counters()
        c.cb = ctypes.sizeof(c)
        rss = c.PeakWorkingSetSize / 2**20 if ctypes.windll.kernel32.K32GetProcessMemoryInfo(handle, ctypes.byref(c), c.cb) else None
        t = [wintypes.FILETIME() for _ in range(4)]
        ok = ctypes.windll.kernel32.GetProcessTimes(handle, *[ctypes.byref(x) for x in t])
        ticks = lambda f: (f.dwHighDateTime << 32 | f.dwLowDateTime) / 1e7
        cpu = ticks(t[2]) + ticks(t[3]) if ok else None
        return rss, cpu
    except (AttributeError, OSError, ValueError):
        return None, None
