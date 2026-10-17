/**
 * ============================================================================
 *  指尖花开 · main.js
 *  手势控制的 Three.js 粒子花朵
 * ----------------------------------------------------------------------------
 *  模块划分（自上而下）：
 *   §0  配置常量           —— 所有可调参数集中在这里
 *   §1  工具函数           —— 平滑、插值、节流等
 *   §2  手势追踪 HandTracker—— MediaPipe Hands 封装 + 21 关键点骨架绘制
 *   §3  张力 TensionMeter   —— 由 21 关键点计算“手掌张开度” 0~1
 *   §4  花朵 FlowerField    —— 几何体 + GLSL 粒子花朵
 *   §5  舞台 Stage          —— Three.js 场景、摄像头背景纹理、渲染循环
 *   §6  UI 绑定             —— 面板、HUD、启动遮罩、错误提示
 *   §7  启动流程 main()     —— 装配以上模块
 * ============================================================================
 */

import * as THREE from 'three';
// 只在需要 Bloom 泛光时才加载（避免 CDN 慢时阻塞启动）
// 这里静态引入，simple 起见；如需减包可改成动态 import()。
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ==========================================================================
   §0  配置常量（改这里就能调参）
   ========================================================================== */

const CONFIG = {
  /* ---------- 粒子与花朵 ---------- */
  particleCount: 12000,   // 粒子数量，界面可调范围 5000 ~ 20000
  petalCount: 6,          // 花瓣数量
  petalSharp: 0.75,       // 花瓣形状指数：越小平瓣越"瘦"、瓣与瓣之间凹得越深（越像花瓣）
  coilTurns: 2.4,         // 花苞卷曲圈数（未绽放时粒子沿螺旋卷成球）
  coreRatio: 0.06,        // 花心粒子占比（花蕊小球）
  seedRatio: 0.10,        // 中心种子粒子占比（绽放时喷发成尘埃）
  sizeBase: 1.5,          // 粒子基础尺寸（像素，会被 devicePixelRatio 缩放）
  bloomScale: 1.05,       // 完全绽放时花瓣半径放大倍数（视觉上“散开”）
  maxClusters: 5,         // 最多几朵花（着色器里的 MAX_CLUSTERS，改这个要同步改 GLSL）

  /* ---------- 张力 → 绽放 映射阈值 ---------- */
  lowTension: 0.32,       // ≤ 此值：粒子聚合、花苞闭合（bloom = 0）
  highTension: 0.66,      // ≥ 此值：粒子扩散、完全绽放（bloom = bloomMax）
  bloomMax: 1.35,         // 绽放度上限；>1 会触发花心种子向外喷发
  bloomOvershoot: 0.22,   // 过渡区中段的张开加速包络（0 = 纯 S 曲线）

  /* ---------- 交互模式 ----------
     'single' 单手模式：原来的玩法。一只手的张开度控制绽放，
                        手掌移动让花朵轻摆。
     'two'    双手模式：双手距离决定花朵数量（1~5 朵），
                        双手开合推进生长，转动/移动双手旋转平移花丛。

     两种模式是【互斥】的：选单手时完全忽略第二只手，
     选双手时第二只手才参与运算。这样行为可预期，不会出现
     "举了第二只手，结果单手的手感也变了"这种含糊状态。 */
  mode: 'two',

  /* ---------- 双手交互（仅 mode === 'two' 时生效） ---------- */
  multiCluster: true,     // 是否允许一朵以上的花（关闭则永远 1 朵）
  handSpanMin: 0.12,      // 双手中点在归一化坐标里的"最小距离"（双手贴一起）
  handSpanMax: 0.62,      // "最大距离"（双手尽量拉开），用于归一化
  twoHandRotate: 1.0,     // 双手旋转→场景旋转的灵敏度
  twoHandPan: 0.9,        // 双手中点位移→场景平移的灵敏度
  clusterSpread: 1.7,     // 多朵花之间的散布半径（模型单位；太大会开出画面）
  clusterStagger: 0.18,   // 各朵花生长/绽放的错峰程度（0=同时，1=完全依次）
  clusterShrink: 0.34,    // 花越多、单朵越小（0=不缩，0.5=5 朵时缩到一半）

  /* ---------- 生长动画 ---------- */
  growDuration: 3.2,      // 从种子长到开花的总时长（秒）
  growSeedHold: 0.35,     // 种子停留阶段占比（0~1）
  growSprout: 0.55,       // 种子→花苞 完成时的进度占比（剩下的用来开花）
  autoGrowOnStart: true,  // 打开程序后自动播放一次生长动画

  /* ---------- 手感 ---------- */
  smoothing: 0.18,        // 指数平滑系数（越小越平滑、越迟钝），界面可调
  gain: 1.0,              // 灵敏度增益，界面可调
  openGain: 1.4,          // 张开度归一化区间的放大倍数（1.4 ≈ 以 [0, 0.715] 映射到 [0,1]）
  hysteresis: 0.05,       // 迟滞带宽，避免阈值附近状态反复横跳
  lostTimeout: 900,       // 丢失手部后多少毫秒开始回落到中性值（ms）

  /* ---------- 摄像头 / 识别 ---------- */
  camWidth: 640,
  camHeight: 480,
  maxHands: 2,            // 双手识别；单只手也能正常用
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6,

  /* ---------- 渲染 ---------- */
  autoRotate: 0.12,       // 自动旋转速度（弧度/秒）
  bloomStrength: 0.72,    // 泛光强度（太高会把整个花朵糊成白团）
  bloomRadius: 0.62,
  bloomThreshold: 0.24,   // 只让较亮的部分发光
  maxPixelRatio: 2,       // 上限，防止 4K 屏上粒子过密掉帧
  videoPlaneScale: 1.6,   // 背景视频平面的缩放（1 = 铺满，>1 = 放大裁切）

  /* ---------- 调试 ---------- */
  showSkeleton: true,
  showVideo: true,
  showHud: true,
};

/** 阈值判定后的状态机标签 */
const STATE = {
  BUD: 'bud',           // 花苞闭合
  MID: 'mid',           // 过渡
  BLOOM: 'bloom',       // 绽放
};

/* ==========================================================================
   §1  工具函数
   ========================================================================== */

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 指数平滑：帧率无关的 lerp。
 * 每帧用固定 α 的 lerp 在 30fps / 120fps 上手感完全不同，
 * 这里把 α 看成「60fps 下每帧的保留比例」，换算成连续时间的衰减系数：
 *     keep(Δt) = (1 − α)^(Δt × 60)
 * 这样同一段时间在不同帧率下衰减总量完全一致（verify.mjs 里有断言）。
 * @param {number} current 当前值
 * @param {number} target  目标值
 * @param {number} alpha   60fps 下的平滑系数（0~1，越大越跟手）
 * @param {number} dt      帧间隔（秒）
 */
function damp(current, target, alpha, dt) {
  const keep = Math.pow(1 - clamp(alpha, 0.0001, 0.9999), dt * 60);
  return current + (target - current) * (1 - keep);
}

/** 三次平滑阶跃 smoothstep(e0, e1, x)，输出 0~1 */
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * 把张力映射为绽放度 bloom ∈ [0, bloomMax]，中间段平滑过渡。
 *
 *   tension ≤ lowTension  → bloom = 0         （花苞，粒子聚合）
 *   lowTension ~ highTension → S 形平滑上升   （缓缓绽放）
 *   tension ≥ highTension → bloom = bloomMax  （完全绽放，粒子扩散）
 *
 * 过冲设计：乘一个「中段隆起」的钟形包络
 *     envelope(t) = 1 + peak × sin(π · t)      t ∈ [0,1] 为归一化张力
 * 让曲线在过渡区中段（约 tension 0.42 附近）最快张开，
 * 到高张力端又回落成正好 bloomMax —— 于是花朵「唰」地打开再稳稳停住，
 * 而不是线性地慢慢爬到底，观感更像真实的花开。
 *
 * 注意：包络只作用于饱和之前的 core 值（core < 1），
 * 到达 highTension 时包络必须是 1.0，否则 bloom 会超过 bloomMax
 * （verify.mjs 里有「单调不减 + 上界」断言守住这一点）。
 */
function tensionToBloom(tension) {
  const { lowTension: lo, highTension: hi, bloomMax, bloomOvershoot } = CONFIG;
  const t = clamp((tension - lo) / (hi - lo || 1e-6));   // 归一化到 0~1
  const core = t * t * (3 - 2 * t);                      // smoothstep，S 形
  // 钟形包络：t=0 与 t=1 处为 1，中间最大 1 + bloomOvershoot
  // core 本身最大只有 1，所以必须乘 bloomMax 才能张开到设定幅度
  const envelope = 1 + bloomOvershoot * Math.sin(Math.PI * t);
  return clamp(core * envelope * bloomMax, 0, bloomMax);
}

/* ==========================================================================
   §3  张力计算 TensionMeter
   --------------------------------------------------------------------------
   核心公式（重点，见 README 详解）：
   设：
     D_tip = Σ|tip_i − wrist| / 5        i = 8,12,16,20（四指指尖）+ 4（拇指尖）
     D_pip = D(0→9)                      腕 → 中指 MCP（指关节），作为手掌尺度基准
     D_max = D(0→12)                     腕 → 中指指尖，用于判断“全张开”
   则：
     raw   = (D_tip / 5) / D_pip              − 1      ← 手掌张开度（拳≈0）
     open  = clamp(raw * openGain, 0, 1)               ← 归一化到 0~1
     t_ins = clamp(open × gain, 0, 1)
     t_new = t_old + (t_ins − t_old) × damp(smoothing, dt)  ← 帧率无关平滑
     tension = t_new
   为什么这样算：
     · 除以 D_pip 做“尺度归一化”，手掌离镜头远近都不影响结果；
     · 除以 5 取均值，避免单根手指抖动导致数值跳变；
     · 相对 D(0→9) 而非绝对值，因为食指/中指 MCP 在握拳与张开时位移最小，
       是稳定可靠的手掌尺寸参考；
     · 拇指指尖取点 4 而不是 3，因为 3 是拇指 IP 关节，握拳时也离腕较远。
   ========================================================================== */
class TensionMeter {
  constructor() {
    this.raw = 0;        // 未平滑的瞬时张力
    this.value = 0;      // 平滑后的张力（对外暴露）
    this.openness = 0;   // 手指伸直程度（四指平均），用于辅助视觉反馈
    this.state = STATE.BUD;
    this.lastSeen = 0;   // 上次识别到手的时间戳
    this.hasHand = false;
    this.bloom = 0;      // 平滑后的绽放度
  }

  /**
   * @param {Array<{x:number,y:number,z:number}>} lm 21 个关键点（归一化坐标）
   * @param {number} dt 帧间隔（秒）
   */
  update(lm, dt) {
    const { smoothing, gain, openGain, lowTension, highTension, lostTimeout } = CONFIG;

    if (lm && lm.length >= 21) {
      this.hasHand = true;
      const wrist = lm[0];
      const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y, (lm[i].z - wrist.z) * 0.5);

      // ① 手掌尺度基准：腕 → 中指掌指关节（MCP, 9）
      const palmScale = Math.max(dip(9), 1e-4);

      // ② 五根指尖（含拇指尖 4）到手腕的平均距离
      const tips = [4, 8, 12, 16, 20];
      const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;

      // ③ 相对张开度：握拳时 tipMean ≈ palmScale（指尖蜷到掌心），
      //    张开时 tipMean ≈ 2 × palmScale，因此减 1 后正好落在 0~1 附近
      const relative = tipMean / palmScale - 1;

      // ④ 归一化 + 增益 + 截断
      this.raw = clamp(clamp(relative * openGain, 0, 1) * gain, 0, 1);

      // ⑤ 辅助指标：四指（不含拇指）的伸直程度 —— 用于花瓣“握拢”的感觉
      const curl = [8, 12, 16, 20].reduce((s, tipIdx, k) => {
        const pipIdx = [6, 10, 14, 18][k];             // 各指近节指间关节
        const dTip = Math.hypot(lm[tipIdx].x - wrist.x, lm[tipIdx].y - wrist.y);
        const dPip = Math.hypot(lm[pipIdx].x - wrist.x, lm[pipIdx].y - wrist.y);
        return s + clamp(dTip / Math.max(dPip, 1e-4) - 1, 0, 1);
      }, 0) / 4;
      this.openness = curl;

      this.lastSeen = performance.now();
    } else {
      // 识别不到手时的兜底：
      //  · 短暂丢失（< lostTimeout）：保持上一次的 raw 不变，避免瞬间抽动
      //  · 持续丢失：缓缓回落到中性值 0.45，让花朵半开着待机，而不是“卡死”
      if (performance.now() - this.lastSeen > lostTimeout) {
        this.hasHand = false;
        this.raw = damp(this.raw, 0.45, 0.02, dt);   // 用很慢的系数，过渡自然
        this.openness = damp(this.openness, 0.45, 0.02, dt);
      }
    }

    // ⑥ 指数平滑（帧率无关）
    this.value = damp(this.value, this.raw, smoothing, dt);

    // ⑦ 迟滞状态机：0.32 以下为花苞，0.66 以上为绽放
    if (this.value < lowTension - (this.state === STATE.BUD ? 0 : CONFIG.hysteresis)) {
      this.state = STATE.BUD;
    } else if (this.value > highTension + (this.state === STATE.BLOOM ? 0 : CONFIG.hysteresis)) {
      this.state = STATE.BLOOM;
    } else if (this.state !== STATE.BLOOM && this.state !== STATE.BUD) {
      this.state = STATE.MID;
    } else {
      // 处于 BUD/BLOOM 且未越过对侧阈值 → 进入过渡带
      const inBand = this.value >= lowTension && this.value <= highTension;
      if (inBand) this.state = STATE.MID;
    }

    // ⑧ 绽放度：用 bloom 再平滑一次，画面更柔和
    const targetBloom = tensionToBloom(this.value);
    this.bloom = damp(this.bloom, targetBloom, 0.12, dt);
    return this.value;
  }

  /** 不依赖 MediaPipe 的纯函数版本：给定 21 点直接算瞬时张力。
   *  抽出来是为了让双手模式能对"左手/右手"分别调用（见 TwoHandController）。 */
  static instantTension(lm, gainMul = 1) {
    if (!lm || lm.length < 21) return null;
    const { gain, openGain } = CONFIG;
    const wrist = lm[0];
    const dip = (i) => Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y, (lm[i].z - wrist.z) * 0.5);
    const palmScale = Math.max(dip(9), 1e-4);
    const tips = [4, 8, 12, 16, 20];
    const tipMean = tips.reduce((s, i) => s + dip(i), 0) / tips.length;
    const relative = tipMean / palmScale - 1;
    return clamp(clamp(relative * openGain, 0, 1) * gain * gainMul, 0, 1);
  }
}

/* ==========================================================================
   §2.5  双手交互 TwoHandController
   --------------------------------------------------------------------------
   单手只能表达"张开度"一个自由度；加上第二只手后可以表达更多：

     ① 双手距离 span  → 花朵数量（1 ~ maxClusters 朵）
        两掌越远，长出的花越多 —— 像在"播种"出一片花丛。
        span 用「掌心欧氏距离 / 双手腕间距的尺度」归一化，手离镜头远近不影响。

     ② 双手开合 openness → 生长进度 grow（0→1）
        双手同时张开 = 让花继续生长；双手握拳 = 停止生长。
        取两只手张力的【较大值】，任一只手张开就能推进。

     ③ 双手旋转角 roll → 场景绕 Y 轴旋转
        两掌连线的倾角，转动手腕时整片花丛跟着转。

     ④ 双手中点 center → 场景平移
        两手整体移动，花丛跟着移动。

   只手时：退化为原来的单手模式（拉伸/握拳控制绽放）。
   ========================================================================== */

class TwoHandController {
  constructor() {
    /** 输出给渲染层的状态 */
    this.span = 0;          // 归一化双手距离 0~1
    this.rotation = 0;      // 两掌连线角度（弧度）
    this.center = new THREE.Vector2(0.5, 0.5);   // 双手中点（镜像后的归一化坐标）
    this.openness = 0;      // 双手综合张开度 0~1
    this.active = false;    // 是否检测到双手

    /** 平滑值（避免抖动） */
    this.smoothSpan = 0;
    this.smoothRot = 0;
    this.smoothCenter = new THREE.Vector2(0.5, 0.5);
    this.lastSeen = 0;

    /** 旋转累积量：用于场景持续旋转（角度是相对的，不能直接用） */
    this.rotationAccum = 0;
    this._lastRawRot = null;
    this._lastRawSpan = null;
  }

  /**
   * @param {Array} handsData HandTracker.handsData（未镜像坐标）
   * @param {number} dt
   */
  update(handsData, dt) {
    /* 模式判断放在调用方（App._frame 只在双手模式下才喂数据），
       这里只看"是不是真的有两只手"，保持控制器本身职责单一。 */
    const two = Array.isArray(handsData) && handsData.length >= 2;

    if (two) {
      this.active = true;
      this.lastSeen = performance.now();

      const [a, b] = handsData;   // 已按 Left/Right 排好序
      const pa = a.pointer, pb = b.pointer;

      // ---- ① 双手距离 ----
      // 视频坐标是归一化的 [0,1]；x 方向还要乘宽高比才和 y 方向等尺度，
      // 但这里只需要一个稳定的相对量，直接算欧氏距离即可。
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.hypot(dx, dy);

      // 尺度归一化：用"两只手各自的手掌大小"做基准，手离镜头远近不影响读数
      const palmA = TensionMeter.palmSize(a.landmarks);
      const palmB = TensionMeter.palmSize(b.landmarks);
      const palmRef = Math.max((palmA + palmB) * 0.5, 1e-4);
      // 距离 / 手掌尺寸 → 与镜头距离无关的比值
      const distNorm = dist / palmRef;

      // 映射到 0~1（比值 ≈ 1.2 时算并拢，≈ 4.5 时算完全拉开）
      const rawSpan = clamp((distNorm - 1.2) / (4.5 - 1.2));

      // ---- ② 双手张开度 ----
      const ta = TensionMeter.instantTension(a.landmarks) ?? 0;
      const tb = TensionMeter.instantTension(b.landmarks) ?? 0;
      // 取较大值：任一只手张开就能推进生长，比取平均更好操作
      const rawOpen = Math.max(ta, tb);
      this.openness = damp(this.openness, rawOpen, 0.16, dt);

      // ---- ③ 旋转角 ----
      // 注意 y 轴向下，取负号让"顺时针转手 = 顺时针转花"
      const rawRot = Math.atan2(-dy, dx);

      // ---- ④ 中点 ----
      // 镜像：MediaPipe 是原始视频坐标，画面是镜像的
      const cx = 1 - (pa.x + pb.x) * 0.5;
      const cy = (pa.y + pb.y) * 0.5;

      // ---- 平滑 ----
      this.smoothSpan = damp(this.smoothSpan, rawSpan, 0.14, dt);
      this.span = this.smoothSpan;
      this.smoothCenter.x = damp(this.smoothCenter.x, cx, 0.12, dt);
      this.smoothCenter.y = damp(this.smoothCenter.y, cy, 0.12, dt);
      this.center.copy(this.smoothCenter);

      /* 旋转要处理"角度回绕"：atan2 在 ±π 处会跳变。
         做法是记录上一帧原始角度，取最短路径的增量再累积，
         这样跨越 ±π 时不会突然反向甩一整圈。 */
      if (this._lastRawRot === null) {
        this._lastRawRot = rawRot;
      } else {
        let delta = rawRot - this._lastRawRot;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        this._lastRawRot = rawRot;
        // 只在双手确实在动时累积，抑制静止时噪声引起的缓慢漂移
        if (Math.abs(delta) > 0.0015) {
          this.rotationAccum += delta * CONFIG.twoHandRotate;
        }
      }
      this.smoothRot = this.rotationAccum;
      this.rotation = this.smoothRot;
    } else {
      // ---- 没有双手：平滑回落到中性值 ----
      this.active = false;
      this._lastRawRot = null;      // 下次进入双手模式时重新起算，避免跳变
      this.openness = damp(this.openness, 0, 0.08, dt);
      // span 保留最后的值（花朵数量不会因为暂时举手而闪没），
      // 但如果长时间没有双手，慢慢回落到"一朵花"
      if (performance.now() - this.lastSeen > CONFIG.lostTimeout * 2) {
        this.smoothSpan = damp(this.smoothSpan, 0, 0.02, dt);
        this.span = this.smoothSpan;
      }
      this.smoothCenter.x = damp(this.smoothCenter.x, 0.5, 0.05, dt);
      this.smoothCenter.y = damp(this.smoothCenter.y, 0.5, 0.05, dt);
      this.center.copy(this.smoothCenter);
    }

    return this.span;
  }

  /** 供 UI 显示的简要状态 */
  describe() {
    if (!this.active) return '单手模式';
    return `双手模式 · 距离 ${this.span.toFixed(2)} · 开合 ${this.openness.toFixed(2)}`;
  }
}

/* 给 TensionMeter 补一个静态工具：估算手掌尺寸，用于双手距离的尺度归一化 */
TensionMeter.palmSize = function (lm) {
  if (!lm || lm.length < 21) return 1e-4;
  const wrist = lm[0];
  return Math.max(Math.hypot(lm[9].x - wrist.x, lm[9].y - wrist.y), 1e-4);
};

/* ==========================================================================
   §2.6  生长动画 GrowthAnimator
   --------------------------------------------------------------------------
   把「种子 → 发芽 → 花苞 → 开花」做成一条时间轴。

   两种驱动方式：
     · 自动播放 play()：按 growDuration 从 0 走到 1（程序启动时播一次）
     · 手势驱动 setTarget()：双手张开度决定目标进度，玩家自己"喂"生长

   生长曲线设计（关键手感）：
     g ∈ [0, growSeedHold]            种子期：趴着不动，蓄力
     g ∈ [seedHold, growSprout]       破土期：加速长出（easeOutBack，末端轻微过冲）
     g ∈ [growSprout, 1]              开花期：交给 bloom 去表现，grow 本身缓入收尾

   为什么要分段：如果一条 easeInOut 从头用到尾，种子期会"还没站稳就开始长"，
   看起来像被拉伸而不是生长。分段后先慢、再猛、再稳，才像真的发芽。
   ========================================================================== */

class GrowthAnimator {
  constructor() {
    this.progress = 0;        // 当前生长进度 0~1
    this.autoPlaying = false; // 是否在自动播放
    this.autoTime = 0;        // 自动播放已进行的秒数
    this.gestureTarget = 0;   // 手势模式下的目标进度
    this.useGesture = false;  // 是否由手势驱动
    this.growTime = 0;        // 供着色器做破土抖动用的时间
    this.sproutFlash = 0;     // 破土瞬间的闪光（0~1，衰减）
    this._prevProgress = 0;
  }

  /** 从头播放一次生长动画 */
  play() {
    this.autoPlaying = true;
    this.useGesture = false;
    this.autoTime = 0;
    this.progress = 0;
    this.growTime = 0;
    this._prevProgress = 0;
  }

  /** 重新播种：直接重置到种子状态（不自动播放） */
  reset() {
    this.autoPlaying = false;
    this.useGesture = false;
    this.autoTime = 0;
    this.progress = 0;
    this.growTime = 0;
    this.gestureTarget = 0;
    this._prevProgress = 0;
  }

  /** 交给手势驱动；target ∈ [0,1] */
  setTarget(target) {
    this.useGesture = true;
    this.autoPlaying = false;
    this.gestureTarget = clamp(target);
  }

  /**
   * @param {number} dt
   * @param {number} gestureGrow 手势给出的目标生长进度（双手张开度）
   * @returns {number} 当前生长进度
   */
  update(dt, gestureGrow = 0) {
    const prev = this.progress;

    if (this.autoPlaying) {
      // ---- 自动播放：按时间推进 ----
      this.autoTime += dt;
      const t = clamp(this.autoTime / Math.max(CONFIG.growDuration, 0.1));
      this.progress = t;
      if (t >= 1) {
        this.autoPlaying = false;
        this.progress = 1;
      }
    } else if (this.useGesture) {
      // ---- 手势驱动：向目标平滑（生长快、倒退慢） ----
      const target = clamp(gestureGrow);
      // 往上长比往回缩快得多 —— 现实里花也不会瞬间缩回种子里
      const rate = target > this.progress ? 0.10 : 0.03;
      this.progress = damp(this.progress, target, rate, dt);
    }
    // 否则：保持当前进度不动（暂停）

    this.growTime += dt;

    /* 破土闪光：进度刚越过"开始破土"那一刻触发一次 */
    const sproutStart = CONFIG.growSeedHold;
    if (prev < sproutStart && this.progress >= sproutStart) {
      this.sproutFlash = 1;
    }
    this.sproutFlash = Math.max(0, this.sproutFlash - dt * 1.6);

    this._prevProgress = this.progress;
    return this.progress;
  }

  /** 把整体进度展开成"单朵花"的两段量：形态(形态0~1) 与 绽放(0~1)
   *  @param {number} stagger 该朵花的错峰偏移（0~clusterStagger）
   */
  static shapes(progress, stagger = 0) {
    // 错峰：越靠后的花，它的时间轴越滞后
    const g = clamp((progress - stagger) / Math.max(1 - stagger, 1e-3));

    const seedHold = CONFIG.growSeedHold;    // 种子停留占比
    const sproutAt = CONFIG.growSprout;      // 长出花苞时的占比

    /* ---- 形态：种子 → 花苞 ----
       [0, seedHold]：保持 0（趴在地上）
       [seedHold, sproutAt]：easeOutBack，末端轻微过冲，像"顶出来" */
    let form = 0;
    if (g > seedHold) {
      const u = clamp((g - seedHold) / Math.max(sproutAt - seedHold, 1e-3));
      const c1 = 1.70158, c3 = c1 + 1;
      const back = 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
      form = clamp(back);
    }

    /* ---- 绽放：花苞 → 开花 ----
       [sproutAt, 1]：easeInOut，平滑张开 */
    let bloomT = 0;
    if (g > sproutAt) {
      const u = clamp((g - sproutAt) / Math.max(1 - sproutAt, 1e-3));
      bloomT = u * u * (3 - 2 * u);
    }

    return { form, bloomT };
  }
}

/* ==========================================================================
   §2.7  花丛布局 ClusterLayout
   --------------------------------------------------------------------------
   把"双手距离"映射成一组花的摆放位置。

   布局用【黄金角螺旋】（向日葵种子排列）：
     i 朵花的第 k 个位置：
       r = spread × sqrt(k / n)          ← sqrt 让各花在面积上均匀
       θ = k × 137.508°                  ← 黄金角，永不重叠、分布最美
   比"均分圆周"好在：花数从 1 变到 5 时，已有花朵的位置不会整体重排，
   只会插入新位置 —— 视觉上是"长出新的花"，而不是"整片花丛跳一下"。
   ========================================================================== */

class ClusterLayout {
  constructor() {
    this.positions = [];
    for (let i = 0; i < CONFIG.maxClusters; i++) {
      this.positions.push(new THREE.Vector3());
    }
  }

  /**
   * @param {number} span 归一化双手距离 0~1
   * @returns {number} 应该有几朵花（1 ~ maxClusters）
   */
  static countForSpan(span) {
    const n = Math.round(lerp(1, CONFIG.maxClusters, clamp(span)));
    return Math.max(1, Math.min(CONFIG.maxClusters, n));
  }

  /**
   * 计算每朵花的位置
   * @param {number} count 花朵数量
   * @param {number} spread 散布半径
   */
  layout(count, spread) {
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));   // ≈ 2.39996 rad = 137.5°
    for (let k = 0; k < CONFIG.maxClusters; k++) {
      const p = this.positions[k];
      if (k >= count) {
        // 未激活：叠到中心并让调用方把 scale 设为 0
        p.set(0, 0, 0);
        continue;
      }
      // 单朵花时居中；多朵时螺旋铺开
      const r = count === 1 ? 0 : spread * Math.sqrt((k + 0.5) / count);
      const th = k * GOLDEN;
      // 中心那朵稍微抬高一点，边缘的略低，形成自然的丛生层次
      const y = -r * 0.12 + (count === 1 ? 0 : -0.05);
      p.set(Math.cos(th) * r, y, Math.sin(th) * r);
    }
    return this.positions;
  }
}

/* ==========================================================================
   §2  手势追踪 HandTracker
   --------------------------------------------------------------------------
   · 使用 MediaPipe Hands（CDN UMD，window.Hands）
   · 输入：隐藏的 <video>
   · 输出：onResults(landmarks|null, handedness)
   · 额外职责：在 overlay 画布上绘制 21 点与骨架连线
   ========================================================================== */

/** MediaPipe Hands 官方 21 关键点连接表（用于画骨架） */
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
  [0, 17],                                  // 掌根闭合
];

class HandTracker {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLCanvasElement} opts.overlay 骨架绘制画布
   * @param {(lm:Array|null, info:object)=>void} opts.onResults
   * @param {(msg:string, fatal?:boolean)=>void} opts.onError
   */
  constructor({ video, overlay, onResults, onError, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext('2d');
    this.onResults = onResults;
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});

    this.hands = null;
    this.stream = null;
    this.running = false;

    /** 双手数据：每只手的 { landmarks, handedness, label, pointer }
     *  左手在前、右手在后（按 MediaPipe 的 label 排序，保证索引稳定） */
    this.handsData = [];
    /** 兼容旧接口：主手（右手优先）的 21 点，没有手时为 null */
    this.lastLandmarks = null;
    this.lastHandedness = null;

    /** 平滑后的手指位置（用于画面“跟手”），存归一化坐标 */
    this.pointer = new THREE.Vector2(0.5, 0.5);
    this.pointerTarget = new THREE.Vector2(0.5, 0.5);
    this.pointerActive = false;

    /** 双手是否同时出现 */
    this.twoHandActive = false;
  }

  /** 检查 MediaPipe 脚本是否加载成功 */
  static isAvailable() {
    return typeof window !== 'undefined' && typeof window.Hands === 'function';
  }

  /** 请求摄像头 + 初始化 MediaPipe。返回 Promise<void> */
  async start() {
    if (this.running) return;

    // ---- ① 环境检查 ----
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        '浏览器不支持摄像头 API。请使用 Chrome / Edge / Safari 最新版，' +
        '并确认页面通过 http(s) 打开（file:// 协议下浏览器会禁用摄像头）。'
      );
    }
    if (!HandTracker.isAvailable()) {
      throw new Error(
        'MediaPipe Hands 脚本未能加载（window.Hands 未定义）。' +
        '请检查网络是否能访问 cdn.jsdelivr.net，或改用 npm 本地安装后重试。'
      );
    }

    // ---- ② 打开摄像头 ----
    this.onStatus('正在请求摄像头权限…');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: CONFIG.camWidth },
          height: { ideal: CONFIG.camHeight },
        },
      });
    } catch (err) {
      throw new Error(this._describeCameraError(err));
    }

    this.video.srcObject = this.stream;
    // iOS Safari 需要这个属性才允许内联播放
    this.video.setAttribute('playsinline', 'true');
    await this.video.play().catch(() => {
      /* 某些浏览器 play() 会被拒绝，交给下方 videoWidth 检测兜底 */
    });

    // ---- ③ 初始化 MediaPipe Hands ----
    this.onStatus('正在初始化手部识别模型…');
    this.hands = new window.Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
    });

    this.hands.setOptions({
      /* 始终识别 2 只手：单手模式下多识别的那只不会参与运算（见 App._frame），
         但保留它有两个好处：
           1. 用户可以随时切到双手模式而无需重启识别
           2. 单手模式下也能在画面里看到第二只手，提示"切双手就能用上它"
         代价是识别开销略高；若在低端机上有性能问题，
         可以把 maxHands 设成 1（那样双手模式就不可用了）。 */
      maxNumHands: CONFIG.maxHands,
      modelComplexity: 1,             // 0=最快 / 1=平衡；移动端可考虑 0
      selfieMode: false,              // 我们自己处理镜像，避免坐标二次翻转
      minDetectionConfidence: CONFIG.minDetectionConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
    });

    this.hands.onResults((results) => this._handleResults(results));

    // ---- ④ 启动识别循环 ----
    this.running = true;
    this.onStatus('手势识别运行中');
    this._loop();
  }

  /** 内部识别循环：send 是异步的，必须 await 后再排下一帧，否则会堆积 */
  async _loop() {
    while (this.running) {
      if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
        try {
          await this.hands.send({ image: this.video });
        } catch (err) {
          // 单帧失败不致命，记录后继续
          console.warn('[HandTracker] send 失败：', err);
        }
      } else {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      // MediaPipe 会自己占用一帧时间；这里补一个微延时让出主线程
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  _handleResults(results) {
    const all = results?.multiHandLandmarks || [];
    const handedness = results?.multiHandedness || [];

    /* ---------- 整理成双手数据 ----------
       MediaPipe 的 multiHandLandmarks 顺序会随手出现顺序变化，
       如果直接用下标 0/1，两只手会"串位"，导致左右手控制互换。
       这里按 handedness 的 label 排序（Left 在前、Right 在后），
       索引就稳定了；同时用 score 最高的那只作为"主手"。

       注意：selfieMode=false 时，MediaPipe 报的 Left/Right 是
       摄像头视角的标签（和镜子里的左右相反），这里统一换算成
       "用户视角"的左右，方便使用者理解左手/右手的提示。 */
    this.handsData = all.map((lm, i) => {
      const h = handedness[i] || {};
      // 摄像头视角 → 用户视角：标签互换
      const cameraLabel = h.label || h.classification?.[0]?.label || '';
      const userLabel = cameraLabel === 'Left' ? 'Right'
                      : cameraLabel === 'Right' ? 'Left' : '';
      // 掌心锚点（0/5/9/13/17 的均值）比单点稳
      const ids = [0, 5, 9, 13, 17];
      let cx = 0, cy = 0;
      for (const k of ids) { cx += lm[k].x; cy += lm[k].y; }
      cx /= ids.length; cy /= ids.length;
      return {
        landmarks: lm,
        label: userLabel,
        score: h.score ?? 0,
        // 注意：这里的 pointer 还是【未镜像】的原始视频坐标
        pointer: { x: cx, y: cy },
      };
    });

    // 排序：Left(用户左手) 在前
    this.handsData.sort((a, b) => {
      const rank = (d) => (d.label === 'Left' ? 0 : d.label === 'Right' ? 1 : 2);
      const r = rank(a) - rank(b);
      return r !== 0 ? r : b.score - a.score;
    });

    this.twoHandActive = this.handsData.length >= 2;

    /* ---------- 主手：优先用用户右手（右手控制绽放更符合直觉） ---------- */
    const primary =
      this.handsData.find((h) => h.label === 'Right') ||
      this.handsData[0] ||
      null;

    this.lastLandmarks = primary ? primary.landmarks : null;
    this.lastHandedness = primary
      ? { label: primary.label, score: primary.score }
      : null;
    this.pointerActive = !!primary;

    if (primary) {
      this.pointerTarget.set(primary.pointer.x, primary.pointer.y);
    }

    this._drawOverlay(this.handsData);
    this.onResults(this.lastLandmarks, {
      handedness: this.lastHandedness,
      hands: this.handsData,
      twoHand: this.twoHandActive,
    });
  }

  /** 手部骨架 + 关键点绘制（镜像后绘制，与视频背景方向一致）
   *  @param {Array} handsData 每只手 { landmarks, label }；空数组表示清空
   */
  _drawOverlay(handsData) {
    const canvas = this.overlay;
    const ctx = this.overlayCtx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // 尺寸自适应（只在变化时重设，避免每帧清空画布）
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const list = Array.isArray(handsData) ? handsData.filter((d) => d && d.landmarks) : [];
    if (list.length === 0 || !CONFIG.showSkeleton) return;

    // 归一化坐标 → 画布像素（镜像：x → 1 - x，和镜像的视频背景对齐）
    const px = (p) => (1 - p.x) * canvas.width;
    const py = (p) => p.y * canvas.height;

    const shown = [
      0,                                   // 腕
      1, 2, 3, 4,                          // 拇指
      5, 6, 7, 8,                          // 食指
      9, 10, 11, 12,                       // 中指
      13, 14, 15, 16,                      // 无名指
      17, 18, 19, 20,                      // 小指
    ];

    // 左右手用不同配色，一眼看出哪只手在控制什么
    //   用户右手 → 青蓝（控制绽放）
    //   用户左手 → 品红（辅助生长）
    //   未知     → 淡白
    const PALETTE = {
      Right: { line: 'rgba(124, 231, 255, 0.62)', glow: 'rgba(124, 231, 255, 0.9)', tip: 'rgba(160, 240, 255, 1)' },
      Left:  { line: 'rgba(255, 150, 210, 0.62)', glow: 'rgba(255, 122, 198, 0.9)', tip: 'rgba(255, 170, 220, 1)' },
      '':    { line: 'rgba(225, 235, 255, 0.55)', glow: 'rgba(220, 232, 255, 0.85)', tip: 'rgba(240, 248, 255, 1)' },
    };

    for (const hand of list) {
      const lm = hand.landmarks;
      const pal = PALETTE[hand.label] || PALETTE[''];

      // ---- 连线 ----
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 2.2 * dpr;
      ctx.shadowColor = pal.glow;
      ctx.shadowBlur = 8 * dpr;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(px(lm[a]), py(lm[a]));
        ctx.lineTo(px(lm[b]), py(lm[b]));
      }
      ctx.stroke();

      // ---- 关键点 ----
      for (const i of shown) {
        const isTip = [4, 8, 12, 16, 20].includes(i);
        ctx.beginPath();
        ctx.arc(px(lm[i]), py(lm[i]), (isTip ? 5 : 3.4) * dpr, 0, Math.PI * 2);
        if (isTip) {
          ctx.fillStyle = pal.tip;
          ctx.shadowColor = pal.glow;
          ctx.shadowBlur = 14 * dpr;
        } else {
          ctx.fillStyle = 'rgba(235, 245, 255, 0.92)';
          ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
          ctx.shadowBlur = 8 * dpr;
        }
        ctx.fill();
      }
    }

    /* ---- 双手模式：画出两掌之间的连线 + 距离提示 ----
       这条线是"双手交互"的视觉锚点：它随距离伸缩，
       直观告诉使用者"拉得越开，花长得越多"。 */
    if (list.length >= 2) {
      const [a, b] = list;
      const ax = px(a.pointer), ay = py(a.pointer);
      const bx = px(b.pointer), by = py(b.pointer);

      ctx.save();
      ctx.shadowColor = 'rgba(255, 230, 150, 0.9)';
      ctx.shadowBlur = 12 * dpr;
      ctx.strokeStyle = 'rgba(255, 235, 170, 0.75)';
      ctx.lineWidth = 1.6 * dpr;
      ctx.setLineDash([7 * dpr, 7 * dpr]);   // 虚线，区别于骨架实线
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);

      // 两端的掌心小圆
      for (const [x, y] of [[ax, ay], [bx, by]]) {
        ctx.beginPath();
        ctx.arc(x, y, 8 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 240, 190, 0.9)';
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.shadowBlur = 0;
  }

  /** 把 getUserMedia 的报错翻译成人话 */
  _describeCameraError(err) {
    const name = err?.name || '';
    const map = {
      NotAllowedError:
        '摄像头权限被拒绝。请在浏览器地址栏左侧的锁形图标里允许「摄像头」，然后刷新页面重试。',
      PermissionDeniedError:
        '摄像头权限被拒绝。请允许摄像头访问后刷新页面。',
      NotFoundError:
        '没有检测到可用的摄像头设备。请连接摄像头或使用带摄像头的设备重试。',
      DevicesNotFoundError:
        '没有检测到可用的摄像头设备。',
      NotReadableError:
        '摄像头被其他程序占用（如会议软件、相机应用）。请关闭占用的程序后重试。',
      TrackStartError:
        '摄像头无法启动，可能被其他程序占用。',
      OverconstrainedError:
        '摄像头不支持请求的分辨率。已尝试 640×480，请更换设备或降低分辨率要求。',
      SecurityError:
        '安全限制：请通过 https:// 或 http://localhost 打开页面，file:// 协议下无法使用摄像头。',
      AbortError:
        '摄像头启动被中断，请重试。',
    };
    return map[name] || `无法打开摄像头：${err?.message || name || '未知错误'}`;
  }

  /** 停止识别并释放摄像头 */
  stop() {
    this.running = false;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.onStatus('摄像头已关闭');
    this.handsData = [];
    this.twoHandActive = false;
    this.lastLandmarks = null;
    this.pointerActive = false;
    this._drawOverlay([]);
    this.onResults(null, { hands: [], twoHand: false });
  }

  /** 每帧调用：平滑手指指针位置 */
  update(dt) {
    // 镜像：MediaPipe 输出的是原始视频坐标，画面是镜像的
    const targetX = 1 - this.pointerTarget.x;
    const targetY = this.pointerTarget.y;
    this.pointer.x = damp(this.pointer.x, this.pointerActive ? targetX : 0.5, 0.14, dt);
    this.pointer.y = damp(this.pointer.y, this.pointerActive ? targetY : 0.5, 0.14, dt);
  }
}

/* ==========================================================================
   §4  粒子花朵 FlowerField
   --------------------------------------------------------------------------
   几何体设计（全部在 CPU 端一次生成，之后只在顶点着色器里插值）：
   每颗粒子保存两组位置与两组颜色：
     aPosBud   —— 花苞形态（闭合，粒子沿螺旋卷成球形）
     aPosBloom —— 绽放形态（沿极坐标花瓣曲线铺开）
     aColorBud / aColorBloom
   顶点着色器用 uniform uBloom 在两者之间 mix，
   位置、颜色、旋转、尺寸全部在 GPU 完成 → 几万粒子也能 60fps。
   ========================================================================== */

/* ---------- 顶点着色器 ----------
   源码里的 __MAX_CLUSTERS__ 会在下方用 CONFIG.maxClusters 替换，
   这样 GLSL 的数组长度和 JS 的配置永远一致（改配置不用改着色器）。

   注意：这里【不能】写成 ${...} —— 它本身就是一个 JS 模板字符串，
   ${} 会被立刻求值（引用不存在的变量会直接报错），
   必须用一个普通占位符，事后再 replace。 */
const VERT = /* glsl */ `
  precision highp float;

  /* 粒子属性（CPU 一次性填充） */
  attribute vec3  aPosBud;      // 花苞形态位置
  attribute vec3  aPosBloom;    // 绽放形态位置
  attribute vec3  aPosSeed;     // 种子形态位置（生长动画第一帧）
  attribute vec3  aColorBud;    // 花苞颜色
  attribute vec3  aColorBloom;  // 绽放颜色
  attribute float aSeed;        // 随机种子 0~1
  attribute float aSize;        // 尺寸系数
  attribute float aRole;        // 角色：0=花瓣 1=花心 2=种子尘埃
  attribute float aCluster;     // 所属花朵簇索引（0~MAX_CLUSTERS-1）

  /* 全局参数 */
  uniform float uBloom;         // 绽放度 0~1（可略大于 1，用于过冲）
  uniform float uTime;          // 累计时间
  uniform float uSize;          // 基础尺寸
  uniform float uPixelRatio;    // 设备像素比
  uniform vec2  uPointer;       // 手掌位置（归一化 0~1）
  uniform float uPointerActive; // 是否有手 0/1
  uniform float uTension;       // 平滑张力
  uniform vec3  uPetalAxis;     // 花朵朝向（用于飘动方向）

  /* ---------- 生长动画 ---------- */
  uniform float uGrow;          // 生长进度 0~1（0=种子，1=长成）
  uniform float uGrowTime;      // 生长开始至今的秒数（用于破土抖动）

  /* ---------- 多花簇 ----------
     注意：MAX_CLUSTERS 由 JS 在运行时注入（见 buildVertexShader），
     值等于 CONFIG.maxClusters，避免两边写死后不一致。
     GLSL ES 1.00 的 uniform 数组只能用常量表达式索引，
     所以下面取数必须用 for 循环逐项比较。 */
  #define MAX_CLUSTERS __MAX_CLUSTERS__
  uniform int   uClusterCount;              // 当前激活的花簇数量
  uniform vec3  uClusterPos[MAX_CLUSTERS];  // 每簇的中心位置
  uniform float uClusterScale[MAX_CLUSTERS];// 每簇的缩放
  uniform float uClusterBloom[MAX_CLUSTERS];// 每簇的独立绽放度
  uniform float uClusterGrow[MAX_CLUSTERS]; // 每簇的独立生长进度（错峰生长）

  varying vec3  vColor;
  varying float vAlpha;
  varying float vGlow;

  /* 便宜好用的 3D 噪声（用于呼吸/飘动，不追求物理正确） */
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }

  void main() {
    /* ---------- ⓪ 取本粒子所属花簇的参数 ----------
       GLSL ES 1.00 的 uniform 数组只能用「常量表达式」索引，
       所以这里必须用 for 循环逐项比较，不能直接 uClusterPos[i]。 */
    int ci = int(aCluster + 0.5);
    if (ci < 0) ci = 0;
    if (ci > MAX_CLUSTERS - 1) ci = MAX_CLUSTERS - 1;

    vec3  cPos   = uClusterPos[0];
    float cScale = uClusterScale[0];
    float cBloom = uClusterBloom[0];
    float cGrow  = uClusterGrow[0];
    for (int i = 0; i < MAX_CLUSTERS; i++) {
      if (i == ci) {
        cPos   = uClusterPos[i];
        cScale = uClusterScale[i];
        cBloom = uClusterBloom[i];
        cGrow  = uClusterGrow[i];
      }
    }

    float b = clamp(cBloom, 0.0, 2.0);
    float g = clamp(cGrow, 0.0, 1.0);

    /* ---------- ① 位置插值：种子 → 花苞 → 绽放 ----------
       生长进度 g 控制「种子→花苞」，绽放度 b 控制「花苞→绽放」。
       两段分开，就能实现"先长出来、再开花"的时序。 */
    vec3 pos = mix(aPosSeed, aPosBud, smoothstep(0.0, 0.55, g));
    pos = mix(pos, aPosBloom, clamp(b, 0.0, 1.0));

    /* ---------- ①.5 生长缩放：刚出土时很小，逐渐长到正常尺寸 ---------- */
    float growScale = mix(0.35, 1.0, smoothstep(0.0, 0.85, g));
    pos *= growScale;

    /* 种子期：粒子在地面上铺开成一小摊（像撒下的种子/土堆），
       而不是缩成一个小点 —— 这样"播种"阶段有明确的视觉存在感。 */
    float seedFlat = 1.0 - smoothstep(0.0, 0.22, g);
    pos.xz *= 1.0 + seedFlat * 1.8;
    pos.y = mix(pos.y, -0.5, seedFlat * 0.85);

    /* 破土抖动：生长前期加一点高频抖动，像在用力顶开土壤 */
    float sprout = (1.0 - smoothstep(0.1, 0.65, g)) * step(0.01, g);
    pos.x += sin(uGrowTime * 22.0 + aSeed * 40.0) * 0.035 * sprout;
    pos.z += cos(uGrowTime * 19.0 + aSeed * 31.0) * 0.035 * sprout;
    /* 破土时整体抬高一点，像从地里钻出来 */
    pos.y += (1.0 - smoothstep(0.0, 0.5, g)) * -0.35 * sprout;

    /* ---------- ② 呼吸：整体缓慢起伏，避免画面"死板" ---------- */
    float breath = sin(uTime * 0.9 + aSeed * 6.2831) * 0.5 + 0.5;
    pos *= 1.0 + breath * 0.022 * (0.35 + b);

    /* ---------- ③ 噪声飘动：模拟花粉在空气中的轻微浮动 ---------- */
    vec3 np = pos * 0.65 + vec3(0.0, uTime * 0.12, uTime * 0.06);
    vec3 drift = vec3(
      noise3(np) - 0.5,
      noise3(np + 13.7) - 0.5,
      noise3(np + 71.3) - 0.5
    );
    pos += drift * (0.045 + b * 0.24) * g;

    /* ---------- ④ 花瓣扇形展开：绽放瞬间像扇面一样层层打开 ---------- */
    float open = smoothstep(0.0, 1.0, clamp(b, 0.0, 1.0));
    float ang = 0.18 * (1.0 - open) * (aSeed - 0.5) * 2.0;
    float ca = cos(ang), sa = sin(ang);
    pos.xz = mat2(ca, -sa, sa, ca) * pos.xz;

    /* ---------- ④.5 移到本花簇的位置并缩放 ----------
       ⚠️ 这里踩过一个很容易忽略的坑：
       未激活的花簇 cScale = 0，如果直接 pos * 0 + cPos，
       该簇的全部粒子会【塌缩到同一个点】。加法混合下这些粒子
       叠成一整块过曝的白方块，再被泛光拉成一条亮线 ——
       画面上就会莫名多出一个白方块 + 一根白线。

       处理方式：把未激活簇的粒子【重定向到第 0 簇】，
       并且不加任何随机抖动 —— 让它们沿着同一套花瓣几何叠加，
       等于把这一朵花的粒子密度提高 N 倍。
       这样无论开几朵花，总粒子数始终全部用上，形状也不会被揉散。 */
    float cActive = step(0.001, cScale);
    vec3  usePos   = mix(uClusterPos[0],   cPos,   cActive);
    float useScale = mix(uClusterScale[0], cScale, cActive);

    pos = pos * useScale + usePos;

    /* ---------- ⑤ 跟手倾斜：手往左移动，花往左轻摆 ---------- */
    vec2 p = (uPointer - 0.5) * 2.0;
    float tilt = uPointerActive;
    pos.x += (-p.x) * tilt * 0.5 * (1.0 + length(pos.xz) * 0.35);
    pos.y += ( p.y) * tilt * 0.28;

    /* ---------- ⑥ 花心种子向上"喷发" ---------- */
    float burst = max(0.0, b - 1.0) * (0.6 + aSeed * 0.8);
    if (aRole > 1.5) {
      pos.y += burst * 2.4;
      pos.xz *= 1.0 + burst * 0.9;
    }

    /* ---------- ⑦ 手指处轻微排斥（跟随指尖的交互感） ----------
       把归一化指针坐标换算到花朵所在的模型空间：
         x: 0~1 → -3~+3（约等于相机在 6.4 距离下的可见宽度）
         y: 0~1 → +2.4~-2.4（屏幕 y 向下，模型 y 向上，需要翻转）
       然后让指尖附近的粒子沿径向被推开，形成"指尖扰动花丛"的感觉。

       ⚠️ 这里有个非常隐蔽的 NaN 陷阱（实测在真实 GPU 上也会触发）：
       当某个粒子的位置恰好等于指尖位置时 d = 0，
       而 normalize(d) 内部要除以 length(d) = 0 → 结果是 NaN。
       只要有一个顶点是 NaN，整条图元就会画成一条无意义的线，
       在画面上表现为"花朵上方突然飘着一根白线"。

       修法：给 length 一个下限，用除法代替 normalize。
       （只给 dist 加 0.001 是不够的 —— 那只保护了 dist 这个变量，
         normalize 内部仍然会对零向量做除法。） */
    float dToPointer = 1e3;
    if (uPointerActive > 0.5) {
      vec3 pointerWorld = vec3((uPointer.x - 0.5) * 6.0, (0.5 - uPointer.y) * 4.0 + 0.4, 0.0);
      vec3 d = pos - pointerWorld;
      float rawLen = length(d);
      // 关键：分母取 max(.,1e-4)，保证永远不会除以 0
      float safeLen = max(rawLen, 1e-4);
      vec3 dir = d / safeLen;                  // 等价于 normalize，但不会 NaN
      float dist = rawLen + 0.001;
      dToPointer = dist;
      float push = exp(-dist * dist * 3.0) * 0.55 * (1.0 + b);
      pos += dir * push;
    }

    /* ---------- ⑧ 投影 ---------- */
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    /* ---------- ⑨ 尺寸：近大远小 + 绽放时略缩小，形成层次 ----------
       这里踩过两个坑，都表现为"画面里出现一条突兀的白线 / 大色块"：

       ① gl_PointSize 用 1/(-mv.z)：粒子飘到相机平面附近时
          -mv.z → 0，尺寸会算出极大值（甚至负数 → 画出拉伸长条）。
       ② 只把结果 clamp 到 26px 还不够：一个几乎贴着镜头的粒子
          仍然会变成 26px 的大点，在画面边缘糊成一条线。

       所以改成：**尺寸随深度收敛**。深度越近，允许的最大尺寸越小，
       而不是简单截断。再配合"相机后方不画"，彻底消除拖影。 */
    float depth = -mv.z;

    float size = uSize * aSize * (1.0 - clamp(b, 0.0, 1.0) * 0.25);
    // 生长前期粒子略小，长成后恢复
    size *= mix(0.6, 1.0, smoothstep(0.0, 0.6, g));

    // 透视缩放：以 5.6 个单位为"标准距离"
    float persp = 5.6 / max(depth, 0.6);
    // 限制逐级放大：距离很近时放大倍数快速趋近于 1.8，
    // 避免单颗粒子被无限放大
    persp = min(persp, 1.8);

    gl_PointSize = size * uPixelRatio * persp * 1.6 * (0.75 + 0.5 * aSeed);

    /* 注意：gl_PointSize 的下限必须是 1.0，不能是 0.6。
       ALIASED_POINT_SIZE_RANGE 的最小值通常是 1，请求小于 1 的尺寸属于
       未定义行为 —— 某些驱动会把它光栅化成一条细长的线。
       低于 1px 的粒子其实也看不见，直接按 1 处理即可。 */
    gl_PointSize = clamp(gl_PointSize, 1.0, 14.0);

    // 相机后方 / 过近的粒子直接丢弃，免得糊在屏幕边缘
    if (depth <= 0.8) {
      gl_PointSize = 0.0;
    }

    /* ---------- ⑩ 颜色与亮度 ---------- */
    vColor = mix(aColorBud, aColorBloom, clamp(b, 0.0, 1.0));

    /* 花心更亮（像花蕊发光）；其余粒子按随机种子微调 */
    float isCoreParticle = 1.0 - step(0.5, aRole);
    vGlow = mix(0.6, 1.3, isCoreParticle) * (0.72 + 0.55 * aSeed) + b * 0.3;

    /* 花心粒子在中心高度重叠，加法混合会叠成一个锐利的白方块。
       单独压低它们的贡献，让"亮"来自多颗自然叠加，
       而不是单颗贼亮 —— 中心就变成柔和的光晕而不是实心块。 */
    if (aRole > 0.5 && aRole < 1.5) {
      vGlow *= 0.5;
    }

    /* 绽放瞬间的"冲击闪光"：b ≈ 0.7 时最亮 */
    vGlow += exp(-pow((b - 0.7) * 3.5, 2.0)) * 0.55;

    /* 刚冒出来时更亮一点，像嫩芽发光 */
    vGlow += (1.0 - smoothstep(0.0, 0.5, g)) * 0.45 * sprout;

    /* 指尖附近的粒子更亮，强化跟手反馈 */
    vAlpha = 1.0;
    if (uPointerActive > 0.5) {
      float near = exp(-dToPointer * dToPointer * 2.2);
      vGlow += near * 0.9;
      vAlpha = mix(0.72, 1.0, near);
    }

    /* 生长阶段的可见度：
       - 种子期（g≈0）不能完全透明，否则"播种"阶段是一片漆黑，
         看不到任何反馈。这里给一个下限（0.35），让种子是一点微弱的光。
       - 冒头之后迅速升到满亮度。 */
    vAlpha *= mix(0.35, 1.0, smoothstep(0.0, 0.18, g));

    /* 种子期额外给一点冷色微光，强调"还没长出来" */
    vGlow += (1.0 - smoothstep(0.0, 0.25, g)) * 0.35;
  }
`;

/* 把 __MAX_CLUSTERS__ 占位符替换成 CONFIG.maxClusters。
   用函数而不是模块级常量，是因为 CONFIG 可能在运行期被修改后触发重建。 */
const buildVertexShader = () =>
  VERT.replace('__MAX_CLUSTERS__', String(Math.max(1, Math.round(CONFIG.maxClusters))));

/* ---------- 片元着色器 ---------- */
const FRAG = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vGlow;

  void main() {
    /* 圆形柔边粒子：中心亮、边缘透明，天然形成光晕 */
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;

    float soft = smoothstep(0.5, 0.0, d);           // 外软边
    float core = pow(smoothstep(0.5, 0.0, d), 3.0); // 中心亮核

    /* 加法混合下，粒子叠在一起容易过曝。这里压低单颗粒子的输出，
       靠"多颗叠加"形成层次，而不是靠单颗很亮 —— 这样才能看清
       花瓣的形状与颜色渐变。

       标定说明：未激活的花簇已经不再参与绘制，所以画面亮度
       完全来自"这一朵花自己的 1/activeCount 粒子"。相比早期版本
       （那时有 4/5 的粒子堆在原点制造虚假亮度），现在需要把
       单颗的贡献调高一些，整体亮度才和以前相当。 */
    vec3 col = vColor * (0.62 + vGlow * 0.50);
    col += vec3(core) * 0.14 * clamp(vGlow, 0.0, 2.0);

    float alpha = soft * vAlpha * clamp(0.22 + vGlow * 0.32, 0.0, 0.68);

    gl_FragColor = vec4(col, alpha);
  }
`;

class FlowerField {
  constructor() {
    this.group = new THREE.Group();
    this.build();
  }

  /** 依据 CONFIG 重建整个粒子系统 */
  build() {
    // 释放旧资源
    if (this.points) {
      this.group.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }

    const count = Math.floor(CONFIG.particleCount);
    const geo = new THREE.BufferGeometry();

    const posBud = new Float32Array(count * 3);
    const posBloom = new Float32Array(count * 3);
    const posSeed = new Float32Array(count * 3);   // 生长动画的起点（种子）
    const colBud = new Float32Array(count * 3);
    const colBloom = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const role = new Float32Array(count);
    const cluster = new Float32Array(count);       // 所属花簇索引

    const { petalCount, petalSharp, coilTurns } = CONFIG;
    const coreCount = Math.floor(count * CONFIG.coreRatio);
    const seedCount = Math.floor(count * CONFIG.seedRatio);

    /* 颜色：花苞偏青蓝冷调，绽放偏粉橙暖调（HSL 插值更自然） */
    const cBudInner = new THREE.Color().setHSL(0.55, 0.85, 0.62); // 青蓝
    const cBudOuter = new THREE.Color().setHSL(0.62, 0.75, 0.42); // 深蓝紫
    const cBloomInner = new THREE.Color().setHSL(0.06, 0.95, 0.68); // 暖橙
    const cBloomOuter = new THREE.Color().setHSL(0.92, 0.95, 0.66); // 玫粉
    const cCore = new THREE.Color().setHSL(0.13, 1.0, 0.78);        // 金黄花蕊

    const tmpColor = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      let r, theta, radius, y, cr, sr;

      /* ---------- ① 角色分类 ---------- */
      const isCore = i < coreCount;
      const isSeed = i >= coreCount && i < coreCount + seedCount;
      let roleValue = 0;
      if (isCore) roleValue = 1;
      else if (isSeed) roleValue = 2;
      role[i] = roleValue;

      /* ---------- ② 绽放形态：极坐标花瓣曲线 ----------
         r(θ) = |cos(k·θ / 2)|^(1/sharp)   —— 经典的 k 瓣玫瑰曲线
         再乘上径向随机系数，让粒子填满花瓣面而不是只有轮廓。
      ------------------------------------------------- */
      const PETAL_R = 1.35;  // 花瓣最大半径（模型单位）
      theta = Math.random() * Math.PI * 2;
      // 玫瑰曲线半径（归一化到 0~1）；petalSharp < 1 时花瓣更瘦、瓣间凹陷更深
      const petalR = Math.pow(
        Math.abs(Math.cos((petalCount * theta) / 2)),
        petalSharp
      );
      // 径向分布：sqrt 让粒子在花瓣面上均匀（面积均匀采样）。
      // 系数 0.97 让靠边的粒子也能到花瓣尖端，形成清晰的轮廓。
      const radial = Math.sqrt(Math.random()) * 0.97 + 0.03;
      radius = petalR * radial * PETAL_R * CONFIG.bloomScale;
      /* 花瓣不是平的：让它在"根部低、尖端高"的曲面上展开，
         形成像真花一样向上张开的立体花冠（而不是一个朝下的碗）。
         lift 在根部 ≈ 0、到花瓣尖端升到 ≈ 0.45。 */
      const petalT = clamp(radius / (PETAL_R * CONFIG.bloomScale));  // 0=花心 1=瓣尖
      const lift = Math.pow(petalT, 1.3) * 0.45;
      // 花心/种子粒子集中在中心
      if (isCore) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.pow(Math.random(), 0.6) * 0.3;
        posBloom[i3] = Math.cos(a) * rr;
        posBloom[i3 + 1] = Math.sin(a) * rr * 0.8 + 0.04;
        posBloom[i3 + 2] = (Math.random() - 0.5) * 0.22;
      } else if (isSeed) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.pow(Math.random(), 0.5) * 1.1;
        posBloom[i3] = Math.cos(a) * rr;
        posBloom[i3 + 1] = (Math.random() - 0.4) * 0.8;
        posBloom[i3 + 2] = Math.sin(a) * rr;
      } else {
        posBloom[i3] = Math.cos(theta) * radius;
        posBloom[i3 + 1] = lift + (Math.random() - 0.5) * 0.12;
        posBloom[i3 + 2] = Math.sin(theta) * radius;
      }

      /* ---------- ③ 花苞形态：紧密包裹的水滴形 ----------
         要点：花苞必须是一个【有体积的实体】，而不是一条螺旋线。
         之前把半径和角度都绑在同一个 u 上，粒子只会排成一根细螺旋线，
         看起来像个圈。这里改成：
           · 先在单位球里取一个均匀分布的点（球面方向 + 体积半径）
           · 再按高度做"水滴形"拉伸：底部饱满、顶部收尖
           · 叠加一点点绕轴扭曲（twist），形成花瓣层层包裹的观感
      ------------------------------------------------- */
      const budRadius = 0.62;
      const budHeight = 1.15;

      // ① 球内均匀采样（拒绝法太慢，用 cbrt 做体积均匀采样）
      const cosT = 2 * Math.random() - 1;          // cosθ ∈ [-1,1]
      const sinT = Math.sqrt(1 - cosT * cosT);
      const phi0 = Math.random() * Math.PI * 2;
      const vol = Math.cbrt(Math.random());         // 体积均匀：r ∝ U^(1/3)

      // ② 水滴外形：竖直方向按位置缩放半径，底宽顶尖
      const vy = cosT * vol;                        // [-1,1] 竖直坐标
      const hNorm = (vy + 1) * 0.5;                 // 0=底 1=顶
      // 半径包络：底部饱满、中部最宽、顶部收成尖
      const envelope = Math.sin(Math.pow(hNorm, 0.75) * Math.PI * 0.86 + 0.12);
      const shell = Math.cbrt(Math.random());       // 单独采样，保证内部也填充

      r = sinT * vol * budRadius * envelope * (0.35 + 0.65 * shell);
      // ③ 绕 y 轴轻微扭曲：越靠上扭转越多，模拟花瓣螺旋包裹
      const twist = (vy * 0.5 + 0.5) * CONFIG.coilTurns * 0.9;
      const phi = phi0 + twist;
      y = vy * budHeight * 0.5 + 0.12;

      // 花心/种子在花苞里也挤在中心
      if (isCore) { r *= 0.3; y *= 0.3; }
      if (isSeed) { r *= 0.75; }

      posBud[i3] = Math.cos(phi) * r;
      posBud[i3 + 1] = y;
      posBud[i3 + 2] = Math.sin(phi) * r;

      /* ---------- ③.5 种子形态：紧贴地面的一小撮颗粒 ----------
         生长动画的起点。种子的关键观感是"趴在地上"：
         y 坐标压在很小的范围里（贴地），水平方向也收得很紧。
         这样从种子 → 花苞的过程就是"破土长出"，而不是凭空放大。 */
      {
        const sa = Math.random() * Math.PI * 2;
        // sqrt 让种子在圆盘上面积均匀
        const srr = Math.sqrt(Math.random()) * 0.16;
        posSeed[i3] = Math.cos(sa) * srr;
        posSeed[i3 + 1] = -0.52 + Math.random() * 0.09;   // 贴地（略低于花苞底部）
        posSeed[i3 + 2] = Math.sin(sa) * srr;
      }

      /* ---------- ③.6 花簇分配 ----------
         用粒子序号取模来分簇（而不是随机），保证每簇的粒子数严格相等，
         这样每朵花的疏密程度才一致。
         花苞/种子这种集中在中心的粒子也照常分簇。 */
      cluster[i] = i % CONFIG.maxClusters;

      /* ---------- ④ 颜色 ---------- */
      // 绽放色：中心暖橙 → 外缘玫粉（按粒子在花瓣上的相对半径取渐变）
      const t = clamp(radius / (PETAL_R * CONFIG.bloomScale));
      tmpColor.copy(cBloomInner).lerp(cBloomOuter, Math.pow(t, 0.75));
      if (isCore) tmpColor.copy(cCore);
      if (isSeed) tmpColor.lerp(new THREE.Color(0xffffff), 0.7);
      colBloom[i3] = tmpColor.r; colBloom[i3 + 1] = tmpColor.g; colBloom[i3 + 2] = tmpColor.b;

      /* 花苞色：中心亮青 → 外层深蓝紫，整体压暗。
         用"离花苞中轴的距离"做渐变，外层越远越深，形成包卷的立体感。 */
      const budRadialT = clamp(Math.hypot(posBud[i3], posBud[i3 + 2]) / budRadius);
      tmpColor.copy(cBudInner).lerp(cBudOuter, Math.pow(budRadialT, 0.8));
      if (isCore) tmpColor.copy(cCore).lerp(cBudInner, 0.45);
      if (isSeed) tmpColor.lerp(new THREE.Color(0xbfe9ff), 0.6);
      colBud[i3] = tmpColor.r * 0.72; colBud[i3 + 1] = tmpColor.g * 0.78; colBud[i3 + 2] = tmpColor.b * 0.95;

      /* ---------- ⑤ 随机种子 / 尺寸 ---------- */
      seed[i] = Math.random();
      // 花瓣粒子略大，尘埃粒子略小
      size[i] = isCore ? 1.5 : isSeed ? 0.75 : (0.65 + Math.random() * 0.7);
    }

    /* position 属性是必需的，但真实位置完全在顶点着色器里用 aPosBud/aPosBloom
       插值算出来。这里给它一份初始数据（不影响渲染），同时显式设置
       drawRange —— 不设置的话其 count 是 null，three.js 会一个粒子都不画。 */
    geo.setAttribute('position', new THREE.BufferAttribute(posBloom.slice(), 3));
    geo.setAttribute('aPosBud', new THREE.BufferAttribute(posBud, 3));
    geo.setAttribute('aPosBloom', new THREE.BufferAttribute(posBloom, 3));
    geo.setAttribute('aPosSeed', new THREE.BufferAttribute(posSeed, 3));
    geo.setAttribute('aColorBud', new THREE.BufferAttribute(colBud, 3));
    geo.setAttribute('aColorBloom', new THREE.BufferAttribute(colBloom, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aRole', new THREE.BufferAttribute(role, 1));
    geo.setAttribute('aCluster', new THREE.BufferAttribute(cluster, 1));

    // 明确告诉 three.js 要绘制全部粒子
    geo.setDrawRange(0, count);

    // 手动给一个包围球，避免 frustum culling 误裁（位置在 GPU 里算，CPU 不知道范围）
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 16);

    /* 多花簇 uniform：GLSL ES 1.00 要求数组有固定长度，这里按 MAX_CLUSTERS 分配。
       初始化时把第 0 簇放在原点、其余簇叠在原点（不可见），
       真实位置由 TwoHandController / 生长动画每帧写入。 */
    const MC = CONFIG.maxClusters;
    const clusterPos = [];
    const clusterScale = new Float32Array(MC).fill(1);
    const clusterBloom = new Float32Array(MC);
    const clusterGrow = new Float32Array(MC);
    for (let i = 0; i < MC; i++) clusterPos.push(new THREE.Vector3(0, 0, 0));

    this.material = new THREE.ShaderMaterial({
      vertexShader: buildVertexShader(),
      fragmentShader: FRAG,
      uniforms: {
        uBloom: { value: 0 },
        uTime: { value: 0 },
        uSize: { value: CONFIG.sizeBase },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio) },
        uPointer: { value: new THREE.Vector2(0.5, 0.5) },
        uPointerActive: { value: 0 },
        uTension: { value: 0 },
        uPetalAxis: { value: new THREE.Vector3(0, 1, 0) },
        // 生长动画
        uGrow: { value: 0 },
        uGrowTime: { value: 0 },
        // 多花簇
        uClusterCount: { value: 1 },
        uClusterPos: { value: clusterPos },
        uClusterScale: { value: clusterScale },
        uClusterBloom: { value: clusterBloom },
        uClusterGrow: { value: clusterGrow },
      },
      transparent: true,
      depthWrite: false,                 // 粒子不做深度写入，避免互相遮挡出黑边
      blending: THREE.AdditiveBlending,  // 加法混合 → 自然光晕
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    /* 花冠朝向：稍微向相机方向前倾（正值 = 花冠朝观察者抬起），
       这样既能看到花瓣的正面分布，又能看出立体层次。
       相机在 y=0.7 略高于花朵，所以前倾一点正好正对视线。 */
    this.group.rotation.x = 0.42;
    this.baseTiltX = 0.42;
  }

  /**
   * 每帧更新
   * @param {object} s 渲染状态
   * @param {number} s.bloom        绽放度
   * @param {number} s.tension      张力
   * @param {THREE.Vector2} s.pointer 手指位置（归一化 0~1）
   * @param {boolean} s.pointerActive 是否有手
   * @param {number} s.grow         生长进度 0~1
   * @param {number} s.growTime     生长开始至今的秒数
   * @param {Array<{pos:THREE.Vector3,scale:number,bloom:number,grow:number}>} s.clusters 花簇
   * @param {number} dt
   */
  update(s, dt) {
    const u = this.material.uniforms;
    u.uBloom.value = s.bloom;
    u.uTension.value = s.tension;
    u.uPointer.value.copy(s.pointer);
    u.uPointerActive.value = damp(u.uPointerActive.value, s.pointerActive ? 1 : 0, 0.2, dt);
    u.uTime.value += dt;

    // ---- 生长动画 ----
    u.uGrow.value = s.grow;
    // 只有在生长过程中才推进"破土抖动"计时，长成后停住，省得白算
    u.uGrowTime.value = (s.grow > 0 && s.grow < 1) ? s.growTime : u.uGrowTime.value;

    // ---- 多花簇 ----
    const clusters = s.clusters || [];
    const n = Math.max(1, Math.min(CONFIG.maxClusters, clusters.length || 1));
    u.uClusterCount.value = n;
    for (let i = 0; i < CONFIG.maxClusters; i++) {
      const c = clusters[i];
      if (c) {
        u.uClusterPos.value[i].copy(c.pos);
        u.uClusterScale.value[i] = c.scale;
        u.uClusterBloom.value[i] = c.bloom;
        u.uClusterGrow.value[i] = c.grow;
      } else {
        // 未激活的簇：缩放到 0，粒子塌缩到原点，等于不可见
        u.uClusterPos.value[i].set(0, 0, 0);
        u.uClusterScale.value[i] = 0;
        u.uClusterBloom.value[i] = 0;
        u.uClusterGrow.value[i] = 0;
      }
    }

    /* 整体缩放：花苞时收紧、绽放时长大。
       注意多花簇模式下每簇已有自己的 scale，这里只做整体呼吸感，
       所以把幅度压小，避免和簇缩放叠乘后过冲。 */
    const target = 0.92 + s.bloom * 0.10;
    this.group.scale.setScalar(damp(this.group.scale.x, target, 0.2, dt));
  }
}

/* ==========================================================================
   §5  舞台 Stage：场景 / 相机 / 摄像头背景 / 后期
   ========================================================================== */

class Stage {
  constructor(glCanvas, bgCanvas, video) {
    this.glCanvas = glCanvas;
    this.bgCanvas = bgCanvas;
    this.bgCtx = bgCanvas.getContext('2d', { alpha: false });
    this.video = video;

    /* ---------- 渲染器 ---------- */
    this.renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: false,        // 粒子用不上 MSAA，省性能
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    /* ---------- 场景与相机 ---------- */
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 1.5, 6.0);
    this.camera.lookAt(0, 0.15, 0);

    /* ---------- 背景：摄像头视频平面 ---------- */
    this.videoTexture = new THREE.CanvasTexture(bgCanvas);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    const bgGeo = new THREE.PlaneGeometry(2, 2);
    this.bgMaterial = new THREE.MeshBasicMaterial({
      map: this.videoTexture,
      transparent: true,
      opacity: 0.22,               // 半透明叠加，让粒子更突出（太高会盖住花朵）
      depthWrite: false,
      depthTest: false,
    });
    this.bgMesh = new THREE.Mesh(bgGeo, this.bgMaterial);
    /* 用正交相机把 2×2 的平面直接铺满屏幕。
       注意：正交相机在 x/y 上都是 -1~1，所以一个 2×2 的平面本身就已经
       铺满视口了 —— 这里只需要按「视频宽高比 vs 视口宽高比」做 contain
       裁切，让画面等比放大到刚好盖住屏幕，多出来的部分被裁掉。
       具体缩放量在 resize() 里按视口计算。 */
    this.bgScene = new THREE.Scene();
    this.bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bgMesh.renderOrder = -1;
    this.bgScene.add(this.bgMesh);

    /* ---------- 花朵 ---------- */
    this.flower = new FlowerField();
    this.scene.add(this.flower.group);

    /* ---------- 环境星尘：给空间一点体积感 ---------- */
    this._buildStarDust();

    /* ---------- 后期泛光 ---------- */
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.bgScene, this.bgCamera));
    this.scenePass = new RenderPass(this.scene, this.camera);
    this.scenePass.clear = false;     // 叠在背景之上，不清屏
    this.composer.addPass(this.scenePass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      CONFIG.bloomStrength,
      CONFIG.bloomRadius,
      CONFIG.bloomThreshold
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    this.resize();

    this.clock = new THREE.Clock();
  }

  /** 远景星尘，纯装饰 */
  _buildStarDust() {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 8 + Math.random() * 14;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({
      size: 0.06,
      color: 0x9fc8ff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.stars = new THREE.Points(g, m);
    this.scene.add(this.stars);
  }

  /** 把当前视频帧画进 bgCanvas（镜像），供纹理使用 */
  drawVideoFrame() {
    if (!CONFIG.showVideo) return;
    const v = this.video;
    const c = this.bgCanvas;
    if (!v || v.readyState < 2 || !v.videoWidth) return;

    // 画布尺寸跟随视频，保持低成本
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    const ctx = this.bgCtx;
    ctx.save();
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);           // 镜像，符合照镜子的直觉
    ctx.drawImage(v, 0, 0, c.width, c.height);
    ctx.restore();
    this.videoTexture.needsUpdate = true;
  }

  setVideoVisible(visible) {
    this.bgMesh.visible = visible;
  }

  /** 尺寸自适应：桌面按高度取景，移动端按宽度取景，保证花朵始终在画面里 */
  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxPixelRatio);

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);

    this.camera.aspect = w / h;
    /* 竖屏（手机）时把相机拉远，避免花朵被裁掉。
       绽放后花瓣半径约 PETAL_R * bloomScale ≈ 1.6，花苞高约 0.9，
       相机 42° FOV、距离 6.4 时可见半高约 6.4*tan(21°) ≈ 2.45，
       足够容纳整朵花并且四周留白舒服。 */
    const aspect = w / h;
    if (aspect < 1) {
      // 竖屏：水平方向可见范围变窄，需要按 1/aspect 额外拉远
      this.camera.position.set(0, 1.5, 7.4 / Math.max(aspect, 0.5));
    } else {
      // 桌面：稍微抬高一点点俯视，既能看全花冠又不至于压扁它
      this.camera.position.set(0, 1.5, 5.6);
    }
    this.camera.lookAt(0, 0.15, 0);
    this.camera.updateProjectionMatrix();

    // 后期通道的 target 也要跟着变（setSize 已处理）
    this.flower.material.uniforms.uPixelRatio.value = dpr;

    /* 背景视频做「cover」等比铺满：
       正交相机可视范围是 2×2（x/y 都是 -1~1），而平面几何体也是 2×2，
       所以 scale = 1 时平面刚好铺满整个视口。
       要在「不拉伸」的前提下盖满视口，需要让平面的宽高比等于视频宽高比，
       并且至少有一个方向 ≥ 1：
         videoAspect = 视频宽/高
         viewAspect  = 视口宽/高
       若视口比视频更宽 → 以宽度为准放大，多余高度被裁掉；
       否则以高度为准放大。最后再乘 CONFIG.videoPlaneScale 做手动放大。 */
    const viewAspect = aspect;
    const videoAspect = (this.video.videoWidth || 4) / (this.video.videoHeight || 3);
    let sx = 1, sy = 1;
    if (viewAspect > videoAspect) {
      // 视口更宽：让平面宽度铺满，按视频比例推算高度
      sy = viewAspect / videoAspect;
    } else {
      // 视口更高：让平面高度铺满，按视频比例推算宽度
      sx = videoAspect / viewAspect;
    }
    this.bgMesh.scale.set(sx * CONFIG.videoPlaneScale, sy * CONFIG.videoPlaneScale, 1);
  }

  /** 渲染一帧 */
  render(dt, state) {
    this.clock.getDelta();

    // 背景视频纹理
    this.drawVideoFrame();

    // 花朵更新（含生长动画 + 多花簇）
    this.flower.update(state, dt);

    /* ---- 场景旋转 ----
       自动旋转 + 双手旋转角叠加。
       双手模式下用 twoHandController 累积的 rotationAccum
       （它是相对增量，不会因为角度回绕而跳变）。 */
    const rotY = CONFIG.autoRotate * dt;
    this.flower.group.rotation.y += rotY;
    if (state.clusterRotate) {
      this.flower.group.rotation.y = state.clusterRotate;
    }

    // ---- 场景平移：双手整体移动时花丛跟着走 ----
    if (state.panOffset) {
      const tx = state.panOffset.x;
      const ty = state.panOffset.y;
      this.flower.group.position.x = damp(this.flower.group.position.x, tx, 0.1, dt);
      this.flower.group.position.y = damp(this.flower.group.position.y, ty, 0.1, dt);
    } else {
      this.flower.group.position.x = damp(this.flower.group.position.x, 0, 0.06, dt);
      this.flower.group.position.y = damp(this.flower.group.position.y, 0, 0.06, dt);
    }

    // ---- 花冠俯仰：跟随手掌上下 ----
    if (state.pointerActive) {
      const targetX = this.flower.baseTiltX + (state.pointer.y - 0.5) * 0.5;
      this.flower.group.rotation.x = damp(this.flower.group.rotation.x, targetX, 0.1, dt);
    } else {
      this.flower.group.rotation.x = damp(this.flower.group.rotation.x, this.flower.baseTiltX, 0.05, dt);
    }

    // 星尘缓慢反向旋转
    if (this.stars) {
      this.stars.rotation.y += dt * 0.012;
      this.stars.rotation.x += dt * 0.004;
    }

    /* 曝光与泛光：绽放时提亮，但生长初期要压暗（种子不该发光） */
    const lit = state.bloom * (0.4 + 0.6 * clamp(state.grow * 1.6));
    this.renderer.toneMappingExposure = 1.0 + lit * 0.28;
    this.bloomPass.strength = CONFIG.bloomStrength * (0.55 + lit * 0.6);

    this.composer.render();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.composer.dispose?.();
  }
}

/* ==========================================================================
   §6  UI 绑定
   ========================================================================== */

const $ = (id) => document.getElementById(id);

class UI {
  constructor(app) {
    this.app = app;
    this.el = {
      panel: $('panel'),
      panelToggle: $('panelToggle'),
      panelClose: $('panelClose'),
      cameraToggle: $('cameraToggle'),
      manualTension: $('manualTension'),
      manualTensionOut: $('manualTensionOut'),
      smoothing: $('smoothing'),
      smoothingOut: $('smoothingOut'),
      gain: $('gain'),
      gainOut: $('gainOut'),
      particleCount: $('particleCount'),
      particleCountOut: $('particleCountOut'),
      petalCount: $('petalCount'),
      petalCountOut: $('petalCountOut'),
      bloom: $('bloom'),
      bloomOut: $('bloomOut'),
      autoRotate: $('autoRotate'),
      autoRotateOut: $('autoRotateOut'),
      showVideo: $('showVideo'),
      showSkeleton: $('showSkeleton'),
      showHud: $('showHud'),
      twoHandOptions: $('twoHandOptions'),
      twoHandHint: $('twoHandHint'),
      singleHandHint: $('singleHandHint'),
      modeSingle: $('modeSingle'),
      modeTwo: $('modeTwo'),
      multiClusterToggle: $('multiClusterToggle'),
      replayGrow: $('replayGrow'),
      grow: $('grow'),
      growOut: $('growOut'),
      growFill: $('growFill'),
      growValue: $('growValue'),
      clusterValue: $('clusterValue'),
      status: $('status'),
      hud: $('hud'),
      tensionFill: $('tensionFill'),
      tensionValue: $('tensionValue'),
      bloomState: $('bloomState'),
      gate: $('gate'),
      startBtn: $('startBtn'),
      toast: $('toast'),
      overlay: $('overlay'),
    };
    this._bind();
    this._syncOutputs();
  }

  _bind() {
    const el = this.el;

    // ---- 面板开合 ----
    el.panelToggle.addEventListener('click', () => this.togglePanel(true));
    el.panelClose.addEventListener('click', () => this.togglePanel(false));
    // 移动端点击面板外收起
    document.addEventListener('pointerdown', (e) => {
      if (!el.panel.classList.contains('open')) return;
      if (el.panel.contains(e.target) || el.panelToggle.contains(e.target)) return;
      this.togglePanel(false);
    });
    // Esc 收起
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.togglePanel(false);
    });

    // ---- 摄像头开关 ----
    el.cameraToggle.addEventListener('change', async () => {
      if (el.cameraToggle.checked) {
        try {
          await this.app.handTracker.start();
          this.app.useManual = false;
          el.manualTension.disabled = false;
        } catch (err) {
          el.cameraToggle.checked = false;
          this.app.useManual = true;
          this.toast(err.message || String(err));
        }
      } else {
        this.app.handTracker.stop();
        this.app.useManual = true;
      }
    });

    // ---- 参数滑块 ----
    const bindRange = (input, output, apply, fmt = (v) => v.toFixed(2)) => {
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        output.textContent = fmt(v);
        apply(v);
      });
    };

    bindRange(el.manualTension, el.manualTensionOut, (v) => {
      this.app.manualTension = v;
      // 拖动滑块即视为进入手动模式
      if (this.app.handTracker.running) {
        this.app.useManual = true;
      }
    });

    bindRange(el.smoothing, el.smoothingOut, (v) => { CONFIG.smoothing = v; });
    bindRange(el.gain, el.gainOut, (v) => { CONFIG.gain = v; });

    bindRange(el.particleCount, el.particleCountOut, (v) => {
      CONFIG.particleCount = v;
      this._rebuildDebounced();
    }, (v) => String(Math.round(v)));

    bindRange(el.petalCount, el.petalCountOut, (v) => {
      CONFIG.petalCount = v;
      this._rebuildDebounced();
    }, (v) => String(Math.round(v)));

    bindRange(el.bloom, el.bloomOut, (v) => { this.app.manualBloom = v; });

    bindRange(el.autoRotate, el.autoRotateOut, (v) => { CONFIG.autoRotate = v; });

    // ---- 显示开关 ----
    el.showVideo.addEventListener('change', () => {
      CONFIG.showVideo = el.showVideo.checked;
      this.app.stage.setVideoVisible(CONFIG.showVideo);
    });
    el.showSkeleton.addEventListener('change', () => { CONFIG.showSkeleton = el.showSkeleton.checked; });
    el.showHud.addEventListener('change', () => {
      CONFIG.showHud = el.showHud.checked;
      el.hud.classList.toggle('hidden', !CONFIG.showHud);
    });

    // ---- 交互模式（单手 / 双手）----
    if (el.modeSingle && el.modeTwo) {
      const onModeChange = () => {
        const mode = el.modeTwo.checked ? 'two' : 'single';
        this.app.setMode(mode);
        this._applyModeUI(mode);
      };
      el.modeSingle.addEventListener('change', onModeChange);
      el.modeTwo.addEventListener('change', onModeChange);
    }

    // ---- 双手模式的子选项 ----
    if (el.multiClusterToggle) {
      el.multiClusterToggle.addEventListener('change', () => {
        CONFIG.multiCluster = el.multiClusterToggle.checked;
        this.log(CONFIG.multiCluster ? '多朵花已开启' : '固定只开一朵花');
      });
    }

    // ---- 生长动画 ----
    if (el.replayGrow) {
      el.replayGrow.addEventListener('click', () => {
        // 重播要同时清掉"手动接管"，否则滑块会一直压着动画
        this.app.manualGrowOn = false;
        if (el.grow) {
          el.grow.value = '0';
          if (el.growOut) el.growOut.textContent = '0.00';
        }
        el.replayGrow.disabled = true;            // 播放期间禁用，避免连点
        setTimeout(() => { el.replayGrow.disabled = false; }, 400);
        this.app.growth.play();
        this.log('重新播放生长动画：种子 → 发芽 → 开花');
      });
    }
    if (el.grow) {
      bindRange(el.grow, el.growOut, (v) => {
        /* 拖到 0 视为"交还给自动/手势"，其余值表示手动接管。
           这样既保留了"手动拖到底看种子"的能力，又能随时交还控制权。 */
        if (v <= 0.001) {
          this.app.manualGrowOn = false;
          this.app.manualGrow = 0;
        } else {
          this.app.manualGrowOn = true;
          this.app.manualGrow = v;
        }
      });
    }

    // ---- 启动按钮 ----
    el.startBtn.addEventListener('click', () => this.app.startFromGate());
  }

  /** 粒子数/花瓣数变化时重建几何体，做个防抖避免拖动时疯狂重建 */
  _rebuildDebounced() {
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      const t0 = performance.now();
      this.app.stage.flower.build();
      this.log(`几何体已重建：${Math.round(CONFIG.particleCount)} 粒子 / ${CONFIG.petalCount} 花瓣 ` +
               `(${(performance.now() - t0).toFixed(0)}ms)`);
    }, 160);
  }

  /**
   * 根据模式显示/隐藏对应的说明与子选项。
   * 单手模式把"多朵花"这类双手专属选项收起来，
   * 避免面板上出现一堆当前无效的开关。
   */
  _applyModeUI(mode) {
    const isTwo = mode === 'two';
    if (this.el.twoHandOptions) this.el.twoHandOptions.hidden = !isTwo;
    if (this.el.singleHandHint) this.el.singleHandHint.hidden = isTwo;
    if (this.el.modeSingle) this.el.modeSingle.checked = !isTwo;
    if (this.el.modeTwo) this.el.modeTwo.checked = isTwo;
  }

  togglePanel(open) {
    const isOpen = open ?? !this.el.panel.classList.contains('open');
    this.el.panel.classList.toggle('open', isOpen);
    document.body.classList.toggle('panel-open', isOpen);
  }

  _syncOutputs() {
    this.el.manualTensionOut.textContent = parseFloat(this.el.manualTension.value).toFixed(2);
    this.el.smoothingOut.textContent = parseFloat(this.el.smoothing.value).toFixed(2);
    this.el.gainOut.textContent = parseFloat(this.el.gain.value).toFixed(2);
    this.el.particleCountOut.textContent = String(Math.round(CONFIG.particleCount));
    this.el.petalCountOut.textContent = String(Math.round(CONFIG.petalCount));
    this.el.bloomOut.textContent = '0.00';
    this.el.autoRotateOut.textContent = parseFloat(this.el.autoRotate.value).toFixed(2);
    if (this.el.growOut && this.el.grow) {
      this.el.growOut.textContent = parseFloat(this.el.grow.value).toFixed(2);
    }
    if (this.el.multiClusterToggle) this.el.multiClusterToggle.checked = CONFIG.multiCluster;
    // 交互模式单选与相关区块的初始可见性
    this._applyModeUI(CONFIG.mode === 'single' ? 'single' : 'two');
  }

  /** HUD 与状态文字刷新（每帧调用，只做最轻量的 DOM 写入）
   *  @param {object} state 主循环组装的状态（含 bloom / tension / grow / clusters）
   *  @param {object} info  { twoActive, handCount, clusterCount, twoHand, growth }
   */
  updateHud(state, info = {}) {
    const tension = state.tension;
    const grow = state.grow ?? 1;

    if (CONFIG.showHud) {
      const pct = (tension * 100).toFixed(0);
      this.el.tensionFill.style.width = pct + '%';
      this.el.tensionValue.textContent = tension.toFixed(2);

      // 生长进度条
      if (this.el.growFill) {
        this.el.growFill.style.width = (clamp(grow) * 100).toFixed(0) + '%';
      }
      if (this.el.growValue) {
        this.el.growValue.textContent = clamp(grow).toFixed(2);
      }
      if (this.el.clusterValue) {
        this.el.clusterValue.textContent = String(info.clusterCount ?? 1);
      }
    }

    /* ---------- 状态文字 ----------
       按当前模式给出对应提示：
         · 双手模式 + 检测到双手 → 显示阶段/花朵数/距离
         · 双手模式但只有一只手 → 提示举起第二只手
         · 单手模式 → 显示原来的握拳/张开状态
       单手模式【不会】提示"举起第二只手"，因为那个模式压根不看第二只手。 */
    const mode = CONFIG.mode === 'single' ? 'single' : 'two';
    const hands = info.handCount ?? 0;

    let label;
    if (mode === 'two' && info.twoActive) {
      const th = info.twoHand;
      const n = info.clusterCount ?? 1;
      const stage = grow < CONFIG.growSeedHold ? '播种'
                  : grow < CONFIG.growSprout ? '发芽'
                  : grow < 0.98 ? '生长' : '盛开';
      label = `双手 · ${stage} · ${n} 朵花 · 拉开双手长出更多花`;
      if (th) label += ` · 距离 ${th.span.toFixed(2)}`;
    } else {
      const st = this._stateFromTension(tension);
      if (st === STATE.BUD) label = '花苞闭合 · 握紧拳头';
      else if (st === STATE.BLOOM) label = '完全绽放 · 张开五指';
      else label = '缓缓绽放 · 半开手掌';

      if (grow < CONFIG.growSeedHold) label += ' · 种子期';
      else if (grow < CONFIG.growSprout) label += ' · 正在发芽';

      // 只在单手模式下加"单手"前缀，双手模式另有提示
      if (mode === 'single') label = '单手 · ' + label;
    }

    let hint = '';
    if (hands === 0) {
      hint = '（未识别到手部，使用手动/中性值）';
    } else if (mode === 'two' && hands === 1 && !info.twoActive) {
      hint = '（举起第二只手启用双手交互）';
    } else if (mode === 'single' && hands >= 2) {
      hint = '（当前为单手模式，只用手势最强的那只手）';
    }

    const text = hint ? label + ' ' + hint : label;

    if (this._lastLabel !== text) {
      this.el.bloomState.textContent = text;
      this._lastLabel = text;
    }
  }

  /** 由张力值反推状态标签（HUD 用，避免依赖 TensionMeter 内部状态） */
  _stateFromTension(t) {
    if (t < CONFIG.lowTension) return STATE.BUD;
    if (t > CONFIG.highTension) return STATE.BLOOM;
    return STATE.MID;
  }

  log(msg) {
    const el = this.el.status;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    el.textContent = `[${time}] ${msg}\n` + el.textContent;
    // 只保留最近 12 行
    const lines = el.textContent.split('\n');
    if (lines.length > 13) el.textContent = lines.slice(0, 13).join('\n');
  }

  toast(msg, type = 'error', duration = 6000) {
    const el = this.el.toast;
    el.textContent = msg;
    el.classList.toggle('info', type === 'info');
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  hideGate() {
    this.el.gate.classList.add('hide');
  }
}

/* ==========================================================================
   §7  主程序
   ========================================================================== */

class App {
  constructor() {
    this.ui = new UI(this);
    this.tension = new TensionMeter();
    this.twoHand = new TwoHandController();
    this.growth = new GrowthAnimator();
    this.layout = new ClusterLayout();

    this.stage = new Stage($('gl'), $('bg'), $('video'));
    this.handTracker = new HandTracker({
      video: $('video'),
      overlay: $('overlay'),
      onResults: (lm, info) => {
        this.landmarks = lm;
        this.handsInfo = info || {};
      },
      onError: (msg) => this.ui.toast(msg),
      onStatus: (s) => this.ui.log(s),
    });

    this.useManual = true;        // 没有摄像头时用手动张力
    this.manualTension = 0.85;
    this.manualBloom = 0;         // 面板上的 bloom 微调偏移
    this.manualGrow = 0;          // 面板上的手动生长进度（0~1）
    this.manualGrowOn = false;    // 是否处于"手动接管生长"状态（显式开关，见 _frame）
    this.landmarks = null;
    this.handsInfo = {};
    this.running = false;
    this.lastTime = performance.now();

    /** 每帧组装好的花簇数据（复用以避免每帧 new 对象） */
    this.clusters = [];
    for (let i = 0; i < CONFIG.maxClusters; i++) {
      this.clusters.push({
        pos: new THREE.Vector3(),
        scale: 0,
        bloom: 0,
        grow: 0,
      });
    }
    this.panOffset = new THREE.Vector2(0, 0);
    this._clusterCount = 1;

    this._bindVisibility();
  }

  /** 页面切到后台时暂停渲染，省电 */
  _bindVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.running = false;
      } else if (!this.running) {
        this.running = true;
        this.lastTime = performance.now();
        this.ui.log('恢复渲染');
        requestAnimationFrame(this._frame);
      }
    });
  }

  /** 用户点击“开始体验”后调用 */
  async startFromGate() {
    this.ui.hideGate();

    if (this.ui.el.cameraToggle.checked) {
      try {
        await this.handTracker.start();
        this.useManual = false;
        this.ui.log('摄像头就绪，请把手放进画面');
      } catch (err) {
        this.ui.el.cameraToggle.checked = false;
        this.useManual = true;
        this.ui.toast(err.message || String(err), 'error', 9000);
        this.ui.log('摄像头不可用，已切换为手动模式（拖动左侧滑块体验）');
      }
    } else {
      this.useManual = true;
      this.ui.log('已跳过摄像头，使用手动模式');
    }

    if (!this.running) {
      this.running = true;
      this.lastTime = performance.now();
      // 启动时自动播一次生长动画（种子 → 发芽 → 开花）
      if (CONFIG.autoGrowOnStart) {
        this.manualGrowOn = false;
        this.growth.play();
        this.ui.log('生长动画开始：种子 → 发芽 → 开花');
      }
      requestAnimationFrame(this._frame);
    }
  }

  /**
   * 切换交互模式（'single' 单手 / 'two' 双手）
   *
   * 为什么要有这个方法而不是直接改 CONFIG.mode：
   * 切换时有一批"跨帧状态"需要重置，否则会带着旧模式的残留值进入新模式。
   * 比如从双手切到单手时，twoHand.span 还停在 1.0（5 朵花），
   * 得等它慢慢 damp 回 0，中间会看到花朵数量缓慢减少的怪现象。
   * 这里显式清干净，切换是"立刻生效"的。
   */
  setMode(mode) {
    const next = mode === 'single' ? 'single' : 'two';
    const prev = CONFIG.mode;
    if (prev === next) return;

    CONFIG.mode = next;

    // ---- 重置双手控制器的累积状态 ----
    this.twoHand.span = 0;
    this.twoHand.smoothSpan = 0;
    this.twoHand.openness = 0;
    this.twoHand.active = false;
    this.twoHand.rotationAccum = 0;
    this.twoHand._lastRawRot = null;
    this.twoHand.smoothCenter.set(0.5, 0.5);
    this.twoHand.center.set(0.5, 0.5);

    // ---- 场景平移与旋转复位，避免带着上一模式的偏移 ----
    this.panOffset.set(0, 0);
    this.stage.flower.group.position.set(0, 0, 0);

    // ---- 花朵数量回到 1 朵（单手模式必然是 1 朵） ----
    this._clusterCount = 1;

    const label = next === 'two'
      ? '双手模式：拉开双手长出更多花，张开推进生长，转动旋转花丛'
      : '单手模式：握拳闭合、张开五指绽放，手掌移动让花朵轻摆';
    this.ui.log('已切换到' + label);
    return next;
  }

  /** 当前模式（供 UI 读取） */
  get mode() { return CONFIG.mode; }

  /** 渲染主循环 */
  _frame = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this._frame);

    // dt 截断，避免切换标签页回来时出现巨大跳变
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    // ---- ① 手势数据 ----
    this.handTracker.update(dt);
    const lm = this.handTracker.lastLandmarks;
    const handsData = this.handTracker.handsData;
    const cameraOn = this.handTracker.running && !this.useManual;

    // ---- ② 双手交互（仅双手模式参与运算） ----
    const twoHandMode = CONFIG.mode === 'two';
    /* 单手模式下直接喂空数组，TwoHandController 会走"无双手"分支：
       span/openness 平滑回落到 0，不会残留上一轮双手的数值。
       这样切换模式后不会有一段"幽灵双手"的过渡。 */
    this.twoHand.update(twoHandMode && cameraOn ? handsData : [], dt);
    const twoActive = twoHandMode && cameraOn && this.twoHand.active;

    // ---- ③ 单手张力（右手优先） ----
    if (cameraOn) {
      this.tension.update(lm, dt);
    } else {
      // 手动模式：张力来自滑块；同时保留平滑，手感与手势模式一致
      this.tension.update(null, dt);
      this.tension.raw = this.manualTension;
      this.tension.value = damp(this.tension.value, this.manualTension, CONFIG.smoothing, dt);
      this.tension.bloom = damp(this.tension.bloom, tensionToBloom(this.tension.value), 0.12, dt);
    }

    /* ---- ④ 生长进度 ----
       优先级：手动覆盖 > 自动播放 > 手势驱动 > 默认长成

       注意 manualGrow 用一个显式的开关 manualGrowOn 控制，
       不能靠 "manualGrow > 0" 判断 —— 那样滑块拖到 0 就永远关不掉覆盖，
       而拖到中间值后又无法交还给手势（是个很隐蔽的状态泄漏）。 */
    let growProgress;
    if (this.manualGrowOn) {
      this.growth.update(dt, 0);              // 仍然推进内部计时（破土抖动要用）
      this.growth.progress = damp(this.growth.progress, this.manualGrow, 0.12, dt);
      growProgress = this.growth.progress;
    } else if (this.growth.autoPlaying) {
      growProgress = this.growth.update(dt, 0);
    } else if (twoActive) {
      // 双手模式：张开度驱动生长
      growProgress = this.growth.update(dt, this.twoHand.openness);
    } else {
      // 单手 / 无手：生长进度缓慢回落到"已长成"，避免花朵一直是小苗
      growProgress = this.growth.update(dt, 1);
    }

    // ---- ⑤ 花朵数量与布局 ----
    /* 只有"双手模式 + 检测到双手 + 允许多朵"时才变化花朵数量。
       其余情况恒为 1 朵 —— 单手模式始终保持原样，不会被花朵数量分心。 */
    const spanForCount = twoActive ? this.twoHand.span : 0;
    const wantCount = (CONFIG.multiCluster && twoActive)
      ? ClusterLayout.countForSpan(spanForCount)
      : 1;
    // 数量变化做平滑过渡，避免花朵突然闪现（用连续的浮点值驱动 scale）
    this._clusterCount = damp(this._clusterCount, wantCount, 0.10, dt);
    const activeCount = Math.max(1, Math.min(CONFIG.maxClusters, Math.round(this._clusterCount)));

    const spread = CONFIG.clusterSpread * (0.35 + 0.65 * spanForCount);
    const positions = this.layout.layout(activeCount, spread);

    // ---- ⑥ 逐朵花计算形态与绽放 ----
    const baseBloom = clamp(this.tension.bloom + this.manualBloom, 0, 2.2);

    /* 花越多，单朵越小 —— 否则花丛会溢出画面。
       用 sqrt(count) 衰减：1 朵时 1.0，5 朵时约 0.68（配合 clusterSpread 控制总占幅）。 */
    const shrink = 1 / (1 + CONFIG.clusterShrink * Math.sqrt(Math.max(activeCount - 1, 0)));

    for (let i = 0; i < CONFIG.maxClusters; i++) {
      const c = this.clusters[i];
      const on = i < activeCount;

      // 错峰：每朵花的时间轴依次滞后，形成"一朵接一朵开"的层次
      const stagger = CONFIG.clusterStagger * i;
      const { form, bloomT } = GrowthAnimator.shapes(growProgress, stagger);

      // 缩放：花朵长出来时从 0 放大到 1（用 form 驱动），再乘上花数衰减
      const targetScale = on ? clamp(form) * shrink : 0;
      c.scale = damp(c.scale, targetScale, 0.16, dt);
      // 位置也做平滑，避免数量变化时花朵瞬移
      c.pos.lerp(positions[i], clamp(dt * 6, 0, 1));

      /* 绽放度 = 该朵花自己的开花进度 × 张力绽放度
         两者相乘：植物先长出来（bloomT），再按手势张开（baseBloom）。
         双手模式下让左右手分工更明确：
           右手张力 → 主绽放（baseBloom 已含）
           双手开合 → 促进开花 */
      const gestureBoost = twoActive ? this.twoHand.openness * CONFIG.bloomMax * 0.35 : 0;
      c.bloom = clamp(bloomT * (baseBloom + gestureBoost), 0, 2.2);
      c.grow = clamp(form);
    }

    // ---- ⑦ 双手中点 → 场景平移 ----
    if (twoActive) {
      // 归一化坐标(0~1) → 模型偏移；乘负号让"手往右移，花往右移"（画面是镜像的）
      const px = (this.twoHand.center.x - 0.5) * 2.0 * CONFIG.twoHandPan;
      const py = (0.5 - this.twoHand.center.y) * 2.0 * CONFIG.twoHandPan;
      this.panOffset.set(px, py * 0.6);
    } else {
      this.panOffset.set(0, 0);
    }

    // ---- ⑧ 渲染 ----
    const state = {
      // 兼容旧字段（单朵花的整体绽放度，用于 HUD 与曝光）
      bloom: baseBloom,
      tension: this.tension.value,
      pointer: this.handTracker.pointer,
      pointerActive: this.handTracker.pointerActive && cameraOn,
      // 生长与多花簇
      grow: growProgress,
      growTime: this.growth.growTime,
      clusters: this.clusters,
      clusterRotate: twoActive ? this.twoHand.rotationAccum : null,
      panOffset: twoActive ? this.panOffset : null,
    };
    this.stage.render(dt, state);

    // ---- ⑨ HUD ----
    this.ui.updateHud(state, {
      twoActive,
      handCount: cameraOn ? handsData.length : 0,
      clusterCount: activeCount,
      twoHand: this.twoHand,
      growth: this.growth,
    });
  };
}

/* ==========================================================================
   启动
   ========================================================================== */

function boot() {
  let app;
  try {
    app = new App();
  } catch (err) {
    console.error(err);
    const t = document.getElementById('toast');
    t.textContent = '初始化失败：' + (err?.message || err) +
      '（你的浏览器可能不支持 WebGL，请更新浏览器或开启硬件加速）';
    t.classList.add('show');
    return;
  }
  window.__flowerApp = app; // 方便在控制台调试

  app.ui.log('Three.js r' + THREE.REVISION + ' 已加载');
  app.ui.log(HandTracker.isAvailable()
    ? 'MediaPipe Hands 已加载，等待用户授权'
    : '⚠ MediaPipe Hands 未加载（可能是网络问题），将回退到手动模式');

  // 若 8 秒内没点到“开始”，给一句提示（不自动启动，浏览器要求用户手势）
  setTimeout(() => {
    if (!app.running) app.ui.log('等待你点击「开始体验」…（浏览器要求用户手势才能开启摄像头）');
  }, 8000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
