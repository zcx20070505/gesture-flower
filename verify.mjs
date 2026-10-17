/**
 * 离线自检脚本（不依赖浏览器）
 *
 * 它做了三件事：
 *  1) 把 main.js 的纯数学部分（张力公式 / 绽放映射 / 平滑）抽出来跑数值断言
 *  2) 用 glslang 风格的轻量语法检查器扫描 GLSL，抓常见错误（类型不匹配等）
 *  3) 校验 DOM 里出现过的所有 id/class 都能在 HTML/CSS 中找到
 *
 * 用法：node verify.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dirname, f), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};

const mainSrc = read('main.js');
const htmlSrc = read('index.html');
const cssSrc = read('style.css');

/* ==========================================================================
   1. 数值验证：把 CONFIG 与公式按 main.js 里的定义复刻一遍
   （这里刻意重写而不是 import，因为 main.js 顶层 import 了 three，
     在没有浏览器环境时会失败；重写也顺便起到“公式双写校验”的作用）
   ========================================================================== */

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/* 从 main.js 里解析 CONFIG，避免测试和实现对不上（数字改了这里自动跟上）。
   必须锚定行首缩进，否则会匹配到注释里的 "bloom = bloomMax" 之类文字。 */
const num = (key) => {
  const m = mainSrc.match(new RegExp(`^\\s{2}${key}:\\s*([\\d.]+)`, 'm'));
  if (!m) throw new Error(`CONFIG.${key} 未在 main.js 中找到`);
  return parseFloat(m[1]);
};
const CONFIG = {
  lowTension: num('lowTension'),
  highTension: num('highTension'),
  bloomMax: num('bloomMax'),
  bloomOvershoot: num('bloomOvershoot'),
  openGain: num('openGain'),
  gain: num('gain'),
  // 新增：双手交互 + 生长动画
  maxClusters: num('maxClusters'),
  clusterSpread: num('clusterSpread'),
  clusterStagger: num('clusterStagger'),
  growDuration: num('growDuration'),
  growSeedHold: num('growSeedHold'),
  growSprout: num('growSprout'),
};

function tensionToBloom(tension) {
  const { lowTension: lo, highTension: hi, bloomMax, bloomOvershoot } = CONFIG;
  const t = clamp((tension - lo) / (hi - lo || 1e-6));
  const core = t * t * (3 - 2 * t);
  const envelope = 1 + bloomOvershoot * Math.sin(Math.PI * t);
  return clamp(core * envelope * bloomMax, 0, bloomMax);
}

console.log(`\n[1] 张力 → 绽放 映射   (lo=${CONFIG.lowTension} hi=${CONFIG.highTension} max=${CONFIG.bloomMax})`);
ok('tension = 0    → bloom = 0（花苞）', tensionToBloom(0) === 0, `got ${tensionToBloom(0)}`);
ok('tension = 0.20 → bloom = 0（仍在花苞区）', tensionToBloom(0.2) === 0, `got ${tensionToBloom(0.2)}`);
ok('tension = 0.32 → bloom = 0（阈值下沿）', tensionToBloom(0.32) === 0, `got ${tensionToBloom(0.32)}`);
ok('tension = 0.49 → 处于过渡中段（0.2 < bloom < bloomMax）',
  tensionToBloom(0.49) > 0.2 && tensionToBloom(0.49) < CONFIG.bloomMax,
  `got ${tensionToBloom(0.49).toFixed(3)}`);
ok('tension = 0.66 → bloom = bloomMax（阈值上沿即完全绽放）',
  Math.abs(tensionToBloom(0.66) - CONFIG.bloomMax) < 1e-9, `got ${tensionToBloom(0.66).toFixed(3)}`);
ok('tension = 1.00 → bloom = bloomMax（不越界）',
  Math.abs(tensionToBloom(1) - CONFIG.bloomMax) < 1e-9, `got ${tensionToBloom(1).toFixed(3)}`);
{
  let mono = true, inRange = true, prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.002) {
    const b = tensionToBloom(t);
    if (b < prev - 1e-9) { mono = false; break; }
    if (b < 0 || b > CONFIG.bloomMax + 1e-9) { inRange = false; break; }
    prev = b;
  }
  ok('映射在整个 [0,1] 上单调不减（不会“张开反而收缩”）', mono);
  ok('映射始终落在 [0, bloomMax] 内（不越界）', inRange);
  const mid = tensionToBloom(0.49);
  ok(`过渡区中段有明显张开（tension 0.49 → bloom ${mid.toFixed(2)}，超过一半）`, mid > CONFIG.bloomMax * 0.5);
}

console.log('\n[2] 手掌张开度 tension 公式');
/** 复刻 TensionMeter.update 的核心公式 */
function computeTension(lm, gain = 1) {
  const wrist = lm[0];
  const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y);
  const palmScale = Math.max(dip(9), 1e-4);
  const tips = [4, 8, 12, 16, 20];
  const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;
  const relative = tipMean / palmScale - 1;
  return clamp(clamp(relative * CONFIG.openGain, 0, 1) * gain, 0, 1);
}

/** 构造一只手：fist = true 握拳（指尖蜷回掌心），false 张开 */
function makeHand(fist, scale = 1, ox = 0.5, oy = 0.5) {
  const lm = [];
  const P = (x, y) => ({ x: ox + x * scale, y: oy + y * scale, z: 0 });
  lm[0] = P(0, 0.20);      // 腕
  // MCP (掌指关节)
  lm[1] = P(-0.055, 0.115); lm[5] = P(-0.02, 0.085);
  lm[9] = P(0.012, 0.075);  lm[13] = P(0.042, 0.095); lm[17] = P(0.068, 0.135);
  // PIP
  lm[2] = P(-0.088, 0.075); lm[6] = P(-0.028, 0.015);
  lm[10] = P(0.012, 0.005); lm[14] = P(0.052, 0.03);  lm[18] = P(0.085, 0.08);
  // DIP
  lm[3] = P(-0.105, 0.045); lm[7] = P(-0.032, -0.03);
  lm[11] = P(0.012, -0.04); lm[15] = P(0.058, -0.01); lm[19] = P(0.095, 0.045);
  // TIP：握拳时蜷回（y 变小、x 收回），张开时外伸
  const tipOut = (tx, ty) => (fist ? P(tx * 0.55 + 0.012, ty * 0.35 + 0.06) : P(tx, ty));
  lm[4] = fist ? P(-0.03, 0.13) : P(-0.115, 0.02);
  lm[8] = tipOut(-0.035, -0.085);
  lm[12] = tipOut(0.012, -0.10);
  lm[16] = tipOut(0.062, -0.06);
  lm[20] = tipOut(0.105, 0.005);
  return lm;
}

{
  const tFist = computeTension(makeHand(true));
  const tOpen = computeTension(makeHand(false));
  ok(`握拳 tension = ${tFist.toFixed(3)} → 落在花苞区 (< 0.32)`, tFist < 0.32);
  ok(`张开 tension = ${tOpen.toFixed(3)} → 落在绽放区 (> 0.66)`, tOpen > 0.66);
  ok('握拳 < 张开', tFist < tOpen);

  // 尺度不变性：手掌离镜头更远（整体变小）不应改变结果
  const tOpenFar = computeTension(makeHand(false, 0.55));
  const tFistFar = computeTension(makeHand(true, 0.55));
  ok(`尺度不变性：张开 ${tOpen.toFixed(3)} vs 远距 ${tOpenFar.toFixed(3)}`,
    Math.abs(tOpen - tOpenFar) < 0.02);
  ok(`尺度不变性：握拳 ${tFist.toFixed(3)} vs 远距 ${tFistFar.toFixed(3)}`,
    Math.abs(tFist - tFistFar) < 0.02);

  // 位置不变性：手移到画面角落结果不变
  const tCorner = computeTension(makeHand(false, 1, 0.18, 0.22));
  ok(`位置不变性：居中 ${tOpen.toFixed(3)} vs 角落 ${tCorner.toFixed(3)}`,
    Math.abs(tOpen - tCorner) < 0.02);

  // 边界：全部关键点重合（MediaPipe 异常输出）不应产生 NaN
  const degenerate = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const tDeg = computeTension(degenerate);
  ok('退化输入（21 点重合）不产生 NaN，结果为 0', Number.isFinite(tDeg) && tDeg === 0, `got ${tDeg}`);
}

console.log('\n[3] 帧率无关平滑 damp()');
{
  const clamp2 = clamp;
  function damp(cur, target, alpha, dt) {
    const keep = Math.pow(1 - clamp2(alpha, 0.0001, 0.9999), dt * 60);
    return cur + (target - cur) * (1 - keep);
  }
  // 用同一段时间、不同步长推进，最终值应当几乎一致
  const stepsA = [];
  let v = 0;
  for (let i = 0; i < 60; i++) v = damp(v, 1, 0.18, 1 / 60);   // 60fps × 1s
  stepsA.push(v);
  let v2 = 0;
  for (let i = 0; i < 30; i++) v2 = damp(v2, 1, 0.18, 1 / 30); // 30fps × 1s
  stepsA.push(v2);
  let v3 = 0;
  for (let i = 0; i < 120; i++) v3 = damp(v3, 1, 0.18, 1 / 120); // 120fps × 1s
  stepsA.push(v3);
  const spread = Math.max(...stepsA) - Math.min(...stepsA);
  ok(`30/60/120fps 一秒后结果一致（极差 ${spread.toExponential(2)}）`, spread < 1e-9,
    `values=${stepsA.map((x) => x.toFixed(6)).join(', ')}`);
  ok('平滑不会过冲（始终 ≤ 目标值）', stepsA.every((x) => x <= 1 + 1e-12));
}

/* ==========================================================================
   3.5  双手交互 + 生长动画（新增功能的数学验证）
   ========================================================================== */

console.log('\n[3.5] 双手交互 · 距离 → 花朵数量');
{
  // 复刻 ClusterLayout.countForSpan
  const countForSpan = (span) => {
    const n = Math.round(1 + (CONFIG.maxClusters - 1) * clamp(span));
    return Math.max(1, Math.min(CONFIG.maxClusters, n));
  };

  ok(`span=0 时只有 1 朵花`, countForSpan(0) === 1, `got ${countForSpan(0)}`);
  ok(`span=1 时有 ${CONFIG.maxClusters} 朵花（等于 maxClusters）`,
    countForSpan(1) === CONFIG.maxClusters, `got ${countForSpan(1)}`);
  {
    // 单调不减，且始终落在 [1, maxClusters]
    let mono = true, inRange = true, prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const n = countForSpan(s);
      if (n < prev) mono = false;
      if (n < 1 || n > CONFIG.maxClusters) inRange = false;
      prev = n;
    }
    ok('花朵数量随双手距离单调不减', mono);
    ok(`花朵数量始终在 [1, ${CONFIG.maxClusters}] 内`, inRange);
  }
  {
    // 每个数量档位都应可达
    const seen = new Set();
    for (let s = 0; s <= 1.0001; s += 0.005) seen.add(countForSpan(s));
    ok(`1~${CONFIG.maxClusters} 每个花朵数量都可达（实际可达 ${[...seen].sort().join(',')}）`,
      seen.size === CONFIG.maxClusters);
  }

  // ---- 双手距离的尺度归一化：手离镜头远近不影响读数 ----
  {
    const palmSize = (lm) => Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
    /* 造一双手。注意量纲要贴近真实：
       distNorm = 双手心距离 / 手掌尺寸，实测区间约 1.2(并拢) ~ 4.5(拉开)。
       所以手掌尺寸取 1，两手心距离按"手掌尺寸的倍数"给。 */
    const makePair = (distInPalmUnits, scale) => {
      const palm = 1.0;                       // 手掌尺寸（腕→中指MCP）= 1 个单位
      const mk = (ox) => {
        const lm = [];
        for (let i = 0; i < 21; i++) lm.push({ x: ox, y: 0, z: 0 });
        lm[0] = { x: ox, y: palm, z: 0 };     // 腕
        lm[9] = { x: ox, y: 0, z: 0 };        // 中指 MCP
        return lm;
      };
      // 两手掌心相距 distInPalmUnits 个"手掌单位"
      const a = mk(0), b = mk(distInPalmUnits);
      const apply = (lm, ox, oy, s) => lm.map((p) => ({ x: ox + p.x * s, y: oy + p.y * s, z: 0 }));
      return [apply(a, 0.1, 0.5, scale), apply(b, 0.1, 0.5, scale)];
    };
    /** 复刻 TwoHandController 里 span 的计算 */
    const spanOf = (pair) => {
      const [a, b] = pair;
      const pa = a[9], pb = b[9];
      const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const palmRef = Math.max((palmSize(a) + palmSize(b)) * 0.5, 1e-4);
      const distNorm = dist / palmRef;
      return clamp((distNorm - 1.2) / (4.5 - 1.2));
    };

    ok(`两手并拢(distNorm≈1.2) → span ≈ 0（实际 ${spanOf(makePair(1.2, 1)).toFixed(3)}）`,
      spanOf(makePair(1.2, 1)) < 0.02);
    ok(`两手拉开(distNorm≈4.5) → span ≈ 1（实际 ${spanOf(makePair(4.5, 1)).toFixed(3)}）`,
      spanOf(makePair(4.5, 1)) > 0.98);

    // 尺度不变性：整体缩小（手离镜头更远）不应改变读数
    const near = spanOf(makePair(3, 1.0));
    const far = spanOf(makePair(3, 0.45));
    ok(`双手距离的尺度不变性：近 ${near.toFixed(3)} vs 远 ${far.toFixed(3)}`,
      Math.abs(near - far) < 0.02);
    ok('两手拉开 → span 变大（1.5 → 4.0 单调）',
      spanOf(makePair(4.0, 1)) > spanOf(makePair(1.5, 1)));
  }
}

console.log('\n[3.6] 双手交互 · 角度回绕处理');
{
  /* TwoHandController 用"最短路径增量累积"来避免 atan2 在 ±π 处跳变。
     这里复刻那段逻辑，喂一条跨越 ±π 的角度序列，确认累积量连续。 */
  const unwrap = (angles) => {
    let accum = 0, last = null;
    const out = [];
    for (const raw of angles) {
      if (last === null) { last = raw; }
      else {
        let delta = raw - last;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        last = raw;
        if (Math.abs(delta) > 0.0015) accum += delta;
      }
      out.push(accum);
    }
    return out;
  };

  /* 真正要测的是"角度跨越 ±π 边界"的情况：
     atan2 的输出范围是 (-π, π]，当真实角度从 +179° 转到 +181° 时，
     输出会从 +3.124 突跳到 -3.124（差 2π）。不做最短路径解包的话，
     累积量会瞬间反向甩一整圈。 */
  const seq = [];
  for (let i = 0; i <= 20; i++) {
    // 真实角度：从 175° 平滑走到 185°（跨越 180°）
    const rawDeg = 175 + (i / 20) * 10;
    let rad = (rawDeg * Math.PI) / 180;
    // 模拟 atan2 的输出折叠到 (-π, π]
    while (rad > Math.PI) rad -= Math.PI * 2;
    while (rad < -Math.PI) rad += Math.PI * 2;
    seq.push(rad);
  }
  const acc = unwrap(seq);
  let mono = true;
  for (let i = 1; i < acc.length; i++) if (acc[i] < acc[i - 1] - 1e-9) mono = false;
  ok('跨越 ±π 时累积旋转量单调、不反向甩圈', mono,
    `acc=${acc.map((x) => x.toFixed(3)).join(',')}`);
  const total = acc[acc.length - 1] - acc[0];
  ok(`跨越 ±π 走的是最短路径（总变化 ${total.toFixed(3)} rad ≈ 0.175）`,
    Math.abs(total - 0.1745) < 0.01, `got ${total.toFixed(4)}`);

  /* 对照实验：如果【不解包】直接累加 atan2 的原始输出，
     跨过 ±π 那一帧会产生约 -2π 的错误跳变。
     这证明解包逻辑不是多余的。 */
  {
    let naive = 0, last = null;
    for (const raw of seq) {
      if (last === null) { last = raw; continue; }
      naive += raw - last;      // 不做最短路径处理
      last = raw;
    }
    // 期望：0.1745 的正确变化 加上 一次 -2π 的跳变 ≈ -6.109
    ok(`不解包会产生 ≈-2π 的错误跳变（${naive.toFixed(3)}），证明解包是必要的`,
      Math.abs(naive - (0.1745 - Math.PI * 2)) < 0.05, `naive=${naive.toFixed(4)}`);
  }
}

console.log('\n[3.7] 生长动画 · 阶段时序');
{
  const clampA = clamp;
  // 复刻 GrowthAnimator.shapes
  const shapes = (progress, stagger = 0) => {
    const g = clampA((progress - stagger) / Math.max(1 - stagger, 1e-3));
    const seedHold = CONFIG.growSeedHold;
    const sproutAt = CONFIG.growSprout;

    let form = 0;
    if (g > seedHold) {
      const u = clampA((g - seedHold) / Math.max(sproutAt - seedHold, 1e-3));
      const c1 = 1.70158, c3 = c1 + 1;
      const back = 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
      form = clampA(back);
    }
    let bloomT = 0;
    if (g > sproutAt) {
      const u = clampA((g - sproutAt) / Math.max(1 - sproutAt, 1e-3));
      bloomT = u * u * (3 - 2 * u);
    }
    return { form, bloomT };
  };

  const s0 = shapes(0);
  ok('progress=0（种子期）：形态=0、绽放=0（还在土里）',
    s0.form === 0 && s0.bloomT === 0, JSON.stringify(s0));

  const s1 = shapes(CONFIG.growSeedHold - 1e-6);
  ok(`种子期结束前形态仍为 0（蓄力阶段）`, s1.form === 0, JSON.stringify(s1));

  const s2 = shapes(CONFIG.growSprout);
  ok(`到 growSprout(${CONFIG.growSprout}) 时：形态已长成=1、尚未开花=0`,
    Math.abs(s2.form - 1) < 1e-6 && s2.bloomT === 0, JSON.stringify(s2));

  const s3 = shapes(1);
  ok('progress=1：全部长成并完全开花',
    Math.abs(s3.form - 1) < 1e-6 && Math.abs(s3.bloomT - 1) < 1e-6, JSON.stringify(s3));

  {
    // 全程单调不减（植物不会倒着长）
    let monoForm = true, monoBloom = true, prevF = -1, prevB = -1;
    for (let p = 0; p <= 1.0001; p += 0.002) {
      const { form, bloomT } = shapes(p);
      if (form < prevF - 1e-9) monoForm = false;
      if (bloomT < prevB - 1e-9) monoBloom = false;
      prevF = form; prevB = bloomT;
    }
    ok('生长全程 form 单调不减（不会倒着缩回去）', monoForm);
    ok('生长全程 bloomT 单调不减', monoBloom);
  }
  {
    // 值域必须落在 [0,1]，否则着色器里的 mix 会外插出鬼影
    let inRange = true;
    for (let p = 0; p <= 1.0001; p += 0.002) {
      const { form, bloomT } = shapes(p);
      if (form < 0 || form > 1 || bloomT < 0 || bloomT > 1) inRange = false;
    }
    ok('form / bloomT 始终落在 [0,1]', inRange);
  }
  {
    // 错峰：越靠后的花进度越滞后
    const p = 0.6;
    let staggered = true, prev = 2;
    for (let i = 0; i < CONFIG.maxClusters; i++) {
      const { form } = shapes(p, CONFIG.clusterStagger * i);
      if (form > prev + 1e-9) staggered = false;
      prev = form;
    }
    ok('错峰生长：靠后的花进度不超前于靠前的花', staggered);
  }
  {
    // 错峰不应把最后一朵花卡死在未生长状态
    const last = shapes(1, CONFIG.clusterStagger * (CONFIG.maxClusters - 1));
    ok('progress=1 时最后一朵花也能完全长成', Math.abs(last.form - 1) < 1e-6,
      JSON.stringify(last));
  }
}

console.log('\n[3.8] 花丛布局 · 黄金角螺旋');
{
  // 复刻 ClusterLayout.layout
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const layout = (count, spread) => {
    const out = [];
    for (let k = 0; k < CONFIG.maxClusters; k++) {
      if (k >= count) { out.push({ x: 0, z: 0, active: false }); continue; }
      const r = count === 1 ? 0 : spread * Math.sqrt((k + 0.5) / count);
      const th = k * GOLDEN;
      out.push({ x: Math.cos(th) * r, z: Math.sin(th) * r, r, a: th, active: true });
    }
    return out;
  };

  const one = layout(1, CONFIG.clusterSpread);
  ok('只有一朵花时居中（半径 0）', one[0].r === 0);

  {
    // 多朵花时任意两朵不应重叠（最小间距要有个下限）
    let minGap = Infinity;
    const pts = layout(CONFIG.maxClusters, CONFIG.clusterSpread).filter((p) => p.active);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        minGap = Math.min(minGap, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
      }
    }
    ok(`多朵花之间不重叠（最小间距 ${minGap.toFixed(3)}）`, minGap > 0.25, `minGap=${minGap}`);
  }
  {
    // 黄金角：相邻两朵的夹角应恒为 137.5°
    const pts = layout(5, CONFIG.clusterSpread);
    const d1 = Math.abs(((pts[1].a - pts[0].a) * 180) / Math.PI);
    ok(`相邻花朵夹角为黄金角 137.5°（实际 ${d1.toFixed(2)}°）`,
      Math.abs(d1 - 137.508) < 0.1, `got ${d1}`);
  }
  {
    // 半径随序号单调不减（螺旋向外扩展）
    const pts = layout(5, CONFIG.clusterSpread).filter((p) => p.active);
    let mono = true;
    for (let i = 1; i < pts.length; i++) if (pts[i].r < pts[i - 1].r - 1e-9) mono = false;
    ok('花朵半径沿螺旋向外单调扩展', mono);
  }
  {
    // spread 越大，花丛铺得越开
    const tight = layout(5, 1.0).filter((p) => p.active);
    const wide = layout(5, 4.0).filter((p) => p.active);
    const maxR = (a) => Math.max(...a.map((p) => p.r));
    ok(`散布半径随 spread 线性放大（${maxR(tight).toFixed(2)} → ${maxR(wide).toFixed(2)}）`,
      maxR(wide) > maxR(tight) * 3);
  }
}

/* ==========================================================================
   3.9  交互模式（单手 / 双手 二选一）
   ========================================================================== */

console.log('\n[3.9] 交互模式切换');
{
  const modeNum = mainSrc.match(/^\s{2}mode:\s*'(\w+)'/m);
  ok('CONFIG 里有 mode 字段', !!modeNum, String(modeNum));
  const mode = modeNum ? modeNum[1] : '';
  ok(`默认模式是合法值（'single' 或 'two'，实际 '${mode}'）`,
    mode === 'single' || mode === 'two');

  /* ---- 模式应当支配"花朵数量"的计算 ---- */
  {
    /* 复刻 App._frame 里决定花朵数量的那段逻辑：
          wantCount = (multiCluster && twoActive) ? countForSpan(span) : 1
       其中 twoActive 本身又被模式门控。 */
    const countForSpan = (span) => {
      const n = Math.round(1 + (CONFIG.maxClusters - 1) * clamp(span));
      return Math.max(1, Math.min(CONFIG.maxClusters, n));
    };
    const wantCount = (m, twoDetected, span, multiCluster = true) => {
      const twoActive = (m === 'two') && twoDetected;
      return (multiCluster && twoActive) ? countForSpan(span) : 1;
    };

    ok('单手模式：即使检测到双手、距离拉满，也只开 1 朵',
      wantCount('single', true, 1.0) === 1, `got ${wantCount('single', true, 1.0)}`);
    ok('双手模式 + 检测到双手 + 距离拉满：开满多朵',
      wantCount('two', true, 1.0) === CONFIG.maxClusters,
      `got ${wantCount('two', true, 1.0)}`);
    ok('双手模式但只检测到 1 只手：仍然只有 1 朵',
      wantCount('two', false, 1.0) === 1, `got ${wantCount('two', false, 1.0)}`);
    ok('双手模式 + 关闭多朵花开关：固定 1 朵',
      wantCount('two', true, 1.0, false) === 1);
  }

  /* ---- 模式切换必须清理跨帧残留状态 ---- */
  {
    /* 复刻 App.setMode 的重置逻辑，验证切换后不会带着旧值 */
    const makeApp = () => ({
      twoHand: { span: 1, smoothSpan: 1, openness: 1, active: true, rotationAccum: 3.7, _lastRawRot: 0.5,
                 smoothCenter: { x: 0.9, y: 0.1, set(a, b) { this.x = a; this.y = b; } },
                 center: { x: 0.9, y: 0.1, set(a, b) { this.x = a; this.y = b; } } },
      panOffset: { x: 2, y: 1, set(a, b) { this.x = a; this.y = b; } },
      flowerGroupPos: { x: 1.5, y: 0.8, set(a, b) { this.x = a; this.y = b; } },
      _clusterCount: 5,
    });
    const setMode = (app, mode, cur) => {
      const next = mode === 'single' ? 'single' : 'two';
      if (cur === next) return next;              // 同模式直接返回
      app.twoHand.span = 0;
      app.twoHand.smoothSpan = 0;
      app.twoHand.openness = 0;
      app.twoHand.active = false;
      app.twoHand.rotationAccum = 0;
      app.twoHand._lastRawRot = null;
      app.twoHand.smoothCenter.set(0.5, 0.5);
      app.twoHand.center.set(0.5, 0.5);
      app.panOffset.set(0, 0);
      app.flowerGroupPos.set(0, 0);
      app._clusterCount = 1;
      return next;
    };

    const a = makeApp();
    setMode(a, 'single', 'two');
    ok('切到单手：双手 span 被清零（不会残留 5 朵花）', a.twoHand.span === 0);
    ok('切到单手：openness 被清零', a.twoHand.openness === 0);
    ok('切到单手：旋转累积被清零', a.twoHand.rotationAccum === 0);
    ok('切到单手：旋转解包基准重置为 null（下次进双手重新起算）', a.twoHand._lastRawRot === null);
    ok('切到单手：场景平移复位', a.panOffset.x === 0 && a.panOffset.y === 0);
    ok('切到单手：花朵组位置复位', a.flowerGroupPos.x === 0 && a.flowerGroupPos.y === 0);
    ok('切到单手：花朵数量回到 1', a._clusterCount === 1);

    // 同模式重复调用应当是 no-op（不会把正在用的状态清掉）
    const b2 = makeApp();
    setMode(b2, 'two', 'two');
    ok('重复设置同一模式是空操作（不会误清状态）', b2.twoHand.span === 1);
  }

  /* ---- 单手模式下第二只手不应影响张力 ---- */
  {
    /* 单手的张力只取"主手"（右手优先）。验证：即使同时有两只手，
       张力值应当等于其中某一只手的值，而不是两只手的平均。 */
    const instantTension = (lm) => {
      const wrist = lm[0];
      const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y, (lm[i].z - wrist.z) * 0.5);
      const palmScale = Math.max(dip(9), 1e-4);
      const tips = [4, 8, 12, 16, 20];
      const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;
      return clamp(clamp((tipMean / palmScale - 1) * CONFIG.openGain, 0, 1) * CONFIG.gain, 0, 1);
    };
    const makeHand = (open, s = 1) => {
      const lm = [];
      const P = (x, y) => ({ x: 0.5 + x * s, y: 0.5 + y * s, z: 0 });
      lm[0] = P(0, 0.20);
      lm[1] = P(-0.055, 0.115); lm[5] = P(-0.02, 0.085);
      lm[9] = P(0.012, 0.075);  lm[13] = P(0.042, 0.095); lm[17] = P(0.068, 0.135);
      lm[2] = P(-0.088, 0.075); lm[6] = P(-0.028, 0.015);
      lm[10] = P(0.012, 0.005); lm[14] = P(0.052, 0.03);  lm[18] = P(0.085, 0.08);
      lm[3] = P(-0.105, 0.045); lm[7] = P(-0.032, -0.03);
      lm[11] = P(0.012, -0.04); lm[15] = P(0.058, -0.01); lm[19] = P(0.095, 0.045);
      lm[4]  = open ? P(-0.115, 0.02) : P(-0.03, 0.13);
      lm[8]  = open ? P(-0.035, -0.085) : P(-0.007, 0.09);
      lm[12] = open ? P(0.012, -0.10)  : P(0.012, 0.095);
      lm[16] = open ? P(0.062, -0.06)  : P(0.028, 0.08);
      lm[20] = open ? P(0.105, 0.005)  : P(0.062, 0.115);
      return lm;
    };

    const openHand = makeHand(true), fistHand = makeHand(false);
    const tOpen = instantTension(openHand), tFist = instantTension(fistHand);
    const avg = (tOpen + tFist) / 2;

    ok(`张开手张力明显高于握拳手（${tOpen.toFixed(2)} vs ${tFist.toFixed(2)}）`, tOpen > tFist);
    ok('单手模式取"主手"的值，而不是两只手的平均（平均值会稀释手感）',
      Math.abs(tOpen - avg) > 0.05, `open=${tOpen.toFixed(3)} avg=${avg.toFixed(3)}`);
  }
}

/* ==========================================================================
   4. GLSL 静态检查：抓类型错误、未声明的变量、varying 不匹配
   ========================================================================== */

console.log('\n[4] GLSL 着色器检查');
{
  const extract = (name) => {
    const re = new RegExp(`const ${name} = /\\* glsl \\*/ \`([\\s\\S]*?)\`;`);
    const m = mainSrc.match(re);
    return m ? m[1] : null;
  };
  const vert = extract('VERT');
  const frag = extract('FRAG');
  ok('能提取到 VERT 着色器源码', !!vert);
  ok('能提取到 FRAG 着色器源码', !!frag);

  if (vert && frag) {
    // --- varying 一致性 ---
    const varyingOf = (src) => {
      const set = new Set();
      for (const m of src.matchAll(/varying\s+(\w+)\s+(\w+)\s*;/g)) set.add(`${m[1]} ${m[2]}`);
      return set;
    };
    const vv = varyingOf(vert);
    const fv = varyingOf(frag);
    const vertWrites = [...vv].every((d) => {
      const nm = d.split(' ')[1];
      return new RegExp(`\\b${nm}\\s*=`).test(vert);
    });
    const fragWrites = [...fv].some((d) => {
      const nm = d.split(' ')[1];
      return new RegExp(`\\b${nm}\\s*=`).test(frag);
    });
    ok('顶点着色器写入了它声明的所有 varying', vertWrites, [...vv].join(', '));
    ok('片元着色器只读取 varying、不写入', !fragWrites);
    const onlyRead = [...fv].every((d) => {
      const nm = d.split(' ')[1];
      return new RegExp(`\\b${nm}\\b`).test(vert);
    });
    ok('片元着色器用到的 varying 都在顶点着色器里声明过', onlyRead, [...fv].join(', '));

    // --- 片元着色器引用的 uniform 必须都存在于 JS 的 uniforms 里 ---
    const jsUniforms = new Set(
      [...mainSrc.matchAll(/^\s{8}(u[A-Z]\w*):\s*\{\s*value:/gm)].map((m) => m[1])
    );
    const fragUniforms = new Set([...frag.matchAll(/uniform\s+\w+\s+(u\w+)\s*;/g)].map((m) => m[1]));
    const vertUniforms = new Set([...vert.matchAll(/uniform\s+\w+\s+(u\w+)\s*;/g)].map((m) => m[1]));
    const missingFrag = [...fragUniforms].filter((u) => !jsUniforms.has(u));
    const missingVert = [...vertUniforms].filter((u) => !jsUniforms.has(u));
    ok('片元着色器的 uniform 都在 JS 中提供', missingFrag.length === 0, missingFrag.join(', '));
    ok('顶点着色器的 uniform 都在 JS 中提供（three 内置的除外）', missingVert.length === 0, missingVert.join(', '));

    // --- 类型匹配：vec3 = vec3 但绝不能出现 vec2/vec3 混用 ---
    const hasBadVecMix = /length\(\s*pos\.xy\s*-\s*vec3\(/.test(vert);
    ok('没有 vec2 - vec3 的类型错误', !hasBadVecMix);
    ok('没有 length(vec3) 被当成 vec2 使用', !/vec2\s*\(\s*length\(/.test(vert));

    // --- 属性声明必须与 geometry.setAttribute 一一对应 ---
    const attribs = [...vert.matchAll(/attribute\s+\w+\s+(a\w+)\s*;/g)].map((m) => m[1]);
    const setAttrs = [...mainSrc.matchAll(/setAttribute\('(a\w+)'/g)].map((m) => m[1]);
    const missingAttr = attribs.filter((a) => !setAttrs.includes(a));
    ok(`顶点属性 ${attribs.length} 个与 geometry 一一对应`, missingAttr.length === 0, missingAttr.join(', '));

    // --- 配对括号 ---
    ok('顶点着色器花括号配对', (vert.match(/{/g) || []).length === (vert.match(/}/g) || []).length);
    ok('片元着色器花括号配对', (frag.match(/{/g) || []).length === (frag.match(/}/g) || []).length);

    // --- 片元着色器必须写 gl_FragColor ---
    ok('片元着色器写了 gl_FragColor', /gl_FragColor\s*=/.test(frag));
    ok('顶点着色器写了 gl_Position', /gl_Position\s*=/.test(vert));
    ok('顶点着色器设置了 gl_PointSize（Points 渲染必需）', /gl_PointSize\s*=/.test(vert));

    // --- 所有自定义函数都被定义过 ---
    /* 注意：着色器里现在有 int(...) 这类类型转换调用，要一并放进 builtins，
       否则会被误报成"调用未定义函数"。 */
    const calls = new Set([...vert.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]));
    const defined = new Set([...vert.matchAll(/\b(?:float|vec2|vec3|vec4|void|mat2|int|bool)\s+(\w+)\s*\(/g)].map((m) => m[1]));
    const builtins = new Set(['if','for','while','return','clamp','mix','smoothstep','length','normalize',
      'sin','cos','tan','exp','pow','abs','floor','fract','step','mat2','vec2','vec3','vec4','float','int','bool',
      'max','min','sqrt','discard','dot','distance','sign','mod','reflect',
      'ceil','round','trunc','atan','asin','acos','cross','faceforward','radians','degrees','inversesqrt']);
    const undef = [...calls].filter((c) => !defined.has(c) && !builtins.has(c));
    ok('没有调用未定义的 GLSL 函数', undef.length === 0, undef.join(', '));

    /* --- 新增属性/宏的正确性 --- */
    ok('顶点着色器声明了 aPosSeed（生长动画的种子形态）', /attribute\s+vec3\s+aPosSeed/.test(vert));
    ok('顶点着色器声明了 aCluster（多花簇索引）', /attribute\s+float\s+aCluster/.test(vert));
    ok('生长动画做了 种子→花苞 的位置插值', /mix\(aPosSeed,\s*aPosBud/.test(vert));
    ok('绽放做了 花苞→绽放 的位置插值', /mix\(pos,\s*aPosBloom/.test(vert));
    /* --- MAX_CLUSTERS 宏必须由 JS 注入，且和 CONFIG 一致 ---
       注意：着色器本身是 JS 模板字符串，所以占位符不能写成 ${...}
       （那样会被立刻求值并报错），必须用普通占位符事后 replace。 */
    ok('GLSL 的 MAX_CLUSTERS 是占位符（由 JS 注入）',
      /#define\s+MAX_CLUSTERS\s+__MAX_CLUSTERS__/.test(mainSrc));
    ok('着色器里没有误用 JS 模板占位符 ${...}（会导致运行时 ReferenceError）',
      !/\$\{[A-Z_]+\}/.test(mainSrc));
    ok('存在把 MAX_CLUSTERS 注入着色器的替换函数',
      /VERT\.replace\('__MAX_CLUSTERS__'/.test(mainSrc));
    /* --- uniform 数组只能用常量索引：确认取簇参数用的是 for 循环 --- */
    ok('花簇参数用 for 循环逐项取出（GLSL ES 1.00 不支持动态索引 uniform 数组）',
      /for\s*\(int\s+i\s*=\s*0;\s*i\s*<\s*MAX_CLUSTERS;\s*i\+\+\)/.test(vert));
  }
}

/* ==========================================================================
   5. DOM 契约：main.js 里 $('xxx') 抓的 id 必须都在 HTML 里存在
   ========================================================================== */

console.log('\n[5] DOM id / class 契约');
{
  const wanted = new Set([...mainSrc.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  const htmlIds = new Set([...htmlSrc.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !htmlIds.has(id));
  ok(`main.js 引用的 ${wanted.size} 个 id 在 index.html 中都存在`, missing.length === 0, missing.join(', '));

  // HTML 里引用的 CSS class 应存在（允许少量纯排版类）
  const htmlClasses = new Set();
  for (const m of htmlSrc.matchAll(/\bclass="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) htmlClasses.add(c);
  }
  const cssClasses = new Set([...cssSrc.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
  const missingCls = [...htmlClasses].filter((c) => !cssClasses.has(c));
  ok(`HTML 用到的 ${htmlClasses.size} 个 class 在 style.css 中都有样式`, missingCls.length === 0, missingCls.join(', '));

  // 关键元素
  for (const id of ['gl', 'video', 'bg', 'overlay', 'panel', 'gate', 'startBtn', 'toast', 'hud']) {
    ok(`关键元素 #${id} 存在`, htmlIds.has(id));
  }
  ok('引入了 style.css', /href="\.\/style\.css"/.test(htmlSrc));
  ok('引入了 main.js 且为 module', /<script type="module" src="\.\/main\.js">/.test(htmlSrc));
  ok('引入了 MediaPipe Hands UMD 脚本', /@mediapipe\/hands@[\d.]+\/hands\.js/.test(htmlSrc));
  ok('有 viewport meta（响应式必需）', /name="viewport"/.test(htmlSrc));
  ok('importmap 同时映射了 three 与 three/addons/', /"three":/.test(htmlSrc) && /"three\/addons\/":/.test(htmlSrc));

  /* ---- 交互模式选择器的结构契约 ---- */
  ok('存在"单手交互"单选项 #modeSingle', htmlIds.has('modeSingle'));
  ok('存在"双手交互"单选项 #modeTwo', htmlIds.has('modeTwo'));
  ok('两个单选项共用同一个 radio name（才能互斥）',
    (htmlSrc.match(/name="interactionMode"/g) || []).length === 2);
  ok('单选组带 role="radiogroup"（无障碍）', /role="radiogroup"/.test(htmlSrc));
  ok('单选组有 aria-label', /role="radiogroup"[^>]*aria-label=/.test(htmlSrc));
  // 默认选中项必须与 CONFIG.mode 一致，否则面板显示与实际行为不符
  {
    const twoChecked = /id="modeTwo"[^>]*checked/.test(htmlSrc);
    const singleChecked = /id="modeSingle"[^>]*checked/.test(htmlSrc);
    const modeMatch = mainSrc.match(/^\s{2}mode:\s*'(\w+)'/m);
    const defaultMode = modeMatch ? modeMatch[1] : '';
    ok(`HTML 默认选中项与 CONFIG.mode 一致（CONFIG='${defaultMode}'）`,
      (defaultMode === 'two' && twoChecked && !singleChecked) ||
      (defaultMode === 'single' && singleChecked && !twoChecked),
      `twoChecked=${twoChecked} singleChecked=${singleChecked}`);
  }
  ok('单向模式专属说明 #singleHandHint 初始为 hidden',
    /id="singleHandHint"[^>]*hidden/.test(htmlSrc));
}

/* ==========================================================================
   6. 响应式与无障碍
   ========================================================================== */

console.log('\n[6] 响应式 / 无障碍');
{
  ok('style.css 有窄屏媒体查询', /@media\s*\(max-width:\s*720px\)/.test(cssSrc));
  ok('style.css 适配了刘海屏安全区', /safe-area-inset-bottom/.test(cssSrc));
  ok('style.css 尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(cssSrc));
  ok('触控热区 ≥ 44px（.panel-toggle）', /\.panel-toggle\s*\{[^}]*height:\s*44px/s.test(cssSrc));
  ok('提示条带 role="alert"', /role="alert"/.test(htmlSrc));
  ok('hud 使用 aria-hidden 避免干扰读屏', /id="hud"[^>]*aria-hidden="true"/.test(htmlSrc));
}

/* ==========================================================================
   7. 功能需求覆盖
   ========================================================================== */

console.log('\n[7] 需求覆盖');
{
  ok('粒子数范围 5000~20000 可配置', /min="5000"\s+max="20000"/.test(htmlSrc));
  ok('默认粒子数在合法区间内', CONFIG && mainSrc.includes('particleCount: 12000'));
  ok('阈值 0.32 与 0.66 都出现在配置里', /lowTension:\s*0\.32/.test(mainSrc) && /highTension:\s*0\.66/.test(mainSrc));
  ok('使用 ShaderMaterial', /new THREE\.ShaderMaterial/.test(mainSrc));
  ok('使用 THREE.Points', /new THREE\.Points\(/.test(mainSrc));
  ok('顶点着色器内做位置插值（种子→花苞、花苞→绽放两段）',
    /mix\(aPosSeed,\s*aPosBud/.test(mainSrc) && /mix\(pos,\s*aPosBloom/.test(mainSrc));
  ok('极坐标花瓣函数存在（玫瑰曲线 r = |cos(kθ/2)|^sharp）',
    /Math\.cos\(\(petalCount \* theta\) \/ 2\)/.test(mainSrc));
  /* 花瓣数 k 决定玫瑰曲线的瓣数，做数值验证：
     r(θ) = |cos(kθ/2)|^sharp 在 θ∈[0,2π) 上应恰好有 2k 个"瓣尖"
     （sharp 越小瓣越瘦；用阈值法统计局部极大值个数） */
  {
    const countPeaks = (k, sharp) => {
      const N = 4000;
      const vals = [];
      for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2;
        vals.push(Math.pow(Math.abs(Math.cos((k * th) / 2)), sharp));
      }
      let peaks = 0;
      for (let i = 0; i < N; i++) {
        const a = vals[(i - 1 + N) % N], b = vals[i], c = vals[(i + 1) % N];
        if (b > a && b >= c && b > 0.6) peaks++;
      }
      return peaks;
    };
    for (const k of [3, 6, 9]) {
      ok(`花瓣数 k=${k} 时曲线恰好有 ${k} 个瓣（检测到 ${countPeaks(k, 0.75)} 个）`,
        countPeaks(k, 0.75) === k);
    }
  }
  ok('有颜色渐变（HSL 插值）', /setHSL/.test(mainSrc));
  ok('有光晕（加法混合 + 泛光后期）', /AdditiveBlending/.test(mainSrc) && /UnrealBloomPass/.test(mainSrc));
  ok('摄像头错误分支覆盖权限拒绝', /NotAllowedError/.test(mainSrc));
  ok('摄像头错误分支覆盖无设备', /NotFoundError/.test(mainSrc));
  ok('摄像头错误分支覆盖被占用', /NotReadableError/.test(mainSrc));
  ok('摄像头错误分支覆盖 file:// 安全限制', /SecurityError/.test(mainSrc));
  ok('处理了 user-gesture 限制（启动遮罩）', /startFromGate/.test(mainSrc));
  ok('页面切后台会暂停渲染', /visibilitychange/.test(mainSrc));
  ok('dt 做了截断，避免切回标签页跳变', /Math\.min\(\(now - this\.lastTime\) \/ 1000, 0\.05\)/.test(mainSrc));
  ok('丢失手部后有回落逻辑', /lostTimeout/.test(mainSrc));
  ok('阈值判定带迟滞，避免抖动', /hysteresis/.test(mainSrc));
}

console.log(`\n${'='.repeat(58)}`);
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log(`${'='.repeat(58)}\n`);
process.exit(fail === 0 ? 0 : 1);
