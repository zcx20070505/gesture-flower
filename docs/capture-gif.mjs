/**
 * 捕获 GIF 演示素材
 *
 * 思路：不依赖实时播放（软件渲染只有 ~5fps，实时截会很卡），
 * 而是【逐帧设定状态】→ 等渲染稳定 → 截图。
 * 这样每一帧的画面都由我们精确控制，动画节奏也可控。
 *
 * 用法：先起 http 服务（端口 5500），再 node docs/capture-gif.mjs
 * 输出：docs/gif-frames/frame-000.png ...
 */
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';

const OUT = 'D:/deepseek/gesture-flower/docs/gif-frames';
const URL = 'http://127.0.0.1:5500/index.html';

// 画面尺寸：16:10，兼顾清晰度与 GIF 体积
const W = 800, H = 500;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, permissions: ['camera'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__flowerApp !== undefined, { timeout: 45000 });
await page.click('#startBtn');
await page.waitForTimeout(2500);

/* ---------------------------------------------------------------------------
   在页面里安装"状态钉住"钩子
   ---------------------------------------------------------------------------
   主循环每帧都会重算 clusters 的 pos/scale/grow/bloom，
   如果只在截图前设一次，会被下一帧覆盖掉。
   这里包住 stage.render，在它执行前把状态写进去，
   保证每一帧渲染的都是我们指定的画面。
--------------------------------------------------------------------------- */
await page.evaluate(() => {
  const app = window.__flowerApp;
  const st = app.stage;

  // 关闭摄像头背景（测试用的假摄像头画面是绿色斑块，不适合做演示）
  const sv = document.getElementById('showVideo');
  sv.checked = false;
  sv.dispatchEvent(new Event('change', { bubbles: true }));

  // 停掉自动旋转，改由脚本控制
  const ar = document.getElementById('autoRotate');
  ar.value = '0';
  ar.dispatchEvent(new Event('input', { bubbles: true }));

  // 关掉面板，留出干净画面
  const panel = document.getElementById('panel');
  if (panel.classList.contains('open')) document.getElementById('panelToggle').click();

  /* 隐藏 HUD 与标题栏：GIF 是为了展示花朵效果，
     UI 上的数字（尤其是被我"钉住"状态后不同步的数值）会分散注意力。
     保留标题更友好，但小尺寸下标题也嫌挤，这里一并隐掉。 */
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = 'none';
  const title = document.querySelector('.title');
  if (title) title.style.display = 'none';
  const toggle = document.getElementById('panelToggle');
  if (toggle) toggle.style.display = 'none';

  /* 相机取景：默认相机在 5.6 处，5 朵花铺开时会出画面。
     GIF 画面比网页更窄，需要拉远并抬高一点，让整片花丛落在框内。 */
  st.camera.position.set(0, 1.8, 6.9);
  st.camera.lookAt(0, -0.1, 0);
  st.camera.updateProjectionMatrix();

  /* 关掉背景星尘：它在大屏上是氛围装饰，但在 GIF 这种小尺寸下
     会变成一堆杂散亮点（尤其淡蓝色的那些），干扰主体。
     GIF 需要的是干净的高对比画面。 */
  if (st.stars) st.stars.visible = false;

  /* 提亮：GIF 会在各种设备/聊天窗口里被缩放压缩，
     亮度不够就会糊成一团黑。

     注意：Stage.render 在调用 composer.render() 之前会按 bloom 重算曝光，
     直接改 renderer.toneMappingExposure 会被覆盖。
     所以这里在 composer.render 上再包一层，在它真正执行前一刻写入亮度，
     确保是最后生效的那个值。 */
  const origComposerRender = st.composer.render.bind(st.composer);
  st.composer.render = (...args) => {
    st.renderer.toneMappingExposure = 1.45;
    if (st.bloomPass) {
      // 泛光适中：既要光晕，又不能把花瓣细节糊掉
      st.bloomPass.strength = 0.88;
      st.bloomPass.radius = 0.60;
      st.bloomPass.threshold = 0.26;
    }
    return origComposerRender(...args);
  };

  window.__pin = null;

  const origRender = st.render.bind(st);
  st.render = (dt, s) => {
    const pin = window.__pin;

    /* 相机每帧强制锁定：resize() 会重设相机位置，
       而截图尺寸固定、理论上不会触发 resize，但保险起见每帧写一次。 */
    st.camera.position.set(0, pin ? (pin.camY ?? 1.8) : 1.8, pin ? (pin.camZ ?? 6.9) : 6.9);
    st.camera.lookAt(0, -0.1, 0);
    st.camera.updateProjectionMatrix();


    if (pin) {
      s.bloom = pin.bloom;
      s.grow = pin.grow;
      s.growTime = 2.0;
      s.pointerActive = false;
      s.clusterRotate = pin.rot;

      /* 直接写入 clusters：pos 用 layout 算好的螺旋坐标，
         scale/grow/bloom 由帧脚本给出 */
      for (let i = 0; i < pin.clusters.length && i < app.clusters.length; i++) {
        const c = app.clusters[i];
        const p = pin.clusters[i];
        c.pos.set(p.x, p.y, p.z);
        c.scale = p.scale;
        c.grow = p.grow;
        c.bloom = p.bloom;
      }
      // 未用到的簇归零
      for (let i = pin.clusters.length; i < app.clusters.length; i++) {
        app.clusters[i].scale = 0;
        app.clusters[i].grow = 0;
        app.clusters[i].bloom = 0;
        app.clusters[i].pos.set(0, 0, 0);
      }
    }
    return origRender(dt, s);
  };

  /* 黄金角螺旋布局，与 main.js 的 ClusterLayout 一致 */
  window.__layout = (count, spread) => {
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const out = [];
    for (let k = 0; k < count; k++) {
      const r = count === 1 ? 0 : spread * Math.sqrt((k + 0.5) / count);
      const th = k * GOLDEN;
      out.push({
        x: Math.cos(th) * r,
        y: -r * 0.12 + (count === 1 ? 0 : -0.05),
        z: Math.sin(th) * r,
      });
    }
    return out;
  };

  /* 生长曲线，与 GrowthAnimator.shapes 一致 */
  window.__shapes = (progress, stagger) => {
    const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
    const g = clamp((progress - stagger) / Math.max(1 - stagger, 1e-3));
    const seedHold = 0.35, sproutAt = 0.55;
    let form = 0;
    if (g > seedHold) {
      const u = clamp((g - seedHold) / Math.max(sproutAt - seedHold, 1e-3));
      const c1 = 1.70158, c3 = c1 + 1;
      form = clamp(1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2));
    }
    let bloomT = 0;
    if (g > sproutAt) {
      const u = clamp((g - sproutAt) / Math.max(1 - sproutAt, 1e-3));
      bloomT = u * u * (3 - 2 * u);
    }
    return { form, bloomT };
  };
});

/**
 * 设定一帧的状态并截图
 * @param {object} p
 *   grow    生长进度 0~1
 *   bloom   绽放度 0~1.35
 *   count   花朵数量 1~5
 *   spread  散布半径
 *   rot     场景 Y 轴旋转
 *   stagger 错峰系数
 */
async function shot(index, { grow, bloom, count = 1, spread = 1.7, rot = 0, stagger = 0.18, camZ = 6.9, camY = 1.8 }) {
  await page.evaluate(({ grow, bloom, count, spread, rot, stagger, camZ, camY }) => {
    const app = window.__flowerApp;
    const pos = window.__layout(count, spread);
    // 5 朵时单朵缩小，和主循环的 clusterShrink 逻辑一致
    const shrink = 1 / (1 + 0.34 * Math.sqrt(Math.max(count - 1, 0)));

    const clusters = [];
    for (let i = 0; i < count; i++) {
      const { form, bloomT } = window.__shapes(grow, stagger * i);
      clusters.push({
        x: pos[i].x, y: pos[i].y, z: pos[i].z,
        scale: form * shrink,
        grow: form,
        bloom: Math.min(2.2, bloomT * bloom),
      });
    }
    window.__pin = { grow, bloom, clusters, rot, camZ, camY };
  }, { grow, bloom, count, spread, rot, stagger, camZ, camY });

  // 等 3 个渲染帧（软件渲染约 5fps，每帧约 200ms）
  await page.evaluate(() => new Promise((resolve) => {
    let n = 0;
    const tick = () => { if (++n >= 3) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));

  const file = `${OUT}/frame-${String(index).padStart(3, '0')}.png`;
  await page.screenshot({ path: file });
  return file;
}

/* ---------------------------------------------------------------------------
   帧序列设计（36 帧）
   ---------------------------------------------------------------------------
   1) 种子 → 发芽 → 花苞   展示生长动画
   2) 花苞 → 完全绽放       展示握拳/张开映射
   3) 单手展示
   4) 切到双手 → 1 朵变 5 朵  展示双手交互
   5) 五朵盛开定格
--------------------------------------------------------------------------- */
const frames = [];
let idx = 0;

/* 阶段 1：种子 → 发芽（6 帧） */
for (let i = 0; i < 6; i++) {
  const t = i / 5;
  frames.push({ grow: 0.03 + t * 0.47, bloom: 0, count: 1 });
}
/* 阶段 2：发芽 → 花苞 → 初绽（7 帧） */
for (let i = 0; i < 7; i++) {
  const t = i / 6;
  frames.push({ grow: 0.5 + t * 0.5, bloom: 0.05 + t * 0.40, count: 1 });
}
/* 阶段 3：完全绽放（8 帧） */
for (let i = 0; i < 8; i++) {
  const t = i / 7;
  const e = t * t * (3 - 2 * t);
  frames.push({ grow: 1, bloom: 0.45 + e * 0.90, count: 1, rot: t * 0.5 });
}
/* 阶段 4：单手展示（3 帧，轻微旋转） */
for (let i = 0; i < 3; i++) {
  frames.push({ grow: 1, bloom: 1.35, count: 1, rot: 0.5 + i * 0.18 });
}
/* 阶段 5：双手拉开 → 1 朵变 5 朵（7 帧）
   注意 5 朵时用更小的 spread（1.25）并拉远相机，保证整片花丛落在框内 */
for (let i = 0; i < 7; i++) {
  const t = i / 6;
  const e = t * t * (3 - 2 * t);
  frames.push({
    grow: 1, bloom: 1.35,
    count: Math.max(1, Math.round(1 + e * 4)),
    spread: 1.7,
    rot: 1.04 + t * 0.5,
    camZ: 6.9 + e * 0.9,   // 花多了稍微拉远，保证整片花丛在框内
    camY: 1.8 + e * 0.3,
  });
}
/* 阶段 6：五朵盛开定格（5 帧） */
for (let i = 0; i < 5; i++) {
  frames.push({
    grow: 1, bloom: 1.35, count: 5, spread: 1.7,
    rot: 1.54 + i * 0.12, camZ: 7.8, camY: 2.1,
  });
}

console.log(`共 ${frames.length} 帧，开始捕获...`);
for (const f of frames) {
  await shot(idx++, f);
  if (idx % 6 === 0) console.log(`  已捕获 ${idx}/${frames.length}`);
}

await browser.close();
console.log(`\n完成：${frames.length} 帧 -> ${OUT}`);
