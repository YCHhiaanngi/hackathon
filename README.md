# hackathon · 听见颜色

面向视障用户的电脑端无障碍网页：用户把一件衣物举到固定摄像头前，系统用语音提示调整位置，稳定后自动识别并播报颜色。全程无需看取景框、无需点击拍照。

## 识别方式

默认 **本地真实模式**：全部图像处理在浏览器内完成（固定背景差分 + 连通区域定位 + 掩膜内颜色分类），无网络请求、无密钥、无后端。这是真实图像处理，但不是语义衣物识别——播报口径为“目标区域的主要颜色是……”。

另有 **演示模式**（Mock 脚本，明确标注）与预留的 **远程服务模式**（HTTP 契约见 docs/api-contract.md）。

## 快速启动

```bash
npm install
npm run dev        # 打开 http://localhost:5173/
```

```bash
npm run test:local # 本地视觉算法自检（29 项合成图用例）
npm run build      # 类型检查 + 构建到 dist/
```

## 文档

- 操作手册（启动、校准、验证、发布、故障排查）：[docs/runbook.md](docs/runbook.md)
- 接口契约（三种模式、字段、错误结构）：[docs/api-contract.md](docs/api-contract.md)
- 验收记录与限制：[docs/acceptance.md](docs/acceptance.md)
- 前端交接：[docs/frontend-handoff.md](docs/frontend-handoff.md)
- 验收清单：[ACCEPTANCE.md](ACCEPTANCE.md)

## 使用条件与限制

摄像头固定、背景简洁、光照均匀时效果可靠；复杂背景与剧烈光照变化下定位为受限能力，详见验收记录。
