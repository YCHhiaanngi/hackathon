# 前端交接文档 · 听见颜色

> 分支：`feature/frontend-hear-colors`（独立前端分支，未合并 main/master）。
> 技术栈：Vite 7 + React 19 + TypeScript 7（strict）。部署沿用 GitHub Pages（`.github/workflows/deploy.yml`，构建产物 `dist/`）。

## 运行

```bash
npm install
npm run dev       # 本地开发（localhost，摄像头可用）
npm run build     # 类型检查 + 构建到 dist/
npm run preview   # 预览构建产物
```

摄像头要求安全上下文：`localhost` 或 HTTPS。GitHub Pages 默认 HTTPS，可直接用。

## 配置（环境变量）

| 变量 | 取值 | 说明 |
| --- | --- | --- |
| `VITE_API_MODE` | `local`（默认）/ `mock` / `http` | local = 浏览器本地真实图像处理；mock = 演示模式（回放脚本）；http = 远程服务 |
| `VITE_API_BASE_URL` | 如 `https://api.example.com` | 仅 http 模式需要，需配置 CORS |

> 更新（v0.2）：本地真实识别已实现（`src/local/`，固定背景辅助模式），契约不变。详见 docs/acceptance.md。

本地联调：复制 `.env.example` 为 `.env.local` 填写（不要提交真实地址以外的敏感信息；**任何模型密钥都不得进入前端**）。

所有可调参数集中在 [src/config.ts](../src/config.ts)：采样间隔（500ms）、定位结果时效（1500ms，原型初始值需实测）、语音间隔（4s）、方向确认次数、居中容差与滞回、稳定性窗口、降级阈值等。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `src/App.tsx` | 页面组装：顶部状态、预览、右侧面板、控制区；只读引擎快照 |
| `src/guidance/engine.ts` | 核心状态机：未启动/等待授权/寻找目标/调整位置/保持稳定/识别颜色/结果已播报/暂停/错误；采样闭环、时效检查、降级、结果失效 |
| `src/guidance/messages.ts` | 全部提示文案（固定提示词） |
| `src/api/client.ts` | 唯二能力适配函数 `locateTarget` / `recognizeColor`，含响应字段校验 |
| `src/api/http.ts` | multipart 上传、超时、统一错误归类（NETWORK_ERROR / MALFORMED_RESPONSE 等） |
| `src/api/mockLocate.ts` / `mockColor.ts` / `mockScenario.ts` | Mock：正常/多目标/暗光/模糊/慢响应/目标丢失六场景，结构与真实接口一致 |
| `src/camera/cameraSession.ts` | getUserMedia 生命周期与权限/设备错误归类 |
| `src/camera/frameSampler.ts` | 抽帧：长边 640 JPEG，只取最新帧 |
| `src/direction/directionMapping.ts` | 图像坐标↔用户方向换算 + 两段式校准（右移→上移） |
| `src/speech/speechDispatcher.ts` | 语音调度：4s 同句节流、新提示取消旧提示、应用语音/读屏单通道、中文语音检测 |
| `src/components/*` | 纯展示组件 |
| `src/shared/types.ts` | 与 `docs/api-contract.md` 对应的类型 |

## 关键行为说明

- **采样背压**：同时最多一个定位请求，未完成就跳过本次；颜色识别同时最多一个，仅稳定后触发，不逐帧调用。
- **防过期**：定位结果年龄 >1500ms 不用于方向播报；颜色结果需同属当前 session、未取消、未超时（<6s）、期间目标未丢失/移动，否则丢弃重识别。
- **防重复**：方向建议连续两次一致才播报；同色同物不重复播报；结果失效后界面标注"上次结果"。
- **降级**：最近 8 次定位中 ≥75% 过期 → "停稳后分析"模式（停止实时指路，保留停稳识别）；恢复到 ≤25% 自动退出。
- **校准**：检测到单个稳定目标后，依次请用户右移、上移；两步都检测到明确位移才宣布成功；失败进入 8s 冷却。未完成校准不输出左右指令。映射随 session 重建失效。
- **资源**：暂停=停采样+停语音（保留预览）；停止=释放摄像头+取消请求+清理计时器；页面隐藏自动暂停；pagehide 释放全部。
- **Mock 标注**：演示模式下视频角标常驻"模拟引导，不分析当前摄像头画面"，顶栏有"演示模式"徽章；真实接口失败**不会**静默切到 Mock。

## 已验证 / 未验证

已验证（本地 Chrome + 构建产物，Mock 正常场景，按秒级 DOM 采样核对）：
- 构建通过（`tsc --noEmit` + `vite build`）。
- 完整闭环：启动说明 → 无目标提示 → 方向校准两步（右移→上移）→"方向校准完成"→"可以了，请保持不动"→ 自动识别并播报"蓝色上衣"。
- 目标被拿走约 2.5 秒后结果标注"上次结果（目标已变化）"；第二件衣物进入后给出**校准后的方向指令**（"请把衣物向你的左手方向移动一点"），稳定后播报"红色 T 恤"，未错报上一件。
- 暂停/继续/停止/重听按钮与状态切换；停止后摄像头释放；控制台无报错。
- 其余 Mock 场景（多目标/暗光/模糊/慢响应/目标丢失）路径已实现，供查按 ACCEPTANCE.md 逐项勾选。

未验证（需要真实设备/后端）：
- 真实摄像头上用户实际左右上下移动的方向正确性（映射默认经校准确认，但仍需真机实测）。
- 上下映射在不同摄像头/驱动下的表现。
- 尹的真实服务联调：`/api/vision/locate`、`/api/color/analyze`、CORS、延迟与降级阈值实测调整（`locateResultMaxAgeMs` 1500ms 是初始参数）。
- 读屏软件（NVDA/JAWS）全流程实操。
- 慢响应/断网在真实网络下的表现（Mock 的 slow 场景已覆盖逻辑路径）。

## 给尹的接入说明

1. 按 `docs/api-contract.md` 实现两个接口，`targetBox` 为 0~1 归一化、基于未镜像上传图像。
2. 提供独立 HTTPS 地址并配置 CORS（允许 `POST` + `multipart/form-data`）。
3. 前端设置 `VITE_API_MODE=http`、`VITE_API_BASE_URL=<地址>` 即可联调，无需改代码。
4. 联调通过后，再由团队决定合并到主分支并发布 GitHub Pages。
