/**
 * 生成桌面快捷方式用的图标（.ico）
 *
 * 用纯 Node 写 PNG（zlib 压缩）+ ICO 容器，不依赖任何第三方库。
 * 图案：六瓣花 + 中心发光花蕊，与程序里的粒子花朵呼应。
 *
 * 用法：node make-icon.mjs
 * 输出：icon.ico（含 16/32/48/64/128/256 六种尺寸，Windows 会自动挑合适的）
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/* ---------- 1. 画一张 RGBA 位图 ---------- */

/** 画一朵六瓣花，返回 Float 数组 [r,g,b,a]（a 为 0~1） */
function renderFlower(size) {
  const px = new Float32Array(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size * 0.46;              // 花朵半径
  const petals = 6;

  // 背景：深蓝紫径向渐变（和程序页面底色一致），中心略亮以衬托花朵
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy) / (size * 0.72);
      const t = Math.min(1, d);
      px[i]     = 0.07 + 0.10 * (1 - t);
      px[i + 1] = 0.08 + 0.09 * (1 - t);
      px[i + 2] = 0.14 + 0.16 * (1 - t);
      px[i + 3] = 1;
    }
  }

  /** 把颜色按 alpha 叠加到目标像素上 */
  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
    const i = (y * size + x) * 4;
    px[i]     = px[i]     * (1 - a) + r * a;
    px[i + 1] = px[i + 1] * (1 - a) + g * a;
    px[i + 2] = px[i + 2] * (1 - a) + b * a;
  };

  /* ---------- 花瓣：极坐标玫瑰曲线，和 main.js 里的公式一致 ---------- */
  const SS = 3;                        // 超采样倍数，让边缘平滑
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const dx = fx - cx, dy = fy - cy;
          const dist = Math.hypot(dx, dy);
          const theta = Math.atan2(dy, dx);
          if (dist > R) continue;

          const u = dist / R;          // 0=中心 1=瓣尖
          // r(θ) = |cos(k·θ/2)|^0.75  —— 与程序一致
          const petalR = Math.pow(Math.abs(Math.cos((petals * theta) / 2)), 0.75);
          if (u > petalR) continue;

          // 花瓣内部的着色：中心金黄 → 外缘玫粉
          const t = Math.min(1, u / Math.max(petalR, 1e-3));
          const inner = [1.0, 0.93, 0.62];      // 金黄花蕊
          const outer = [1.0, 0.46, 0.76];      // 玫粉花瓣
          let r = inner[0] + (outer[0] - inner[0]) * t;
          let g = inner[1] + (outer[1] - inner[1]) * t;
          let b = inner[2] + (outer[2] - inner[2]) * t;

          // 花瓣外缘再压亮一点，避免整朵花显得发暗
          const rim = Math.pow(t, 3.0);
          r = r + (1 - r) * rim * 0.16;
          g = g + (1 - g) * rim * 0.10;
          b = b + (1 - b) * rim * 0.14;

          // 中心发光：越靠中心越亮，模拟粒子堆积的强光
          const glow = Math.pow(1 - Math.min(1, u * 2.6), 2.0);
          r = r + (1 - r) * glow * 0.98;
          g = g + (1 - g) * glow * 0.98;
          b = b + (1 - b) * glow * 0.98;

          // 花瓣边缘柔化，避免锯齿
          const edge = Math.min(1, (petalR - u) * R * 0.9);
          const a = Math.min(1, edge) * (0.55 + 0.45 * (1 - t * 0.3));
          blend(x, y, r, g, b, a / (SS * SS));
        }
      }
    }
  }
  return px;
}

/* ---------- 2. 把 RGBA 编码成 PNG ---------- */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;                       // filter: none
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = y * (size * 4 + 1) + 1 + x * 4;
      raw[d]     = Math.round(Math.min(1, px[s])     * 255);
      raw[d + 1] = Math.round(Math.min(1, px[s + 1]) * 255);
      raw[d + 2] = Math.round(Math.min(1, px[s + 2]) * 255);
      raw[d + 3] = Math.round(Math.min(1, px[s + 3]) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 3. 打包成 ICO ---------- */
const SIZES = [16, 32, 48, 64, 128, 256];
const pngs = SIZES.map((s) => ({ size: s, data: encodePNG(renderFlower(s), s) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);            // reserved
header.writeUInt16LE(1, 2);            // type: 1 = icon
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + pngs.length * 16;
const entries = [];
for (const { size, data } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size;       // 256 用 0 表示
  e[1] = size >= 256 ? 0 : size;
  e[2] = 0;                            // 调色板数
  e[3] = 0;                            // reserved
  e.writeUInt16LE(1, 4);               // 颜色平面
  e.writeUInt16LE(32, 6);              // 位深
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
writeFileSync(new URL('./icon.ico', import.meta.url), ico);
writeFileSync(new URL('./icon-256.png', import.meta.url), pngs[pngs.length - 1].data);
console.log(`icon.ico 已生成：${SIZES.join(' / ')} 像素，共 ${(ico.length / 1024).toFixed(1)} KB`);
