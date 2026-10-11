// 听见颜色 · 前端页面组装：顶部状态栏 + 左侧视频预览 + 右侧引导/结果 + 控制区。
// 所有逻辑在 GuidanceEngine 中，本组件只读快照并转发用户操作。

import { useCallback, useSyncExternalStore } from 'react';
import { GuidanceEngine } from './guidance/engine';
import type { Phase } from './guidance/engine';
import { VideoPreview } from './components/VideoPreview';
import { SidePanel } from './components/SidePanel';
import { ControlsBar } from './components/ControlsBar';
import { MOCK_SCENARIO_LABELS } from './api/mockScenario';
import type { MockScenarioId } from './api/mockScenario';
import type { SpeechChannel } from './speech/speechDispatcher';

const CAMERA_STATUS_TEXT: Record<string, string> = {
  idle: '未开启',
  requesting: '等待摄像头授权',
  ready: '已开启',
  error: '不可用',
};

const PHASE_TEXT: Record<Phase, string> = {
  idle: '未启动',
  awaiting_permission: '等待授权',
  searching: '寻找目标',
  adjusting: '调整位置',
  hold_steady: '保持稳定',
  recognizing: '识别颜色',
  announced: '结果已播报',
  paused: '已暂停',
  error: '错误',
};

// 引擎是页面级单例：模块级创建，避免 StrictMode 双渲染导致的重复全局监听。
const engine = new GuidanceEngine();

export default function App() {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  const attachVideo = useCallback((el: HTMLVideoElement | null) => engine.attachVideo(el), []);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">听见颜色</h1>
        <div className="header-status">
          <span className={`camera-dot camera-${snap.cameraStatus}`} aria-hidden="true" />
          <span>摄像头：{CAMERA_STATUS_TEXT[snap.cameraStatus] ?? snap.cameraStatus}</span>
          <span className={snap.isMock ? 'mode-badge mock' : 'mode-badge real'}>
            {snap.isMock ? '演示模式（模拟数据）' : '真实模式'}
          </span>
          <span className="phase-badge">{PHASE_TEXT[snap.phase]}</span>
          {snap.serviceDown && <span className="service-down">定位服务异常，重试中</span>}
        </div>
      </header>

      <main className="app-main">
        <VideoPreview
          attachVideo={attachVideo}
          box={snap.lastBox}
          cameraStatus={snap.cameraStatus}
          isMock={snap.isMock}
          degraded={snap.degraded}
        />
        <SidePanel
          guidanceText={snap.guidanceText}
          calibratingStep={snap.calibratingStep}
          result={snap.result}
          resultStale={snap.resultStale}
          history={snap.history}
        />
      </main>

      <footer className="app-footer">
        <ControlsBar
          phase={snap.phase}
          canRepeat={snap.guidanceText.length > 0}
          onStart={() => void engine.start()}
          onPause={() => engine.pause()}
          onResume={() => engine.resume()}
          onStop={() => engine.stop()}
          onRepeat={() => engine.repeatSpeech()}
        />

        <fieldset className="speech-channel">
          <legend>语音方式</legend>
          <label>
            <input
              type="radio"
              name="speech-channel"
              checked={snap.speechChannel === 'app'}
              onChange={() => engine.setSpeechChannel('app' satisfies SpeechChannel)}
            />
            应用语音
          </label>
          <label>
            <input
              type="radio"
              name="speech-channel"
              checked={snap.speechChannel === 'reader'}
              onChange={() => engine.setSpeechChannel('reader' satisfies SpeechChannel)}
            />
            读屏模式
          </label>
        </fieldset>

        {snap.isMock && (
          <label className="mock-scenario">
            Mock 场景：
            <select
              value={snap.mockScenario}
              onChange={(e) => engine.chooseMockScenario(e.target.value as MockScenarioId)}
            >
              {Object.entries(MOCK_SCENARIO_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </footer>

      {snap.speechChannel === 'app' && !snap.chineseVoiceAvailable && (
        <div className="voice-warning" role="alert">
          未检测到中文语音，将只显示文字提示；你也可以切换到读屏模式。
        </div>
      )}

      {/* 读屏模式专用 live 区域：应用语音模式下不更新，避免双通道。 */}
      <div className="visually-hidden" aria-live="polite">
        {snap.speechChannel === 'reader' ? snap.readerLiveText : ''}
      </div>
    </div>
  );
}
