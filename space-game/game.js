/* ============================================================
 * 太空躲避外星人 · 波次版
 * 玩法：横向躲避外星人，靠「险避」与「脉冲清场」滚连击分数。
 * 每关 3 波，速度、密度、敌人种类逐波递进。
 * 手势：MediaPipe HandLandmarker，食指位置控船、握拳放脉冲。
 * ============================================================ */

const CONFIG = {
  mp: {
    // 全部走仓库内自带资源：本地 http 与线上 Pages 都能直接加载，不依赖 CDN
    bundle: "../vendor/mediapipe/vision_bundle.mjs",
    wasm: "../vendor/mediapipe/wasm",
    model: "../vendor/models/hand_landmarker.task",
  },
  camera: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
  startLives: 3,
  laneCount: 5,          // 场地横向分 5 条车道
  shipEdge: 0.05,        // 飞船左右极限
  shipY: 0.84,           // 飞船纵向位置（0 顶 / 1 底）
  handTimeoutMs: 320,    // 手离开 320ms 后交还键盘/鼠标控制
  /* 手势链路：只在新视频帧上推理；平滑时间常数直接决定跟手延迟 */
  gesture: { minIntervalMs: 8, tau: 0.014, cursorTau: 0.012, deadzone: 0.003 },
  combo: { window: 3.6, perStep: 5, max: 5 },   // 每 5 连击 +1 倍率，最高 ×5
  pulse: { cost: 50, max: 100, regen: 4.2, radius: 0.33, speed: 1.35 },
};

/* 10 关基础参数：波次内还会再乘 WAVES 的系数 */
const LEVELS = [
  { n: 1,  dur: 40, speed: 0.185, spawn: 1.55, two: 0.18, bomb: 0.11, chest: 0.14, shield: 0.06, scout: 0.22, seeker: 0.10, scoutWave: 2, seekerWave: 9,  tag: "热身" },
  { n: 2,  dur: 44, speed: 0.196, spawn: 1.47, two: 0.22, bomb: 0.12, chest: 0.14, shield: 0.06, scout: 0.24, seeker: 0.14, scoutWave: 2, seekerWave: 3,  tag: "侦察兵 + 追踪者" },
  { n: 3,  dur: 48, speed: 0.207, spawn: 1.39, two: 0.26, bomb: 0.13, chest: 0.15, shield: 0.06, scout: 0.26, seeker: 0.16, scoutWave: 2, seekerWave: 2,  tag: "三波全开" },
  { n: 4,  dur: 52, speed: 0.218, spawn: 1.32, two: 0.30, bomb: 0.14, chest: 0.15, shield: 0.05, scout: 0.28, seeker: 0.18, scoutWave: 1, seekerWave: 2,  tag: "更快节奏" },
  { n: 5,  dur: 56, speed: 0.229, spawn: 1.26, two: 0.34, bomb: 0.15, chest: 0.15, shield: 0.05, scout: 0.30, seeker: 0.20, scoutWave: 1, seekerWave: 2,  tag: "高速" },
  { n: 6,  dur: 60, speed: 0.240, spawn: 1.20, two: 0.38, bomb: 0.16, chest: 0.16, shield: 0.05, scout: 0.32, seeker: 0.22, scoutWave: 1, seekerWave: 1,  tag: "混战" },
  { n: 7,  dur: 64, speed: 0.251, spawn: 1.14, two: 0.42, bomb: 0.17, chest: 0.16, shield: 0.05, scout: 0.34, seeker: 0.24, scoutWave: 1, seekerWave: 1,  tag: "高压" },
  { n: 8,  dur: 68, speed: 0.262, spawn: 1.09, two: 0.46, bomb: 0.18, chest: 0.16, shield: 0.05, scout: 0.36, seeker: 0.26, scoutWave: 1, seekerWave: 1,  tag: "极限" },
  { n: 9,  dur: 72, speed: 0.273, spawn: 1.04, two: 0.50, bomb: 0.19, chest: 0.17, shield: 0.05, scout: 0.38, seeker: 0.28, scoutWave: 1, seekerWave: 1,  tag: "疯狂" },
  { n: 10, dur: 76, speed: 0.284, spawn: 1.00, two: 0.54, bomb: 0.20, chest: 0.17, shield: 0.05, scout: 0.40, seeker: 0.30, scoutWave: 1, seekerWave: 1,  tag: "终局" },
];

/* 每关内的三波：速度与出怪节奏逐波加快 */
const WAVES = [
  { speed: 0.92, spawn: 1.14 },
  { speed: 1.00, spawn: 0.96 },
  { speed: 1.09, spawn: 0.84 },
];

/* 物体参数：pass/near/pulse 是三种得分来源，chest 为拾取加分，life 为扣血 */
const ITEM_KINDS = {
  alien:   { radius: 0.062, pass: 10, near: 25, pulse: 16, life: 1 },
  scout:   { radius: 0.047, pass: 25, near: 45, pulse: 32, life: 1 },
  seeker:  { radius: 0.058, pass: 20, near: 35, pulse: 26, life: 1 },
  bomb:    { radius: 0.058, pass: 0,  near: 0,  pulse: 6,  life: 1 },
  chest_s: { radius: 0.055, chest: 30 },
  chest_m: { radius: 0.060, chest: 80 },
  chest_l: { radius: 0.065, chest: 150 },
  shield:  { radius: 0.058, shield: 1 },
};

const TAU = Math.PI * 2;
const clamp01 = v => Math.min(1, Math.max(0, v));
const clampShip = v => Math.min(1 - CONFIG.shipEdge, Math.max(CONFIG.shipEdge, v));
const $ = id => document.getElementById(id);
const isPickup = kind => kind === "shield" || kind.startsWith("chest");

/* ---------------- 星空背景 ---------------- */
const bg = $("bg");
const bctx = bg.getContext("2d");
let W = 0, H = 0, stars = [], nebula = null;

function buildStars() {
  stars = Array.from({ length: 190 }, () => ({
    x: Math.random(), y: Math.random(),
    r: 0.5 + Math.random() * 1.6,
    a: 0.2 + Math.random() * 0.6,
    ph: Math.random() * TAU,
    sp: 0.4 + Math.random() * 1.2,
  }));
}

function buildNebula() {
  const n = document.createElement("canvas");
  n.width = Math.max(2, Math.floor(W / 2));
  n.height = Math.max(2, Math.floor(H / 2));
  const c = n.getContext("2d");
  c.fillStyle = "#060a22";
  c.fillRect(0, 0, n.width, n.height);
  const blobs = [
    { x: 0.18, y: 0.14, r: 0.55, col: "rgba(92, 62, 210, 0.30)" },
    { x: 0.86, y: 0.28, r: 0.50, col: "rgba(24, 120, 200, 0.26)" },
    { x: 0.52, y: 0.94, r: 0.62, col: "rgba(122, 40, 160, 0.20)" },
    { x: 0.28, y: 0.72, r: 0.38, col: "rgba(30, 90, 190, 0.18)" },
  ];
  for (const b of blobs) {
    const cx = b.x * n.width, cy = b.y * n.height;
    const rr = b.r * Math.max(n.width, n.height);
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, rr);
    g.addColorStop(0, b.col);
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, n.width, n.height);
  }
  nebula = n;
}

function resizeBG() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  bg.width = Math.round(W * dpr); bg.height = Math.round(H * dpr);
  bg.style.width = W + "px"; bg.style.height = H + "px";
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildStars();
  buildNebula();
}

function drawBG(t) {
  if (nebula) bctx.drawImage(nebula, 0, 0, W, H);
  else { bctx.fillStyle = "#060a22"; bctx.fillRect(0, 0, W, H); }
  for (const s of stars) {
    const a = s.a * (0.55 + 0.45 * Math.sin(t * s.sp + s.ph));
    bctx.fillStyle = `rgba(190,235,255,${a.toFixed(3)})`;
    bctx.beginPath();
    bctx.arc(s.x * W, s.y * H, s.r, 0, TAU);
    bctx.fill();
  }
}

/* ---------------- 全屏手势光标层 ---------------- */
const cursorCv = $("cursorLayer");
const cctx = cursorCv.getContext("2d");
let cw = 0, ch = 0;

function resizeCursorLayer() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cw = window.innerWidth;
  ch = window.innerHeight;
  cursorCv.width = Math.round(cw * dpr);
  cursorCv.height = Math.round(ch * dpr);
  cursorCv.style.width = cw + "px";
  cursorCv.style.height = ch + "px";
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ---------------- 手势状态 ---------------- */
const handCursor = {
  x: 0.5, y: 0.5,       // 指尖光标（菜单点击用）
  seenAt: -1e9,
  closed: false,
  downAt: null,
  lastClickAt: 0,
};
let handX = null;       // 飞船用的手部横坐标（以掌指关节为锚点，握拳时不乱跳）
let handSeenAt = -1e9;
let handShipX = 0.5;

function triggerGestureClick() {
  const px = handCursor.x * cw;
  const py = handCursor.y * ch;
  try {
    const el = document.elementFromPoint(px, py);
    if (el && el.click) {
      el.classList.add("gesture-clicked");
      setTimeout(() => el.classList.remove("gesture-clicked"), 180);
      const rect = el.getBoundingClientRect();
      const evt = new MouseEvent("click", {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      });
      el.dispatchEvent(evt);
      ensureAudio();
    }
  } catch (e) {
    console.warn("gesture click failed:", e);
  }
}

/* ---------------- 游戏状态 ---------------- */
const game = {
  screen: "home",
  level: 1,
  wave: 1,
  running: false,
  paused: false,
  ended: false,
  score: 0,
  lives: CONFIG.startLives,
  timeLeft: 0,
  waveTimer: 0,
  items: [],
  particles: [],
  popups: [],
  shockwaves: [],
  shipX: 0.5,
  targetX: 0.5,
  keyDir: 0,
  mouseX: null,
  mouseActive: false,
  invuln: 0,
  spawnTimer: 0,
  shake: 0,
  flash: 0,
  goldFlash: 0,
  energy: CONFIG.pulse.max * 0.5,
  shield: 0,
  combo: 0,
  mult: 1,
  comboTimer: 0,
  bestCombo: 0,
  banner: null,
  pulseUsed: false,
};

const canPulse = () => game.energy >= CONFIG.pulse.cost;

/* ---------------- 绘制：飞船 ---------------- */
function drawShip(c, x, y, w, t, shield = 0, ready = false) {
  const h = w * 1.35;
  c.save();
  c.translate(x, y);

  // 尾焰
  const boost = ready ? 0.16 : 0;
  const fl = h * (0.85 + boost + Math.sin(t * 18) * 0.18 + Math.sin(t * 7.3) * 0.1);
  const fg = c.createLinearGradient(0, h * 0.34, 0, h * 0.34 + fl);
  fg.addColorStop(0, "rgba(150,248,255,0.95)");
  fg.addColorStop(0.45, "rgba(70,150,255,0.55)");
  fg.addColorStop(1, "rgba(60,140,255,0)");
  c.fillStyle = fg;
  c.beginPath();
  c.moveTo(-w * 0.14, h * 0.36);
  c.quadraticCurveTo(0, h * 0.36 + fl, w * 0.14, h * 0.36);
  c.closePath();
  c.fill();

  // 机身
  c.shadowColor = "rgba(90,225,255,0.85)";
  c.shadowBlur = w * 0.22;
  const body = c.createLinearGradient(0, -h * 0.5, 0, h * 0.4);
  body.addColorStop(0, "#d6f9ff");
  body.addColorStop(0.35, "#4fd2ff");
  body.addColorStop(1, "#1451e6");
  c.fillStyle = body;
  c.beginPath();
  c.moveTo(0, -h * 0.5);
  c.quadraticCurveTo(w * 0.32, -h * 0.08, w * 0.26, h * 0.34);
  c.lineTo(-w * 0.26, h * 0.34);
  c.quadraticCurveTo(-w * 0.32, -h * 0.08, 0, -h * 0.5);
  c.closePath();
  c.fill();

  // 侧翼
  c.shadowBlur = 0;
  c.fillStyle = "#2a8dff";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * w * 0.22, h * 0.02);
    c.lineTo(s * w * 0.5, h * 0.36);
    c.lineTo(s * w * 0.2, h * 0.34);
    c.closePath();
    c.fill();
  }

  // 驾驶舱
  const ck = c.createRadialGradient(0, -h * 0.12, 0, 0, -h * 0.12, w * 0.2);
  ck.addColorStop(0, "#ffffff");
  ck.addColorStop(0.5, "#8ef4ff");
  ck.addColorStop(1, "#2b6bff");
  c.fillStyle = ck;
  c.beginPath();
  c.ellipse(0, -h * 0.12, w * 0.12, h * 0.15, 0, 0, TAU);
  c.fill();

  // 高光边
  c.strokeStyle = "rgba(210,250,255,0.6)";
  c.lineWidth = Math.max(1, w * 0.02);
  c.beginPath();
  c.moveTo(0, -h * 0.5);
  c.quadraticCurveTo(w * 0.32, -h * 0.08, w * 0.26, h * 0.34);
  c.stroke();

  // 脉冲就绪：机身外一圈呼吸光
  if (ready) {
    const p = 0.55 + 0.45 * Math.sin(t * 5);
    c.strokeStyle = `rgba(140,246,255,${(0.28 + p * 0.3).toFixed(3)})`;
    c.lineWidth = Math.max(1, w * 0.025);
    c.beginPath();
    c.arc(0, 0, w * 0.62 + p * w * 0.04, 0, TAU);
    c.stroke();
  }

  // 护盾环
  if (shield > 0) {
    c.save();
    c.rotate(t * 0.9);
    c.strokeStyle = "rgba(130,225,255,0.85)";
    c.lineWidth = Math.max(1.5, w * 0.05);
    c.setLineDash([w * 0.22, w * 0.16]);
    c.beginPath();
    c.arc(0, 0, w * 0.74, 0, TAU);
    c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 0.16;
    c.fillStyle = "#7fdcff";
    c.beginPath();
    c.arc(0, 0, w * 0.74, 0, TAU);
    c.fill();
    c.restore();
  }

  c.restore();
}

/* ---------------- 绘制：普通外星人 ---------------- */
function drawAlien(c, x, y, r, t, phase) {
  const bob = Math.sin(t * 2.4 + phase) * r * 0.06;
  c.save();
  c.translate(x, y + bob);

  c.shadowColor = "rgba(255,95,190,0.8)";
  c.shadowBlur = r * 0.9;

  // 触角
  c.strokeStyle = "#c73bd8";
  c.lineWidth = Math.max(1.2, r * 0.11);
  c.lineCap = "round";
  const wob = Math.sin(t * 4 + phase) * r * 0.1;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * r * 0.42, -r * 0.62);
    c.quadraticCurveTo(s * r * 0.76, -r * 1.02 + wob, s * r * 0.62, -r * 1.26 + wob);
    c.stroke();
    c.fillStyle = "#ffd1ec";
    c.beginPath();
    c.arc(s * r * 0.62, -r * 1.26 + wob, r * 0.12, 0, TAU);
    c.fill();
  }

  // 身体
  const g = c.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, "#ffb0da");
  g.addColorStop(0.45, "#ff5fae");
  g.addColorStop(1, "#8e16b8");
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(0, 0, r * 0.95, r * 0.88, 0, 0, TAU);
  c.fill();

  // 大眼睛
  c.shadowBlur = 0;
  for (const s of [-1, 1]) {
    c.fillStyle = "#f3feff";
    c.beginPath();
    c.ellipse(s * r * 0.33, -r * 0.16, r * 0.26, r * 0.31, 0, 0, TAU);
    c.fill();
    const px = s * r * 0.33 + Math.sin(t + phase) * r * 0.05;
    c.fillStyle = "#08131f";
    c.beginPath();
    c.arc(px, -r * 0.14, r * 0.13, 0, TAU);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.95)";
    c.beginPath();
    c.arc(px - r * 0.04, -r * 0.2, r * 0.045, 0, TAU);
    c.fill();
  }

  // 嘴
  c.strokeStyle = "#5a0b63";
  c.lineWidth = Math.max(1.1, r * 0.07);
  c.beginPath();
  c.arc(0, r * 0.2, r * 0.18, 0.15 * Math.PI, 0.85 * Math.PI);
  c.stroke();

  // 小脚
  c.fillStyle = "#c73bd8";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(s * r * 0.3, r * 0.82, r * 0.16, r * 0.12, 0, 0, TAU);
    c.fill();
  }

  c.restore();
}

/* ---------------- 绘制：侦察兵（小、快、青绿） ---------------- */
function drawScout(c, x, y, r, t, phase) {
  const bob = Math.sin(t * 5 + phase) * r * 0.04;
  c.save();
  c.translate(x, y + bob);

  // 速度拖尾
  c.strokeStyle = "rgba(90,255,200,0.26)";
  c.lineWidth = Math.max(1, r * 0.16);
  c.lineCap = "round";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * r * 0.26, -r * 0.55);
    c.lineTo(s * r * 0.1, -r * 1.8 - Math.sin(t * 10 + phase) * r * 0.22);
    c.stroke();
  }

  // 侧翼
  c.fillStyle = "#12a97a";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(0, -r * 0.5);
    c.quadraticCurveTo(s * r * 0.95, -r * 0.2, s * r * 0.55, r * 0.55);
    c.quadraticCurveTo(s * r * 0.2, r * 0.1, 0, -r * 0.1);
    c.closePath();
    c.fill();
  }

  // 机身
  const g = c.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, "#dcffe9");
  g.addColorStop(0.45, "#5df0b0");
  g.addColorStop(1, "#008a5e");
  c.fillStyle = g;
  c.shadowColor = "rgba(70,255,190,0.8)";
  c.shadowBlur = r * 0.7;
  c.beginPath();
  c.moveTo(0, -r * 1.05);
  c.quadraticCurveTo(r * 0.42, -r * 0.1, 0, r * 0.98);
  c.quadraticCurveTo(-r * 0.42, -r * 0.1, 0, -r * 1.05);
  c.fill();
  c.shadowBlur = 0;

  // 独眼
  c.fillStyle = "#06301f";
  c.beginPath();
  c.arc(0, -r * 0.2, r * 0.26, 0, TAU);
  c.fill();
  c.fillStyle = "#c9ffe4";
  c.beginPath();
  c.arc(-r * 0.06, -r * 0.28, r * 0.09, 0, TAU);
  c.fill();

  c.restore();
}

/* ---------------- 绘制：追踪者（紫、会横移） ---------------- */
function drawSeeker(c, x, y, r, t, phase) {
  c.save();
  c.translate(x, y);

  // 触手
  c.strokeStyle = "rgba(190,140,255,0.85)";
  c.lineWidth = Math.max(1, r * 0.13);
  c.lineCap = "round";
  for (let k = -1; k <= 1; k++) {
    const sw = Math.sin(t * 3.4 + phase + k) * r * 0.3;
    c.beginPath();
    c.moveTo(k * r * 0.34, r * 0.42);
    c.quadraticCurveTo(k * r * 0.5 + sw, r * 0.95, k * r * 0.22 + sw * 0.7, r * 1.42);
    c.stroke();
  }

  // 伞体
  const g = c.createLinearGradient(0, -r, 0, r * 0.8);
  g.addColorStop(0, "#e6d2ff");
  g.addColorStop(0.5, "#a86bff");
  g.addColorStop(1, "#4a12a8");
  c.fillStyle = g;
  c.shadowColor = "rgba(180,120,255,0.85)";
  c.shadowBlur = r * 0.9;
  c.beginPath();
  c.ellipse(0, 0, r * 0.9, r * 0.8, 0, 0, TAU);
  c.fill();
  c.shadowBlur = 0;

  // 锁定环
  const pulse = 0.5 + 0.5 * Math.sin(t * 4 + phase);
  c.strokeStyle = `rgba(255,170,80,${(0.3 + 0.4 * pulse).toFixed(3)})`;
  c.lineWidth = Math.max(1, r * 0.08);
  c.beginPath();
  c.arc(0, 0, r * (1.02 + pulse * 0.12), 0, TAU);
  c.stroke();

  // 大橙眼
  const eg = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.5);
  eg.addColorStop(0, "#fff6d0");
  eg.addColorStop(0.45, "#ffb347");
  eg.addColorStop(1, "#c2410c");
  c.fillStyle = eg;
  c.beginPath();
  c.arc(0, 0, r * 0.5, 0, TAU);
  c.fill();
  c.fillStyle = "#2a0a00";
  const look = Math.sin(t * 1.7 + phase) * r * 0.1;
  c.beginPath();
  c.arc(look, 0, r * 0.2, 0, TAU);
  c.fill();

  c.restore();
}

/* ---------------- 绘制：炸弹 ---------------- */
function drawBomb(c, x, y, r, t) {
  c.save();
  c.translate(x, y);

  const f = 0.6 + Math.sin(t * 18) * 0.4;
  c.shadowColor = `rgba(255,${180 + Math.sin(t * 22) * 60},40,0.9)`;
  c.shadowBlur = r * 0.8;
  c.fillStyle = "#ffdc70";
  c.beginPath();
  c.arc(r * 0.3, -r * 1.15, r * 0.16 * f, 0, TAU);
  c.fill();
  c.strokeStyle = "#8a6e42";
  c.lineWidth = Math.max(1, r * 0.06);
  c.beginPath();
  c.moveTo(0, -r * 0.5);
  c.quadraticCurveTo(r * 0.3, -r * 0.9, r * 0.28, -r * 1.1);
  c.stroke();

  c.shadowBlur = r * 0.6;
  c.shadowColor = "rgba(255,90,90,0.7)";
  const bg2 = c.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.1, 0, 0, r);
  bg2.addColorStop(0, "#4a4e58");
  bg2.addColorStop(0.55, "#1d222a");
  bg2.addColorStop(1, "#0a0c10");
  c.fillStyle = bg2;
  c.beginPath();
  c.arc(0, 0, r, 0, TAU);
  c.fill();

  c.shadowBlur = 0;
  c.fillStyle = "rgba(190,210,230,0.35)";
  c.beginPath();
  c.arc(-r * 0.3, -r * 0.3, r * 0.18, 0, TAU);
  c.fill();

  c.strokeStyle = "#ff4a4a";
  c.lineWidth = Math.max(1.2, r * 0.12);
  c.beginPath();
  const d = r * 0.38;
  c.moveTo(-d, -d); c.lineTo(d, d);
  c.moveTo(d, -d); c.lineTo(-d, d);
  c.stroke();

  c.restore();
}

/* ---------------- 绘制：宝箱 ---------------- */
function drawChest(c, x, y, r, kind) {
  const tier = kind === "chest_l" ? "l" : kind === "chest_m" ? "m" : "s";
  const colors = {
    s: { body: ["#a1753f", "#5a3a16"], band: "#e8b856", glow: "rgba(232,184,86,0.9)", label: "30" },
    m: { body: ["#c68642", "#6e4419"], band: "#ffd24a", glow: "rgba(255,210,74,0.95)", label: "80" },
    l: { body: ["#ffb73a", "#8c5a12"], band: "#fff27a", glow: "rgba(255,242,122,1)", label: "150" },
  }[tier];

  const wob = Math.sin(performance.now() / 320) * r * 0.07;
  c.save();
  c.translate(x, y + wob);

  c.shadowColor = colors.glow;
  c.shadowBlur = r * 1.1;

  const bw = r * 1.6;
  const bh = r * 1.2;
  const radius = r * 0.18;
  const g = c.createLinearGradient(0, -bh / 2, 0, bh / 2);
  g.addColorStop(0, colors.body[0]);
  g.addColorStop(1, colors.body[1]);
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(-bw / 2 + radius, -bh / 2);
  c.lineTo(bw / 2 - radius, -bh / 2);
  c.quadraticCurveTo(bw / 2, -bh / 2, bw / 2, -bh / 2 + radius);
  c.lineTo(bw / 2, bh / 2 - radius);
  c.quadraticCurveTo(bw / 2, bh / 2, bw / 2 - radius, bh / 2);
  c.lineTo(-bw / 2 + radius, bh / 2);
  c.quadraticCurveTo(-bw / 2, bh / 2, -bw / 2, bh / 2 - radius);
  c.lineTo(-bw / 2, -bh / 2 + radius);
  c.quadraticCurveTo(-bw / 2, -bh / 2, -bw / 2 + radius, -bh / 2);
  c.closePath();
  c.fill();

  c.shadowBlur = 0;
  c.fillStyle = colors.band;
  c.fillRect(-bw / 2, -bh * 0.16, bw, bh * 0.32);

  c.fillStyle = colors.glow;
  c.beginPath();
  c.arc(0, 0, r * 0.18, 0, TAU);
  c.fill();
  c.fillStyle = colors.body[1];
  c.fillRect(-r * 0.05, -r * 0.08, r * 0.1, r * 0.16);

  c.fillStyle = "#fff";
  c.font = `bold ${Math.round(r * 0.44)}px "PingFang SC", sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText("+" + colors.label, 0, -bh / 2 - r * 0.3);

  c.restore();
}

/* ---------------- 绘制：护盾道具 ---------------- */
function drawShieldOrb(c, x, y, r, t) {
  const bob = Math.sin(t * 2.6) * r * 0.08;
  c.save();
  c.translate(x, y + bob);
  c.rotate(Math.sin(t * 1.2) * 0.12);

  c.shadowColor = "rgba(110,220,255,0.95)";
  c.shadowBlur = r * 1.1;
  const g = c.createLinearGradient(0, -r, 0, r);
  g.addColorStop(0, "#e6fbff");
  g.addColorStop(0.5, "#5fd6ff");
  g.addColorStop(1, "#1466c9");
  c.fillStyle = g;
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * TAU / 6;
    const px = Math.cos(a) * r * 0.95, py = Math.sin(a) * r * 0.95;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
  c.shadowBlur = 0;

  c.strokeStyle = "rgba(255,255,255,0.85)";
  c.lineWidth = Math.max(1, r * 0.12);
  c.beginPath();
  c.arc(0, 0, r * 0.46, 0, TAU);
  c.stroke();
  c.beginPath();
  c.moveTo(-r * 0.46, 0); c.lineTo(r * 0.46, 0);
  c.moveTo(0, -r * 0.46); c.lineTo(0, r * 0.46);
  c.stroke();

  c.restore();
}

/* ---------------- 绘制：场地 ---------------- */
const field = $("field");
const fctx = field.getContext("2d");
let fw = 0, fh = 0;

function resizeField() {
  const r = field.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fw = r.width; fh = r.height;
  field.width = Math.round(fw * dpr);
  field.height = Math.round(fh * dpr);
  fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fctx.imageSmoothingQuality = "high";
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

/* ---------------- 绘制：首页预览 ---------------- */
const homeCv = $("homePreview");
const hctx = homeCv.getContext("2d");

function resizeHome() {
  const r = homeCv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  homeCv.width = Math.round(r.width * dpr);
  homeCv.height = Math.round(r.height * dpr);
  hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hctx.imageSmoothingQuality = "high";
}

function drawHome(t) {
  const w = homeCv.clientWidth, h = homeCv.clientHeight;
  if (!w || !h) return;
  hctx.clearRect(0, 0, w, h);
  const unit = Math.min(w, h);

  drawAlien(hctx, w * 0.20, h * 0.30 + Math.sin(t * 1.4) * 7, unit * 0.13, t, 1.4);
  drawScout(hctx, w * 0.47, h * 0.22 + Math.sin(t * 1.8 + 1) * 6, unit * 0.10, t, 2.2);
  drawSeeker(hctx, w * 0.80, h * 0.28 + Math.sin(t * 1.1 + 2) * 8, unit * 0.11, t, 3.7);

  const sx = w * 0.5 + Math.sin(t * 0.8) * w * 0.13;
  const sy = h * 0.80 + Math.sin(t * 2.2) * unit * 0.02;
  drawShip(hctx, sx, sy, unit * 0.22, t, 0, true);
}

/* ---------------- 绘制：粒子 / 飘字 / 冲击波 ---------------- */
function burst(x, y, n, color, power = 1) {
  for (let i = 0; i < n; i++) {
    if (game.particles.length > 220) game.particles.shift();
    const a = Math.random() * TAU;
    const sp = (0.12 + Math.random() * 0.5) * power;
    game.particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.35 + Math.random() * 0.45,
      max: 0.8,
      color,
      size: 1 + Math.random() * 2.2,
    });
  }
}

function addPopup(text, x, y, color, size = 1) {
  if (game.popups.length > 14) game.popups.shift();
  game.popups.push({ text, x, y, color, size, life: 0.95, max: 0.95 });
}

function drawParticles(c, dt) {
  c.save();
  c.globalCompositeOperation = "lighter";
  for (const p of game.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 0.32 * dt;
    p.life -= dt;
    const k = Math.max(0, p.life / p.max);
    if (k <= 0) continue;
    c.globalAlpha = Math.min(1, k * 1.6);
    c.fillStyle = p.color;
    c.beginPath();
    c.arc(p.x * fw, p.y * fh, p.size, 0, TAU);
    c.fill();
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.restore();
  for (let i = game.particles.length - 1; i >= 0; i--) {
    if (game.particles[i].life <= 0) game.particles.splice(i, 1);
  }
}

function drawShockwaves(c) {
  c.save();
  c.globalCompositeOperation = "lighter";
  for (const s of game.shockwaves) {
    const k = clamp01(s.r / s.max);
    const a = (1 - k) * 0.9;
    c.strokeStyle = `rgba(120,244,255,${a.toFixed(3)})`;
    c.lineWidth = Math.max(2, fw * 0.018 * (1 - k) + 1);
    c.beginPath();
    c.arc(s.x * fw, s.y * fh, s.r, 0, TAU);
    c.stroke();
    c.strokeStyle = `rgba(200,255,255,${(a * 0.5).toFixed(3)})`;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(s.x * fw, s.y * fh, s.r * 0.82, 0, TAU);
    c.stroke();
  }
  c.restore();
}

function drawPopups(c) {
  c.save();
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (const p of game.popups) {
    const k = clamp01(p.life / p.max);
    const y = p.y * fh - (1 - k) * fw * 0.11;
    c.globalAlpha = Math.min(1, k * 2.2);
    c.fillStyle = p.color;
    c.font = `800 ${Math.round(fw * 0.042 * p.size)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.fillText(p.text, p.x * fw, y);
  }
  c.globalAlpha = 1;
  c.restore();
}

function drawBanner(c) {
  const b = game.banner;
  if (!b || b.t <= 0) return;
  const p = 1 - b.t / b.dur;
  const a = Math.min(1, p * 8, b.t * 2.4);
  if (a <= 0) return;
  const cx = fw / 2;
  const cy = fh * 0.25;
  const slide = (1 - Math.min(1, p * 5)) * -fw * 0.05;

  c.save();
  c.globalAlpha = a;
  const bw = fw * 0.78, bh2 = fw * 0.235;
  c.fillStyle = "rgba(5, 14, 38, 0.92)";
  c.strokeStyle = "rgba(62, 230, 255, 0.45)";
  c.lineWidth = 1;
  roundRect(c, cx - bw / 2, cy - bh2 / 2, bw, bh2, fw * 0.03);
  c.fill();
  c.stroke();

  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = "#eafcff";
  c.shadowColor = "rgba(62, 230, 255, 0.9)";
  c.shadowBlur = 18;
  c.font = `800 ${Math.round(fw * 0.062)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  c.fillText(b.title, cx + slide, cy - fw * 0.012);

  c.shadowBlur = 0;
  c.fillStyle = "rgba(190, 235, 255, 0.88)";
  c.font = `500 ${Math.round(fw * 0.033)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  c.fillText(b.sub, cx + slide, cy + fw * 0.062);
  c.restore();
}

function drawEnergyBar(c) {
  const w = fw * 0.34, h = Math.max(5, fw * 0.017);
  const x = fw * 0.045, y = fh - fw * 0.052;
  const p = game.energy / CONFIG.pulse.max;
  c.save();
  c.fillStyle = "rgba(6, 16, 42, 0.75)";
  roundRect(c, x - 1, y - 1, w + 2, h + 2, h);
  c.fill();
  const g = c.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, "#2bd6ff");
  g.addColorStop(1, canPulse() ? "#b6fbff" : "#4d8fd8");
  c.fillStyle = g;
  roundRect(c, x, y, Math.max(h, w * p), h, h / 2);
  c.fill();

  c.fillStyle = canPulse() ? "#d8fbff" : "rgba(170, 215, 240, 0.6)";
  c.font = `600 ${Math.round(fw * 0.028)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  c.textAlign = "left";
  c.textBaseline = "bottom";
  c.fillText(canPulse() ? "脉冲就绪" : "脉冲充能", x, y - 4);
  c.restore();
}

function drawField(t, dt) {
  if (!fw || !fh) return;
  const c = fctx;
  c.clearRect(0, 0, fw, fh);

  c.save();
  if (game.shake > 0.01) {
    c.translate((Math.random() - 0.5) * fw * 0.02 * game.shake,
                (Math.random() - 0.5) * fh * 0.02 * game.shake);
  }

  // 场地内暗角
  const vg = c.createRadialGradient(fw / 2, fh * 0.45, Math.min(fw, fh) * 0.18,
                                    fw / 2, fh * 0.5, Math.max(fw, fh) * 0.78);
  vg.addColorStop(0, "rgba(10,22,60,0)");
  vg.addColorStop(1, "rgba(4,8,28,0.55)");
  c.fillStyle = vg;
  c.fillRect(0, 0, fw, fh);

  // 物体
  for (const it of game.items) {
    const meta = ITEM_KINDS[it.kind];
    const r = fw * 0.068 * meta.radius / 0.062;
    const ix = it.x * fw;
    const iy = it.y * fh;
    if (it.kind === "alien") drawAlien(c, ix, iy, r, t, it.phase);
    else if (it.kind === "scout") drawScout(c, ix, iy, r, t, it.phase);
    else if (it.kind === "seeker") drawSeeker(c, ix, iy, r, t, it.phase);
    else if (it.kind === "bomb") drawBomb(c, ix, iy, r, t);
    else if (it.kind === "shield") drawShieldOrb(c, ix, iy, r, t);
    else drawChest(c, ix, iy, r, it.kind);
  }

  drawParticles(c, game.paused ? 0 : dt);
  drawShockwaves(c);

  // 飞船（受击后闪烁）
  const blink = game.invuln > 0 && Math.floor(t * 10) % 2 === 0;
  const sy = CONFIG.shipY * fh + Math.sin(t * 1.6) * fw * 0.004;
  if (!blink) drawShip(c, game.shipX * fw, sy, fw * 0.105, t, game.shield, canPulse());

  // 连击：船身下方的时间条 + 倍率（避免和护盾圆环重叠）
  if (game.running && game.combo > 0) {
    const k = clamp01(game.comboTimer / CONFIG.combo.window);
    const sx = game.shipX * fw;
    const bw = fw * 0.16;
    const bh = Math.max(2.5, fw * 0.009);
    const by = sy + fw * 0.10;
    c.save();
    c.fillStyle = "rgba(6, 16, 42, 0.78)";
    roundRect(c, sx - bw / 2, by, bw, bh, bh);
    c.fill();
    c.fillStyle = game.mult > 1 ? "#ffd86a" : "#82ebff";
    roundRect(c, sx - bw / 2, by, Math.max(bh, bw * k), bh, bh);
    c.fill();
    if (game.mult > 1) {
      c.fillStyle = "#ffe9a8";
      c.font = `800 ${Math.round(fw * 0.045)}px "PingFang SC", sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.shadowColor = "rgba(255,200,80,0.9)";
      c.shadowBlur = 10;
      c.fillText("×" + game.mult, sx + fw * 0.115, sy);
    }
    c.restore();
  }

  drawPopups(c);

  if (game.flash > 0.01) {
    c.fillStyle = `rgba(255,70,100,${(game.flash * 0.3).toFixed(3)})`;
    c.fillRect(0, 0, fw, fh);
  }
  if (game.goldFlash > 0.01) {
    c.fillStyle = `rgba(255,220,90,${(game.goldFlash * 0.22).toFixed(3)})`;
    c.fillRect(0, 0, fw, fh);
  }

  if (game.running) drawEnergyBar(c);

  // 未开始提示
  if (!game.running && !game.ended) {
    c.textAlign = "center";
    c.fillStyle = "rgba(200,244,255,0.72)";
    c.font = `600 ${Math.round(fw * 0.058)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.fillText("点击「开始游戏」", fw / 2, fh * 0.44);
    c.fillStyle = "rgba(170,220,245,0.62)";
    c.font = `400 ${Math.round(fw * 0.04)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.fillText(`第 ${game.level} 关 · ${LEVELS[game.level - 1].dur} 秒 · 3 波`, fw / 2, fh * 0.44 + fw * 0.1);
  }

  drawBanner(c);

  c.restore();
}

/* ---------------- 音效（程序化） ---------------- */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    try { audioCtx.resume(); } catch (e) {}
  }
  return audioCtx;
}

function tone(type, f0, f1, dur, vol, delay = 0) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, f0), t0);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function noiseBurst(f0, f1, dur, vol, type = "lowpass", q = 0.7) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const len = Math.max(1, Math.floor(ctx.sampleRate * (dur + 0.15)));
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, t0);
  filt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  noise.connect(filt).connect(g).connect(ctx.destination);
  noise.start(t0);
  noise.stop(t0 + dur + 0.05);
}

function playExplosion() {
  noiseBurst(1600, 120, 0.65, 0.5);
  tone("sine", 120, 35, 0.3, 0.55);
}

function playCoin() {
  tone("triangle", 880, 1760, 0.13, 0.26);
  tone("triangle", 1320, 1980, 0.1, 0.16, 0.07);
}

function playPulse() {
  noiseBurst(420, 2600, 0.22, 0.22, "bandpass", 1.1);
  tone("sawtooth", 170, 620, 0.18, 0.16);
  tone("sine", 520, 130, 0.3, 0.18, 0.04);
}

function playPop() {
  tone("square", 620, 980, 0.1, 0.09);
  noiseBurst(2400, 600, 0.12, 0.1);
}

function playNear() {
  tone("sine", 1180, 1560, 0.09, 0.12);
}

function playShieldUp() {
  tone("triangle", 660, 990, 0.16, 0.22);
  tone("triangle", 990, 1480, 0.22, 0.16, 0.08);
}

function playShieldBreak() {
  noiseBurst(1800, 240, 0.35, 0.32, "bandpass", 1.4);
  tone("square", 220, 70, 0.3, 0.2);
}

function playComboUp(mult) {
  const base = 520 + mult * 70;
  tone("triangle", base, base * 1.25, 0.1, 0.14);
  tone("triangle", base * 1.25, base * 1.6, 0.12, 0.12, 0.08);
}

function playWaveChime() {
  tone("sine", 440, 660, 0.18, 0.16);
  tone("sine", 660, 880, 0.26, 0.14, 0.12);
}

/* ---------------- 关卡流程 ---------------- */
let lastGapLane = -1;
let spawnedLanes = new Set();

function prepareLevel(level) {
  game.level = level;
  game.wave = 1;
  game.running = false;
  game.paused = false;
  game.ended = false;
  game.score = 0;
  game.lives = CONFIG.startLives;
  game.timeLeft = LEVELS[level - 1].dur;
  game.waveTimer = LEVELS[level - 1].dur / 3;
  game.items.length = 0;
  game.particles.length = 0;
  game.popups.length = 0;
  game.shockwaves.length = 0;
  game.shipX = game.targetX = 0.5;
  game.keyDir = 0;
  game.mouseX = null;
  game.mouseActive = false;
  game.invuln = 0;
  game.spawnTimer = 0;
  game.shake = 0;
  game.flash = 0;
  game.goldFlash = 0;
  game.energy = CONFIG.pulse.max * 0.5;
  game.shield = 0;
  game.combo = 0;
  game.mult = 1;
  game.comboTimer = 0;
  game.bestCombo = 0;
  game.banner = null;
  game.pulseUsed = false;
  lastGapLane = -1;
  spawnedLanes = new Set();
  $("pauseTag").classList.add("hidden");
  $("btnPause").textContent = "暂停";
  syncHUD(true);
  syncTimer();
  setBtnStates();
  syncPulseUI(true);
}

function waveHint(lv, wave) {
  if (game.level === 1 && wave === 1) return "躲开外星人 · 空格 / 点击场地 / 握拳 放脉冲";
  if (wave === 2 && lv.scoutWave <= 2) return "侦察兵入场：更小、更快、分数更高";
  if (wave === 3 && lv.seekerWave <= 3) return "追踪者入场：会横向追着你";
  if (wave === 2) return "节奏加快，盯住下一行空档";
  if (wave === 3) return "最后一波 · 连击别断";
  return "保持连击，分数滚起来";
}

function setWave(n) {
  game.wave = n;
  game.waveTimer = LEVELS[game.level - 1].dur / 3;
  game.banner = {
    title: `第 ${game.level} 关 · 第 ${n} 波`,
    sub: waveHint(LEVELS[game.level - 1], n),
    t: 2.4,
    dur: 2.4,
  };
  game.spawnTimer = Math.max(game.spawnTimer, 0.55);
  playWaveChime();
  syncHUD();
}

function startRun(level) {
  prepareLevel(level);
  game.running = true;
  game.spawnTimer = 1.15;
  game.invuln = 1.0;
  setWave(1);
  syncHUD(true);
  setBtnStates();
  if (gestureEnabled && !camReady) initGesture();
}

function startCurrent() {
  hideOverlay();
  startRun(game.level);
}

/* 生成种类：先决定炸弹 / 宝箱 / 护盾，再按权重挑敌人 */
function pickKind(lv) {
  const r = Math.random();
  if (r < lv.bomb) return "bomb";
  if (r < lv.bomb + lv.chest) {
    const cr = Math.random();
    if (cr < 0.55) return "chest_s";
    if (cr < 0.88) return "chest_m";
    return "chest_l";
  }
  if (r < lv.bomb + lv.chest + lv.shield) return "shield";

  const scoutW = game.wave >= lv.scoutWave ? lv.scout : 0;
  const seekerW = game.wave >= lv.seekerWave ? lv.seeker : 0;
  const total = 1 + scoutW + seekerW;
  const er = Math.random() * total;
  if (er < 1) return "alien";
  if (er < 1 + scoutW) return "scout";
  return "seeker";
}

/* 每行固定留一条空车道，且空档尽量不与上一行重复 */
function spawnRow(lv) {
  const lanes = Array.from({ length: CONFIG.laneCount }, (_, i) => i);
  let gap;
  do {
    gap = (Math.random() * lanes.length) | 0;
  } while (gap === lastGapLane && lanes.length > 2);
  lastGapLane = gap;

  const free = lanes.filter(i => i !== gap);
  for (let i = free.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [free[i], free[j]] = [free[j], free[i]];
  }

  // 优先占用上一行没出现过的车道
  const prevLanes = spawnedLanes;
  const preferred = free.filter(l => !prevLanes.has(l));
  if (preferred.length >= 2) {
    const remain = free.filter(l => !preferred.includes(l));
    free.length = 0;
    free.push(...preferred, ...remain);
  }

  const want = 2 + (Math.random() < lv.two ? 1 : 0);
  spawnedLanes = new Set();
  const laneWidth = 1 / CONFIG.laneCount;
  let seekerCount = game.items.reduce((n, it) => n + (it.kind === "seeker" ? 1 : 0), 0);

  for (const lane of free.slice(0, want)) {
    const center = (lane + 0.5) * laneWidth;
    const jitter = (Math.random() * 2 - 1) * laneWidth * 0.22;
    const x = Math.max(laneWidth * 0.3, Math.min(1 - laneWidth * 0.3, center + jitter));
    spawnedLanes.add(lane);

    let kind = pickKind(lv);
    // 追踪者最多同时 2 只，避免无解
    if (kind === "seeker") {
      if (seekerCount >= 2) kind = "alien";
      else seekerCount++;
    }

    const vyMul = kind === "scout" ? 1.55 : kind === "seeker" ? 0.82 : kind === "bomb" ? 0.95 : 1;
    game.items.push({
      kind,
      x,
      y: -0.12 - Math.random() * 0.04,
      phase: Math.random() * TAU,
      vyMul,
      passed: false,
    });
  }
}

/* ---------------- 加分 / 连击 / 能量 ---------------- */
function syncComboUI(bump) {
  const box = $("hudComboBox");
  box.classList.toggle("on", game.mult > 1);
  $("hudCombo").textContent = "×" + game.mult;
  if (bump) {
    box.classList.remove("bump");
    void box.offsetWidth;
    box.classList.add("bump");
  }
  syncHUD();
}

function bumpCombo() {
  game.combo++;
  game.bestCombo = Math.max(game.bestCombo, game.combo);
  game.comboTimer = CONFIG.combo.window;
  const m = Math.min(CONFIG.combo.max, 1 + Math.floor(game.combo / CONFIG.combo.perStep));
  if (m !== game.mult) {
    game.mult = m;
    playComboUp(m);
    syncComboUI(true);
  } else {
    syncHUD();
  }
}

function award(base, x, y, opts = {}) {
  const gain = Math.max(1, Math.round(base * game.mult));
  game.score += gain;
  addPopup(`${opts.prefix || "+"}${gain}`, x, y, opts.color || "#bff4ff", opts.size);
  syncHUD();
  return gain;
}

function addEnergy(v) {
  game.energy = Math.min(CONFIG.pulse.max, game.energy + v);
}

function resetCombo() {
  if (game.combo === 0) return;
  game.combo = 0;
  game.mult = 1;
  game.comboTimer = 0;
  syncComboUI(false);
}

/* ---------------- 脉冲 ---------------- */
function firePulse() {
  if (!game.running || game.paused || game.ended) return false;
  if (!canPulse()) {
    addPopup("能量不足", game.shipX, CONFIG.shipY - 0.12, "rgba(170,215,240,0.9)", 0.8);
    return false;
  }
  game.energy -= CONFIG.pulse.cost;
  game.shockwaves.push({
    x: game.shipX,
    y: CONFIG.shipY - 0.02,
    r: fw * 0.04,
    max: fw * CONFIG.pulse.radius,
    hit: new Set(),
  });
  game.shake = Math.max(game.shake, 0.5);
  game.pulseUsed = true;
  $("btnPulse").classList.remove("hint");
  playPulse();
  syncPulseUI(true);
  return true;
}

function updateShockwaves(dt) {
  for (let wi = game.shockwaves.length - 1; wi >= 0; wi--) {
    const s = game.shockwaves[wi];
    s.r += fw * CONFIG.pulse.speed * dt;

    for (let i = game.items.length - 1; i >= 0; i--) {
      const it = game.items[i];
      if (isPickup(it.kind) || s.hit.has(it)) continue;
      const dx = (it.x - s.x) * fw;
      const dy = (it.y - s.y) * fh;
      const dist = Math.hypot(dx, dy);
      if (dist > s.r + fw * ITEM_KINDS[it.kind].radius * 0.7) continue;
      s.hit.add(it);
      game.items.splice(i, 1);
      destroyByPulse(it);
    }

    if (s.r >= s.max) game.shockwaves.splice(wi, 1);
  }
}

function destroyByPulse(it) {
  const meta = ITEM_KINDS[it.kind];
  if (it.kind === "bomb") {
    award(meta.pulse, it.x, it.y, { color: "#ffd08a" });
    burst(it.x, it.y, 10, "#ffb347", 1.1);
    playPop();
  } else {
    award(meta.pulse, it.x, it.y, { color: "#9df7ff" });
    burst(it.x, it.y, 12, it.kind === "scout" ? "#6dffc0" : it.kind === "seeker" ? "#c79bff" : "#ff8fd0", 1.2);
    bumpCombo();
    addEnergy(2);
    playPop();
  }
  game.shake = Math.max(game.shake, 0.18);
}

/* ---------------- 主更新 ---------------- */
function update(dt, now, t) {
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 2.4);
  if (game.flash > 0) game.flash = Math.max(0, game.flash - dt * 2.6);
  if (game.goldFlash > 0) game.goldFlash = Math.max(0, game.goldFlash - dt * 3.0);

  // 飘字与横幅在暂停时也缓慢淡出，避免卡在半空
  if (game.banner && game.banner.t > 0) game.banner.t -= dt;
  for (let i = game.popups.length - 1; i >= 0; i--) {
    game.popups[i].life -= dt;
    if (game.popups[i].life <= 0) game.popups.splice(i, 1);
  }

  if (!game.running || game.paused) return;

  const lv = LEVELS[game.level - 1];
  const wave = WAVES[game.wave - 1];

  // 关卡倒计时
  game.timeLeft -= dt;
  if (game.timeLeft <= 0) {
    game.timeLeft = 0;
    syncTimer();
    endRun(true);
    return;
  }
  syncTimer();

  // 波次推进
  game.waveTimer -= dt;
  if (game.waveTimer <= 0 && game.wave < 3) setWave(game.wave + 1);

  // 能量自然回复 + 连击衰减
  addEnergy(CONFIG.pulse.regen * dt);
  if (game.combo > 0) {
    game.comboTimer -= dt;
    if (game.comboTimer <= 0) resetCombo();
  }

  // 成排生成
  game.spawnTimer -= dt;
  if (game.spawnTimer <= 0) {
    spawnRow(lv);
    game.spawnTimer = lv.spawn * wave.spawn * (0.85 + Math.random() * 0.3);
  }

  const baseSpeed = lv.speed * wave.speed;

  for (let i = game.items.length - 1; i >= 0; i--) {
    const it = game.items[i];
    const meta = ITEM_KINDS[it.kind];

    it.y += baseSpeed * it.vyMul * dt;

    if (it.kind === "scout") {
      it.x += Math.sin(t * 3.2 + it.phase) * 0.05 * dt;
    } else if (it.kind === "seeker" && it.y < 0.68) {
      const dx = game.shipX - it.x;
      const step = 0.155 * dt;
      it.x += Math.sign(dx) * Math.min(Math.abs(dx), step);
    }
    it.x = Math.max(0.035, Math.min(0.965, it.x));

    // 越过飞船高度：判定躲避 / 险避
    if (!it.passed && it.y >= CONFIG.shipY) {
      it.passed = true;
      if (meta.pass > 0) {
        const dx = Math.abs(it.x - game.shipX);
        const nearLine = (meta.radius + 0.05) * 1.45;
        if (dx < nearLine) {
          award(meta.near, it.x, it.y - 0.06, { prefix: "险避 +", color: "#ffd86a" });
          addEnergy(9);
          if (now - lastNearSound > 140) { playNear(); lastNearSound = now; }
        } else {
          award(meta.pass, it.x, it.y - 0.04, { color: "#bff4ff", size: 0.85 });
          addEnergy(4);
        }
        bumpCombo();
      }
    }

    if (it.y > 1.12) game.items.splice(i, 1);
  }

  updateShockwaves(dt);

  if (game.invuln > 0) game.invuln -= dt;

  // 输入优先级：手势 > 键盘 > 鼠标
  const handActive = handX != null && now - handSeenAt < CONFIG.handTimeoutMs;
  if (handActive) {
    game.shipX = clampShip(handShipX);
    game.targetX = game.shipX;
  } else {
    if (game.keyDir) {
      game.targetX = clampShip(game.targetX + game.keyDir * 1.15 * dt);
    } else if (game.mouseActive && game.mouseX != null) {
      game.targetX = clampShip(game.mouseX);
    }
    game.shipX += (game.targetX - game.shipX) * Math.min(1, dt * 12);
    game.shipX = clampShip(game.shipX);
  }

  if (game.invuln <= 0 && fw > 0) checkCollisions();
}

let lastNearSound = 0;

/* ---------------- 碰撞 ---------------- */
function checkCollisions() {
  const sx = game.shipX * fw;
  const sy = CONFIG.shipY * fh;
  const halfW = fw * 0.052;
  const halfH = fw * 0.058;

  for (let i = game.items.length - 1; i >= 0; i--) {
    const it = game.items[i];
    const meta = ITEM_KINDS[it.kind];
    const r = fw * meta.radius;
    const ax = it.x * fw;
    const ay = it.y * fh;

    if (Math.abs(ax - sx) < r + halfW && Math.abs(ay - sy) < r * 0.85 + halfH) {
      game.items.splice(i, 1);

      if (meta.life > 0) {
        hurtPlayer(it);
        if (!game.running) return;
      } else if (meta.chest) {
        award(meta.chest, it.x, it.y, { color: "#ffe08a" });
        game.goldFlash = 1;
        addEnergy(12);
        burst(it.x, it.y, 10, "#ffe08a", 0.8);
        playCoin();
        bumpCombo();
      } else if (meta.shield) {
        game.shield = 1;
        game.goldFlash = 1;
        addEnergy(10);
        addPopup("护盾展开", it.x, it.y - 0.04, "#9de8ff", 0.9);
        burst(it.x, it.y, 12, "#8fe6ff", 0.9);
        playShieldUp();
        syncHUD();
      }
    }
  }
}

function hurtPlayer(it) {
  if (game.shield > 0) {
    game.shield = 0;
    game.invuln = 1.0;
    game.shake = 0.8;
    addPopup("护盾抵挡", it.x, it.y - 0.04, "#9de8ff", 1);
    burst(it.x, it.y, 18, "#8fe6ff", 1.3);
    playShieldBreak();
    syncHUD();
    return;
  }

  game.lives -= 1;
  resetCombo();
  game.invuln = 1.5;
  game.shake = 1;
  game.flash = 1;
  burst(it.x, it.y, 22, "#ff8fb0", 1.5);
  playExplosion();
  syncHUD();

  if (game.lives <= 0) endRun(false);
}

/* ---------------- 结束 ---------------- */
function endRun(success) {
  game.running = false;
  game.paused = false;
  game.ended = true;
  $("pauseTag").classList.add("hidden");
  $("btnPause").textContent = "暂停";
  syncTimer();
  setBtnStates();
  const record = recordBest(game.level, game.score);
  showResult(success, record);
}

/* ---------------- 结果弹层 ---------------- */
function makeBtn(text, primary, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn" + (primary ? " primary" : "");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function showResult(success, record) {
  const title = $("resultTitle");
  title.textContent = success ? "挑战成功" : "挑战失败";
  title.classList.toggle("ok", success);
  title.classList.toggle("bad", !success);

  let detail = `第 ${game.level} 关 · 第 ${game.wave} 波 · 得分 ${game.score} · 最高连击 ${game.bestCombo}`;
  if (success && game.level === LEVELS.length) detail += " · 已通关全部关卡";
  $("resultDetail").textContent = detail;

  const card = document.querySelector(".result-card");
  const old = card.querySelector(".record-tag");
  if (old) old.remove();
  if (record) {
    const tag = document.createElement("div");
    tag.className = "record-tag";
    tag.textContent = "新 纪 录";
    $("resultDetail").after(tag);
  }

  const acts = $("resultActions");
  acts.innerHTML = "";
  if (success && game.level < LEVELS.length) {
    unlockLevel(game.level + 1);
    acts.appendChild(makeBtn("进行下一关", true, () => {
      hideOverlay();
      startRun(game.level + 1);
    }));
  } else {
    acts.appendChild(makeBtn("重新挑战", true, () => {
      hideOverlay();
      startRun(game.level);
    }));
  }
  acts.appendChild(makeBtn("返回首页", false, goHome));

  $("overlay").classList.remove("hidden");
}

function hideOverlay() {
  $("overlay").classList.add("hidden");
}

/* ---------------- HUD / 按钮 ---------------- */
let lastTimerText = "";
const hudCache = { score: -1, lives: -1, level: "", combo: "" };

function syncHUD(force) {
  if (force || hudCache.score !== game.score) {
    hudCache.score = game.score;
    $("hudScore").textContent = game.score;
  }
  if (force || hudCache.lives !== game.lives) {
    hudCache.lives = game.lives;
    $("hudLives").textContent = `${Math.max(0, game.lives)} ❤`;
  }
  const lvTxt = `${game.level}-${game.wave}`;
  if (force || hudCache.level !== lvTxt) {
    hudCache.level = lvTxt;
    $("hudLevel").textContent = lvTxt;
  }
  const cTxt = "×" + game.mult;
  if (force || hudCache.combo !== cTxt) {
    hudCache.combo = cTxt;
    $("hudCombo").textContent = cTxt;
    $("hudComboBox").classList.toggle("on", game.mult > 1);
  }
}

function syncTimer() {
  const s = Math.max(0, Math.ceil(game.timeLeft));
  const txt = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  if (txt !== lastTimerText) {
    lastTimerText = txt;
    $("fieldTimer").textContent = txt;
  }
}

let pulseUiCache = { pct: -1, ready: null, disabled: null };
function syncPulseUI(force) {
  const btn = $("btnPulse");
  if (!btn) return;
  const pct = Math.round(game.energy / CONFIG.pulse.max * 100);
  const ready = canPulse();
  const disabled = !game.running || game.paused || game.ended;
  if (force || pct !== pulseUiCache.pct) {
    pulseUiCache.pct = pct;
    btn.style.setProperty("--p", pct + "%");
  }
  if (force || ready !== pulseUiCache.ready) {
    pulseUiCache.ready = ready;
    btn.classList.toggle("ready", ready);
  }
  const hint = ready && !game.pulseUsed && game.running && !game.paused;
  btn.classList.toggle("hint", hint);
  if (force || disabled !== pulseUiCache.disabled) {
    pulseUiCache.disabled = disabled;
    btn.disabled = disabled;
  }
}

function setBtnStates() {
  $("btnStart").disabled = game.running;
  $("btnStart").textContent = game.running ? "进行中" : (game.ended ? "再来一局" : "开始游戏");
  $("btnPause").disabled = !game.running;
  $("btnPulse").disabled = !game.running || game.paused || game.ended;
  pulseUiCache.disabled = null;
}

function togglePause() {
  if (!game.running) return;
  game.paused = !game.paused;
  $("pauseTag").classList.toggle("hidden", !game.paused);
  $("btnPause").textContent = game.paused ? "继续" : "暂停";
  setBtnStates();
}

/* ---------------- 页面切换 ---------------- */
function showScreen(name) {
  game.screen = name;
  for (const id of ["home", "levels", "game"]) {
    $(id).classList.toggle("hidden", id !== name);
  }
  $("camWrap").classList.toggle("hidden", name !== "game");
  if (name !== "game") stopCamera();
  if (name === "game") {
    requestAnimationFrame(() => { resizeField(); drawField(performance.now() / 1000, 0); });
  } else if (name === "home") {
    requestAnimationFrame(resizeHome);
  }
}

function goHome() {
  hideOverlay();
  game.running = false;
  game.paused = false;
  game.ended = false;
  game.items.length = 0;
  game.keyDir = 0;
  showScreen("home");
}

/* ---------------- 进度 / 最佳分数 ---------------- */
const UNLOCK_KEY = "spaceGameUnlocked";
const BEST_KEY = "spaceGameBest";
let unlockedLevel = 1;
let bestScores = {};

function loadProgress() {
  try {
    const v = parseInt(localStorage.getItem(UNLOCK_KEY) || "1", 10);
    unlockedLevel = Number.isFinite(v) ? Math.min(LEVELS.length, Math.max(1, v)) : 1;
  } catch (e) {
    unlockedLevel = 1;
  }
  try {
    bestScores = JSON.parse(localStorage.getItem(BEST_KEY) || "{}") || {};
  } catch (e) {
    bestScores = {};
  }
}

function unlockLevel(n) {
  const v = Math.min(LEVELS.length, Math.max(unlockedLevel, n));
  if (v <= unlockedLevel) return;
  unlockedLevel = v;
  try { localStorage.setItem(UNLOCK_KEY, String(v)); } catch (e) {}
  buildLevelGrid();
}

function recordBest(level, score) {
  const prev = bestScores[level] || 0;
  if (score <= prev) return false;
  bestScores[level] = score;
  try { localStorage.setItem(BEST_KEY, JSON.stringify(bestScores)); } catch (e) {}
  buildLevelGrid();
  return true;
}

function buildLevelGrid() {
  const grid = $("levelGrid");
  grid.innerHTML = "";
  for (const lv of LEVELS) {
    const locked = lv.n > unlockedLevel;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "level-card" + (locked ? " locked" : "");
    b.disabled = locked;
    const best = bestScores[lv.n] || 0;
    b.innerHTML = `<span class="lv-num">第 ${lv.n} 关</span>
      <span class="lv-time">${locked ? "—" : lv.dur + " 秒 · 3 波"}</span>
      <span class="lv-tag">${locked ? "未解锁" : lv.tag}</span>
      <span class="lv-best">${locked ? "" : best ? "最佳 " + best : "暂无记录"}</span>`;
    if (!locked) {
      b.addEventListener("click", () => {
        hideOverlay();
        game.ended = false;
        prepareLevel(lv.n);
        showScreen("game");
      });
    }
    grid.appendChild(b);
  }
}

/* ---------------- 手势 / 摄像头 ---------------- */
const video = $("cam");
const skel = $("skel");
const skelCtx = skel.getContext("2d");
const HAND_LINKS = [
  [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8], [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16], [13,17],[17,18],[18,19],[19,20], [0,17],
];

let landmarker = null;
let camReady = false;
let camStream = null;
let lastDetect = 0;
let gestureLoading = false;
let gestureEnabled = true;
let gestureError = false;
let frameTick = 0;          // 摄像头已产出多少帧
let frameStamp = 0;         // 最近一帧视频的显示时间戳
let lastTickSeen = -1;      // 上一帧已推理过的 frameTick
let lastStamp = 0;          // 传给 MediaPipe 的时间戳，必须严格递增
let vfcHandle = 0;

/* 用 requestVideoFrameCallback 拿到真实帧节拍：同一帧不重复推理 */
function watchVideoFrames() {
  if (typeof video.requestVideoFrameCallback !== "function") return;
  if (vfcHandle) return;
  const step = () => {
    vfcHandle = video.requestVideoFrameCallback((now) => {
      frameTick++;
      frameStamp = now;
      step();
    });
  };
  step();
}

function unwatchVideoFrames() {
  if (vfcHandle && typeof video.cancelVideoFrameCallback === "function") {
    video.cancelVideoFrameCallback(vfcHandle);
  }
  vfcHandle = 0;
  frameTick = 0;
  lastTickSeen = -1;
  frameStamp = 0;
}

function setCamStatus(text, warn) {
  const node = $("camStatus");
  if (node.textContent !== text) node.textContent = text;
  node.classList.toggle("warn", !!warn);
}

function setBtnCam() {
  const b = $("btnCam");
  if (gestureLoading) b.textContent = "手势 …";
  else if (!gestureEnabled) b.textContent = "手势 · 关";
  else if (gestureError) b.textContent = "手势 · 重试";
  else b.textContent = "手势 · 开";
}

function drawSkeleton(lm, color) {
  const w = skel.width, h = skel.height;
  skelCtx.strokeStyle = color;
  skelCtx.fillStyle = color;
  skelCtx.lineWidth = 4;
  skelCtx.lineCap = "round";
  skelCtx.globalAlpha = 0.9;
  for (const [a, b] of HAND_LINKS) {
    skelCtx.beginPath();
    skelCtx.moveTo((1 - lm[a].x) * w, lm[a].y * h);
    skelCtx.lineTo((1 - lm[b].x) * w, lm[b].y * h);
    skelCtx.stroke();
  }
  for (const p of lm) {
    skelCtx.beginPath();
    skelCtx.arc((1 - p.x) * w, p.y * h, 6, 0, TAU);
    skelCtx.fill();
  }
  skelCtx.globalAlpha = 1;
}

/* 授权框可能被忽略而一直挂起：超时后自然降级，之后才拿到的流也会被关掉 */
function requestCamera(constraints, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      const err = new Error("camera timeout");
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
    navigator.mediaDevices.getUserMedia(constraints).then(
      stream => {
        clearTimeout(timer);
        if (settled) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        settled = true;
        resolve(stream);
      },
      err => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      }
    );
  });
}

async function initCamera() {
  if (camReady) return "ok";
  try {
    if (location.protocol === "file:") return "file";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unsupported";
    const stream = await requestCamera({
      video: { ...CONFIG.camera, facingMode: "user" },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (track && typeof track.applyConstraints === "function") {
      try { await track.applyConstraints({ advanced: [{ frameRate: CONFIG.camera.frameRate }] }); } catch (e) {}
    }
    camStream = stream;
    video.srcObject = stream;
    video.muted = true;
    video.style.imageRendering = "pixelated";
    video.setAttribute("playsinline", "");
    await video.play();
    camReady = true;
    watchVideoFrames();
    $("camWrap").classList.remove("off");
    setCamStatus("把手放进画面");
    return "ok";
  } catch (e) {
    console.warn("摄像头不可用：", e);
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "denied";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "notfound";
    if (n === "TimeoutError") return "timeout";
    return "error";
  }
}

function stopCamera() {
  unwatchVideoFrames();
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  video.srcObject = null;
  camReady = false;
  handX = null;
  handSeenAt = -1e9;
  handCursor.seenAt = -1e9;
  handCursor.closed = false;
  skelCtx.clearRect(0, 0, skel.width, skel.height);
}

function markGestureUnavailable(reason) {
  gestureError = true;
  gestureLoading = false;
  stopCamera();
  $("camWrap").classList.add("off");
  const msg = {
    denied: "摄像头被拒绝 · 鼠标/键盘可玩",
    notfound: "未找到摄像头 · 鼠标/键盘可玩",
    unsupported: "浏览器不支持摄像头 · 鼠标/键盘可玩",
    file: "需本地 http 服务才能用摄像头 · 鼠标/键盘可玩",
    timeout: "摄像头未响应 · 鼠标/键盘可玩",
    library: "手势库加载失败 · 鼠标/键盘可玩",
    error: "摄像头不可用 · 鼠标/键盘可玩",
  }[reason] || "手势不可用 · 鼠标/键盘可玩";
  setCamStatus(msg, true);
  setBtnCam();
}

async function createLandmarker(lib, fileset, delegate) {
  return lib.HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: CONFIG.mp.model,
      ...(delegate ? { delegate } : {}),
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  });
}

async function initGesture() {
  if (!gestureEnabled || gestureLoading || camReady) return;
  gestureLoading = true;
  gestureError = false;
  setBtnCam();
  setCamStatus("正在请求摄像头…");

  const r = await initCamera();
  if (r !== "ok") {
    markGestureUnavailable(r);
    return;
  }

  if (!landmarker) {
    setCamStatus("正在加载手势库…");
    try {
      const lib = await import(CONFIG.mp.bundle);
      const fileset = await lib.FilesetResolver.forVisionTasks(CONFIG.mp.wasm);
      // GPU 推理单帧明显快于 CPU；不支持时回退 CPU，保证弱设备也能用
      try {
        landmarker = await createLandmarker(lib, fileset, "GPU");
      } catch (e) {
        console.warn("GPU 推理不可用，回退 CPU：", e);
        landmarker = await createLandmarker(lib, fileset, null);
      }
    } catch (e) {
      console.warn("手势库加载失败：", e);
      stopCamera();
      markGestureUnavailable("library");
      return;
    }
  }

  gestureLoading = false;
  gestureError = false;
  setCamStatus("把手放进画面");
  setBtnCam();
}

/* 食指 / 其它手指是否收拢（相对掌长归一化，适配远近） */
function fingerFolded(lm, tip, pip, mcp) {
  const palm = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.01;
  const dTip = Math.hypot(lm[tip].x - lm[mcp].x, lm[tip].y - lm[mcp].y) / palm;
  const dPip = Math.hypot(lm[pip].x - lm[mcp].x, lm[pip].y - lm[mcp].y) / palm;
  return dTip < dPip * 1.08;
}

function detect(now) {
  if (!landmarker || !camReady || video.readyState < 2) return;

  // 只在新视频帧上推理：同一帧重复送进模型只会白占主线程，结果是旧的
  // 预览窗被隐藏时 rVFC 可能不再回调，超时后自动退回按 rAF 节流
  const vfcLive = vfcHandle !== 0 && frameStamp > 0 && now - frameStamp < 200;
  if (vfcLive) {
    if (frameTick === lastTickSeen) return;
  } else if (now - lastDetect < 33) {
    return;
  }
  const since = now - lastDetect;
  if (since < CONFIG.gesture.minIntervalMs) return;
  lastDetect = now;
  if (vfcLive) lastTickSeen = frameTick;

  // 时间戳必须严格递增，优先用视频帧自身的显示时间
  let ts = vfcLive ? frameStamp : now;
  if (!ts || ts <= lastStamp) ts = lastStamp + 1;
  lastStamp = ts;

  let res;
  try {
    res = landmarker.detectForVideo(video, ts);
  } catch (e) {
    return;
  }

  skelCtx.clearRect(0, 0, skel.width, skel.height);
  const lms = res.landmarks || [];

  if (!lms.length) {
    handCursor.closed = false;
    handCursor.downAt = null;
    handX = null;
    $("tagHand").classList.remove("on");
    return;
  }

  const lm = lms[0];
  // 光标用指尖；控船用掌指关节，握拳时不会突然下沉
  const tipX = clamp01(1 - lm[8].x);
  const tipY = clamp01(lm[8].y);
  const anchorX = clamp01(1 - lm[5].x);
  handSeenAt = now;

  // 指数平滑改成按时间常数计算，不再写死每帧系数：
  // 摄像头掉到 20fps 时跟手速度不变，30fps 时延迟从 ~133ms 降到 ~35ms
  const dt = Math.min(0.2, Math.max(0.001, since / 1000));
  const kShip = 1 - Math.exp(-dt / CONFIG.gesture.tau);
  const kCursor = 1 - Math.exp(-dt / CONFIG.gesture.cursorTau);
  if (Math.abs(anchorX - handShipX) > CONFIG.gesture.deadzone) {
    handShipX += (anchorX - handShipX) * kShip;
  }
  handX = handShipX;

  if (Math.abs(tipX - handCursor.x) > CONFIG.gesture.deadzone) {
    handCursor.x += (tipX - handCursor.x) * kCursor;
  }
  if (Math.abs(tipY - handCursor.y) > CONFIG.gesture.deadzone) {
    handCursor.y += (tipY - handCursor.y) * kCursor;
  }
  handCursor.seenAt = now;

  // 握拳：食指收拢，且另外三指里至少两指收拢
  const others = [
    fingerFolded(lm, 12, 10, 9),
    fingerFolded(lm, 16, 14, 13),
    fingerFolded(lm, 20, 18, 17),
  ].filter(Boolean).length;
  const isFist = fingerFolded(lm, 8, 6, 5) && others >= 2;

  const prevClosed = handCursor.closed;
  handCursor.closed = isFist;

  if (isFist && !prevClosed) {
    handCursor.downAt = now;
    if (game.screen === "game" && game.running && !game.paused) {
      firePulse();
    }
  } else if (!isFist && prevClosed && handCursor.downAt != null) {
    const hold = now - handCursor.downAt;
    const inPlay = game.screen === "game" && game.running && !game.paused;
    if (!inPlay && hold > 90 && hold < 1200 && now > handCursor.lastClickAt + 250) {
      triggerGestureClick();
      handCursor.lastClickAt = now;
    }
    handCursor.downAt = null;
  }

  drawSkeleton(lm, "#3ee6ff");
  $("tagHand").classList.add("on");
  if (game.screen === "game") {
    setCamStatus(isFist ? "手势已连接 · 握拳放脉冲" : "手势已连接 · 食指控船");
  }
}

/* ---------------- 输入 ---------------- */
$("toLevels").addEventListener("click", () => showScreen("levels"));
$("backHome").addEventListener("click", goHome);
$("btnStart").addEventListener("click", startCurrent);
$("btnPause").addEventListener("click", togglePause);
$("btnPulse").addEventListener("click", e => {
  e.stopPropagation();
  firePulse();
});
$("btnCam").addEventListener("click", () => {
  if (gestureLoading) return;
  if (!gestureEnabled) {
    gestureEnabled = true;
    initGesture();
  } else if (gestureError || !camReady) {
    initGesture();
  } else {
    gestureEnabled = false;
    stopCamera();
    $("camWrap").classList.add("off");
    setCamStatus("手势已关闭 · 鼠标/键盘可玩", true);
  }
  setBtnCam();
});

window.addEventListener("keydown", e => {
  if (e.code === "ArrowLeft" || e.code === "KeyA") {
    game.keyDir = -1;
    game.mouseActive = false;
    e.preventDefault();
  } else if (e.code === "ArrowRight" || e.code === "KeyD") {
    game.keyDir = 1;
    game.mouseActive = false;
    e.preventDefault();
  } else if (e.code === "KeyP") {
    togglePause();
  } else if (e.code === "Space") {
    if (game.screen !== "game") return;
    e.preventDefault();
    if (!game.running && !game.ended) startCurrent();
    else firePulse();
  } else if (e.code === "Enter" && game.screen === "game" && !game.running && !game.ended) {
    startCurrent();
  }
});

window.addEventListener("keyup", e => {
  if (e.code === "ArrowLeft" || e.code === "KeyA") game.keyDir = 0;
  if (e.code === "ArrowRight" || e.code === "KeyD") game.keyDir = 0;
});

field.addEventListener("pointermove", e => {
  const r = field.getBoundingClientRect();
  if (!r.width) return;
  game.mouseX = clampShip((e.clientX - r.left) / r.width);
  game.mouseActive = true;
});

field.addEventListener("pointerdown", e => {
  if (e.button != null && e.button !== 0) return;
  const r = field.getBoundingClientRect();
  if (!r.width) return;
  game.mouseX = clampShip((e.clientX - r.left) / r.width);
  game.mouseActive = true;
  ensureAudio();
  if (game.running && !game.paused && !game.ended) firePulse();
});

/* ---------------- 手势光标渲染 ---------------- */
let mouseCursorX = 0.5, mouseCursorY = 0.5;
let mouseMoved = false;
window.addEventListener("pointermove", e => {
  mouseMoved = true;
  mouseCursorX = e.clientX / Math.max(1, window.innerWidth);
  mouseCursorY = e.clientY / Math.max(1, window.innerHeight);
});

function drawCursor(t, now) {
  if (!cw || !ch) return;
  cctx.clearRect(0, 0, cw, ch);

  // 游戏中飞船本身就是光标，避免双重指示
  const inPlay = game.screen === "game" && game.running && !game.paused;
  if (inPlay) return;

  const handSeen = handCursor.seenAt > 0 && now - handCursor.seenAt < CONFIG.handTimeoutMs;
  // 还没有任何输入时不要凭空画一个十字准星
  if (!handSeen && !mouseMoved) return;

  let cx, cy;
  if (handSeen) {
    cx = handCursor.x * cw;
    cy = handCursor.y * ch;
  } else {
    cx = mouseCursorX * cw;
    cy = mouseCursorY * ch;
  }

  const isClosed = handCursor.closed && handSeen;
  const r = isClosed ? 22 : 18;

  cctx.save();
  cctx.shadowColor = isClosed ? "rgba(255,90,120,0.85)" : "rgba(62,230,255,0.85)";
  cctx.shadowBlur = 20;

  cctx.strokeStyle = isClosed ? "#ff5a78" : "#3ee6ff";
  cctx.lineWidth = 2.5;
  cctx.beginPath();
  cctx.arc(cx, cy, r, 0, TAU);
  cctx.stroke();

  cctx.lineWidth = 1.5;
  cctx.beginPath();
  cctx.moveTo(cx - r - 10, cy); cctx.lineTo(cx - r * 0.55, cy);
  cctx.moveTo(cx + r + 10, cy); cctx.lineTo(cx + r * 0.55, cy);
  cctx.moveTo(cx, cy - r - 10); cctx.lineTo(cx, cy - r * 0.55);
  cctx.moveTo(cx, cy + r + 10); cctx.lineTo(cx, cy + r * 0.55);
  cctx.stroke();

  cctx.fillStyle = isClosed ? "#ff8fa0" : "#bff4ff";
  cctx.beginPath();
  cctx.arc(cx, cy, 3.5, 0, TAU);
  cctx.fill();

  if (isClosed) {
    cctx.shadowBlur = 0;
    cctx.strokeStyle = "#fff";
    cctx.lineWidth = 2;
    cctx.beginPath();
    const d = r * 0.45;
    cctx.moveTo(cx - d, cy - d); cctx.lineTo(cx + d, cy + d);
    cctx.moveTo(cx + d, cy - d); cctx.lineTo(cx - d, cy + d);
    cctx.stroke();
  }

  cctx.restore();
}

/* 切到后台自动暂停 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden && game.running && !game.paused) togglePause();
});

window.addEventListener("resize", () => {
  resizeBG();
  resizeCursorLayer();
  resizeHome();
  if (game.screen === "game") resizeField();
});

/* 首次交互解锁音频 */
let audioPrimed = false;
function primeAudioOnce() {
  if (audioPrimed) return;
  audioPrimed = true;
  ensureAudio();
}
window.addEventListener("pointerdown", primeAudioOnce, { once: true });
window.addEventListener("keydown", primeAudioOnce, { once: true });

/* ---------------- 主循环 ---------------- */
let lastFrame = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  detect(now);
  drawBG(t);

  if (game.screen === "game") {
    update(dt, now, t);
    drawField(t, dt);
    if (game.running) {
      syncPulseUI(false);
      syncHUD(false);
    }
  } else if (game.screen === "home") {
    drawHome(t);
  }

  drawCursor(t, now);
  requestAnimationFrame(loop);
}

/* ---------------- 启动 ---------------- */
resizeBG();
resizeCursorLayer();
resizeHome();
loadProgress();
buildLevelGrid();
prepareLevel(1);
showScreen("home");
setBtnCam();
requestAnimationFrame(loop);

/* 首次交互后再请求摄像头：授权框不会打断开局，也不影响纯键鼠游玩 */
window.addEventListener("pointerdown", () => {
  if (gestureEnabled) initGesture();
}, { once: true });
