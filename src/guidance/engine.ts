// 引导状态机引擎：把摄像头、抽帧、定位/颜色适配、方向校准、语音调度串成一条闭环。
// 页面组件只读快照、调用 start/pause/resume/stop/repeat 等动作，不直接碰网络与坐标换算。

import { CONFIG } from '../config';
import type { ApiMode } from '../config';
import { getLocalVisionStatus, locateTarget, recognizeColor } from '../api/client';
import { ApiError } from '../shared/types';
import type { ColorResponse, LocateResponse, TargetBox, TargetState } from '../shared/types';
import { CameraError, CameraSession } from '../camera/cameraSession';
import type { CameraErrorKind, CameraStatus } from '../camera/cameraSession';
import { captureFrame } from '../camera/frameSampler';
import type { CapturedFrame } from '../camera/frameSampler';
import {
  DirectionCalibrator,
  EMPTY_MAPPING,
  boxCenter,
  imageDeltaToUserDirections,
  isCalibrated,
} from '../direction/directionMapping';
import type { DirectionMapping } from '../direction/directionMapping';
import { MSG } from './messages';
import { SpeechDispatcher } from '../speech/speechDispatcher';
import type { SpeechChannel } from '../speech/speechDispatcher';
import { setMockScenario } from '../api/mockScenario';
import type { MockScenarioId } from '../api/mockScenario';

export type Phase =
  | 'idle' // 未启动
  | 'awaiting_permission' // 等待授权
  | 'preparing' // 背景校准（本地模式采集基准背景）
  | 'searching' // 寻找目标
  | 'adjusting' // 调整位置（含校准）
  | 'hold_steady' // 保持稳定
  | 'recognizing' // 识别颜色
  | 'announced' // 结果已播报
  | 'paused' // 暂停
  | 'error'; // 错误

export interface AnnouncedResult {
  objectName: string | null;
  primaryColor: string;
  secondaryColors: string[];
  pattern: string;
  message: string;
  announcedAt: number;
}

export interface HistoryItem {
  time: number;
  text: string;
  primaryColor: string;
  objectName: string | null;
}

export interface EngineSnapshot {
  phase: Phase;
  guidanceText: string;
  cameraStatus: CameraStatus;
  cameraErrorKind: CameraErrorKind | null;
  apiMode: ApiMode;
  isMock: boolean;
  /** 本地模式基准背景采集进度 0~1。 */
  baselineProgress: number;
  mockScenario: MockScenarioId;
  degraded: boolean;
  calibrated: boolean;
  calibratingStep: 'right' | 'up' | null;
  /** 最近一次新鲜定位的目标框（原始图像坐标），仅用于叠加显示。 */
  lastBox: TargetBox | null;
  targetState: TargetState | null;
  result: AnnouncedResult | null;
  /** true = 结果已失效，界面必须标注“上次结果”。 */
  resultStale: boolean;
  history: HistoryItem[];
  readerLiveText: string;
  chineseVoiceAvailable: boolean;
  speechChannel: SpeechChannel;
  serviceDown: boolean;
}

interface StabilitySample {
  cx: number;
  cy: number;
  colorReady: boolean;
}

interface ColorEpisode {
  id: number;
  sessionId: string;
  capturedAt: number;
  box: TargetBox;
  invalid: boolean;
}

const IDLE_TEXT = '点击“开始识别”，然后按语音提示操作。';

export class GuidanceEngine {
  private readonly camera = new CameraSession();
  private readonly speech = new SpeechDispatcher();
  private readonly calibrator = new DirectionCalibrator();

  private video: HTMLVideoElement | null = null;
  private sessionId: string | null = null;
  private frameId = 0;

  private loopTimer: number | null = null;
  private sampling = false;

  private locateAbort: AbortController | null = null;
  private locateInflight = false;
  private colorAbort: AbortController | null = null;
  private colorEpisode: ColorEpisode | null = null;
  private episodeSeq = 0;
  private colorCooldownUntil = 0;

  private mapping: DirectionMapping = { ...EMPTY_MAPPING };
  private calibrationCooldownUntil = 0;

  private stability: StabilitySample[] = [];
  private latencyWindow: number[] = [];
  private lastAdviceKey = '';
  private lastAdviceCount = 0;
  private centeredX = true;
  private centeredY = true;
  private consecutiveLocateErrors = 0;
  private announcedLostRun = 0;
  private announcedBox: TargetBox | null = null;

  private snapshot: EngineSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.snapshot = this.buildSnapshot('idle', IDLE_TEXT, 'idle');
    this.speech.onReaderText = (text) => {
      this.snapshot = { ...this.snapshot, readerLiveText: text };
      this.emit();
    };
    this.speech.onVoiceAvailability = (available) => {
      this.snapshot = { ...this.snapshot, chineseVoiceAvailable: available };
      this.emit();
    };
    this.camera.setOnEnded(() => {
      // 设备被拔出或系统回收
      this.haltSampling();
      this.camera.stop();
      this.snapshot = {
        ...this.snapshot,
        cameraStatus: 'error',
        cameraErrorKind: 'unknown',
        lastBox: null,
      };
      this.say(MSG.cameraEnded);
      this.setPhase('error');
    });
    document.addEventListener('visibilitychange', () => {
      // 页面隐藏：暂停分析，作废旧提示（pause 会停掉语音与在途请求）。
      if (document.hidden && this.sampling) {
        this.pause();
      }
    });
    window.addEventListener('pagehide', () => this.stop());
  }

  // ---------- 对外订阅 ----------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(
    phase: Phase,
    guidanceText: string,
    cameraStatus: CameraStatus,
  ): EngineSnapshot {
    return {
      phase,
      guidanceText,
      cameraStatus,
      cameraErrorKind: null,
      apiMode: CONFIG.apiMode,
      isMock: CONFIG.apiMode === 'mock',
      baselineProgress: 0,
      mockScenario: 'normal',
      degraded: false,
      calibrated: false,
      calibratingStep: null,
      lastBox: null,
      targetState: null,
      result: null,
      resultStale: false,
      history: [],
      readerLiveText: '',
      chineseVoiceAvailable: this.speech.chineseVoiceAvailable,
      speechChannel: this.speech.currentChannel,
      serviceDown: false,
    };
  }

  // ---------- 生命周期动作 ----------

  attachVideo(video: HTMLVideoElement | null): void {
    if (video) {
      this.video = video;
      this.camera.attach(video);
    } else if (this.video) {
      this.camera.detach(this.video);
      this.video = null;
    }
  }

  async start(): Promise<void> {
    if (this.sampling || this.snapshot.phase === 'awaiting_permission') return;

    // 重新开始：新 session，旧状态全部作废。
    this.haltSampling();
    this.sessionId = crypto.randomUUID();
    this.frameId = 0;
    this.resetGuidanceState();
    this.snapshot = this.buildSnapshot('awaiting_permission', MSG.waitingPermission, 'requesting');
    this.snapshot = { ...this.snapshot, isMock: CONFIG.apiMode === 'mock' };
    this.emit();

    try {
      await this.camera.start();
    } catch (err) {
      const kind = err instanceof CameraError ? err.kind : 'unknown';
      this.snapshot = { ...this.snapshot, cameraStatus: 'error', cameraErrorKind: kind };
      this.say(cameraErrorMessage(kind));
      this.setPhase('error');
      return;
    }

    this.snapshot = { ...this.snapshot, cameraStatus: 'ready' };
    this.sampling = true;
    if (CONFIG.apiMode === 'local') {
      // 本地真实模式：先采集基准背景，再开始引导。
      this.say(MSG.prepareBackground);
      this.setPhase('preparing');
    } else {
      const intro = CONFIG.apiMode === 'mock' ? `${MSG.intro}${MSG.introMockSuffix}` : MSG.intro;
      this.say(intro);
      this.setPhase('searching');
    }
    this.startLoop();
  }

  pause(): void {
    if (!this.sampling) return;
    this.sampling = false;
    this.haltInFlight();
    this.speech.stop(); // 暂停即停止播报，待播报内容作废
    this.setGuidanceText(MSG.paused);
    this.setPhase('paused');
  }

  resume(): void {
    if (this.snapshot.phase !== 'paused') return;
    this.resetStability();
    this.setGuidanceText(MSG.noTarget);
    this.setPhase('searching');
    this.sampling = true;
    this.startLoop();
  }

  stop(): void {
    const wasActive =
      this.sampling || this.snapshot.phase === 'paused' || this.snapshot.phase === 'awaiting_permission';
    this.sampling = false;
    this.haltInFlight();
    this.camera.stop();
    this.speech.stop();
    this.sessionId = null;
    this.resetGuidanceState();
    if (wasActive) {
      this.snapshot = this.buildSnapshot('idle', IDLE_TEXT, 'idle');
      this.setGuidanceText(MSG.stopped);
    } else {
      this.snapshot = this.buildSnapshot('idle', IDLE_TEXT, 'idle');
    }
    this.emit();
  }

  repeatSpeech(): void {
    this.speech.repeat();
  }

  setSpeechChannel(channel: SpeechChannel): void {
    this.speech.setChannel(channel);
    this.snapshot = { ...this.snapshot, speechChannel: channel };
    this.emit();
  }

  chooseMockScenario(scenario: MockScenarioId): void {
    setMockScenario(scenario);
    this.snapshot = { ...this.snapshot, mockScenario: scenario };
    this.emit();
  }

  // ---------- 采样闭环 ----------

  private startLoop(): void {
    if (this.loopTimer !== null) return;
    this.loopTimer = window.setTimeout(() => void this.loopTick(), 0);
  }

  private stopLoop(): void {
    if (this.loopTimer !== null) {
      window.clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  private async loopTick(): Promise<void> {
    this.loopTimer = null;
    if (!this.sampling || !this.sessionId) return;

    // 同时最多一个定位请求：上一个未完成就跳过本次，不堆积旧帧。
    if (this.locateInflight) {
      this.scheduleNextTick();
      return;
    }
    const video = this.video;
    if (!video) {
      this.scheduleNextTick();
      return;
    }
    let frame: CapturedFrame | null = null;
    try {
      frame = await captureFrame(video);
    } catch {
      frame = null;
    }
    if (!frame) {
      // 视频未就绪：跳过本次，稍后重试。
      this.scheduleNextTick();
      return;
    }

    this.frameId += 1;
    const sessionId = this.sessionId;
    const frameId = this.frameId;
    const controller = new AbortController();
    this.locateAbort = controller;
    this.locateInflight = true;
    try {
      const res = await locateTarget({
        image: frame.blob,
        sessionId,
        frameId,
        capturedAt: frame.capturedAt,
        signal: controller.signal,
      });
      this.handleLocateResponse(res, frame.blob);
    } catch (err) {
      this.handleLocateError(err);
    } finally {
      this.locateInflight = false;
      this.locateAbort = null;
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    if (!this.sampling || this.loopTimer !== null) return;
    this.loopTimer = window.setTimeout(() => void this.loopTick(), CONFIG.locateIntervalMs);
  }

  private haltInFlight(): void {
    this.stopLoop();
    this.locateAbort?.abort();
    this.locateAbort = null;
    this.colorAbort?.abort();
    this.colorAbort = null;
    this.colorEpisode = null;
  }

  private haltSampling(): void {
    this.sampling = false;
    this.haltInFlight();
    this.speech.stop();
  }

  private resetGuidanceState(): void {
    this.mapping = { ...EMPTY_MAPPING };
    this.calibrationCooldownUntil = 0;
    this.colorCooldownUntil = 0;
    this.resetStability();
    this.latencyWindow = [];
    this.lastAdviceKey = '';
    this.lastAdviceCount = 0;
    this.consecutiveLocateErrors = 0;
    this.announcedLostRun = 0;
    this.announcedBox = null;
  }

  private resetStability(): void {
    this.stability = [];
  }

  // ---------- 定位结果处理 ----------

  private handleLocateResponse(res: LocateResponse, imageBlob: Blob): void {
    if (!this.sampling || res.sessionId !== this.sessionId) return;

    if (this.consecutiveLocateErrors > 0) {
      this.consecutiveLocateErrors = 0;
      if (this.snapshot.serviceDown) {
        this.snapshot = { ...this.snapshot, serviceDown: false };
        this.say(MSG.locateServiceRecovered);
      }
    }

    const age = Date.now() - res.capturedAt;
    this.pushLatency(age);
    this.updateDegraded();

    const fresh = age <= CONFIG.locateResultMaxAgeMs;

    // 可视化叠加只反映新鲜结果；过期定位不更新画面框，也不驱动引导。
    if (fresh) {
      this.snapshot = {
        ...this.snapshot,
        lastBox: res.targetState === 'single' ? res.targetBox : null,
        targetState: res.targetState,
      };
    } else {
      this.snapshot = { ...this.snapshot, lastBox: null };
      this.emit();
      return;
    }

    // 本地模式：基准背景未就绪时，只做背景校准，不进入目标引导。
    // 基准在会话内冻结（开始识别时采集）；背景剧变不再触发运行中重校准。
    if (CONFIG.apiMode === 'local' && this.sessionId) {
      const status = getLocalVisionStatus(this.sessionId);
      if (status) {
        if (!status.baselineReady) {
          if (status.baselineProgress !== this.snapshot.baselineProgress) {
            this.snapshot = { ...this.snapshot, baselineProgress: status.baselineProgress };
          }
          this.setGuidanceText(MSG.preparingBackground);
          this.setPhase('preparing');
          this.emit();
          return;
        }
        if (this.snapshot.phase === 'preparing') {
          this.snapshot = { ...this.snapshot, baselineProgress: 1 };
          this.say(MSG.backgroundReady);
          this.setPhase('searching');
        }
      }
    }

    // 校准进行中：优先观察校准，其它引导暂停。
    if (this.calibrator.running) {
      if (res.targetState !== 'single' || !res.targetBox) {
        this.onCalibrationFailed();
      } else {
        const event = this.calibrator.observe(res.targetBox);
        if (event?.type === 'step-started') {
          this.snapshot = { ...this.snapshot, calibratingStep: event.step };
          this.say(MSG.calibrateUp);
        } else if (event?.type === 'completed') {
          this.mapping = event.mapping;
          this.snapshot = {
            ...this.snapshot,
            calibrated: true,
            calibratingStep: null,
          };
          this.say(MSG.calibrateDone);
        } else if (event?.type === 'failed') {
          this.onCalibrationFailed();
        }
      }
      this.emit();
      return;
    }

    // 已播报结果的失效判断（目标丢失/显著移动）。
    this.checkResultInvalidation(res);
    // 进行中的颜色识别是否仍对应当前画面。
    this.checkColorEpisodeValidity(res);

    if (res.targetState === 'single' && res.targetBox) {
      this.pushStability(res.targetBox, res.colorReady);
    } else {
      this.resetStability();
    }

    this.applyLocateGuidance(res);
    this.maybeTriggerColor(res, imageBlob);
    this.emit();
  }

  private applyLocateGuidance(res: LocateResponse): void {
    // 暗光/反光与目标有无无关，优先提示。
    if (res.quality === 'too_dark') {
      this.setPhase('adjusting');
      this.say(MSG.tooDark);
      return;
    }
    if (res.quality === 'glare') {
      this.setPhase('adjusting');
      this.say(MSG.glare);
      return;
    }

    switch (res.targetState) {
      case 'none':
        this.setPhase('searching');
        this.say(MSG.noTarget);
        return;
      case 'multiple':
        this.setPhase('adjusting');
        this.say(MSG.multiple);
        return;
      case 'uncertain':
        this.setPhase('adjusting');
        this.say(MSG.uncertain);
        return;
      case 'single':
        break;
    }
    const box = res.targetBox;
    if (!box) return;

    // 结果已播报且仍有效、目标稳定：保持安静，不重复提示，等待目标变化。
    if (
      this.snapshot.phase === 'announced' &&
      !this.snapshot.resultStale &&
      res.colorReady &&
      this.isRoughlyStable()
    ) {
      return;
    }

    // 明显移动优先于位置调整（暗光/反光已在上方处理）。
    if (res.quality === 'blurred') {
      this.setPhase('adjusting');
      this.say(MSG.blurred);
      return;
    }

    // 降级模式：定位持续过慢时，不再做实时指路，只做停稳后分析。
    if (this.snapshot.degraded) {
      if (res.colorReady) {
        this.setPhase('hold_steady');
        this.say(MSG.holdSteady);
      } else {
        this.setPhase('adjusting');
        this.say(MSG.blurred);
      }
      return;
    }

    if (res.framing === 'too_small') {
      this.setPhase('adjusting');
      this.say(MSG.tooSmall);
      return;
    }

    // 未确认方向映射：目标大致稳定时发起一次简短校准。
    if (!isCalibrated(this.mapping)) {
      if (Date.now() >= this.calibrationCooldownUntil && this.isRoughlyStable()) {
        const event = this.calibrator.begin(box);
        if (event.type === 'step-started') {
          this.snapshot = { ...this.snapshot, calibratingStep: event.step };
          this.setPhase('adjusting');
          this.say(MSG.calibrateRight);
          return;
        }
      }
      // 校准冷却中或目标还不够稳：只给不含左右方向的提示。
      if (res.colorReady) {
        this.setPhase('hold_steady');
        this.say(MSG.holdSteady);
      } else {
        this.setPhase('adjusting');
        this.say(this.centeringAdvice(box, true));
      }
      return;
    }

    // 居中判断（带滞回），一次只提示一个方向。
    const { cx, cy } = boxCenter(box);
    const offX = CONFIG.guide.centerX - cx; // >0：框需向图像右侧移动
    const offY = CONFIG.guide.centerY - cy;
    const tol = CONFIG.guide.centerTolerance;
    const hys = CONFIG.guide.hysteresis;
    if (this.centeredX && Math.abs(offX) > tol + hys) this.centeredX = false;
    if (!this.centeredX && Math.abs(offX) < tol) this.centeredX = true;
    if (this.centeredY && Math.abs(offY) > tol + hys) this.centeredY = false;
    if (!this.centeredY && Math.abs(offY) < tol) this.centeredY = true;

    if (!this.centeredX || !this.centeredY) {
      const advice = this.centeringAdvice(box, false);
      if (advice === this.lastAdviceKey) {
        this.lastAdviceCount += 1;
      } else {
        this.lastAdviceKey = advice;
        this.lastAdviceCount = 1;
      }
      // 连续一致才播报，避免左右反复跳变。
      if (this.lastAdviceCount >= CONFIG.direction.confirmCount) {
        this.say(advice);
      } else {
        this.setGuidanceText(advice);
      }
      this.setPhase('adjusting');
      return;
    }
    this.lastAdviceKey = '';
    this.lastAdviceCount = 0;

    if (res.colorReady) {
      this.setPhase('hold_steady');
      this.say(MSG.holdSteady);
    } else {
      // 已居中但后端认为还不够识别条件：不苛求继续移动，只请用户保持。
      this.setPhase('adjusting');
      this.say(MSG.blurred);
    }
  }

  /**
   * 生成居中提示。方向严格经过 DirectionMapping 换算；
   * 未校准的轴退回不含方向的中性提示。
   */
  private centeringAdvice(box: TargetBox, horizontalOnly: boolean): string {
    const { cx, cy } = boxCenter(box);
    const offX = CONFIG.guide.centerX - cx;
    const offY = CONFIG.guide.centerY - cy;
    const pickHorizontal = horizontalOnly || Math.abs(offX) >= Math.abs(offY);
    if (pickHorizontal) {
      const { horizontal } = imageDeltaToUserDirections(offX, 0, this.mapping);
      if (horizontal === 'left') return MSG.moveLeft;
      if (horizontal === 'right') return MSG.moveRight;
      return MSG.croppedGeneric;
    }
    const { vertical } = imageDeltaToUserDirections(0, offY, this.mapping);
    if (vertical === 'up') return MSG.moveUp;
    if (vertical === 'down') return MSG.moveDown;
    return MSG.croppedGeneric;
  }

  // ---------- 稳定性与颜色识别 ----------

  private pushStability(box: TargetBox, colorReady: boolean): void {
    const { cx, cy } = boxCenter(box);
    this.stability.push({ cx, cy, colorReady });
    while (this.stability.length > CONFIG.stability.windowSize) {
      this.stability.shift();
    }
  }

  private isRoughlyStable(): boolean {
    return this.computeStable(false);
  }

  private isStableAndReady(): boolean {
    return this.computeStable(true);
  }

  private computeStable(requireColorReady: boolean): boolean {
    // 只看最近 N 个样本，避免早期未就绪样本拖慢稳定判定。
    const samples = this.stability.slice(-CONFIG.stability.minStableSamples);
    if (samples.length < CONFIG.stability.minStableSamples) return false;
    let minCx = Number.POSITIVE_INFINITY;
    let maxCx = Number.NEGATIVE_INFINITY;
    let minCy = Number.POSITIVE_INFINITY;
    let maxCy = Number.NEGATIVE_INFINITY;
    for (const s of samples) {
      if (requireColorReady && !s.colorReady) return false;
      if (s.cx < minCx) minCx = s.cx;
      if (s.cx > maxCx) maxCx = s.cx;
      if (s.cy < minCy) minCy = s.cy;
      if (s.cy > maxCy) maxCy = s.cy;
    }
    return (
      maxCx - minCx <= CONFIG.stability.positionEpsilon &&
      maxCy - minCy <= CONFIG.stability.positionEpsilon
    );
  }

  private maybeTriggerColor(res: LocateResponse, imageBlob: Blob): void {
    if (this.colorEpisode) return; // 同时最多一个颜色请求
    if (Date.now() < this.colorCooldownUntil) return;
    // 已播报且未失效的稳定结果不重复识别；目标变化导致失效后会重新触发。
    if (this.snapshot.phase === 'announced' && !this.snapshot.resultStale) return;
    if (res.targetState !== 'single' || !res.targetBox || !res.colorReady) return;
    if (!this.isStableAndReady()) return;
    if (!this.sessionId) return;

    const sessionId = this.sessionId;
    const episode: ColorEpisode = {
      id: ++this.episodeSeq,
      sessionId,
      capturedAt: res.capturedAt,
      box: res.targetBox,
      invalid: false,
    };
    this.colorEpisode = episode;
    const controller = new AbortController();
    this.colorAbort = controller;
    this.setPhase('recognizing');
    this.say(MSG.recognizing);

    recognizeColor({
      image: imageBlob,
      sessionId,
      frameId: res.frameId,
      capturedAt: res.capturedAt,
      targetBox: res.targetBox,
      signal: controller.signal,
    })
      .then((r) => this.handleColorResponse(r, episode))
      .catch((err) => this.handleColorError(err, episode));
  }

  /** 颜色请求发出后，后续定位若显示目标丢失/明显移动，则该次识别作废。 */
  private checkColorEpisodeValidity(res: LocateResponse): void {
    const episode = this.colorEpisode;
    if (!episode) return;
    if (res.targetState !== 'single' || !res.targetBox) {
      episode.invalid = true;
      return;
    }
    const a = boxCenter(episode.box);
    const b = boxCenter(res.targetBox);
    const moved = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    if (moved > CONFIG.invalidation.significantMove) {
      episode.invalid = true;
    }
  }

  private handleColorResponse(res: ColorResponse, episode: ColorEpisode): void {
    this.colorAbort = null;
    if (this.colorEpisode?.id === episode.id) {
      this.colorEpisode = null;
    }
    // 过期/作废校验：session 不符、期间目标丢失或移动、已暂停、结果太老 → 丢弃。
    if (!this.sampling) return;
    if (res.sessionId !== this.sessionId || episode.sessionId !== this.sessionId) return;
    if (episode.invalid) return;
    if (Date.now() - episode.capturedAt > CONFIG.colorResultMaxAgeMs) return;

    if (res.status !== 'ok' || !res.result) {
      this.colorCooldownUntil = Date.now() + 1500;
      this.setPhase('adjusting');
      this.say(res.retryAdvice ?? res.message ?? MSG.colorFailed);
      return;
    }

    const prev = this.snapshot.result;
    const sameAsBefore =
      prev !== null &&
      !this.snapshot.resultStale &&
      prev.primaryColor === res.result.primaryColor &&
      prev.objectName === res.result.objectName;

    const result: AnnouncedResult = {
      objectName: res.result.objectName,
      primaryColor: res.result.primaryColor,
      secondaryColors: res.result.secondaryColors,
      pattern: res.result.pattern,
      message: res.message,
      announcedAt: Date.now(),
    };
    this.announcedBox = episode.box;
    this.announcedLostRun = 0;

    const history = [
      {
        time: result.announcedAt,
        text: res.message,
        primaryColor: result.primaryColor,
        objectName: result.objectName,
      },
      ...this.snapshot.history,
    ].slice(0, 5);

    this.snapshot = { ...this.snapshot, result, resultStale: false, history };
    this.setPhase('announced');
    // 颜色稳定不变时只播报一次。
    if (sameAsBefore) {
      this.setGuidanceText(res.message);
    } else {
      this.say(res.message);
    }
  }

  private handleColorError(err: unknown, episode: ColorEpisode): void {
    this.colorAbort = null;
    if (this.colorEpisode?.id === episode.id) {
      this.colorEpisode = null;
    }
    if (err instanceof ApiError && err.code === 'ABORTED') return;
    if (!this.sampling) return;
    this.colorCooldownUntil = Date.now() + 1500;
    this.setPhase('adjusting');
    this.say(MSG.colorFailed);
  }

  // ---------- 失效与降级 ----------

  private checkResultInvalidation(res: LocateResponse): void {
    const snapshot = this.snapshot;
    if (!snapshot.result || snapshot.resultStale) return;

    let invalidate = false;
    if (res.targetState !== 'single' || !res.targetBox) {
      this.announcedLostRun += 1;
      if (this.announcedLostRun >= CONFIG.invalidation.lostFrames) invalidate = true;
    } else {
      this.announcedLostRun = 0;
      if (this.announcedBox) {
        const a = boxCenter(this.announcedBox);
        const b = boxCenter(res.targetBox);
        if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > CONFIG.invalidation.significantMove) {
          invalidate = true;
        }
      }
    }

    if (invalidate) {
      // 结果失效：界面标注“上次结果”，不再当作当前物品的实时颜色。
      this.snapshot = { ...this.snapshot, resultStale: true };
      if (res.targetState !== 'single') {
        this.setPhase('searching');
      }
    }
  }

  private pushLatency(age: number): void {
    this.latencyWindow.push(age);
    while (this.latencyWindow.length > CONFIG.degraded.windowSize) {
      this.latencyWindow.shift();
    }
  }

  private updateDegraded(): void {
    const w = this.latencyWindow;
    if (w.length < CONFIG.degraded.minSamples) return;
    let stale = 0;
    for (const age of w) {
      if (age > CONFIG.locateResultMaxAgeMs) stale += 1;
    }
    const ratio = stale / w.length;
    if (!this.snapshot.degraded && ratio >= CONFIG.degraded.staleRatioEnter) {
      this.snapshot = { ...this.snapshot, degraded: true };
      this.say(MSG.degradedEnter);
    } else if (this.snapshot.degraded && ratio <= CONFIG.degraded.staleRatioExit) {
      this.snapshot = { ...this.snapshot, degraded: false };
      this.say(MSG.degradedExit);
    }
  }

  private handleLocateError(err: unknown): void {
    if (err instanceof ApiError && err.code === 'ABORTED') return;
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (!this.sampling) return;
    this.consecutiveLocateErrors += 1;
    if (this.consecutiveLocateErrors >= 3 && !this.snapshot.serviceDown) {
      this.snapshot = { ...this.snapshot, serviceDown: true };
      this.say(MSG.locateServiceDown);
    }
    this.emit();
  }

  private onCalibrationFailed(): void {
    this.snapshot = { ...this.snapshot, calibratingStep: null };
    this.calibrationCooldownUntil = Date.now() + CONFIG.direction.calibrationCooldownMs;
    this.say(MSG.calibrateFailed);
  }

  // ---------- 播报与快照 ----------

  /** 所有提示统一入口：更新界面文字 + 交给语音调度（节流/取消）。 */
  private say(text: string): void {
    this.setGuidanceText(text);
    this.speech.speak(text);
  }

  private setGuidanceText(text: string): void {
    if (this.snapshot.guidanceText === text) return;
    this.snapshot = { ...this.snapshot, guidanceText: text };
    this.emit();
  }

  private setPhase(phase: Phase): void {
    if (this.snapshot.phase === phase) return;
    this.snapshot = { ...this.snapshot, phase };
    this.emit();
  }
}

function cameraErrorMessage(kind: CameraErrorKind): string {
  switch (kind) {
    case 'denied':
      return MSG.cameraDenied;
    case 'not_found':
      return MSG.cameraNotFound;
    case 'busy':
      return MSG.cameraBusy;
    case 'not_ready':
      return MSG.cameraNotReady;
    case 'unknown':
      return MSG.cameraUnknown;
  }
}
