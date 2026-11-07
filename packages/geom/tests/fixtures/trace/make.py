# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Writes the source of the trace fixture, made here:

  python3 make.py <dir>

  square.png   48 x 32, white with a black 16 px square 4 px in from the top left

square.jpg is square.png saved as a JPEG (ffmpeg -i square.png -q:v 2 square.jpg); this script does not write it.
"""
import struct
import sys
import zlib
from pathlib import Path


def png(w, h, pixel):
    raw = b''.join(b'\0' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    head = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', head) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def square(x, y):
    return (0, 0, 0) if 4 <= x < 20 and 4 <= y < 20 else (255, 255, 255)


if __name__ == '__main__':
    d = Path(sys.argv[1])
    d.mkdir(parents=True, exist_ok=True)
    (d / 'square.png').write_bytes(png(48, 32, square))
