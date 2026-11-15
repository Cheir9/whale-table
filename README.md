# 鲸鱼牌桌（Whale Table）

多人分街下注小游戏。原生 HTML/CSS/JavaScript 前端 + 零依赖 Node.js 服务端（手写 WebSocket，不用任何第三方库）。

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 入口页面：创建房间 / 加入房间 → 大厅 → 牌桌 |
| `style.css` | 环形牌桌布局、头像、公共池、手机竖屏适配 |
| `game.js` | 前端逻辑：WebSocket、视角旋转、下注按钮 |
| `server.js` | 服务端：静态服务 + WebSocket + 房间与下注状态机 |
| `package.json` | 启动配置（`npm start`） |

## 本地运行

```bash
node server.js
```

然后打开 http://localhost:8000

## 部署

这是一个长连接 WebSocket 应用，需要一个支持 WebSocket 的 Node 环境：

- 启动命令：`npm start`
- 端口：自动读取环境变量 `PORT`
- 不需要数据库，房间和牌局都在内存里

## 玩法

- 房主创建房间、设定每人起始积分
- 小盲位先自由下注（≥1），大盲位必须至少下 2 倍
- 加注下限 = 当前最高注 × 2，可以更高
- 分街进行，房主可随时结束下注或结束整局
- 赢家由房主指定
