// 右侧面板：当前引导、识别结果、最近结果。
// 引导文字使用 role="status"（aria-live polite），只在状态变化时更新，不随视频刷新。

import type { AnnouncedResult, HistoryItem, Phase } from '../guidance/engine';

interface Props {
  guidanceText: string;
  calibratingStep: 'right' | 'up' | null;
  phase: Phase;
  /** 本地模式基准背景采集进度 0~1。 */
  baselineProgress: number;
  result: AnnouncedResult | null;
  resultStale: boolean;
  history: HistoryItem[];
}

/** 常见中文颜色名 → 展示色块（纯展示，不参与识别）。 */
const COLOR_SWATCH: Record<string, string> = {
  红: '#d33',
  橙: '#e80',
  黄: '#dc2',
  绿: '#2a5',
  蓝: '#27d',
  紫: '#84c',
  黑: '#222',
  白: '#eee',
  灰: '#999',
  粉: '#e8a',
  棕: '#753',
};

function swatchFor(colorName: string): string {
  for (const [key, value] of Object.entries(COLOR_SWATCH)) {
    if (colorName.includes(key)) return value;
  }
  return '#666';
}

function formatTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function SidePanel({ guidanceText, calibratingStep, phase, baselineProgress, result, resultStale, history }: Props) {
  return (
    <aside className="side-panel">
      <section className="guidance-card" aria-label="当前引导">
        <h2 className="card-title">当前引导</h2>
        <p className="guidance-text" role="status">
          {guidanceText}
        </p>
        {phase === 'preparing' && (
          <div className="baseline-progress" aria-hidden="true">
            <div
              className="baseline-progress-fill"
              style={{ width: `${Math.round(baselineProgress * 100)}%` }}
            />
          </div>
        )}
        {calibratingStep && (
          <p className="calibrating-hint">方向校准中（{calibratingStep === 'right' ? '第 1 步，共 2 步' : '第 2 步，共 2 步'}）</p>
        )}
      </section>

      <section className="result-card" aria-label="识别结果">
        <h2 className="card-title">识别结果</h2>
        {result ? (
          <div className={resultStale ? 'result-body stale' : 'result-body'}>
            {resultStale && <p className="stale-badge">上次结果（目标已变化）</p>}
            <div className="result-main">
              <span
                className="color-swatch"
                style={{ backgroundColor: swatchFor(result.primaryColor) }}
                aria-hidden="true"
              />
              <span className="result-color">{result.primaryColor}</span>
              {result.objectName && <span className="result-object">{result.objectName}</span>}
            </div>
            {result.secondaryColors.length > 0 && (
              <p className="result-secondary">其他颜色：{result.secondaryColors.join('、')}</p>
            )}
            <p className="result-time">{formatTime(result.announcedAt)} 播报</p>
          </div>
        ) : (
          <p className="result-empty">还没有识别结果。</p>
        )}
      </section>

      <section className="history-card" aria-label="最近结果">
        <h2 className="card-title">最近结果</h2>
        {history.length === 0 ? (
          <p className="result-empty">暂无记录。</p>
        ) : (
          <ul className="history-list">
            {history.map((item) => (
              <li key={item.time}>
                <span className="history-time">{formatTime(item.time)}</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
