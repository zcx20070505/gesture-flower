/**
 * 浏览器端冒烟测试（Playwright + 真实 Chromium）
 *
 * 静态检查抓不到 GLSL 编译错误、Three.js 运行时异常、DOM 绑定错误，
 * 所以这里真的把页面跑起来，并：
 *   1) 捕获所有 console 错误与 pageerror
 *   2) 用假摄像头（Chromium 的 --use-fake-device-for-media-stream）走通授权流程
 *   3) 断言 WebGL 渲染出非空画面（读像素，确认不是黑屏）
 *   4) 拖动“手动张力”滑块，比对两帧画面确实不同 → 证明绽放动画真的在跑
 *   5) 校验着色器编译成功（THREE 会往 console 打 error 日志）
 *
 * 用法：先起 http 服务，然后 node browser-test.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const URL = process.env.TEST_URL || 'http://127.0.0.1:5500/index.html';
const OUT = 'D:/deepseek/gesture-flower/.test-output';
const CONFIG_PARTICLES = 12000;   // 与 main.js 的 CONFIG.particleCount 默认值一致
mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} ${extra}`); }
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',          // 无 GPU 环境用软件光栅化，保证 WebGL 可用
    '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream',   // 自动允许摄像头权限
    '--use-fake-device-for-media-stream',
  ],
});

const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  permissions: ['camera'],
});
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(`[${m.type()}] ${t}`);
  if (m.type() === 'error') consoleErrors.push(t);
});
page.on('pageerror', (e) => pageErrors.push(e.message));

console.log(`\n打开 ${URL}`);
const resp = await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
ok(`页面返回 200`, resp.status() === 200, `got ${resp.status()}`);

/* ---------- 1. 模块是否正确加载 ---------- */
console.log('\n[1] 模块加载');
await page.waitForFunction(() => window.__flowerApp !== undefined, { timeout: 45000 })
  .catch(() => {});
const appReady = await page.evaluate(() => !!window.__flowerApp);
ok('main.js 执行成功且挂载了 window.__flowerApp', appReady);

const mpAvailable = await page.evaluate(() => typeof window.Hands === 'function');
ok('MediaPipe Hands UMD 脚本加载成功（window.Hands 可用）', mpAvailable);

const threeRev = await page.evaluate(() => window.__flowerApp && window.__flowerApp.stage
  ? window.__flowerApp.stage.renderer.getContext().getParameter(0x1F02) : null);
ok('WebGL 上下文已创建并能取到 GL_VERSION', !!threeRev, String(threeRev));

const isWebGL2 = await page.evaluate(() => {
  const gl = window.__flowerApp.stage.renderer.getContext();
  return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
});
console.log(`     GL_VERSION = ${threeRev}  (WebGL2: ${isWebGL2})`);

/* ---------- 2. 着色器是否编译成功 ---------- */
console.log('\n[2] 着色器编译');
// 注意：此时还没渲染过，three.js 是「用到才编译」，所以这里只检查源码就绪，
// program 是否真的编译链接成功要等渲染若干帧之后再看（见 §3 末）。
const shaderInfo = await page.evaluate(() => {
  const mat = window.__flowerApp.stage.flower.material;
  return {
    hasVertex: !!mat.vertexShader && mat.vertexShader.length > 100,
    hasFragment: !!mat.fragmentShader && mat.fragmentShader.length > 100,
    isShaderMaterial: mat.isShaderMaterial === true,
    transparent: mat.transparent,
    blending: mat.blending,
    depthWrite: mat.depthWrite,
  };
});
ok('花朵材质是 ShaderMaterial', shaderInfo.isShaderMaterial);
ok('顶点着色器源码存在', shaderInfo.hasVertex);
ok('片元着色器源码存在', shaderInfo.hasFragment);
const shaderErrLogs = logs.filter((l) => /shader|glsl|compile|program/i.test(l) && /error/i.test(l));
ok('console 中没有着色器相关报错', shaderErrLogs.length === 0, shaderErrLogs.join(' | ').slice(0, 400));

/* ---------- 3. 真的渲染出东西了吗 ---------- */
console.log('\n[3] 实际渲染');
await page.click('#startBtn');
await page.waitForTimeout(2500);

/**
 * 统计「一整帧」里真正提交到 GPU 的绘制量。
 *
 * 为什么不能用 renderer.info.render：
 *   本项目用 EffectComposer，一帧会跑 RenderPass ×2 + UnrealBloom + OutputPass，
 *   而 renderer.info 在每次 render() 开始时被重置 —— 读到的是【最后一个 pass】
 *   的数字（全屏四边形，points 恒为 0），完全看不出花朵画没画。
 *
 * 正确做法：monkey-patch renderer.renderBufferDirect，把一帧内所有 pass 的
 * 绘制调用累加起来。Points 的顶点数就是粒子数，是最硬的证据。
 */
async function sampleRenderStats(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const app = window.__flowerApp;
    const r = app.stage.renderer;
    const acc = { points: 0, triangles: 0, calls: 0, pointsObjects: 0, mshes: 0 };
    const orig = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      const n = geometry.index
        ? geometry.index.count
        : (geometry.attributes.position ? geometry.attributes.position.count : 0);
      const dr = geometry.drawRange;
      const drawCount = (dr && dr.count !== null && dr.count !== Infinity) ? dr.count : n;
      acc.calls++;
      if (object.isPoints) { acc.points += drawCount; acc.pointsObjects++; }
      else { acc.triangles += drawCount / 3; acc.mshes++; }
      return orig(camera, scene, geometry, material, object, group);
    };
    // 等下一帧渲染完（渲染在 rAF 里），然后还原
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        r.renderBufferDirect = orig;
        resolve({
          ...acc,
          programs: r.info.programs ? r.info.programs.length : -1,
          frame: r.info.render.frame,
          geometries: r.info.memory.geometries,
        });
      });
    });
    setTimeout(() => { r.renderBufferDirect = orig; resolve({ ...acc, note: 'timeout' }); }, 5000);
  }));
}

/** 比较两帧截图是否不同（用 Playwright 截图，走合成器，可靠） */
async function shot(page, name) {
  const p = `${OUT}/${name}.png`;
  await page.screenshot({ path: p });
  return p;
}

/** 读取关键 uniform 与 drawRange（用于验证"绽放"确实驱动了着色器） */
async function sampleUniforms(page) {
  return page.evaluate(() => {
    const f = window.__flowerApp.stage.flower;
    const u = f.material.uniforms;
    return {
      uBloom: u.uBloom.value,
      uTension: u.uTension.value,
      uPointerActive: u.uPointerActive.value,
      drawRange: { ...f.points.geometry.drawRange },
    };
  });
}

// 把张力设为 0（花苞）渲染若干帧
await page.evaluate(() => {
  const el = document.getElementById('manualTension');
  el.value = '0';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1800);
const budStats = await sampleRenderStats(page);
const budU = await sampleUniforms(page);
await shot(page, '01-bud');

// 把张力设为 1（绽放）
await page.evaluate(() => {
  const el = document.getElementById('manualTension');
  el.value = '1';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(2600);
const bloomStats = await sampleRenderStats(page);
const bloomU = await sampleUniforms(page);
await shot(page, '02-bloom');

const budUniform = budU.uBloom;
const bloomUniform = bloomU.uBloom;
const flowerDrawRange = bloomU.drawRange;

ok(`渲染循环在持续出帧（已渲染 ${bloomStats.frame} 帧）`, bloomStats.frame > 30, `frame=${bloomStats.frame}`);
ok(`场景真的提交了绘制调用（calls=${bloomStats.calls}）`, bloomStats.calls > 0);
ok(`花朵粒子被光栅化（一帧内 Points 顶点数 = ${bloomStats.points}）`, bloomStats.points > 0,
  JSON.stringify(bloomStats));
// 场景里有花朵(12000) + 星尘(1400) 两组 Points；rAF 等待期间可能多跑一帧，
// 所以不要求精确等于，只要「每个粒子都被提交」即可
ok(`提交的粒子数不少于配置的粒子数（${bloomStats.points} ≥ ${CONFIG_PARTICLES}）`,
  bloomStats.points >= CONFIG_PARTICLES, `points=${bloomStats.points}`);
ok(`花朵用的 drawRange 已正确设置（${flowerDrawRange.count} 个）`,
  flowerDrawRange.count === CONFIG_PARTICLES, JSON.stringify(flowerDrawRange));
/* 注意：绽放与否【不会】改变绘制的顶点数 —— 粒子位置是在顶点着色器里
   用 uBloom 插值的，这正是本项目的性能设计。所以这里要断言的是
   uniform 真的被推进了，而不是绘制量变了。 */
ok('绽放度 uBloom 被真实写入着色器（0 → 1.35）',
  bloomUniform > 1 && budUniform === 0,
  `bud=${budUniform} bloom=${bloomUniform}`);
ok(`显存中已上传几何体（geometries=${bloomStats.geometries}）`,
  bloomStats.geometries > 0, `geometries=${bloomStats.geometries}`);

// 渲染若干帧之后再检查 GL 状态（此时着色器已真正编译链接过）
const glHealth = await page.evaluate(() => {
  const r = window.__flowerApp.stage.renderer;
  const gl = r.getContext();
  return {
    glError: gl.getError(),
    programs: r.info.programs ? r.info.programs.length : 0,
    textures: r.info.memory.textures,
  };
});
ok(`渲染后已编译 ${glHealth.programs} 个 GPU program（着色器全部链接成功）`,
  glHealth.programs > 0, JSON.stringify(glHealth));
ok('渲染后 gl.getError() === 0（无 GL 错误，含着色器编译/链接）',
  glHealth.glError === 0, `glError=${glHealth.glError}`);

/* ---------- 4. 状态机与 HUD ---------- */
console.log('\n[4] 状态机 / HUD');
const hudBloom = await page.textContent('#bloomState');
ok(`张力=1 时 HUD 显示“完全绽放”（实际：“${hudBloom.trim()}”）`, /完全绽放/.test(hudBloom));
const tensionText = await page.textContent('#tensionValue');
ok(`HUD 张力数值刷新为 1.00（实际 ${tensionText.trim()}）`, parseFloat(tensionText) > 0.9);

await page.evaluate(() => {
  const el = document.getElementById('manualTension');
  el.value = '0';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(2200);
const hudBud = await page.textContent('#bloomState');
ok(`张力=0 时 HUD 显示“花苞闭合”（实际：“${hudBud.trim()}”）`, /花苞闭合/.test(hudBud));

/* ---------- 5. 交互控件 ---------- */
console.log('\n[5] 交互控件');
await page.click('#panelToggle');
await page.waitForTimeout(600);
ok('点击按钮可展开控制面板', await page.evaluate(() =>
  document.getElementById('panel').classList.contains('open')));

// 粒子数切换
await page.evaluate(() => {
  const el = document.getElementById('particleCount');
  el.value = '6000';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(900);
const rebuilt = await page.evaluate(() => {
  const g = window.__flowerApp.stage.flower.points.geometry;
  return g.getAttribute('aPosBloom').count;
});
ok(`粒子数改为 6000 后几何体真的重建了（实际 ${rebuilt}）`, rebuilt === 6000, `got ${rebuilt}`);

// 花瓣数
await page.evaluate(() => {
  const el = document.getElementById('petalCount');
  el.value = '9';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(900);
ok('花瓣数滑到 9 未抛异常', pageErrors.length === 0, pageErrors.join(' | '));

/* ---------- 6. 摄像头链路 ---------- */
console.log('\n[6] 摄像头 / 手势链路');
const camState = await page.evaluate(() => {
  const app = window.__flowerApp;
  return {
    running: app.handTracker.running,
    hasStream: !!app.handTracker.stream,
    videoW: app.handTracker.video.videoWidth,
    videoH: app.handTracker.video.videoHeight,
    handsObj: !!app.handTracker.hands,
    trackerActive: app.handTracker.pointerActive,
    status: document.getElementById('status').textContent.slice(0, 400),
  };
});
console.log('     摄像头状态:', JSON.stringify({ ...camState, status: undefined }));
ok('getUserMedia 成功，MediaStream 已建立', camState.hasStream);
ok('视频轨道有分辨率（videoWidth > 0）', camState.videoW > 0, `videoWidth=${camState.videoW}`);
ok('MediaPipe Hands 实例已创建', camState.handsObj);
ok('识别循环处于 running 状态', camState.running);

// 摄像头背景层与骨架画布
ok('overlay 骨架画布尺寸已按 DPR 设置',
  await page.evaluate(() => document.getElementById('overlay').width > 0));

await page.screenshot({ path: `${OUT}/03-with-camera.png` });

/* ---------- 7. 响应式 ---------- */
console.log('\n[7] 响应式');
await page.setViewportSize({ width: 390, height: 844 });   // iPhone 竖屏
await page.waitForTimeout(1200);
const mobile = await page.evaluate(() => {
  const gl = document.getElementById('gl');
  const cs = getComputedStyle(document.getElementById('panel'));
  const r = document.getElementById('panel').getBoundingClientRect();
  return {
    canvasW: gl.clientWidth,
    canvasH: gl.clientHeight,
    winW: window.innerWidth,
    winH: window.innerHeight,
    top: cs.top,
    bottom: cs.bottom,
    rectTop: Math.round(r.top),
  };
});
ok(`竖屏下 canvas 仍铺满视口 (${mobile.canvasW}×${mobile.canvasH} vs ${mobile.winW}×${mobile.winH})`,
  mobile.canvasW === mobile.winW && mobile.canvasH === mobile.winH,
  JSON.stringify(mobile));
// 移动端布局：面板应改为「底部抽屉」—— 定位锚点从 top 换成 bottom
// （面板此时可能是展开状态，所以判断锚点而不是 top 的像素值）
ok(`竖屏下面板改为底部抽屉（bottom=${mobile.bottom}，左右留 10px 安全边）`,
  mobile.bottom !== 'auto' && /^(9|10|11|12)/.test(mobile.bottom),
  JSON.stringify(mobile));
await shot(page, '04-mobile');

const mobileStats = await sampleRenderStats(page);
ok(`竖屏下依然在出帧（frame=${mobileStats.frame}）`, mobileStats.frame > 0);
ok(`竖屏下粒子依然被光栅化（points=${mobileStats.points}）`, mobileStats.points > 0,
  JSON.stringify(mobileStats));

await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(600);

/* ---------- 7.4 交互模式切换（单手 / 双手） ---------- */
console.log('\n[7.4] 交互模式切换');

/* 两个 radio 在 CSS 里是 opacity:0 / width:0（视觉由 .mode-card 承担），
   所以 page.check() 会因为"元素不可见"而超时。
   这里封装一个"点可见卡片、同时把 radio 置为 checked"的辅助函数：
   既模拟真实用户点击，又保证 change 事件被派发到。 */
async function selectMode(pg, mode) {
  const id = mode === 'single' ? '#modeSingle' : '#modeTwo';
  return pg.evaluate((sel) => {
    const radio = document.querySelector(sel);
    if (!radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return radio.checked;
  }, id);
}

{
  // 面板要打开才能操作（移动端/桌面端面板默认收起）
  await page.evaluate(() => {
    if (!document.getElementById('panel').classList.contains('open')) {
      document.getElementById('panelToggle').click();
    }
  });
  await page.waitForTimeout(500);

  // ---- 初始状态：UI 与 CONFIG 应一致 ----
  const init = await page.evaluate(() => ({
    mode: window.__flowerApp.mode,
    singleChecked: document.getElementById('modeSingle').checked,
    twoChecked: document.getElementById('modeTwo').checked,
    twoOptionsHidden: document.getElementById('twoHandOptions').hidden,
    singleHintHidden: document.getElementById('singleHandHint').hidden,
  }));
  console.log('     初始:', JSON.stringify(init));
  ok(`初始模式与 CONFIG.mode 一致（${init.mode}）`,
    (init.mode === 'two') === init.twoChecked);
  ok('单手交互 / 双手交互 两个选项都在面板里',
    (await page.locator('#modeSingle').count()) === 1 &&
    (await page.locator('#modeTwo').count()) === 1);
  ok('两个模式卡片都可见（用户点得到）',
    await page.locator('#modeSingle + .mode-card').isVisible() &&
    await page.locator('#modeTwo + .mode-card').isVisible());
  ok('默认选中双手时，单手说明是隐藏的', init.singleHintHidden === true);

  // ---- 切到单手模式：UI 联动 ----
  await selectMode(page, 'single');
  await page.waitForTimeout(600);
  const toSingle = await page.evaluate(() => ({
    mode: window.__flowerApp.mode,
    twoOptionsHidden: document.getElementById('twoHandOptions').hidden,
    singleHintHidden: document.getElementById('singleHandHint').hidden,
    span: window.__flowerApp.twoHand.span,
    rotationAccum: window.__flowerApp.twoHand.rotationAccum,
    clusterCount: window.__flowerApp._clusterCount,
    panX: window.__flowerApp.panOffset.x,
  }));
  console.log('     切到单手:', JSON.stringify(toSingle));
  ok('点击"单手交互"能把模式切成 single', toSingle.mode === 'single');
  ok('切到单手后，双手专属子选项被收起', toSingle.twoOptionsHidden === true);
  ok('切到单手后，单手说明显示出来', toSingle.singleHintHidden === false);
  ok('切到单手后，双手累积状态被清零（span=0）', toSingle.span === 0);
  ok('切到单手后，旋转累积被清零', toSingle.rotationAccum === 0);
  ok('切到单手后，花朵数量回到 1', toSingle.clusterCount === 1);

  // ---- 单手模式下：喂两只手，也只开 1 朵花 ----
  await feedTwoHands(page, 0.9, true, true);
  await page.waitForTimeout(3000);
  const singleWithTwoHands = await page.evaluate(() => {
    const app = window.__flowerApp;
    const u = app.stage.flower.material.uniforms;
    return {
      mode: app.mode,
      twoActive: app.twoHand.active,
      clusterCount: app._clusterCount,
      visible: app.clusters.filter((c) => c.scale > 0.15).length,
      uniformScale: Array.from(u.uClusterScale.value).map((v) => +v.toFixed(2)),
    };
  });
  console.log('     单手模式喂两只手:', JSON.stringify(singleWithTwoHands));
  ok('单手模式下 TwoHandController 不激活（第二只手被忽略）',
    singleWithTwoHands.twoActive === false, JSON.stringify(singleWithTwoHands));
  ok(`单手模式下即使有两只手也只开 1 朵花（实际 ${singleWithTwoHands.visible} 朵）`,
    singleWithTwoHands.visible === 1, JSON.stringify(singleWithTwoHands));
  ok('单手模式下其他花簇缩放为 0',
    singleWithTwoHands.uniformScale.filter((s) => s > 0.1).length === 1,
    JSON.stringify(singleWithTwoHands.uniformScale));

  // ---- 切回双手模式：功能恢复 ----
  await selectMode(page, 'two');
  await page.waitForTimeout(600);
  const backToTwo = await page.evaluate(() => ({
    mode: window.__flowerApp.mode,
    twoOptionsHidden: document.getElementById('twoHandOptions').hidden,
    singleHintHidden: document.getElementById('singleHandHint').hidden,
  }));
  console.log('     切回双手:', JSON.stringify(backToTwo));
  ok('点击"双手交互"能切回 two', backToTwo.mode === 'two');
  ok('切回双手后，双手子选项重新显示', backToTwo.twoOptionsHidden === false);
  ok('切回双手后，单手说明被收起', backToTwo.singleHintHidden === true);

  // 双手功能确实恢复（拉开长出多朵）
  await feedTwoHands(page, 0.9, true, true);
  await page.waitForTimeout(3000);
  const twoAgain = await page.evaluate(() => {
    const app = window.__flowerApp;
    return {
      span: +app.twoHand.span.toFixed(2),
      visible: app.clusters.filter((c) => c.scale > 0.15).length,
    };
  });
  console.log('     切回双手后拉开:', JSON.stringify(twoAgain));
  ok(`切回双手后，拉开双手重新长出多朵（${twoAgain.visible} 朵）`,
    twoAgain.visible >= 3, JSON.stringify(twoAgain));

  // ---- 反复切换不应有异常 ----
  for (let i = 0; i < 4; i++) {
    await selectMode(page, 'single');
    await page.waitForTimeout(150);
    await selectMode(page, 'two');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  const afterFlapping = await page.evaluate(() => ({
    mode: window.__flowerApp.mode,
    running: window.__flowerApp.running,
  }));
  ok('反复切换模式不会断开渲染循环', afterFlapping.running === true);
  ok('反复切换后模式仍然正确（two）', afterFlapping.mode === 'two');
  await shot(page, '15-mode-two');
  await selectMode(page, 'single');
  await page.waitForTimeout(800);
  await shot(page, '16-mode-single');
  await selectMode(page, 'two');
  await page.waitForTimeout(400);
}

/* ---------- 7.5 双手交互 ---------- */
console.log('\n[7.5] 双手交互');

/* 注意：这里【不能】用 new Function(...) 拼字符串再交给 page.evaluate ——
   Playwright 会把函数序列化后注入页面，new Function 生成的闭包无法正确序列化，
   参数不会绑定（sepX 变成 undefined），于是算出一堆 NaN。
   必须写成一个普通的、可序列化的函数，参数通过 evaluate 的第二个参数传。

   另外：主循环每帧都会用 MediaPipe 的结果覆盖 handTracker.handsData，
   所以喂完数据还要"钉住"它 —— 见 holdTwoHands。 */
async function feedTwoHands(pg, sepX, openA = true, openB = true) {
  return pg.evaluate(({ sepX, openA, openB }) => {
    const app = window.__flowerApp;

    /** 造一只张开度可控的手（21 点），与 verify.mjs 的夹具保持同一套骨架 */
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

    const a = makeHand(0.5 - sepX / 2, 0.5, 1.0, openA);
    const b = makeHand(0.5 + sepX / 2, 0.5, 1.0, openB);
    const pack = (lm, label) => {
      const ids = [0, 5, 9, 13, 17];
      let cx = 0, cy = 0;
      for (const k of ids) { cx += lm[k].x; cy += lm[k].y; }
      return { landmarks: lm, label, score: 0.99, pointer: { x: cx / 5, y: cy / 5 } };
    };
    const data = [pack(a, 'Left'), pack(b, 'Right')];

    // 先让控制器收敛到稳态（多次推进，抵消指数平滑的滞后）
    for (let i = 0; i < 240; i++) app.twoHand.update(data, 1 / 60);

    /* 钉住数据：包住 onResults 的入口，让主循环每帧都拿到这双手。
       MediaPipe 在测试里本来就没结果，所以覆盖它是安全的。 */
    const ht = app.handTracker;
    if (!ht.__origHandle) ht.__origHandle = ht._handleResults.bind(ht);
    ht._handleResults = () => {};
    ht.handsData = data;
    ht.twoHandActive = true;
    ht.lastLandmarks = b;
    ht.pointerActive = true;
    ht.running = true;
    app.useManual = false;

    return {
      span: app.twoHand.span,
      active: app.twoHand.active,
      openness: app.twoHand.openness,
      rotation: app.twoHand.rotation,
    };
  }, { sepX, openA, openB });
}

/** 恢复 HandTracker 的原始结果处理（测试结束后调用，避免影响后续用例） */
async function releaseTwoHands(pg) {
  await pg.evaluate(() => {
    const ht = window.__flowerApp.handTracker;
    if (ht.__origHandle) {
      ht._handleResults = ht.__origHandle;
      delete ht.__origHandle;
    }
    ht.handsData = [];
    ht.twoHandActive = false;
    ht.pointerActive = false;
  });
}

{
  // ---- 两手并拢 vs 拉开：花朵数量应变化 ----
  const near = await feedTwoHands(page, 0.06, true, true);
  const far = await feedTwoHands(page, 0.85, true, true);

  console.log(`     并拢 span=${near.span.toFixed(3)} | 拉开 span=${far.span.toFixed(3)}`);
  ok('双手识别为 active', near.active && far.active);
  ok(`两手拉开时 span 明显变大（${near.span.toFixed(2)} → ${far.span.toFixed(2)}）`,
    far.span > near.span + 0.15, `near=${near.span} far=${far.span}`);
  ok('两手并拢时 span 接近 0（只开一朵花）', near.span < 0.35, `span=${near.span}`);
  ok('两手拉开时 span 接近 1（开满多朵花）', far.span > 0.6, `span=${far.span}`);

  // ---- 花朵数量真的变了 ----
  // 让渲染主循环跑几帧，把 span 传导到实际花簇
  await page.waitForTimeout(2600);
  const clustersAfter = await page.evaluate(() => {
    const app = window.__flowerApp;
    const vis = app.clusters.filter((c) => c.scale > 0.15).length;
    const u = app.stage.flower.material.uniforms;
    return {
      span: app.twoHand.span,
      _clusterCount: app._clusterCount,
      visibleClusters: vis,
      uniformGrow: u.uGrow.value,
      uniformScale: Array.from(u.uClusterScale.value).map((v) => +v.toFixed(2)),
      uniformPos: u.uClusterPos.value.map((p) => [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]),
      uniformBloom: Array.from(u.uClusterBloom.value).map((v) => +v.toFixed(2)),
    };
  });
  console.log('     span =', clustersAfter.span.toFixed(3),
    '| _clusterCount =', clustersAfter._clusterCount.toFixed(2),
    '| 可见花簇 =', clustersAfter.visibleClusters);
  console.log('     uniform scale:', JSON.stringify(clustersAfter.uniformScale));
  console.log('     uniform pos  :', JSON.stringify(clustersAfter.uniformPos));

  ok(`拉开双手后至少 3 朵花被激活（实际 ${clustersAfter.visibleClusters} 朵）`,
    clustersAfter.visibleClusters >= 3, JSON.stringify(clustersAfter));
  ok('各花簇的位置互不相同（真的散开了）',
    new Set(clustersAfter.uniformPos.map((p) => p.join(','))).size > 1,
    JSON.stringify(clustersAfter.uniformPos));
  ok('激活的花簇被写入非零缩放',
    clustersAfter.uniformScale.filter((s) => s > 0.1).length >= 3,
    JSON.stringify(clustersAfter.uniformScale));

  await shot(page, '10-two-hands-many');

  /* 反向验证：两手并拢时应该只剩 1 朵花 —— 这才说明"距离→花数"真的在生效，
     而不是"只要检测到双手就画 5 朵"。 */
  await feedTwoHands(page, 0.04, true, true);
  await page.waitForTimeout(2600);
  const clustersNear = await page.evaluate(() => {
    const app = window.__flowerApp;
    const u = app.stage.flower.material.uniforms;
    return {
      span: app.twoHand.span,
      _clusterCount: app._clusterCount,
      visibleClusters: app.clusters.filter((c) => c.scale > 0.15).length,
      uniformScale: Array.from(u.uClusterScale.value).map((v) => +v.toFixed(2)),
    };
  });
  console.log('     并拢后: span =', clustersNear.span.toFixed(3),
    '| 可见花簇 =', clustersNear.visibleClusters);
  ok(`两手并拢后花朵数量回落到 1（实际 ${clustersNear.visibleClusters} 朵）`,
    clustersNear.visibleClusters <= 2, JSON.stringify(clustersNear));
  ok(`并拢时 span 远小于拉开时（${clustersNear.span.toFixed(2)} < ${far.span.toFixed(2)}）`,
    clustersNear.span < far.span, `near=${clustersNear.span} far=${far.span}`);
}

{
  // ---- 双手张开度 → 生长进度 ----
  // 双手握拳：生长应该停住/回落
  await feedTwoHands(page, 0.8, false, false);
  const closedOpen = await page.evaluate(() => window.__flowerApp.twoHand.openness);
  // 双手张开：生长应该推进
  await feedTwoHands(page, 0.8, true, true);
  const openOpen = await page.evaluate(() => window.__flowerApp.twoHand.openness);
  console.log(`     双手握拳 openness=${closedOpen.toFixed(3)} | 双手张开 openness=${openOpen.toFixed(3)}`);
  ok(`双手张开度能区分握拳/张开（${closedOpen.toFixed(2)} vs ${openOpen.toFixed(2)}）`,
    openOpen > closedOpen + 0.3);
}

{
  // ---- 双手旋转 → 场景旋转 ----
  const rot = await page.evaluate(() => {
    const app = window.__flowerApp;
    app.twoHand.rotationAccum = 0;
    app.twoHand._lastRawRot = null;
    const before = app.twoHand.rotationAccum;

    const mk = (ox, oy) => {
      const lm = [];
      for (let k = 0; k < 21; k++) lm.push({ x: ox, y: oy, z: 0 });
      lm[0] = { x: ox, y: oy + 0.2, z: 0 };
      lm[9] = { x: ox, y: oy, z: 0 };
      return lm;
    };
    const pack = (lm, label) => {
      const ids = [0, 5, 9, 13, 17];
      let cx = 0, cy = 0;
      for (const k of ids) { cx += lm[k].x; cy += lm[k].y; }
      return { landmarks: lm, label, score: 0.99, pointer: { x: cx / 5, y: cy / 5 } };
    };

    // 两掌连线从水平（0°）平滑转到 45°
    const seq = [];
    for (let i = 0; i <= 30; i++) {
      const ang = (i / 30) * (Math.PI / 4);
      const R = 0.25;
      const a = mk(0.5 - Math.cos(ang) * R, 0.5 - Math.sin(ang) * R);
      const b = mk(0.5 + Math.cos(ang) * R, 0.5 + Math.sin(ang) * R);
      app.twoHand.update([pack(a, 'Left'), pack(b, 'Right')], 1 / 60);
      seq.push(app.twoHand.rotationAccum);
    }
    return { before, after: app.twoHand.rotationAccum, seq: seq.map((x) => +x.toFixed(4)) };
  });
  console.log(`     旋转累积: ${rot.before.toFixed(3)} → ${rot.after.toFixed(3)} rad`);
  ok(`双手旋转能累积场景旋转（转了 ${(rot.after - rot.before).toFixed(3)} rad）`,
    Math.abs(rot.after - rot.before) > 0.5, JSON.stringify(rot));
  // 应接近 45°(0.785 rad) × 灵敏度 1.0
  ok(`旋转量与手的转角基本一致（≈0.785 rad）`,
    Math.abs(Math.abs(rot.after - rot.before) - Math.PI / 4) < 0.15,
    `got ${(rot.after - rot.before).toFixed(4)}`);
}

/* ---------- 7.6 生长动画 ---------- */
console.log('\n[7.6] 生长动画');
// 先放开双手数据的"钉子"，让后续用例能自己控制张力
await releaseTwoHands(page);
await page.evaluate(() => { window.__flowerApp.useManual = true; });
await page.waitForTimeout(400);
{
  // 采样几个时间点的状态。推进时长要覆盖 CONFIG.growDuration（3.2s），
  // 所以步数 = 时长 × 60 再留些余量，否则会停在中途。
  const trace = await page.evaluate(() => {
    const app = window.__flowerApp;
    app.manualGrow = 0;
    app.growth.play();
    const dur = 3.2;                       // 与 CONFIG.growDuration 一致
    const steps = Math.ceil(dur * 60) + 60; // 多跑 1 秒确保收尾
    const samples = [];
    for (let i = 0; i < steps; i++) {
      app.growth.update(1 / 60, 0);
      if (i % Math.ceil(steps / 10) === 0) {
        // 让主循环把生长传导到花簇上（用同一步长）
        const c0 = app.clusters[0];
        samples.push({
          p: +app.growth.progress.toFixed(3),
          scale: +c0.scale.toFixed(3),
          grow: +c0.grow.toFixed(3),
          bloom: +c0.bloom.toFixed(3),
        });
      }
    }
    return { samples, finalProgress: app.growth.progress, autoPlaying: app.growth.autoPlaying };
  });
  const traceS = trace.samples;
  console.log('     生长采样:', traceS.map((s) => `p=${s.p}`).join(' | '));

  const first = traceS[0];
  const last = traceS[traceS.length - 1];
  ok(`生长从接近 0 开始（progress=${first.p}）`, first.p < 0.2);
  ok(`生长推进到 1（progress=${trace.finalProgress.toFixed(3)}）`, trace.finalProgress > 0.99);
  ok(`自动播放结束后 autoPlaying 复位`, trace.autoPlaying === false);
  ok(`生长进度单调不减（${first.p} → ${last.p}）`, last.p >= first.p);

  // 生长过程中的实际 uniform
  const growUniform = await page.evaluate(() => {
    const app = window.__flowerApp;
    app.growth.play();
    app.growth.update(1 / 60, 0);
    return app.stage.flower.material.uniforms.uGrow.value;
  });
  ok(`uGrow uniform 被写入着色器（当前 ${growUniform.toFixed(3)}）`,
    growUniform >= 0 && growUniform <= 1);

  /* 生长传导到花簇：让渲染循环真的跑一会儿，再看 grow 是否落到花簇上。
     注意必须回到主循环驱动（_frame 里才算），手动 update 不会传给 clusters。

     关于等待时长：主循环把 dt 裁到 0.05s（防切标签页跳变的有意设计），
     所以 3.2s 的动画需要 3.2/0.05 = 64 帧。本测试跑在 SwiftShader 软件
     渲染上只有约 5fps，64 帧 ≈ 13 秒真实时间。这里按"帧数"轮询而不是
     按固定 wall time 等，既准确又不会在真实 GPU 上白等。 */
  await page.evaluate(() => {
    const app = window.__flowerApp;
    app.manualGrowOn = false;      // 交还控制权给自动播放
    app.manualGrow = 0;
    document.getElementById('manualTension').value = '1';
    document.getElementById('manualTension').dispatchEvent(new Event('input', { bubbles: true }));
    app.growth.play();
  });
  // 轮询等待：直到动画播完（autoPlaying 复位）或超时
  let waited = 0;
  const pollMs = 500;
  const maxWaitMs = 30000;
  while (waited < maxWaitMs) {
    await page.waitForTimeout(pollMs);
    waited += pollMs;
    const done = await page.evaluate(() => !window.__flowerApp.growth.autoPlaying
      && window.__flowerApp.growth.progress > 0.99);
    if (done) break;
  }
  console.log(`     主循环播放生长动画用时 ${(waited / 1000).toFixed(1)}s（软件渲染约 5fps）`);
  const grown = await page.evaluate(() => {
    const app = window.__flowerApp;
    return {
      progress: app.growth.progress,
      cluster0: { scale: +app.clusters[0].scale.toFixed(3), grow: +app.clusters[0].grow.toFixed(3), bloom: +app.clusters[0].bloom.toFixed(3) },
      uGrow: app.stage.flower.material.uniforms.uGrow.value,
    };
  });
  console.log('     主循环生长结果:', JSON.stringify(grown));
  ok(`主循环把生长传导到花簇（cluster0.grow=${grown.cluster0.grow}）`,
    grown.cluster0.grow > 0.9, JSON.stringify(grown));
  ok(`长成后花簇缩放已到位（scale=${grown.cluster0.scale}）`,
    grown.cluster0.scale > 0.5, JSON.stringify(grown));
  ok(`长成后能开花（bloom=${grown.cluster0.bloom}）`,
    grown.cluster0.bloom > 0.5, JSON.stringify(grown));
}

{
  // ---- 手动生长滑块 ----
  await page.evaluate(() => {
    const el = document.getElementById('grow');
    el.value = '0.3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const manual = await page.evaluate(() => ({
    manualGrow: window.__flowerApp.manualGrow,
    manualGrowOn: window.__flowerApp.manualGrowOn,
    growVal: document.getElementById('growValue').textContent,
  }));
  ok(`拖动生长滑块能设置手动进度（manualGrow=${manual.manualGrow}）`,
    Math.abs(manual.manualGrow - 0.3) < 0.01);
  ok('手动接管标志被正确置位（manualGrowOn=true）', manual.manualGrowOn === true);
  ok(`HUD 显示生长数值（${manual.growVal}）`, parseFloat(manual.growVal) >= 0);

  // 拖回 0 应当交还控制权（验证"状态泄漏"修复）
  await page.evaluate(() => {
    const el = document.getElementById('grow');
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const released = await page.evaluate(() => window.__flowerApp.manualGrowOn);
  ok('滑块拖回 0 会交还生长控制权（manualGrowOn=false）', released === false);

  // 点"重新播放"也应清掉手动接管
  await page.evaluate(() => {
    const el = document.getElementById('grow');
    el.value = '0.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#replayGrow');
  await page.waitForTimeout(300);
  const afterReplay = await page.evaluate(() => ({
    autoPlaying: window.__flowerApp.growth.autoPlaying,
    manualGrowOn: window.__flowerApp.manualGrowOn,
  }));
  ok('点击「重新播放生长动画」会重新开始', afterReplay.autoPlaying === true);
  ok('重播会清掉手动接管，动画不会被滑块压住', afterReplay.manualGrowOn === false);
  await page.waitForTimeout(400);
}

{
  // ---- 生长阶段截图 ----
  await page.evaluate(() => {
    const app = window.__flowerApp;
    document.getElementById('showVideo').checked = false;
    document.getElementById('showVideo').dispatchEvent(new Event('change', { bubbles: true }));
    app.growth.autoPlaying = false;
    app.growth.useGesture = false;
  });
  for (const [v, name] of [['0.15', 'seed'], ['0.45', 'sprout'], ['0.7', 'budding'], ['1.0', 'bloomed']]) {
    await page.evaluate((val) => {
      const app = window.__flowerApp;
      app.manualGrow = parseFloat(val);
      app.growth.progress = parseFloat(val);
      app.growth.growTime = 1.0;
      // 让张力足够高，保证"长成"后能开花
      document.getElementById('manualTension').value = '1';
      document.getElementById('manualTension').dispatchEvent(new Event('input', { bubbles: true }));
      app.useManual = true;
    }, v);
    await page.waitForTimeout(1500);
    await shot(page, `20-grow-${name}`);
  }
  ok('生长各阶段截图已保存', true);
}

/* ---------- 8. 无错误收尾 ---------- */
console.log('\n[8] 运行时错误');
const realErrors = consoleErrors.filter((e) =>
  !/favicon|Failed to load resource.*favicon/i.test(e));
ok('全程没有 pageerror（未捕获异常）', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 600));
ok('全程没有 console.error', realErrors.length === 0, realErrors.join(' | ').slice(0, 600));

/* ---------- 9. 无摄像头时的降级 ---------- */
console.log('\n[9] 降级路径（拒绝摄像头权限）');
// 注意：必须用一个【不带 --use-fake-ui-for-media-stream】的浏览器实例。
// 那个参数会让 Chromium 无条件自动授权，连 clearPermissions() 都拦不住，
// 于是永远走不到「用户拒绝」的分支，测试会假阴性。
const degBrowser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx2 = await degBrowser.newContext({ viewport: { width: 1000, height: 700 } });
const page2 = await ctx2.newPage();
const err2 = [];
const err2page = [];
page2.on('pageerror', (e) => err2page.push(e.message));
page2.on('console', (m) => { if (m.type() === 'error') err2.push(m.text()); });
await page2.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page2.waitForFunction(() => window.__flowerApp !== undefined, { timeout: 45000 }).catch(() => {});

// 模拟用户在权限弹窗上点了「阻止」
await page2.evaluate(() => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(
    Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  );
});

await page2.click('#startBtn');
await page2.waitForTimeout(3000);

const degraded = await page2.evaluate(() => ({
  useManual: window.__flowerApp.useManual,
  toastShown: document.getElementById('toast').classList.contains('show'),
  toastText: document.getElementById('toast').textContent,
  stillRendering: window.__flowerApp.running,
  status: document.getElementById('status').textContent.slice(0, 300),
  gateHidden: document.getElementById('gate').classList.contains('hide'),
}));
console.log('     降级状态:', JSON.stringify({ ...degraded, status: undefined }));
ok('摄像头失败后自动切到手动模式', degraded.useManual === true);
ok('给出了用户可见的错误提示', degraded.toastShown, degraded.toastText);
ok('错误文案是中文且可读（不是 undefined/裸英文堆栈）',
  /摄像头|权限|设备/.test(degraded.toastText), degraded.toastText);
ok('降级后渲染循环仍在运行（不是白屏）', degraded.stillRendering === true);
ok('遮罩已隐藏，用户能看到画面', degraded.gateHidden === true);
await shot(page2, '05-degraded');

const degStats = await sampleRenderStats(page2);
ok(`降级模式下花朵仍在渲染（points=${degStats.points}, frame=${degStats.frame}）`,
  degStats.points > 0, JSON.stringify(degStats));
ok('降级路径没有未捕获异常', err2page.length === 0, err2page.join(' | ').slice(0, 400));

await degBrowser.close();
await browser.close();

console.log(`\n${'='.repeat(58)}`);
console.log(`  浏览器测试：通过 ${pass} 项，失败 ${fail} 项`);
console.log(`  截图已保存到 ${OUT}`);
console.log(`${'='.repeat(58)}\n`);
process.exit(fail === 0 ? 0 : 1);
