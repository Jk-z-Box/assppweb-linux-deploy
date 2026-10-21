# AssppWeb Linux 一键部署

为 [Lakr233/AssppWeb](https://github.com/Lakr233/AssppWeb) 提供独立的 Linux 部署与管理脚本。使用上游发布的 `ghcr.io/lakr233/assppweb:latest` 镜像，不修改 Apple 登录、许可证或 IPA 处理逻辑。

支持安装时自定义 **Web 用户名、密码、回源端口**；部署后输入 **`assppweb`** 进入中文管理菜单。默认适配 **Cloudflare Origin Rules**，公网访问地址不需要带回源端口。

## Apple ID 跨设备保持登录（v1.1）

可选的**服务端账号同步版**已加入。Apple ID、密码和会话在服务器加密持久保存；电脑和手机通过同一个网站入口认证后，自动读取同一份账号库。服务器持有解密密钥，所有入口用户共享账号，适合个人私有部署。Apple 令牌过期或要求验证码时仍需重新认证。

**已部署的用户直接运行下面这条升级命令**，保留原域名、回源端口、入口用户名密码和下载数据：

```bash
bash -c 'set -e; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; curl --proto "=https" --tlsv1.2 -fsSL --retry 3 https://raw.githubusercontent.com/Jk-z-Box/assppweb-linux-deploy/main/install.sh -o "$f"; if [ "$EUID" -eq 0 ]; then bash "$f" enable-sync --yes; else sudo bash "$f" enable-sync --yes; fi'
```

升级会在服务器构建镜像，随后备份并重建容器。完成后刷新原电脑网页，点击 **“迁移本机已有账号到服务器”**；手机打开同一网址即可同步。之后快捷菜单增加 **14）启用/升级服务端账号同步**。新安装想启用此功能，可在安装脚本后加 `--sync`。

详见 [同步版说明、数据范围与备份恢复](sync/README.md)。上游默认模式仍使用浏览器本地账号；`assppweb update` 本身不会把旧版管理脚本升级成同步版，请先执行上面的命令。

## 一键部署

在 Linux 服务器上复制执行（需要 `curl`，普通用户需要 `sudo`）：

```bash
bash -c 'set -e; f=$(mktemp); trap '\''rm -f "$f"'\'' EXIT; curl --proto "=https" --tlsv1.2 -fsSL --retry 3 https://raw.githubusercontent.com/Jk-z-Box/assppweb-linux-deploy/main/install.sh -o "$f"; if [ "$EUID" -eq 0 ]; then bash "$f"; else sudo bash "$f"; fi'
```

按提示填写公网域名、Web 回源端口、登录用户名和密码。密码输入不回显；留空则生成随机密码。安装完成后会输出 Cloudflare 配置说明。

脚本先完整下载再执行；下载失败不会执行半截脚本。安装过程中不需要 GitHub Token 或 Cloudflare API Token。

也可以先下载检查，再运行：

```bash
curl -fL https://raw.githubusercontent.com/Jk-z-Box/assppweb-linux-deploy/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

## Cloudflare Origin Rules 配置

默认链路：

```text
浏览器 / iOS
  → https://apps.example.com:443
  → Cloudflare 橙云代理 + Origin Rule
  → 源站 IP:自定义端口（HTTPS，默认 8443）
  → Caddy 用户名密码认证
  → AssppWeb 容器内的 8080 端口
```

1. **DNS**：添加域名的 A/AAAA 记录指向服务器，开启橙云代理。没有可用 IPv6 时不要填写 AAAA。
2. **Origin Rules**：添加规则，表达式为 `(http.host eq "apps.example.com")`，将 **Destination port / 目标端口** 设置为安装时填写的端口，例如 `8443` 或 `18080`。保持 Host 和 SNI 为原域名。
3. **SSL/TLS**：默认使用 Caddy 自动生成并续期的源站私有 CA 证书，应选择 **Full**。此模式对回源流量加密，但 Cloudflare 不校验源站证书身份。不要使用 Flexible。
   如其他站点必须保留全局 Flexible，可在 **Configuration Rules** 中仅匹配本域名，将 **SSL 设置为 Full**，保留原 Origin Rule 的端口覆盖。
4. **边缘证书**：开启 **Always Use HTTPS**，让 HTTP 请求在 Cloudflare 边缘跳转，避免 HTTP 请求回源到 HTTPS 端口。
5. **WebSockets**：保持启用；`/wisp/` 需要 WebSocket 连接。
6. 在云安全组及服务器网络策略中放行选定的源站 **TCP 端口**。脚本不会改写防火墙规则。
7. 浏览器访问 **`https://apps.example.com`**。不要把 `8443` 等源站端口附加到公网 URL。

Origin Rules 的目标端口覆盖支持 1–65535；这里的自定义端口是**源站端口**，与直接访问 Cloudflare 边缘非标准端口的限制不同。[官方说明](https://developers.cloudflare.com/rules/origin-rules/features/#destination-port)

本脚本不修改 Cloudflare 账号设置。不要对该站点强制“缓存所有内容”；默认响应为 `Cache-Control: no-store`。如果启用额外的人机挑战，iOS 安装资源和 `/wisp/` 可能无法完成请求，请检查相应规则。

### 使用 Full (strict)

在 Cloudflare **SSL/TLS → Origin Server** 创建覆盖域名的 Origin CA 证书，将 PEM 证书和私钥保存到服务器。通过菜单选项 **12** 导入，或执行：

```bash
assppweb config --cert /path/to/origin.pem --key /path/to/origin.key --yes
```

成功后将 Cloudflare SSL/TLS 切换为 **Full (strict)**。脚本检查证书有效期和密钥匹配，并由 Caddy 校验配置；证书必须覆盖所用域名。Origin CA 证书不会自动续期，请在到期前重新导入。[Origin CA 文档](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)

## 管理菜单与快捷指令

```bash
assppweb
```

菜单提供状态、启动、停止、重启、日志、更新、镜像回滚、备份、修改配置、修改登录信息、查看回源说明、导入证书、卸载等选项。普通用户执行快捷指令时自动调用 `sudo`。

| 命令 | 用途 |
| --- | --- |
| `assppweb status` | 查看服务状态及健康状态 |
| `assppweb start` | 启动，或从已保留的数据重新创建容器 |
| `assppweb stop` | 停止服务 |
| `assppweb restart` | 重启容器 |
| `assppweb logs` | 跟踪最近日志，Ctrl+C 退出 |
| `assppweb config` | 交互修改域名、端口、用户名及下载/缓存参数 |
| `assppweb passwd` | 修改登录用户名和密码 |
| `assppweb info` | 显示访问地址和 Origin Rules 设置 |
| `assppweb update` | 拉取新镜像、备份、更新；启动失败自动回滚镜像 |
| `assppweb rollback` | 回退到上次更新前的镜像 |
| `assppweb backup` | 停止正在运行的服务，备份后恢复原运行状态 |
| `assppweb uninstall` | 删除本项目容器和网络，保留数据及快捷指令 |

修改配置会先校验新配置，保留旧配置，再重建容器；启动失败会尝试恢复旧配置。运行中的下载可能被中断。端口变化后，也要同步修改 Cloudflare Origin Rule 和安全组。

直接修改端口或域名示例：

```bash
assppweb config --port 18080 --yes
assppweb config --domain apps.example.com --username myadmin --yes
```

默认安装目录为 `/opt/assppweb`。如果快捷指令已被其他程序占用，脚本会保留原文件，可使用：

```bash
sudo bash /opt/assppweb/assppweb.sh menu
```

## 非交互安装与其他模式

```bash
sudo bash install.sh install \
  --domain apps.example.com \
  --username myadmin \
  --password-file /root/asspp-password.txt \
  --port 18080 \
  --threads 8 \
  --cleanup-days 7 \
  --cleanup-mb 10240 \
  --max-download-mb 2048 \
  --yes
```

密码文件用文本编辑器创建，权限设为 `600`。密码为 12–72 字节，不含换行，首尾不能为空白；允许中间空格和特殊字符。不提供密码文件时，`--yes` 模式自动生成随机密码。

用户名支持 1–64 位字母、数字及 `_.@-`，以字母或数字开头。

已有 Nginx、Caddy 或宿主机 Cloudflare Tunnel 时，可只绑定本机 HTTP 端口：

```bash
sudo bash install.sh --proxy --domain apps.example.com --port 18080
```

外层代理指向 `http://127.0.0.1:18080`，对外提供 HTTPS 并透传 WebSocket。容器中的 Tunnel 不能直接通过它自己的 `127.0.0.1` 访问宿主机，需要自行配置宿主机网络连接。

仅本机测试或 SSH 隧道：

```bash
sudo bash install.sh --local --port 18080
ssh -L 18080:127.0.0.1:18080 user@your-server
```

本机浏览器打开 `http://localhost:18080`。此模式不支持 iOS 在线安装。

## 系统与运行条件

- Linux `x86_64/amd64` 或 `aarch64/arm64`。
- 支持为 Debian、Ubuntu、CentOS Stream、Rocky Linux、AlmaLinux、RHEL、Fedora 配置 Docker 官方软件源；自动安装需要相应发行版仍受 Docker 软件源支持、包管理器可用以及 systemd。
- 已安装 Docker Engine 和 Compose 2.18+ 的其他 Linux 系统也可使用。脚本不会自动卸载冲突的容器运行时或替换已存在的 Docker 软件源。
- 服务器需要访问 GitHub/GHCR、Docker 软件源与镜像仓库、Apple 服务和 CDN。
- 同一 Docker Engine 上使用固定 Compose 项目名 `assppweb`，本脚本按单实例设计；不会覆盖已经存在的同名项目。
- 数据空间取决于 IPA 数量和大小；备份还需要额外空间。默认 7 天清理、10240 MB 清理阈值、2048 MB 单文件限制；可在菜单修改，`0` 表示禁用对应限制。
- 缓存容量参数沿用上游的清理机制，不等同于严格的磁盘配额；备份文件不自动清理。

## 登录与数据说明

网页登录采用 Caddy HTTP Basic Authentication，浏览器会显示用户名/密码弹窗。这是实例入口账号，与网页内添加的 Apple ID 分开。密码以 bcrypt 哈希用于入口认证；为便于管理员取回，原始密码另存于 root 可读的 `/opt/assppweb/access-password`：

```bash
sudo cat /opt/assppweb/access-password
```

AssppWeb 自身的访问密码关闭，以避免重复登录；它的端口只存在于 Docker 内部网络。入口保护页面、API 和 Wisp WebSocket。**仅含 UUID 的安装 manifest、IPA 和图标链接允许无登录访问**，以便 iOS 系统下载；持有这些链接的人可以获取对应文件。`/api/install/<id>/url` 等其他路径仍需登录。不要在完成部署后额外公开映射 AssppWeb 容器的 8080 端口。

浏览器会缓存 Basic Auth 凭据；更改密码后，如未出现新登录弹窗，可关闭相关浏览器窗口或用无痕窗口重新访问。

未启用同步版时，Apple ID 数据保存在浏览器 IndexedDB，服务器备份不包含这些账号；可在设置页加密导出。启用同步版后，账号密文及密钥保存在 `data/account-vault/`，随服务器备份一起保存，恢复时两者缺一不可。

服务器目录：

```text
/opt/assppweb/
├── assppweb.sh          已安装的管理器
├── deployment.conf    部署配置
├── compose.yml         容器配置
├── Caddyfile           认证及反向代理配置
├── app.env             上游应用配置
├── access-password    管理员可读的登录密码
├── auth.hash           bcrypt 哈希
├── certs/              导入的源站证书
├── data/               IPA 和已完成任务元数据
├── caddy/              Caddy 证书、私有 CA 和运行数据
└── backups/            完整备份及配置变更备份
```

只恢复已完成的下载任务；未完成任务可能在重启后丢失。`update` 更新的是应用/Caddy 镜像，不会自动更新管理脚本。镜像回滚不回滚数据，且依赖旧镜像尚未被 Docker 清理；回滚选择会保留到下一次成功更新。更换管理脚本前请先备份并检查版本兼容性。

## 备份恢复

```bash
assppweb backup
```

完整备份为 `backups/assppweb-时间-PID.tar.gz`，包含配置、访问密码、私钥和 IPA。不要上传到公开仓库。配置变更备份为 `backups/config-时间-PID/`，不包含 IPA。

恢复时，停止服务，把完整备份解压到一个空的恢复目录，确认内容后用恢复目录中的管理器启动。不要把旧备份直接覆盖正在运行的部署：

```bash
assppweb stop
sudo install -d -m 700 /opt/assppweb-restored
sudo tar -xzf /path/to/backup.tar.gz -C /opt/assppweb-restored
sudo bash /opt/assppweb-restored/assppweb.sh start
```

恢复到新目录后，原快捷指令仍指向旧目录，应使用恢复目录中的管理器；确认旧部署已停止，避免两个目录管理同一个 Compose 项目。

## 验证

```bash
bash -n install.sh
shellcheck install.sh
python3 tests/test_deploy.py
```

可选的真实组件测试（无需 Docker daemon）：

```bash
CADDY_BIN=/absolute/path/to/caddy \
COMPOSE_BIN=/absolute/path/to/docker-compose \
python3 tests/test_deploy.py
```

测试覆盖参数和权限、配置生成、真实 Compose 配置解析、真实 Caddy 用户名密码认证、源站 TLS 握手、安装资源例外、WebSocket 升级、备份失败恢复、配置失败恢复和镜像回滚。Docker 生命周期使用模拟命令验证；当前发布未在远程 Linux VPS 上实际安装 Docker，也未实测 Apple ID 登录和 iOS 安装。

## 上游与许可

- 应用：[Lakr233/AssppWeb](https://github.com/Lakr233/AssppWeb)，MIT License。
- 入口认证与回源：[Caddy](https://caddyserver.com/)，Apache-2.0。
- 本仓库部署脚本：MIT License，见 [LICENSE](LICENSE)。

这是独立部署封装，不是上游官方部署服务。
