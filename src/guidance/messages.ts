// 语音与界面共用的提示文案。固定提示词，不伪装成按真实画面生成的引导。

export const MSG = {
  intro: '请将一件衣物举到屏幕上方的摄像头前。我会提示你调整位置，识别后自动读出颜色。',
  introMockSuffix: '当前是演示模式，只回放模拟画面，不分析真实摄像头内容。',
  waitingPermission: '等待摄像头授权。',
  cameraDenied: '摄像头权限被拒绝。请在浏览器设置中允许摄像头权限后，再点击开始识别。',
  cameraNotFound: '没有找到可用的摄像头设备。请连接摄像头后重试。',
  cameraBusy: '摄像头可能被其他应用占用。请关闭占用它的应用后重试。',
  cameraNotReady: '摄像头尚未就绪，请再试一次。',
  cameraUnknown: '摄像头开启失败，请检查设备后重试。',
  cameraEnded: '摄像头连接中断，请重新开始识别。',

  noTarget: '还没有找到衣物，请把衣物举到摄像头前。',
  multiple: '请一次只展示一件衣物。',
  uncertain: '没有看清衣物，请把衣物举稳一点。',
  tooDark: '画面较暗，请打开附近的灯，避免背对光源。',
  glare: '画面有反光，请避开强光直射。',
  blurred: '请保持衣物不动。',
  tooSmall: '请把衣物靠近摄像头一点。',
  croppedGeneric: '衣物超出了画面，请把衣物移向画面中间。',
  moveLeft: '请把衣物向你的左手方向移动一点。',
  moveRight: '请把衣物向你的右手方向移动一点。',
  moveUp: '请把衣物向上移动一点。',
  moveDown: '请把衣物向下移动一点。',
  holdSteady: '可以了，请保持不动。',
  recognizing: '正在识别颜色。',

  calibrateRight: '先做一下方向校准：请把衣物向你的右手方向轻轻移动一点。',
  calibrateUp: '很好。现在请把衣物向上移动一点。',
  calibrateDone: '方向校准完成。',
  calibrateFailed: '没有确认到移动方向，稍后会再试一次。',

  paused: '已暂停。',
  degradedEnter: '定位响应较慢，已切换为停稳后分析。请把衣物举稳，等待自动识别。',
  degradedExit: '定位速度已恢复，继续实时引导。',
  locateServiceDown: '定位服务暂时不可用，正在重试。',
  locateServiceRecovered: '定位服务已恢复。',
  colorFailed: '这次没有识别成功，会自动重试。',
  noChineseVoice: '没有检测到中文语音，将只显示文字提示。',
  stopped: '已停止。',
} as const;

export type MessageKey = keyof typeof MSG;
