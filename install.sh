#!/usr/bin/env bash
# AssppWeb Linux deployment manager. MIT License.
set -Eeuo pipefail
umask 077

VERSION=1.1.0
COMMAND=install
INSTALL_DIR=/opt/assppweb
DOMAIN=
MODE=origin
PORT=8443
USERNAME='admin'
TLS_MODE=internal
CERT_FILE=
KEY_FILE=
AUTH_HASH=
ACCESS_PASSWORD=
IMAGE=ghcr.io/lakr233/assppweb:latest
SYNC_ENABLED=0
ACCOUNT_PROXY_TOKEN=
SYNC_IMAGE=assppweb-sync:1.1.0
SYNC_BUNDLE_SHA256=140f2f9a1ddae136dccad218a1f0f32270fffeb2336e7b45fc8dd0b24c24fff0
REPLACE_IMAGE=0
CADDY_IMAGE=caddy:2-alpine
PASSWORD_FILE=
ASSUME_YES=0
DOWNLOAD_THREADS=8
CLEANUP_DAYS=7
CLEANUP_MB=10240
MAX_DOWNLOAD_MB=2048
RESTART_SERVICES=()
TEMP_FILE=
STAGE_DIR=
SCRIPT_PATH=${BASH_SOURCE[0]}
SCRIPT_DIR=$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)
if [[ -f "$SCRIPT_DIR/.assppweb-managed" ]]; then INSTALL_DIR=$SCRIPT_DIR; fi

log() { printf '[AssppWeb] %s\n' "$*"; }
die() { printf '[AssppWeb] 错误：%s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
AssppWeb Linux 一键部署管理器

用法：bash install.sh [命令] [选项]
命令：install、menu、config、passwd、info、update、rollback、start、stop、restart、status、logs、backup、enable-sync、uninstall
已安装后输入 assppweb 即可进入中文管理菜单。

选项：
  --domain DOMAIN          公网域名，不含 https://、端口或路径
  --mode origin|proxy|local 默认 origin：Cloudflare Origin Rules 加密回源
  --proxy                  已有 HTTPS 反向代理或 Tunnel，只监听本机 HTTP 端口
  --local                  仅 localhost/SSH 隧道测试，不提供 iOS 在线安装
  --port PORT              自定义 Web 回源端口，默认 8443
  --username NAME          网页登录用户名，默认 admin
  --dir PATH               安装目录，默认 /opt/assppweb
  --image IMAGE            上游镜像，可指定 tag 或 sha256 digest
  --sync                   新安装时启用服务端 Apple ID 账号同步（本机构建镜像）
  --password-file FILE     从文件读取密码；交互安装可输入密码或留空随机生成
  --cert FILE --key FILE   导入源站证书和私钥，搭配 Cloudflare Full (strict)
  --threads N              下载线程数 1–32，默认 8
  --cleanup-days N         缓存保留天数，默认 7；0 禁用
  --cleanup-mb N           缓存清理容量阈值 MB，默认 10240；0 禁用
  --max-download-mb N      单个下载大小上限 MB，默认 2048；0 禁用
  --yes                    无交互运行，需提供 --domain 或 --local
  --help                   显示帮助
  --version                显示版本

默认自动生成源站证书，Cloudflare SSL/TLS 须设为 Full；不要使用 Flexible。
config 修改配置并重建容器；passwd 修改用户名/密码；info 显示回源说明。
enable-sync 升级现有部署为服务端加密账号同步；保留域名、端口与网站密码。
uninstall 删除本项目容器和网络，保留安装包、配置、证书及备份。
HELP
}

parse_args() {
  if [[ $# -gt 0 && $1 != -* ]]; then COMMAND=$1; shift; fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain|--mode|--port|--username|--dir|--image|--password-file|--cert|--key|--threads|--cleanup-days|--cleanup-mb|--max-download-mb)
        [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 缺少参数"
        case "$1" in
          --domain) DOMAIN=$2 ;;
          --mode) MODE=$2 ;;
          --port) PORT=$2 ;;
          --username) USERNAME=$2 ;;
          --dir) INSTALL_DIR=$2 ;;
          --image) IMAGE=$2; SYNC_ENABLED=0 ;;
          --password-file) PASSWORD_FILE=$2 ;;
          --cert) CERT_FILE=$2 ;;
          --key) KEY_FILE=$2 ;;
          --threads) DOWNLOAD_THREADS=$2 ;;
          --cleanup-days) CLEANUP_DAYS=$2 ;;
          --cleanup-mb) CLEANUP_MB=$2 ;;
          --max-download-mb) MAX_DOWNLOAD_MB=$2 ;;
        esac
        shift 2 ;;
      --proxy) MODE=proxy; shift ;;
      --local) MODE=local; shift ;;
      --sync) SYNC_ENABLED=1; IMAGE=$SYNC_IMAGE; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      --help|-h) usage; exit 0 ;;
      --version) printf '%s\n' "$VERSION"; exit 0 ;;
      *) die "未知选项：$1" ;;
    esac
  done
  case "$COMMAND" in
    install|menu|config|passwd|info|update|rollback|start|stop|restart|status|logs|backup|enable-sync|uninstall) ;;
    *) die "未知命令：$COMMAND" ;;
  esac
  [[ $INSTALL_DIR =~ ^/[a-zA-Z0-9_./-]+$ && $INSTALL_DIR != / ]] || die '安装目录须为无空格的绝对路径'
  INSTALL_DIR=${INSTALL_DIR%/}
  case "/${INSTALL_DIR#/}/" in */../*|*/./*|*//*) die '安装目录不能包含 .、.. 或重复斜线' ;; esac
  case "$INSTALL_DIR" in /etc|/usr|/var|/opt|/root|/home|/tmp) die '请使用专用子目录' ;; esac
}

valid_domain() {
  local label
  [[ ${#DOMAIN} -le 253 && $DOMAIN == *.* && ! $DOMAIN =~ ^[0-9.]+$ ]] || return 1
  local labels
  IFS=. read -r -a labels <<< "$DOMAIN"
  [[ $DOMAIN != *. ]] || return 1
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && $label =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

validate_settings() {
  case "$MODE" in origin|proxy|local) ;; *) die '运行模式需为 origin、proxy 或 local' ;; esac
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
  if [[ $MODE == local ]]; then
    [[ -z $DOMAIN ]] || die '--local 不能同时使用 --domain'
  else
    valid_domain || die '域名无效；请使用普通域名或 punycode，不要填写协议、端口或路径'
  fi
  local number
  for number in "$PORT" "$DOWNLOAD_THREADS" "$CLEANUP_DAYS" "$CLEANUP_MB" "$MAX_DOWNLOAD_MB"; do
    [[ $number =~ ^(0|[1-9][0-9]{0,8})$ ]] || die '端口和容量等选项必须为非负十进制整数'
  done
  (( PORT >= 1 && PORT <= 65535 )) || die '端口必须在 1–65535 之间'
  (( DOWNLOAD_THREADS >= 1 && DOWNLOAD_THREADS <= 32 )) || die '线程数必须在 1–32 之间'
  [[ $IMAGE =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$ ]] || die '镜像名称包含非法字符'
  [[ $USERNAME =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$ ]] || die '用户名需为 1–64 位字母、数字或 _.@-，且以字母或数字开头'
  case "$TLS_MODE" in internal|custom) ;; *) die '源站证书类型无效' ;; esac
  if [[ -n $CERT_FILE || -n $KEY_FILE ]]; then
    [[ -f $CERT_FILE && -f $KEY_FILE ]] || die '请同时提供存在的证书和私钥文件'
    [[ $MODE == origin ]] || die '仅 origin 模式使用源站证书'
    TLS_MODE=custom
  fi
}

prompt_value() {
  local prompt=$1 current=$2 value
  read -r -p "$prompt [$current]：" value
  printf -v "$3" '%s' "${value:-$current}"
}

prompt_settings() {
  if [[ $ASSUME_YES == 0 && -t 0 ]]; then
    if [[ $MODE != local ]]; then prompt_value '公网域名（不带协议/端口）' "$DOMAIN" DOMAIN; fi
    prompt_value 'Web 回源端口' "$PORT" PORT
    prompt_value '登录用户名' "$USERNAME" USERNAME
    if [[ $COMMAND == config ]]; then
      prompt_value '下载线程数 1–32' "$DOWNLOAD_THREADS" DOWNLOAD_THREADS
      prompt_value '缓存保留天数（0 禁用）' "$CLEANUP_DAYS" CLEANUP_DAYS
      prompt_value '缓存容量清理阈值 MB（0 禁用）' "$CLEANUP_MB" CLEANUP_MB
      prompt_value '单个下载大小上限 MB（0 禁用）' "$MAX_DOWNLOAD_MB" MAX_DOWNLOAD_MB
    fi
  fi
}

prepare_password() {
  local confirmation
  if [[ -n $PASSWORD_FILE ]]; then
    [[ -f $PASSWORD_FILE ]] || die '密码文件不存在'
    ACCESS_PASSWORD=$(cat -- "$PASSWORD_FILE")
  elif [[ $ASSUME_YES == 0 && -t 0 ]]; then
    read -r -s -p '登录密码（至少 12 字节，留空随机生成）：' ACCESS_PASSWORD
    printf '\n'
    if [[ -n $ACCESS_PASSWORD ]]; then
      read -r -s -p '再次输入密码：' confirmation
      printf '\n'
      [[ $ACCESS_PASSWORD == "$confirmation" ]] || die '两次输入的密码不一致'
    fi
  fi
  if [[ -z $ACCESS_PASSWORD ]]; then
    ACCESS_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
    [[ ${#ACCESS_PASSWORD} == 48 ]] || die '随机密码生成失败'
  fi
  local LC_ALL=C
  [[ ${#ACCESS_PASSWORD} -ge 12 && ${#ACCESS_PASSWORD} -le 72 && $ACCESS_PASSWORD != *$'\n'* && $ACCESS_PASSWORD != *$'\r'* ]] || die '密码需为 12–72 字节，不能包含换行'
  [[ $ACCESS_PASSWORD != [[:space:]]* && $ACCESS_PASSWORD != *[[:space:]] ]] || die '密码首尾不能是空白字符'
}

hash_password() {
  AUTH_HASH=$(printf '%s\n' "$ACCESS_PASSWORD" | docker run --rm -i --network none "$CADDY_IMAGE" caddy hash-password --bcrypt-cost 12)
  [[ $AUTH_HASH =~ ^\$2[aby]\$[0-9][0-9]\$[./a-zA-Z0-9]{53}$ ]] || die '密码哈希生成失败'
}

require_linux_root() {
  [[ $(uname -s) == Linux ]] || die '部署及管理命令仅支持 Linux'
  case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die '上游镜像仅支持 amd64/arm64' ;; esac
  [[ $EUID == 0 ]] || die '请使用 sudo bash install.sh ... 或 root 用户执行'
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    docker --version | grep -q '^Docker version' || die '检测到非 Docker Engine 的兼容命令，请安装 Docker Engine'
    docker compose version >/dev/null 2>&1 || die '已有 Docker 缺少 Compose 插件，请先安装 docker-compose-plugin'
    return
  fi
  [[ -r /etc/os-release ]] || die '无法识别发行版，请先手动安装 Docker Engine 和 Compose'
  # shellcheck disable=SC1091
  . /etc/os-release
  local distro=$ID repo_distro codename architecture
  log "正在为 $distro 安装 Docker Engine 和 Compose 插件"
  case "$distro" in
    ubuntu|debian)
      codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
      [[ $codename =~ ^[a-z]+$ ]] || die '无法识别发行版代号'
      # Leave existing Docker source configuration and container runtimes untouched.
      if dpkg-query -W -f='${Status}\n' containerd runc docker.io podman-docker 2>/dev/null | grep -q 'install ok installed'; then
        die '检测到现有容器运行时；请先按 Docker 官方文档处理包冲突，本脚本不会自动卸载它们'
      fi
      [[ ! -e /etc/apt/sources.list.d/docker.sources && ! -e /etc/apt/sources.list.d/docker.list ]] || die '已有 Docker 软件源，请先使用它安装 Docker 和 Compose'
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
      install -m 0755 -d /etc/apt/keyrings
      curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/assppweb-docker.asc
      chmod 644 /etc/apt/keyrings/assppweb-docker.asc
      architecture=$(dpkg --print-architecture)
      cat > /etc/apt/sources.list.d/assppweb-docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$distro
Suites: $codename
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/assppweb-docker.asc
EOF
      chmod 644 /etc/apt/sources.list.d/assppweb-docker.sources
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    centos|rocky|almalinux|rhel|fedora)
      command -v dnf >/dev/null 2>&1 || die '请使用带 dnf 的受支持发行版，或先手动安装 Docker'
      case "$distro" in rocky|almalinux) repo_distro=centos ;; *) repo_distro=$distro ;; esac
      [[ ! -e /etc/yum.repos.d/docker-ce.repo ]] || die '已有 Docker 软件源，请先使用它安装 Docker 和 Compose'
      dnf install -y ca-certificates curl
      curl --proto '=https' --tlsv1.2 -fsSL --retry 3 "https://download.docker.com/linux/$repo_distro/docker-ce.repo" -o /etc/yum.repos.d/assppweb-docker-ce.repo
      chmod 644 /etc/yum.repos.d/assppweb-docker-ce.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *) die '此发行版需先手动安装 Docker Engine 和 Compose，再重试本脚本' ;;
  esac
  command -v systemctl >/dev/null 2>&1 || die '自动安装需要 systemd，请手动启动 Docker 后重试'
  systemctl enable --now docker
}

docker_ready() {
  command -v docker >/dev/null 2>&1 || die '未安装 Docker'
  docker compose version >/dev/null 2>&1 || die '缺少 Docker Compose 插件'
  local compose_version major minor
  compose_version=$(docker compose version --short)
  compose_version=${compose_version#v}
  IFS=. read -r major minor _ <<< "$compose_version"
  [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || die '无法识别 Compose 版本'
  (( major > 2 || (major == 2 && minor >= 18) )) || die '需要 Docker Compose 2.18 或更新版本'
  local endpoint=${DOCKER_HOST:-}
  if [[ -z $endpoint ]]; then
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
  fi
  [[ $endpoint == unix://* ]] || die '请使用本机 Docker unix socket，不能使用远程 Docker context'
  docker info >/dev/null 2>&1 || die '无法连接 Docker，请先启动 Docker 服务'
}

compose_base() {
  docker compose --project-name assppweb --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/compose.yml" "$@"
}

compose() {
  if [[ -f "$INSTALL_DIR/.active-override.yml" ]]; then
    compose_base -f "$INSTALL_DIR/.active-override.yml" "$@"
  else
    compose_base "$@"
  fi
}

assert_new_directory() {
  [[ ! -L $INSTALL_DIR ]] || die '安装目录不能是符号链接'
  [[ ! -f "$INSTALL_DIR/.assppweb-managed" ]] || die "已有部署，请执行：bash $INSTALL_DIR/assppweb.sh update"
  if [[ -d $INSTALL_DIR && -n $(ls -A -- "$INSTALL_DIR") ]]; then
    die '安装目录不为空；请选择空目录，以免覆盖现有文件'
  fi
}

load_settings() {
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      DOMAIN|MODE|PORT|USERNAME|TLS_MODE|IMAGE|SYNC_ENABLED|ACCOUNT_PROXY_TOKEN|DOWNLOAD_THREADS|CLEANUP_DAYS|CLEANUP_MB|MAX_DOWNLOAD_MB)
        printf -v "$key" '%s' "$value" ;;
    esac
  done < "$INSTALL_DIR/deployment.conf"
}

write_config() {
  local destination=$1 public_url="https://$DOMAIN" bind_port="$PORT:443" site="https://$DOMAIN" scheme=https
  if [[ -z $ACCOUNT_PROXY_TOKEN ]]; then ACCOUNT_PROXY_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n'); fi
  [[ $ACCOUNT_PROXY_TOKEN =~ ^[a-f0-9]{64}$ ]] || die '账号同步入口密钥无效'
  mkdir -p "$destination/certs"
  if [[ $MODE != origin ]]; then
    bind_port="127.0.0.1:$PORT:8080"
    site='http://:8080'
  fi
  if [[ $MODE == local ]]; then public_url="http://localhost:$PORT"; scheme=http; fi
  printf '%s\n' "$ACCESS_PASSWORD" > "$destination/access-password"
  printf '%s\n' "$AUTH_HASH" > "$destination/auth.hash"
  cat > "$destination/app.env" <<EOF
DATA_DIR=/data
PORT=8080
PUBLIC_BASE_URL=$public_url
ACCESS_PASSWORD=
ACCOUNT_PROXY_TOKEN=$ACCOUNT_PROXY_TOKEN
DOWNLOAD_THREADS=$DOWNLOAD_THREADS
AUTO_CLEANUP_DAYS=$CLEANUP_DAYS
AUTO_CLEANUP_MAX_MB=$CLEANUP_MB
MAX_DOWNLOAD_MB=$MAX_DOWNLOAD_MB
UNSAFE_DANGEROUSLY_DISABLE_HTTPS_REDIRECT=$([[ $MODE == local ]] && printf true || printf false)
EOF
  cat > "$destination/compose.yml" <<EOF
services:
  asspp:
    image: $IMAGE
    restart: unless-stopped
    env_file:
      - ./app.env
    volumes:
      - ./data:/data:Z
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/api/settings').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 10s
      retries: 8
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
  caddy:
    image: $CADDY_IMAGE
    restart: unless-stopped
    depends_on:
      asspp:
        condition: service_healthy
    ports:
      - '$bind_port'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro,Z
      - ./certs:/etc/caddy/certs:ro,Z
      - ./caddy/data:/data:Z
      - ./caddy/config:/config:Z
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:2018/health']
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'
EOF
  cat > "$destination/Caddyfile" <<EOF
{
    admin off
    auto_https disable_redirects
    skip_install_trust
}

http://127.0.0.1:2018 {
    respond /health "ok" 200
}

$site {
EOF
  if [[ $MODE == origin ]]; then
    if [[ $TLS_MODE == custom ]]; then
      printf '    tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key\n' >> "$destination/Caddyfile"
    else
      printf '    tls internal\n' >> "$destination/Caddyfile"
    fi
  fi
  cat >> "$destination/Caddyfile" <<EOF
    @protected not path_regexp install "^/api/install/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/(manifest\\.plist|payload\\.ipa|icon-small\\.png|icon-large\\.png)\$"
    basic_auth @protected {
        $USERNAME $AUTH_HASH
    }
    header Cache-Control "no-store"
    reverse_proxy asspp:8080 {
        header_up -Authorization
        header_up X-Asspp-Account-Proxy $ACCOUNT_PROXY_TOKEN
        header_up X-Forwarded-Proto $scheme
    }
}
EOF
  cat > "$destination/deployment.conf" <<EOF
VERSION=$VERSION
DOMAIN=$DOMAIN
MODE=$MODE
PORT=$PORT
USERNAME=$USERNAME
TLS_MODE=$TLS_MODE
IMAGE=$IMAGE
SYNC_ENABLED=$SYNC_ENABLED
ACCOUNT_PROXY_TOKEN=$ACCOUNT_PROXY_TOKEN
DOWNLOAD_THREADS=$DOWNLOAD_THREADS
CLEANUP_DAYS=$CLEANUP_DAYS
CLEANUP_MB=$CLEANUP_MB
MAX_DOWNLOAD_MB=$MAX_DOWNLOAD_MB
EOF
  chmod 600 "$destination/"{app.env,compose.yml,Caddyfile,deployment.conf,auth.hash,access-password}
}

copy_certificates() {
  local destination=$1 cert_pub key_pub
  mkdir -p "$destination/certs"
  if [[ -n $CERT_FILE ]]; then
    command -v openssl >/dev/null 2>&1 || die '导入证书需要 openssl，请先安装 openssl'
    openssl x509 -in "$CERT_FILE" -noout -checkend 0 >/dev/null || die '证书无效或已过期'
    cert_pub=$(openssl x509 -in "$CERT_FILE" -pubkey -noout | openssl sha256)
    key_pub=$(openssl pkey -in "$KEY_FILE" -passin pass: -pubout | openssl sha256)
    [[ $cert_pub == "$key_pub" ]] || die '证书与私钥不匹配'
    cp -- "$CERT_FILE" "$destination/certs/origin.pem"
    cp -- "$KEY_FILE" "$destination/certs/origin.key"
    chmod 600 "$destination/certs/"*
  elif [[ $TLS_MODE == custom && $destination != "$INSTALL_DIR" ]]; then
    cp -- "$INSTALL_DIR/certs/origin.pem" "$destination/certs/origin.pem"
    cp -- "$INSTALL_DIR/certs/origin.key" "$destination/certs/origin.key"
  fi
}

validate_config() {
  local destination=$1
  docker compose --project-name assppweb --project-directory "$destination" -f "$destination/compose.yml" config --quiet
  docker run --rm --network none -v "$destination:/etc/caddy:ro,Z" "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile
}

initialize_config() {
  mkdir -p -- "$INSTALL_DIR"
  chmod 700 "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/caddy/data" "$INSTALL_DIR/caddy/config" "$INSTALL_DIR/backups"
  write_config "$INSTALL_DIR"
  copy_certificates "$INSTALL_DIR"
  cp -- "$SCRIPT_PATH" "$INSTALL_DIR/assppweb.sh"
  chmod 700 "$INSTALL_DIR/assppweb.sh"
  printf '%s\n' "$VERSION" > "$INSTALL_DIR/.assppweb-managed"
  unset ACCESS_PASSWORD
  log "配置已生成：$INSTALL_DIR"
}

install_shortcut() {
  local target=${1:-/usr/local/bin/assppweb}
  if [[ -L $target ]] || { [[ -e $target ]] && ! grep -q '^# assppweb-linux-deploy managed shortcut$' "$target"; }; then
    log "已有 ${target}，保留该文件；可使用 bash $INSTALL_DIR/assppweb.sh menu"
    return
  fi
  mkdir -p "$(dirname -- "$target")"
  cat > "$target" <<EOF
#!/usr/bin/env bash
# assppweb-linux-deploy managed shortcut
if [[ \$EUID != 0 ]]; then
    exec sudo bash '$INSTALL_DIR/assppweb.sh' "\$@"
fi
exec bash '$INSTALL_DIR/assppweb.sh' "\$@"
EOF
  chmod 755 "$target"
}

apply_configuration() {
  local old_config file
  STAGE_DIR=$(mktemp -d "$INSTALL_DIR/.config.XXXXXX")
  write_config "$STAGE_DIR"
  copy_certificates "$STAGE_DIR"
  validate_config "$STAGE_DIR"
  old_config="$INSTALL_DIR/backups/config-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$old_config"
  for file in compose.yml Caddyfile app.env deployment.conf auth.hash access-password; do
    cp -- "$INSTALL_DIR/$file" "$old_config/$file"
    cp -- "$STAGE_DIR/$file" "$INSTALL_DIR/$file"
  done
  cp -R "$INSTALL_DIR/certs" "$old_config/certs"
  if [[ $TLS_MODE == custom ]]; then cp "$STAGE_DIR/certs/"* "$INSTALL_DIR/certs/"; fi
  log '正在应用配置，容器将重建；进行中的下载可能需要重新发起'
  if configuration_up; then
    if [[ $REPLACE_IMAGE == 1 ]]; then rm -f -- "$INSTALL_DIR/.active-override.yml"; fi
    log "配置已更新，旧配置保存在 $old_config"
  else
    log '配置启动失败，恢复旧配置'
    for file in compose.yml Caddyfile app.env deployment.conf auth.hash access-password; do
      cp -- "$old_config/$file" "$INSTALL_DIR/$file"
    done
    if [[ -f "$old_config/certs/origin.pem" ]]; then cp "$old_config/certs/"* "$INSTALL_DIR/certs/"; fi
    if [[ $REPLACE_IMAGE == 1 && -f "$INSTALL_DIR/.rollback.yml" ]]; then
      cp -- "$INSTALL_DIR/.rollback.yml" "$INSTALL_DIR/.active-override.yml"
    fi
    compose up -d --force-recreate --wait --wait-timeout 180 || die '旧配置恢复启动也失败，请检查 logs'
    die '新配置未通过启动检查，已恢复旧配置'
  fi
  rm -rf -- "$STAGE_DIR"
  STAGE_DIR=
  unset ACCESS_PASSWORD
  show_info
}

configuration_up() {
  if [[ $REPLACE_IMAGE == 1 ]]; then
    compose_base up -d --force-recreate --wait --wait-timeout 180
  else
    compose up -d --force-recreate --wait --wait-timeout 180
  fi
}

build_sync() {
  command -v curl >/dev/null 2>&1 || die '构建同步版需要 curl'
  command -v sha256sum >/dev/null 2>&1 || die '构建同步版需要 sha256sum（coreutils）'
  STAGE_DIR=$(mktemp -d)
  log '下载并校验账号同步构建包；首次构建可能需要几分钟'
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
    'https://raw.githubusercontent.com/Jk-z-Box/assppweb-linux-deploy/main/releases/account-sync-1.1.0.tar.gz' \
    -o "$STAGE_DIR/bundle.tar.gz"
  printf '%s  %s\n' "$SYNC_BUNDLE_SHA256" "$STAGE_DIR/bundle.tar.gz" | sha256sum -c - >/dev/null || die '构建包校验失败，现有服务未变更'
  mkdir "$STAGE_DIR/source"
  tar -xzf "$STAGE_DIR/bundle.tar.gz" -C "$STAGE_DIR/source"
  docker build --pull -t "$SYNC_IMAGE" "$STAGE_DIR/source" || die '同步版镜像构建失败，现有服务未变更'
  rm -rf -- "$STAGE_DIR"
  STAGE_DIR=
}

enable_sync() {
  snapshot_images
  build_sync
  backup
  SYNC_ENABLED=1
  IMAGE=$SYNC_IMAGE
  REPLACE_IMAGE=1
  ACCESS_PASSWORD=$(cat "$INSTALL_DIR/access-password")
  AUTH_HASH=$(cat "$INSTALL_DIR/auth.hash")
  apply_configuration
  if [[ $SCRIPT_PATH != "$INSTALL_DIR/assppweb.sh" ]]; then cp -- "$SCRIPT_PATH" "$INSTALL_DIR/assppweb.sh"; fi
  chmod 700 "$INSTALL_DIR/assppweb.sh"
  printf '%s\n' "$VERSION" > "$INSTALL_DIR/.assppweb-managed"
  log '服务端同步已启用。请刷新电脑网页，点击“迁移本机已有账号到服务器”；其他设备随后打开同一网站即可读取。'
}

require_managed() {
  [[ -f "$INSTALL_DIR/.assppweb-managed" && -f "$INSTALL_DIR/compose.yml" ]] || die '指定目录中没有本脚本管理的部署'
}

lock_operation() {
  command -v flock >/dev/null 2>&1 || die '缺少 flock，请安装 util-linux'
  exec 9> "$INSTALL_DIR/.operation.lock"
  flock -n 9 || die '另一个管理操作正在执行，请稍后重试'
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ ${#RESTART_SERVICES[@]} -gt 0 ]]; then
    log '恢复备份前运行中的服务'
    compose start "${RESTART_SERVICES[@]}" || rc=1
  fi
  if [[ -n $TEMP_FILE && -f $TEMP_FILE ]]; then rm -f -- "$TEMP_FILE"; fi
  if [[ -n $STAGE_DIR && -d $STAGE_DIR ]]; then rm -rf -- "$STAGE_DIR"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup() {
  local running service destination
  mkdir -p "$INSTALL_DIR/backups"
  running=$(compose ps --status running --services)
  RESTART_SERVICES=()
  while IFS= read -r service; do
    [[ -z $service ]] || RESTART_SERVICES+=("$service")
  done <<< "$running"
  if [[ ${#RESTART_SERVICES[@]} -gt 0 ]]; then compose stop "${RESTART_SERVICES[@]}"; fi
  destination="$INSTALL_DIR/backups/assppweb-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  TEMP_FILE="$destination.part"
  tar --exclude='./backups' --exclude='./.operation.lock' -czf "$TEMP_FILE" -C "$INSTALL_DIR" .
  chmod 600 "$TEMP_FILE"
  mv -- "$TEMP_FILE" "$destination"
  TEMP_FILE=
  if [[ ${#RESTART_SERVICES[@]} -gt 0 ]]; then compose start "${RESTART_SERVICES[@]}"; fi
  RESTART_SERVICES=()
  log "备份完成：${destination}（含访问密码与证书，请妥善保存）"
}

snapshot_images() {
  local service container image_id services
  services=$(compose config --services)
  TEMP_FILE="$INSTALL_DIR/.rollback.yml.part"
  printf 'services:\n' > "$TEMP_FILE"
  while IFS= read -r service; do
    container=$(compose ps -a -q "$service")
    [[ -n $container ]] || die '更新前缺少容器，无法记录回滚版本；请先运行 start'
    image_id=$(docker inspect --format '{{.Image}}' "$container")
    [[ $image_id =~ ^sha256:[a-f0-9]{64}$ ]] || die '无法记录镜像 ID'
    printf '  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$image_id" >> "$TEMP_FILE"
  done <<< "$services"
  mv -- "$TEMP_FILE" "$INSTALL_DIR/.rollback.yml"
  TEMP_FILE=
}

update() {
  snapshot_images
  log '拉取新镜像；拉取失败不会停止现有服务'
  if [[ $SYNC_ENABLED == 1 ]]; then
    build_sync
    compose_base pull caddy
  else
    compose_base pull
  fi
  backup
  if compose_base up -d --wait --wait-timeout 180; then
    rm -f -- "$INSTALL_DIR/.active-override.yml"
    log '更新完成；旧镜像已记录，可使用 rollback 回退'
  else
    log '更新启动失败，正在恢复旧镜像'
    cp -- "$INSTALL_DIR/.rollback.yml" "$INSTALL_DIR/.active-override.yml"
    if compose up -d --wait --wait-timeout 180; then
      die '新版本未通过启动检查，已恢复旧镜像。数据备份位于 backups/'
    else
      die '新版本和回滚启动均失败，请运行 logs 检查；备份已保留'
    fi
  fi
}

show_info() {
  load_settings
  printf '\n公网地址：https://%s\n登录用户名：%s\nWeb 回源端口：%s\n运行模式：%s\n' "$DOMAIN" "$USERNAME" "$PORT" "$MODE"
  printf '查看密码：sudo cat %s/access-password\n安装目录：%s\n快捷菜单：assppweb\n' "$INSTALL_DIR" "$INSTALL_DIR"
  if [[ $SYNC_ENABLED == 1 ]]; then
    printf 'Apple ID：服务端加密同步（同一网站账号共享）；密钥与会话位于 data/account-vault/，备份时须一起保留。\n'
  fi
  if [[ $MODE == origin ]]; then
    printf '\nCloudflare 设置：\n'
    printf '  DNS：域名 A/AAAA 指向源站，开启橙云代理\n'
    printf '  Origin Rules 匹配：(http.host eq "%s")\n' "$DOMAIN"
    printf '  Destination port / 目标端口：%s\n' "$PORT"
    if [[ $TLS_MODE == custom ]]; then
      printf '  SSL/TLS：Full (strict)，源站证书需覆盖该域名\n'
    else
      printf '  SSL/TLS：Full（自签名源站证书，暂不使用 Full strict）\n'
    fi
    printf '  开启 Always Use HTTPS 与 WebSockets；公网 URL 不要附加回源端口\n'
    printf '  放行服务器 TCP %s；Cloudflare 设置由你在控制台完成\n' "$PORT"
  elif [[ $MODE == proxy ]]; then
    printf '反向代理或 Tunnel 目标：http://127.0.0.1:%s；公网须为 HTTPS，并支持 WebSocket。\n' "$PORT"
  else
    printf '本机测试地址：http://localhost:%s；仅 loopback/SSH 隧道，不支持 iOS 在线安装。\n' "$PORT"
  fi
}

menu() {
  [[ -t 0 ]] || die '菜单需要交互终端；也可直接执行 assppweb status 等命令'
  local selection action
  while true; do
    printf '\n========== AssppWeb 管理菜单 ==========\n'
    printf ' 1) 状态            2) 启动            3) 停止\n'
    printf ' 4) 重启            5) 查看日志        6) 更新镜像\n'
    printf ' 7) 回滚镜像        8) 备份数据        9) 修改域名/端口/下载配置\n'
    printf '10) 修改用户名密码 11) 查看回源说明   12) 导入 Origin CA 证书\n'
    printf '13) 卸载（保留数据）                  0) 退出\n'
    printf '14) 启用/升级服务端账号同步\n'
    read -r -p '请选择：' selection || return 0
    case "$selection" in
      1) action=status ;; 2) action=start ;; 3) action=stop ;; 4) action=restart ;;
      5) action=logs ;; 6) action=update ;; 7) action=rollback ;; 8) action=backup ;;
      9) action=config ;; 10) action=passwd ;; 11) action=info ;;
      12)
        read -r -p '源站证书 PEM 文件绝对路径：' CERT_FILE
        read -r -p '源站私钥文件绝对路径：' KEY_FILE
        if bash "$INSTALL_DIR/assppweb.sh" config --dir "$INSTALL_DIR" --cert "$CERT_FILE" --key "$KEY_FILE" --yes; then :; else log '证书配置失败，请检查提示'; fi
        continue ;;
      13) action=uninstall ;;
      14) action=enable-sync ;;
      0) return 0 ;;
      *) log '无效选项'; continue ;;
    esac
    if bash "$INSTALL_DIR/assppweb.sh" "$action" --dir "$INSTALL_DIR"; then :; else log '操作未成功，请查看上方错误信息'; fi
  done
}

main() {
  parse_args "$@"
  if [[ -f "$INSTALL_DIR/.assppweb-managed" && ( $# == 0 || $1 == --* ) ]]; then COMMAND=menu; fi
  require_linux_root
  if [[ $COMMAND == install ]]; then
    assert_new_directory
    prompt_settings
    validate_settings
    prepare_password
    install_docker
    docker_ready
    if [[ $SYNC_ENABLED == 1 ]]; then build_sync; fi
    [[ -z $(docker ps -aq --filter label=com.docker.compose.project=assppweb) ]] || die '已存在名为 assppweb 的 Compose 项目；请管理现有部署'
    hash_password
    initialize_config
    lock_operation
    install_shortcut
    validate_config "$INSTALL_DIR"
    if [[ $SYNC_ENABLED == 1 ]]; then compose pull caddy; else compose pull; fi
    compose up -d --wait --wait-timeout 180
    log '应用及认证入口的容器健康检查通过'
    show_info
    return
  fi
  require_managed
  load_settings
  parse_args "$@"
  case "$COMMAND" in
    menu) menu; return ;;
    info) show_info; return ;;
  esac
  docker_ready
  case "$COMMAND" in status|logs) ;; *) lock_operation ;; esac
  case "$COMMAND" in
    config|passwd)
      if [[ $COMMAND == config ]]; then
        prompt_settings
      elif [[ $ASSUME_YES == 0 && -t 0 ]]; then
        prompt_value '登录用户名' "$USERNAME" USERNAME
      fi
      validate_settings
      if [[ $COMMAND == passwd || -n $PASSWORD_FILE ]]; then
        prepare_password
        hash_password
      else
        ACCESS_PASSWORD=$(cat "$INSTALL_DIR/access-password")
        AUTH_HASH=$(cat "$INSTALL_DIR/auth.hash")
      fi
      apply_configuration ;;
    update) update ;;
    enable-sync) enable_sync ;;
    rollback)
      [[ -f "$INSTALL_DIR/.rollback.yml" ]] || die '没有可用的镜像回滚记录'
      cp -- "$INSTALL_DIR/.rollback.yml" "$INSTALL_DIR/.active-override.yml"
      compose up -d --wait --wait-timeout 180
      log '已回滚镜像；本操作不回滚数据' ;;
    start) compose up -d --wait --wait-timeout 180 ;;
    stop) compose stop ;;
    restart) compose restart ;;
    status) compose ps ;;
    logs) compose logs --tail 100 -f ;;
    backup) backup ;;
    uninstall) compose down; log "已移除容器与网络，全部数据保留在 ${INSTALL_DIR}；仍可使用 assppweb start 恢复" ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
