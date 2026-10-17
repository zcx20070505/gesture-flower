/**
 * 生成 README 用的展示截图（写入 docs/screenshots/）
 *
 * 为什么要单独写这个脚本：README 里的配图必须能随时重新生成，
 * 而且截图时要把控件的状态调到位（关摄像头背景、拉满生长、停旋转），
 * 手动截很难复现。
 *
 * 用法：先起 http 服务，再 node docs/shots.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.TEST_URL || 'http://127.0.0.1:5500/index.html';
const OUT = 'D:/deepseek/gesture-flower/docs/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['camera'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__flowerApp !== undefined, { timeout: 45000 });

// ---- 首屏：启动遮罩 ----
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/00-start.png` });
console.log('✓ 00-start.png（启动界面）');

await page.click('#startBtn');
await page.waitForTimeout(2500);

/* ---------- 工具：把一双手喂进 HandTracker ---------- */
async function feedHands(sepX, openA = true, openB = true) {
  return page.evaluate(({ sepX, openA, openB }) => {
    const makeHand = (cx, cy, spread, open) => {
      const lm = [];
      const P = (x, y) => ({ x: cx + x * spread, y: cy + y * spread, z: 0 });
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
    const app = window.__flowerApp;
    const ht = app.handTracker;
    const a = makeHand(0.5 - sepX / 2, 0.5, 1.0, openA);
    const b = makeHand(0.5 + sepX / 2, 0.5, 1.0, openB);
    const pack = (lm, label) => {
      const ids = [0, 5, 9, 13, 17];
      let cx = 0, cy = 0;
      for (const k of ids) { cx += lm[k].x; cy += lm[k].y; }
      return { landmarks: lm, label, score: 0.99, pointer: { x: cx / 5, y: cy / 5 } };
    };
    const data = [pack(a, 'Left'), pack(b, 'Right')];
    if (!ht.__origHandle) ht.__origHandle = ht._handleResults.bind(ht);
    ht._handleResults = () => {};
    ht.handsData = data;
    ht.twoHandActive = true;
    ht.lastLandmarks = b;
    ht.pointerActive = true;
    ht.running = true;
    app.useManual = false;
    for (let i = 0; i < 240; i++) app.twoHand.update(data, 1 / 60);
    return { span: app.twoHand.span };
  }, { sepX, openA, openB });
}

/** 准备画面：关摄像头背景、停自动旋转、设定张力与生长 */
async function prep({ tension = 1, grow = 1, panelOpen = false }) {
  await page.evaluate(({ tension, grow, panelOpen }) => {
    const app = window.__flowerApp;
    const sv = document.getElementById('showVideo');
    sv.checked = false;
    sv.dispatchEvent(new Event('change', { bubbles: true }));
    const ar = document.getElementById('autoRotate');
    ar.value = '0';
    ar.dispatchEvent(new Event('input', { bubbles: true }));
    const mt = document.getElementById('manualTension');
    mt.value = String(tension);
    mt.dispatchEvent(new Event('input', { bubbles: true }));
    app.growth.progress = grow;
    app.growth.autoPlaying = false;
    app.growth.useGesture = false;
    app.manualGrowOn = false;

    /* 直接钉住张力与绽放值：软件渲染只有 ~5fps，
       靠主循环的 damp 收敛会很慢，等不干净就会截到过渡中间态
       （表现为花朵半透明、残留上一帧的拖影）。

       注意：page.evaluate 的函数是被序列化后注入页面的，
       看不到 Node 侧的辅助函数，所以这里必须把公式内联。 */
    const tensionToBloom = (t) => {
      const lo = 0.32, hi = 0.66, max = 1.35, over = 0.22;
      const u = Math.max(0, Math.min(1, (t - lo) / (hi - lo)));
      const core = u * u * (3 - 2 * u);
      const env = 1 + over * Math.sin(Math.PI * u);
      return Math.max(0, Math.min(max, core * env * max));
    };

    app.manualTension = tension;
    app.tension.value = tension;
    app.tension.raw = tension;
    app.tension.bloom = tensionToBloom(tension);
    app.manualBloom = 0;

    /* 花朵组摆正：让花冠正对镜头，截出来的花瓣最清楚 */
    const g = app.stage.flower.group;
    g.rotation.y = 0;

    const panel = document.getElementById('panel');
    const isOpen = panel.classList.contains('open');
    if (panelOpen !== isOpen) document.getElementById('panelToggle').click();
  }, { tension, grow, panelOpen });
}

/* 让绽放度立即稳定下来，并跑够帧数让 GPU 画完。
   主循环每帧都会用张力重算 c.bloom，所以只"推一次"没用，
   这里持续按住一段时间（用 rAF 循环反复写），截出来的才是稳定状态。 */
async function settle(ms = 4000) {
  await page.evaluate(async (duration) => {
    const app = window.__flowerApp;
    const t0 = performance.now();
    while (performance.now() - t0 < duration) {
      for (const c of app.clusters) {
        if (c.scale > 0.15) {
          c.bloom = Math.min(2.2, c.grow > 0.55 ? app.tension.bloom : 0);
        }
      }
      // 同时把张力钉死，防止手动模式的 damp 把它拉回去
      app.tension.value = app.manualTension;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, ms);
  // 再等两帧，确保最后一帧已经合成到屏幕
  await page.waitForTimeout(300);
}

/* ---------- 1. 单手模式 · 花朵绽放 ---------- */
await page.evaluate(() => {
  const r = document.getElementById('modeSingle');
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await prep({ tension: 1, grow: 1 });
await settle(6000);
await page.screenshot({ path: `${OUT}/01-single-bloom.png` });
console.log('✓ 01-single-bloom.png（单手模式 · 完全绽放）');

/* ---------- 2. 单手模式 · 花苞闭合 ---------- */
await prep({ tension: 0, grow: 1 });
await settle(5000);
await page.screenshot({ path: `${OUT}/02-single-bud.png` });
console.log('✓ 02-single-bud.png（单手模式 · 花苞闭合）');

/* ---------- 3. 双手模式 · 一片花丛 ---------- */
await page.evaluate(() => {
  const r = document.getElementById('modeTwo');
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await prep({ tension: 1, grow: 1 });
await feedHands(0.88, true, true);
await settle(10000);
await page.screenshot({ path: `${OUT}/03-two-hands-garden.png` });
console.log('✓ 03-two-hands-garden.png（双手模式 · 五朵花丛）');

/* ---------- 4. 生长动画：发芽阶段 ---------- */
await page.evaluate(() => {
  const r = document.getElementById('modeSingle');
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await prep({ tension: 1, grow: 0.42 });
await settle(6000);
await page.screenshot({ path: `${OUT}/04-growth-sprout.png` });
console.log('✓ 04-growth-sprout.png（生长动画 · 发芽）');

/* ---------- 5. 生长动画：种子阶段 ---------- */
await prep({ tension: 1, grow: 0.05 });
await settle(5000);
await page.screenshot({ path: `${OUT}/05-growth-seed.png` });
console.log('✓ 05-growth-seed.png（生长动画 · 种子）');

/* ---------- 6. 控制面板（带摄像头背景） ---------- */
await page.evaluate(() => {
  const r = document.getElementById('modeTwo');
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
});
await prep({ tension: 1, grow: 1, panelOpen: true });
await page.evaluate(() => {
  const sv = document.getElementById('showVideo');
  sv.checked = true;
  sv.dispatchEvent(new Event('change', { bubbles: true }));
});
await settle(6000);
await page.screenshot({ path: `${OUT}/06-panel.png` });
console.log('✓ 06-panel.png（控制面板）');

await browser.close();
console.log('\n全部截图已生成到', OUT);
