# Cloudflare Worker 版简化 Meting API

这个版本只保留单曲解析能力，目标是部署到 Cloudflare Workers 后，尽量兼容原本 Meting API 的单曲接口风格。

和当前 PHP 版相比，删掉了这些能力：

- `playlist`
- `search`
- `name/artist/album/url/pic/lrc` 分路由输出
- `handsome`
- `yrc/qrc` 逐字歌词
- PHP 侧的 APCu / 文件缓存 / PV 统计

保留并重构的能力：

- `netease` / `tencent` 单曲解析
- `Referer` / `Origin` 白名单
- Cloudflare Cache API 缓存
- 网易云 Cookie 定时检查与手动刷新到 KV
- 环境变量控制音质、缓存时间、歌词模式、调试白名单绕过

## 路由

支持两个入口：

- `GET /?server=netease&type=song&id=2608813265`
- `GET /song?server=netease&type=song&id=2608813265`

说明：

- `id` 必填
- `server` 选填，支持 `netease` / `tencent`，默认 `netease`
- `type` 支持 `song` / `url` / `pic` / `lrc`，默认 `song`

## 返回格式

`type=song` 返回风格对齐原 Meting API，返回当前 Worker 自己的二级接口地址。

```json
[
  {
    "title": "歌曲名",
    "author": "歌手1/歌手2",
    "url": "https://your-worker.example/?server=netease&type=url&id=123&auth=...",
    "pic": "https://your-worker.example/?server=netease&type=pic&id=456&auth=...",
    "lrc": "https://your-worker.example/?server=netease&type=lrc&id=123&auth=..."
  }
]
```

各 type 的行为：

- `type=song` 返回 JSON 数组
- `type=url` 返回 302 到真实音频地址
- `type=pic` 返回 302 到真实封面地址
- `type=lrc` 返回纯文本歌词

## 环境变量

`SECRET_DOMAIN` 是关键配置，按你的需求，它保存允许访问的域名列表，逗号分隔：

```txt
blog.esing.dev,192.168.31.222
```

Worker 会校验请求头里的 `Origin` 和 `Referer`，只要其中任意一个 host 命中白名单即可放行。

可用变量如下：

| 变量名                           | 说明                                                            | 默认值                                                           |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `SECRET_DOMAIN`                  | 允许访问的域名白名单，逗号分隔                                  | 无                                                               |
| `DEBUG_ALLOW_ALL_REFERERS`       | 本地调试时跳过 `Origin/Referer` 校验                            | `false`                                                          |
| `AUTH_ENABLED` / `AUTH`          | 可选，显式开启鉴权，语义对齐原项目 `AUTH`                       | 空                                                               |
| `AUTH_SECRET`                    | 鉴权密钥；若未显式配置 `AUTH_ENABLED`，设置了它也会自动开启鉴权 | 空                                                               |
| `DEFAULT_SERVER`                 | 默认音乐源                                                      | `netease`                                                        |
| `DEFAULT_BR`                     | 目标音质，单位 kbps                                             | `320`                                                            |
| `CACHE_MAX_AGE`                  | Worker 响应缓存秒数                                             | `300`                                                            |
| `PICSIZE`                        | 封面尺寸，例如 `300`、`500`                                     | `300`                                                            |
| `LRCTYPE`                        | `0=原歌词`，`1=原文+翻译合并`，`2=仅翻译`                       | `0`                                                              |
| `NETEASE_COOKIE`                 | 可选，网易云 Cookie                                             | 内置默认值                                                       |
| `TENCENT_COOKIE`                 | 可选，QQ 音乐 Cookie                                            | 内置默认值                                                       |
| `NETEASE_COOKIE_CHECK_URL`       | 可选，Cron 和 `/api/check` 用于检查 Cookie 的歌曲接口           | `https://meting.esing.dev/?server=netease&type=song&id=31134338` |
| `NETEASE_COOKIE_REFRESH_ENABLED` | 可选，保留项；手动刷新接口会强制执行                            | `true`                                                           |
| `NETEASE_COOKIE_KV_KEY`          | 可选，KV 中保存网易云 Cookie 的 key                             | `NETEASE_COOKIE`                                                 |
| `NETEASE_COOKIE_META_KV_KEY`     | 可选，KV 中保存刷新元信息的 key                                 | `NETEASE_COOKIE_META`                                            |
| `TELEGRAM_BOT_ID`                | 可选，Telegram Bot API Token；也兼容 `TELEGRAM_BOT_TOKEN`       | 空                                                               |
| `TELEGRAM_CHAT_ID`               | 可选，Telegram Chat ID；与 Bot ID 同时非空才启用推送            | 空                                                               |

说明：

- `CACHE_MAX_AGE` 不建议设太大，音频直链本身会过期。
- 如果你只服务自己站点，建议把 `SECRET_DOMAIN` 只填精确域名或 IP。
- 代码里额外支持 `*.example.com` 这种通配规则。

## 网易云 Cookie 定时检查与手动刷新

Worker 运行时不能写回 `NETEASE_COOKIE` Secret，因此刷新后的 Cookie 使用 KV 持久化：

1. 普通请求优先读取 `METING_COOKIE_KV` 里的 `NETEASE_COOKIE`。
2. KV 中没有 Cookie 时，回退到 `NETEASE_COOKIE` Secret。
3. Cron 不再自动重新登录，而是在当前 Worker 内部按 `NETEASE_COOKIE_CHECK_URL` 的参数执行 `type=song` 检查。
4. 检查逻辑会解析 `type=song` 返回的第一首歌曲 `url` 字段，并在当前 Worker 内部解析该二级 `url`。
5. 如果歌曲 `url` 返回 302/3xx，会读取 `Location`，再请求 `Location` 指向的真实音频地址。
6. 真实音频地址响应不是 4xx/5xx 时判定正常；4xx/5xx、缺少 `url`、缺少 `Location` 或请求异常会判定失败。
7. 手动刷新成功后，会把上游返回的 `Set-Cookie` 合并到当前 Cookie，再只提取 `MUSIC_U` 写回 KV。

需要先创建或准备一个 KV namespace。你已经创建的名称可以叫 `meting`，但 Wrangler 绑定部署时需要 namespace `id`，不能只写名称。

```bash
wrangler kv namespace list
```

公开仓库不要把 namespace id 写进 `wrangler.toml`。部署前用环境变量或 CI Secret 生成私有配置：

```bash
METING_KV_NAMESPACE_ID=你的_namespace_id node scripts/generate-wrangler-config.mjs
wrangler deploy --config .wrangler/wrangler.generated.toml
```

`.wrangler/` 已经被 `.gitignore` 忽略。初始 `NETEASE_COOKIE` 需要是登录后的网页端 Cookie，至少应包含 `MUSIC_U`。

可以手动触发一次 Cookie 检查：

```bash
curl -H "Authorization: Bearer your-auth-secret" \
  https://your-worker.example/api/check
```

`/api/check` 支持 `GET` / `POST`，会复用 `AUTH_SECRET` 做 Bearer 校验。它会在当前 Worker 内部复用歌曲接口和二级 `url` 接口逻辑，避免部署后 Worker 通过公网请求自身域名；如果二级接口返回 302/3xx，会继续请求 `Location` 指向的真实音频地址，并返回各段状态、脱敏 URL 和检查结果。

手动检查时可以通过 `id` 临时指定歌曲：

```bash
curl -H "Authorization: Bearer your-auth-secret" \
  "https://your-worker.example/api/check?id=31134338"
```

检查真实音频地址时只带 `Accept` 和 `Range`，不附加站点 `Origin` / `Referer`。

也可以手动触发一次刷新：

```bash
curl -H "Authorization: Bearer your-auth-secret" \
  https://your-worker.example/api/relogin/163
```

手动刷新接口支持 `GET` / `POST`，会复用 `AUTH_SECRET` 做 Bearer 校验。成功时返回 JSON，包含 HTTP 状态码、刷新时间、网易云上游状态、写入的 KV key，以及 Cookie 的脱敏摘要，例如长度、SHA-256、包含的 Cookie 名称和预览。刷新后写入 KV 的 Cookie 只保留 `MUSIC_U`，接口不会返回完整登录 Cookie。

也可以手动写入一个新的 `MUSIC_U` 到 KV：

```bash
curl -H "Authorization: Bearer your-auth-secret" \
  "https://your-worker.example/api/putcookie?MUSIC_U=your-url-encoded-music-u"
```

`/api/putcookie` 支持 `GET` / `POST`，会复用 `AUTH_SECRET` 做 Bearer 校验。它会把 KV 中的网易云 Cookie 写成 `MUSIC_U=...`，并同步更新刷新元信息；响应只返回脱敏摘要，不返回完整 Cookie。`MUSIC_U` 参数如果包含特殊字符，需要先做 URL 编码。

如果同时配置了 `TELEGRAM_BOT_ID` 和 `TELEGRAM_CHAT_ID`，Cookie 定时检查成功或失败时会向对应 Chat 推送关键信息，包括时间、状态码、检查接口、歌曲 URL 响应、Location、真实音频响应和触发方式；手动刷新成功或失败时也会推送原来的刷新信息。推送内容不会包含完整 Cookie、Bot Token 或未脱敏的 `auth` 参数。

可以用固定测试文本验证 Telegram 配置：

```bash
curl -H "Authorization: Bearer your-auth-secret" \
  https://your-worker.example/api/push
```

`/api/push` 支持 `GET` / `POST`，同样复用 `AUTH_SECRET` 做 Bearer 校验；它只发送代码内置的固定文本，不读取请求体。

## 本地调试

1. 复制配置示例

```bash
cd meting-workers
cp .dev.vars.example .dev.vars
cp wrangler.toml.example wrangler.toml
```

2. 按需修改 `.dev.vars`

```txt
SECRET_DOMAIN=blog.esing.dev,192.168.31.222
DEBUG_ALLOW_ALL_REFERERS=true
AUTH_ENABLED=true
AUTH_SECRET=meting-secret
DEFAULT_BR=320
CACHE_MAX_AGE=300
PICSIZE=300
LRCTYPE=0
NETEASE_COOKIE_CHECK_URL=https://meting.esing.dev/?server=netease&type=song&id=31134338
NETEASE_COOKIE_REFRESH_ENABLED=true
TELEGRAM_BOT_ID=
TELEGRAM_CHAT_ID=
```

3. 本地启动

```bash
wrangler dev
```

本地调试时，如果你希望跳过来源校验，把 `DEBUG_ALLOW_ALL_REFERERS=true` 即可。

## 部署

```bash
cd meting-workers
cp wrangler.toml.example wrangler.toml
wrangler secret put SECRET_DOMAIN
wrangler secret put AUTH_SECRET
wrangler secret put NETEASE_COOKIE
wrangler secret put TENCENT_COOKIE
METING_KV_NAMESPACE_ID=你的_namespace_id node scripts/generate-wrangler-config.mjs
wrangler deploy --config .wrangler/wrangler.generated.toml
```

如需启用 Telegram 推送，再额外配置：

```bash
wrangler secret put TELEGRAM_BOT_ID
wrangler secret put TELEGRAM_CHAT_ID
```

其中：

- `AUTH_ENABLED` 建议直接写在 `wrangler.toml` 的 `[vars]`
- `AUTH_SECRET`、`NETEASE_COOKIE`、`TENCENT_COOKIE` 建议用 `wrangler secret put`
- `NETEASE_COOKIE` 是初始登录 Cookie；手动刷新后的 Cookie 只提取 `MUSIC_U` 并保存在 KV 中
- `TELEGRAM_BOT_ID`、`TELEGRAM_CHAT_ID` 是可选配置；两者都配置后才会启用检查和手动刷新推送
- `METING_KV_NAMESPACE_ID` 建议放在 GitHub Actions Secret 或本机环境变量，不提交到仓库

## 设计说明

- `type=song` 的输出结构改成更接近老版 Meting API 的 `title` / `author` / `url` / `pic` / `lrc`。
- `type=song` 只取歌曲元数据，`url` / `pic` / `lrc` 的真实内容改由二级接口返回。
- 白名单校验放在缓存读取之前，避免缓存命中绕过来源限制。
- 鉴权语义对齐原项目：只对 `url` / `pic` / `lrc` 强制校验 `auth`，`song` 只负责生成带签名的二级链接。
- 如果启用了 `AUTH_ENABLED`（或直接配置了 `AUTH_SECRET`），会对 `url` / `pic` / `lrc` 生成 HMAC-SHA256 `auth` 参数；缺失或错误签名会返回 `403 {"error":"非法请求"}`。
- 缓存使用 `caches.default`，缓存键会包含 `type`、`server`、`id`、`DEFAULT_BR`、`PICSIZE`、`LRCTYPE`。
- 网易云 Cookie 使用顺序是 KV 优先，其次 `NETEASE_COOKIE` Secret，最后内置默认 Cookie。

## 已知限制

- 网易云加密逻辑已经迁到 Worker 里，但仍依赖上游接口可用性。
- 原 PHP 仓库没有网易云 Cookie 续签代码；这里新增的是 Worker 侧的网页端 Cookie 刷新逻辑。
- QQ 音乐部分歌曲可能依赖可用 Cookie。
- 当前没有做请求限流；如果要继续收敛公开访问，建议后续接入 Cloudflare Rate Limiting 或 Turnstile。
