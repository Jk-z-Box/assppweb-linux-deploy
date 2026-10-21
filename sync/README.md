# 服务端 Apple ID 同步版

此扩展基于 Lakr233/AssppWeb 的 `485be0b884e5d88bbd5379179064999992273614` 构建。它改变上游的浏览器本地账号存储设计：Apple ID、密码、会话令牌、Cookie 和设备标识会经 HTTPS 保存到服务器，供同一实例的已认证设备使用。Apple 通信仍通过浏览器 TLS/Wisp 完成。

## 升级已有安装

下载仓库最新 `install.sh`，执行 `sudo bash install.sh enable-sync --yes`。自定义目录增加 `--dir /你的安装目录`。升级保留现有域名、9010 等自定义端口、入口用户名密码、下载数据及证书。

脚本先下载校验构建包并构建 Docker 镜像，成功后备份，再重建容器；构建失败不会停止原服务，启动失败恢复原配置。首次构建需访问 GitHub、npm 和 Docker 镜像源，建议至少 2 GB 可用内存和足够的 Docker 磁盘空间。

升级后：

1. 在原先登录 Apple ID 的电脑浏览器刷新同一域名。
2. 点击“迁移本机已有账号到服务器”。迁移成功的记录才从原 IndexedDB 删除；失败或与服务端重名的记录保留。重名时保留服务端会话，不自动覆盖。
3. 手机打开同一域名，使用原网站入口用户名密码登录，即可读取账号和会话。无需第二套同步密码。
4. 新增、删除、重新认证会立即写入服务端。其他打开的页面每 15 秒及重新获得焦点时拉取。两设备冲突时会拒绝旧写入并刷新列表，按提示重试。

后续 `assppweb update` 重建当前同步发行版并更新 Caddy。它不会自动跟踪上游 main：升级上游版本需发布经过验证的新同步包。`assppweb rollback` 退回上一镜像，但保留服务端账号库文件；回到原上游镜像时页面暂时看不到服务端账号，重新启用同步后可恢复。

新安装使用 `sudo bash install.sh --sync`。已有部署必须使用 `enable-sync`，不要重新 install。

## 数据和访问范围

- 文件：`/opt/assppweb/data/account-vault/accounts.enc`，AES-256-GCM 加密。
- 密钥：同目录 `key`，32 字节随机生成；文件权限 600、目录权限 700。
- **服务器持有解密密钥，管理员能读取登录信息。这是服务端托管，不是端到端加密。** 应仅部署在自己信任的服务器。
- 本版本是单实例共享账号库；持有网站入口账号的人能查看、使用、导出和删除全部 Apple ID。不是多用户隔离系统。
- API 默认拒绝访问，只接受 Caddy 覆写的内部随机鉴权头；不对外暴露应用端口。自定义请求头、Origin 检查、无 CORS 和 no-store 响应防止跨站请求及缓存。
- 新会话只在当前页面内存中缓存，不继续写入浏览器 IndexedDB。页面刷新后从服务器读取。
- `assppweb backup` 包含密文和密钥，恢复时必须一起恢复；丢失密钥不能解密账号库。不要把备份上传到公开仓库。
- Apple 可以撤销、过期或要求二次验证。跨设备保存会话不能保证永久免登录。网页入口密码的保留时间由浏览器决定。
- 同一账号建议避免多设备同时发起授权/登录；版本冲突机制保护服务端数据，但无法撤销已经发往 Apple 的请求。

## 构建与复核

`Dockerfile` 下载上述固定上游提交，检查 SHA-256，然后覆盖 `overlay/` 并运行 `patch-upstream.mjs` 接入路由和界面。若上游接入点发生变化，构建直接失败，避免生成半接入版本。保留上游许可证 `LICENSE.upstream`。浏览器自动翻译已禁用，请使用应用内的语言设置。

```bash
docker build -t assppweb-sync:1.1.0 sync/
```

测试来源：`sync/tests/backend/accounts.test.ts` 放入上游 `backend/tests/sync/accounts.test.ts`；`sync/tests/frontend/accounts.test.ts` 替换上游 `frontend/tests/store/accounts.test.ts`。按上游 `npm ci` 后运行各自的 `npm test`。部署管理器测试位于 `tests/test_deploy.py`。

发行包由 `tools/package_sync.py` 确定性生成，脚本内嵌构建包摘要。每次修改 sync 构建源码后必须重新打包并更新摘要。
