# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Runs one process and reports wall time, peak memory and CPU time."""
import os
import subprocess
import sys
import time


def run(cmd, stdout=None, stderr=None, cwd=None):
    """Returns a dict: wall_ms, rc, rss_mb and cpu_s (None where the platform gives no data).

    On POSIX the child's resource usage comes from wait4, so it covers only this process. On
    Windows it needs the optional psutil package; without it memory and CPU are None.
    """
    t0 = time.perf_counter()
    p = subprocess.Popen(cmd, stdout=stdout, stderr=stderr, cwd=cwd)
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
    wall = (time.perf_counter() - t0) * 1000
    return {"wall_ms": wall, "rc": p.returncode, "rss_mb": rss, "cpu_s": cpu}
