// The tab / bookmark icon: a tiny pixel-art version of the app's printer with a sheet of paper coming out.
// Drawn from a 16 x 16 pixel map and written as PNG files (Node only, used at build time), then embedded in both pages as
// data: links, so there is no extra file to host.

import { deflateSync } from 'node:zlib';

const PALETTE = {
  T: [200, 184, 154, 255], // the app's tan background
  L: [140, 107, 82, 255], // printer top
  B: [107, 80, 64, 255], // printer body
  D: [46, 26, 8, 255], // dark edges
  S: [13, 6, 0, 255], // paper slot
  P: [255, 248, 238, 255], // paper
  I: [92, 61, 30, 255], // ink lines on the paper
  g: [139, 175, 124, 255], // green light
  a: [212, 168, 67, 255], // amber light
  r: [232, 160, 160, 255], // rose button / light
};

// 16 rows of 16 characters.
const MAP = [
  'TTTTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTTTT',
  'TTLLLLLLLLLLLLTT',
  'TTLLLLLLLLLLLLTT',
  'TTBBBBBBBBBBBBTT',
  'TTBrrBBBBBgarBTT',
  'TTBrrBBBBBBBBBTT',
  'TTBBBBBBBBBBBBTT',
  'TTBBDDDDDDDDBBTT',
  'TTDDDSSSSSSDDDTT',
  'TTTDDPPPPPPDDTTT',
  'TTTTTPIIIIPTTTTT',
  'TTTTTPPPPPPTTTTT',
  'TTTTTPIIPPPTTTTT',
  'TTTTTPPPPPPTTTTT',
  'TTTTTPTPTPTPTTTT',
];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** The icon as an RGBA pixel array at `size` x `size` (nearest neighbour, so the pixels stay sharp). */
export function iconPixels(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = MAP[Math.floor((y * 16) / size)][Math.floor((x * 16) / size)];
      const [r, g, b, a] = PALETTE[ch];
      const i = (y * size + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return px;
}

/** A PNG file (Buffer) of the icon at `size` x `size`. */
export function iconPng(size) {
  const px = iconPixels(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The <link> tags for the tab icon (32 px) and the iPhone home-screen icon (180 px), as data: URLs. */
export function iconLinks() {
  const url = (size) => `data:image/png;base64,${iconPng(size).toString('base64')}`;
  return `<link rel="icon" type="image/png" sizes="32x32" href="${url(32)}">\n<link rel="apple-touch-icon" sizes="180x180" href="${url(180)}">`;
}
