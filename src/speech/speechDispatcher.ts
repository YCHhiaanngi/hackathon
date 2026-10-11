// 语音调度：所有提示都经过这里。
// - 同一句提示至少间隔 CONFIG.speechMinIntervalMs；
// - 新提示会取消尚未播完的旧提示，不排长队；
// - 应用语音模式与读屏模式二选一，不自动猜测读屏软件；
// - 没有中文语音时明确提示，仍保留文字。

import { CONFIG } from '../config';

export type SpeechChannel = 'app' | 'reader';

export class SpeechDispatcher {
  private channel: SpeechChannel = 'app';
  private lastText = '';
  private lastSpokenAt = 0;
  private zhVoice: SpeechSynthesisVoice | null = null;
  private voiceReady = false;
  /** 读屏模式下需要更新到 aria-live 区域的文本。 */
  onReaderText: ((text: string) => void) | null = null;
  /** 中文语音可用性变化时通知（true=可用）。 */
  onVoiceAvailability: ((available: boolean) => void) | null = null;

  constructor() {
    if ('speechSynthesis' in window) {
      const load = () => {
        const voices = window.speechSynthesis.getVoices();
        this.zhVoice =
          voices.find((v) => /^zh([-_]|$)/i.test(v.lang) && /cn|hans|普通话|中文/i.test(`${v.lang} ${v.name}`)) ??
          voices.find((v) => /^zh([-_]|$)/i.test(v.lang)) ??
          null;
        this.voiceReady = true;
        this.onVoiceAvailability?.(this.zhVoice !== null);
      };
      load();
      window.speechSynthesis.addEventListener('voiceschanged', load);
    }
  }

  setChannel(channel: SpeechChannel): void {
    if (this.channel === channel) return;
    this.stop();
    this.channel = channel;
  }

  get currentChannel(): SpeechChannel {
    return this.channel;
  }

  get chineseVoiceAvailable(): boolean {
    return this.voiceReady && this.zhVoice !== null;
  }

  /** 播报一条提示；与上一条相同且间隔不足时跳过；新提示取消旧提示。 */
  speak(text: string): void {
    const now = Date.now();
    if (text === this.lastText && now - this.lastSpokenAt < CONFIG.speechMinIntervalMs) {
      return;
    }
    this.lastText = text;
    this.lastSpokenAt = now;

    if (this.channel === 'reader') {
      // 取消应用语音残留，文本交给 aria-live 区域。
      this.cancelSynthesis();
      this.onReaderText?.(text);
      return;
    }

    if (!('speechSynthesis' in window)) {
      this.onReaderText?.(text);
      return;
    }
    this.cancelSynthesis();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    if (this.zhVoice) {
      utterance.voice = this.zhVoice;
    }
    window.speechSynthesis.speak(utterance);
  }

  /** 主动重听上一条，不受间隔限制。 */
  repeat(): void {
    if (!this.lastText) return;
    const text = this.lastText;
    this.lastSpokenAt = 0;
    this.speak(text);
  }

  /** 停止识别时立即停止语音。 */
  stop(): void {
    this.cancelSynthesis();
  }

  private cancelSynthesis(): void {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }
}
