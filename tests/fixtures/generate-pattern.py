import pathlib
import struct
import zlib

root = pathlib.Path(__file__).parent
width, height = 64, 48
colors = [(240, 20, 30), (20, 220, 40), (30, 40, 230), (240, 240, 240)]
rows = []
for y in range(height):
    row = b"\x00"
    for x in range(width):
        row += bytes(colors[(y >= height // 2) * 2 + (x >= width // 2)])
    rows.append(row)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows)))
png += chunk(b"IEND", b"")
(root / "pattern.png").write_bytes(png)
