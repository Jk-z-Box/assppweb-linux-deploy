# 家庭共享验证记录

2026-10-24，基于部署版 v1.3.0 的实际账号与 Apple 服务验证。本文不包含账号、设备标识、Cookie、令牌或 Apple 原始私有响应。

## 已验证的结果

- 成员账号发起家庭查询，Apple 返回 `status: 0`、两个家庭成员，双方 `sharingPurchases: true`，`membershipStatus: "1"`。
- 家庭信息中的购买者与成员标识均匹配相应已登录账号；两者均为美国商店。
- 成员对 Shadowrocket 的普通 `ent/download` 请求返回 `9610`。
- 使用成员自身令牌、GUID 和 kbsync，附加原购买者标识 `ownerDsid`，仍返回 `9610`；附加 `X-FM-Dsid` 的试验也未取得下载链接。
- 旧 `r/redownload` 在 iTunes 请求配置下返回 `AMD-Action::SP`，有无 SAP 请求签名均未取得下载链接；Configurator 请求配置返回空 HTTP 403。这里不推定 `AMD-Action::SP` 的含义。
- 购买项目页面要求重新登录。没有通过该页面取得可用的家庭下载参数。

这些结果确认了家庭关系和共享开关，但**没有确认成员对具体应用的下载授权，也没有生成或验证成员授权 IPA**。家庭关系检测不能代替 Apple 的应用授权校验。

## v1.3.1 实现范围

账号详情新增按需家庭查询，展示 Apple 返回的成员、当前账号、有效成员关系和购买共享开关。错误不再一律解释为“必须先购买”；界面明确说明成员授权下载尚未支持。

查询使用：

```text
GET https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/familyInfo
User-Agent: Configurator/2.18 (Macintosh; OS X 15.3.2; 24D81) AppleWebKit/0620.2.4.11.6
X-Apple-Store-Front: <当前账号商店>-1
X-Dsid: <当前账号 DSID>
Cookie: <按域名、路径、有效期筛选的当前账号 Cookie>
Accept: application/json
```

请求无正文、无查询参数，不携带密码，也不需要 `X-Token`。使用其他客户端配置的初始请求曾返回 2002；对照测试显示，在上述成功配置上添加 `X-Token` 仍成功，因此不能把 2002 单独归因于该头。

响应只提取展示所需字段，不保存家庭原始响应，不将家庭 ID 当成许可，不更换下载者的认证身份。解析会拒绝错误状态、过大或格式异常的响应、重复或不安全的账号标识、以及不包含当前账号的非空成员列表。账号切换、重新认证和页面卸载后不会显示过时查询结果。

Wisp 仅增加精确主机 `play.itunes.apple.com`，继续限制 443 端口和禁止直接 IP、回环地址。

## 本地验证

前端 213 项、后端 58 项、部署管理器 39 项、Cookie 入口 17 项测试全部通过（共 327 项）；前后端生产构建通过。完整固定上游源码与补丁接入验证通过，已有 v1.3.0 发行文件未改写。

## 尚待验证

完整成员下载需要 Apple 接受成员会话与购买来源，并返回可验证的安装包及授权元数据。仅添加购买者标识未能通过验证。不能把使用购买者账号下载的 IPA 标为成员的家庭共享下载，也不能靠修改 IPA 元数据构造授权。

后续只有在真实成员请求成功后，才接入共享来源选择、下载任务归属和安装验证。目前可使用原购买账号的普通下载，或 Apple 官方家庭购买项目流程。

参考：[Apple 家庭购买项目下载说明](https://support.apple.com/102599)、[ipatool 家庭共享需求 #206](https://github.com/majd/ipatool/issues/206)、[Shadowrocket App Store 页面](https://apps.apple.com/us/app/shadowrocket/id932747118)。
