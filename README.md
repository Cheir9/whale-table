# Deno Deploy 部署说明

这是 Node 版（`server.js`）的 Deno 移植版，玩法完全一致，只是运行环境换成 Deno Deploy（长期免费）。

## 两个文件

| 文件 | 说明 |
|---|---|
| `main.ts` | Deno 入口：静态服务 + WebSocket + 全部游戏逻辑 |
| `assets.ts` | 自动打包的 `index.html` / `style.css` / `game.js`（Deno Deploy 没有文件系统，只能内联） |

## 部署步骤

1. 打开你的 GitHub 仓库，点 **Add file → Upload files**
2. 把 `main.ts` 和 `assets.ts` 两个文件传上去，**Commit changes**
3. 打开 https://dash.deno.com ，用 GitHub 登录
4. **New Project** → 选你的仓库（第一次要授权 Deno 访问 GitHub）
5. 入口文件（Entrypoint）填 `main.ts`
6. 点 **Deploy**

部署完会给你一个 `https://你的项目.deno.dev` 的网址，永久不变，电脑关机也能访问。

## 重新生成 assets.ts

改了 `index.html` / `style.css` / `game.js` 之后要重新打包：

```bash
node gen-assets.mjs
```

（`gen-assets.mjs` 在项目的 `deno-version/` 目录里）
