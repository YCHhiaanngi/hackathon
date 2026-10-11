// 本地视觉核心的合成图验证：node（经 tsx）直跑，不依赖摄像头与浏览器。
// 运行：npm run test:local
// 覆盖：基准采集、单目标定位、基础颜色、多色不均混、多候选、目标消失、
// 基准冻结（停稳不消失）、深色/纯色质量判断、过小/靠边、背景失效、同帧掩膜、耗时。

import { CONFIG } from '../src/config';
import { createLocalSession, locateRaster, recognizeRaster } from '../src/local/localVision';
import type { LocalSession } from '../src/local/localVision';
import { addNoise, fillRect, solidRaster } from '../src/local/imageUtils';
import type { Raster } from '../src/local/imageUtils';

const W = 640;
const H = 480;
const BG: [number, number, number] = [200, 200, 200];

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

function bg(): Raster {
  const r = solidRaster(W, H, BG);
  addNoise(r, 4);
  return r;
}

let seq = 0;
function ids(sessionId: string) {
  seq += 1;
  return { sessionId, frameId: seq, capturedAt: Date.now() };
}

/** 新会话并喂满基准帧。 */
function sessionWithBaseline(): LocalSession {
  const s = createLocalSession(`test-${Math.random()}`);
  for (let i = 0; i < CONFIG.localVision.baselineFrames + 1; i++) {
    locateRaster(s, bg(), ids(s.sessionId));
  }
  return s;
}

/** 在背景上放一块矩形“衣物”。 */
function frameWithRect(
  color: [number, number, number],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Raster {
  const r = bg();
  fillRect(r, x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H, color);
  return r;
}

// ---------- 1. 基准采集与空画面 ----------
{
  const s = createLocalSession('t1');
  let last = locateRaster(s, bg(), ids('t1'));
  check('基准采集中返回 none', last.targetState === 'none');
  for (let i = 0; i < CONFIG.localVision.baselineFrames + 1; i++) {
    last = locateRaster(s, bg(), ids('t1'));
  }
  check('空画面（与基准一致）返回 none', last.targetState === 'none', `state=${last.targetState}`);
}

// ---------- 2. 单目标定位：框随内容变化且位置正确 ----------
{
  const s = sessionWithBaseline();
  // 衣物在图像右下区域
  const f = frameWithRect([220, 30, 30], 0.55, 0.45, 0.85, 0.85);
  const res = locateRaster(s, f, ids(s.sessionId));
  check('检测到单个目标', res.targetState === 'single');
  const box = res.targetBox;
  check('目标框非空且有效', !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1 && box.y + box.height <= 1);
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    check('目标框中心接近真实位置（右下）', Math.abs(cx - 0.7) < 0.08 && Math.abs(cy - 0.65) < 0.08,
      `cx=${cx.toFixed(2)} cy=${cy.toFixed(2)}`);
    check('目标可识别（colorReady）', res.colorReady, `quality=${res.quality} framing=${res.framing}`);
  }

  // 同一目标换到左上 → 框跟着变
  const f2 = frameWithRect([220, 30, 30], 0.1, 0.1, 0.35, 0.4);
  const res2 = locateRaster(s, f2, ids(s.sessionId));
  const box2 = res2.targetBox;
  check('目标移动后框跟着变（左上）', !!box2 && box2.x + box2.width / 2 < 0.3 && box2.y + box2.height / 2 < 0.35,
    box2 ? `cx=${(box2.x + box2.width / 2).toFixed(2)}` : 'null');
}

// ---------- 3. 基础颜色：红/绿/蓝/黑/白/灰 ----------
const COLOR_CASES: Array<{ name: string; rgb: [number, number, number]; expect: string }> = [
  { name: '红色', rgb: [220, 30, 30], expect: '红' },
  { name: '绿色', rgb: [30, 160, 60], expect: '绿' },
  { name: '蓝色', rgb: [30, 60, 200], expect: '蓝' },
  { name: '黑色', rgb: [25, 25, 25], expect: '黑' },
  { name: '白色', rgb: [245, 245, 245], expect: '白' },
  { name: '灰色', rgb: [120, 120, 120], expect: '灰' },
];
for (const c of COLOR_CASES) {
  const s = sessionWithBaseline();
  const f = frameWithRect(c.rgb, 0.35, 0.3, 0.65, 0.75);
  const loc = locateRaster(s, f, ids(s.sessionId));
  const rec = recognizeRaster(s, f, ids(s.sessionId), loc.targetBox ?? { x: 0.35, y: 0.3, width: 0.3, height: 0.45 });
  check(`颜色识别：${c.name}`, rec.status === 'ok' && rec.result?.primaryColor === c.expect,
    `got=${rec.result?.primaryColor ?? rec.message}`);
}

// ---------- 4. 多色区域不被平均成不存在的颜色 ----------
{
  const s = sessionWithBaseline();
  const r = bg();
  fillRect(r, 0.35 * W, 0.3 * H, 0.15 * W, 0.45 * H, [220, 30, 30]); // 左半红
  fillRect(r, 0.5 * W, 0.3 * H, 0.15 * W, 0.45 * H, [30, 60, 200]); // 右半蓝
  const loc = locateRaster(s, r, ids(s.sessionId));
  const rec = recognizeRaster(s, r, ids(s.sessionId), loc.targetBox ?? { x: 0.35, y: 0.3, width: 0.3, height: 0.45 });
  const primary = rec.result?.primaryColor;
  const secondary = rec.result?.secondaryColors ?? [];
  check('红蓝各半：主色是红或蓝', primary === '红' || primary === '蓝', `primary=${primary}`);
  check('红蓝各半：另一色进入次要颜色', secondary.includes('红') || secondary.includes('蓝'),
    `secondary=${secondary.join('/')}`);
  check('红蓝各半：不混成紫色', primary !== '紫' && !secondary.includes('紫'));
}

// ---------- 5. 多候选 ----------
{
  const s = sessionWithBaseline();
  const r = bg();
  fillRect(r, 0.1 * W, 0.3 * H, 0.15 * W, 0.4 * H, [220, 30, 30]);
  fillRect(r, 0.7 * W, 0.3 * H, 0.15 * W, 0.4 * H, [30, 60, 200]);
  const res = locateRaster(s, r, ids(s.sessionId));
  check('两块分离目标 → multiple', res.targetState === 'multiple', `state=${res.targetState}`);
  check('multiple 时 targetBox 为 null', res.targetBox === null);
}

// ---------- 6. 目标消失 & 基准冻结（停稳不消失） ----------
{
  const s = sessionWithBaseline();
  const f = frameWithRect([220, 30, 30], 0.4, 0.35, 0.65, 0.75);
  let last = locateRaster(s, f, ids(s.sessionId));
  // 目标停稳 12 帧：基准冻结，不能逐渐被吸收
  for (let i = 0; i < 12; i++) {
    last = locateRaster(s, f, ids(s.sessionId));
  }
  check('停稳 12 帧后目标仍存在（基准冻结）', last.targetState === 'single');
  // 目标消失
  const gone = locateRaster(s, bg(), ids(s.sessionId));
  check('目标消失后返回 none', gone.targetState === 'none');
}

// ---------- 7. 深色衣物不误判暗光；全画面变暗 → too_dark ----------
{
  const s = sessionWithBaseline();
  const f = frameWithRect([30, 30, 60], 0.4, 0.35, 0.65, 0.75); // 深藏青
  const res = locateRaster(s, f, ids(s.sessionId));
  check('深色衣物（背景正常）不判 too_dark', res.quality !== 'too_dark', `quality=${res.quality}`);

  const s2 = sessionWithBaseline();
  const dark = solidRaster(W, H, [40, 40, 40]);
  addNoise(dark, 3);
  fillRect(dark, 0.4 * W, 0.35 * H, 0.25 * W, 0.4 * H, [60, 60, 95]);
  const res2 = locateRaster(s2, dark, ids(s2.sessionId));
  check('全画面变暗 → too_dark', res2.quality === 'too_dark', `quality=${res2.quality}`);
}

// ---------- 8. 目标过小 / 靠边 ----------
{
  const s = sessionWithBaseline();
  const small = frameWithRect([220, 30, 30], 0.45, 0.4, 0.53, 0.52); // ~1% 面积
  const res = locateRaster(s, small, ids(s.sessionId));
  check('目标过小 → framing=too_small 或 none', res.framing === 'too_small' || res.targetState === 'none',
    `framing=${res.framing} state=${res.targetState}`);

  const s2 = sessionWithBaseline();
  const edge = frameWithRect([220, 30, 30], 0.0, 0.3, 0.12, 0.7); // 贴左边
  const res2 = locateRaster(s2, edge, ids(s2.sessionId));
  check('目标靠边 → framing=cropped', res2.framing === 'cropped', `framing=${res2.framing}`);
}

// ---------- 9. 背景明显变化 → 基准失效 ----------
{
  const s = sessionWithBaseline();
  let res = locateRaster(s, bg(), ids(s.sessionId));
  for (let i = 0; i < CONFIG.localVision.backgroundInvalidFrames; i++) {
    const changed = solidRaster(W, H, [90, 120, 160]); // 整个场景变了
    addNoise(changed, 3);
    res = locateRaster(s, changed, ids(s.sessionId));
  }
  check('背景剧变连续多帧 → uncertain（需重新校准）', res.targetState === 'uncertain', `state=${res.targetState}`);
}

// ---------- 10. 掩膜与目标框属于同一帧（缓存按 frameId） ----------
{
  const s = sessionWithBaseline();
  // 第 1 帧：红色目标在左
  const f1 = frameWithRect([220, 30, 30], 0.1, 0.3, 0.3, 0.7);
  const id1 = ids(s.sessionId);
  const loc1 = locateRaster(s, f1, id1);
  // 用同一帧图像 + 同一 frameId 识别 → 红
  const rec1 = recognizeRaster(s, f1, id1, loc1.targetBox!);
  check('同帧识别：红', rec1.result?.primaryColor === '红', `got=${rec1.result?.primaryColor}`);
  // 第 2 帧：目标变成绿色，识别用新帧重新差分，不套旧掩膜
  const f2 = frameWithRect([30, 160, 60], 0.1, 0.3, 0.3, 0.7);
  const id2 = ids(s.sessionId);
  const loc2 = locateRaster(s, f2, id2);
  const rec2 = recognizeRaster(s, f2, id2, loc2.targetBox!);
  check('换帧后识别新颜色：绿', rec2.result?.primaryColor === '绿', `got=${rec2.result?.primaryColor}`);
}

// ---------- 11. 耗时测量 ----------
{
  const s = sessionWithBaseline();
  const f = frameWithRect([220, 30, 30], 0.4, 0.35, 0.65, 0.75);
  const N = 30;
  const t0 = performance.now();
  let last = locateRaster(s, f, ids(s.sessionId));
  for (let i = 0; i < N; i++) last = locateRaster(s, f, ids(s.sessionId));
  const t1 = performance.now();
  const recId = ids(s.sessionId);
  const t2 = performance.now();
  for (let i = 0; i < N; i++) recognizeRaster(s, f, recId, last.targetBox!);
  const t3 = performance.now();
  const locateMs = (t1 - t0) / N;
  const colorMs = (t3 - t2) / N;
  console.log(`耗时（640×480 合成图，Node ${process.version}）：定位 ${locateMs.toFixed(1)}ms/次，颜色 ${colorMs.toFixed(1)}ms/次`);
  check('定位耗时可支撑 500ms 采样', locateMs < 100, `${locateMs.toFixed(1)}ms`);
  check('颜色识别耗时远低于定位间隔', colorMs < 100, `${colorMs.toFixed(1)}ms`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
