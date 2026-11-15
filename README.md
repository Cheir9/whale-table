# Northflank 部署说明（免费层 Sandbox）

## 为什么选它

- 免费层是**永久免费**，不是试用，不用绑卡
- 每月 $20 资源额度，这个游戏只用 $2–3
- **Always on，不休眠**（不像 Render 免费版闲置就睡）

## 需要上传的文件

把 `Dockerfile` 传到 GitHub 仓库**根目录**（和 `server.js` 同一层）。

仓库里现在应该长这样：

```
Dockerfile        ← 新增
index.html
style.css
game.js
server.js
package.json
README.md
main.ts           ← 如果之前传了 Deno 版，留着也没关系
assets.ts
```

## 部署步骤

1. 打开 https://app.northflank.com/signup ，用 **GitHub 账号**登录
2. 点 **Create Project**，名字随便（比如 `whale-table`），区域选近的（Singapore / Hong Kong）
3. 进项目后点 **Create Service** → 选 **Deployment**
4. **Repository** 选 GitHub，授权后选你的仓库，分支 `main`
5. **Build** 选 **Dockerfile**，路径保持 `./Dockerfile`
6. **Network / Ports**：新增一个端口
   - Port：`8080`
   - Protocol：`HTTP`
   - 勾选 **Public**（对外可访问）
7. 点 **Create / Deploy**，等 2–3 分钟构建
8. 构建完成后，在服务的 **Domains** 里能看到公网地址，形如
   `https://你的服务名-你的项目名.northflank.app`

## 注意事项

- 免费层只有 2 个 service，够用，别重复建
- 端口必须是 `8080`，和 Dockerfile 里的 `EXPOSE 8080` 一致
- 这个服务**没有数据库**，房间数据都在内存里，重启会清空（对局丢失是正常的）
- 网址永久不变，你电脑关机也能访问
