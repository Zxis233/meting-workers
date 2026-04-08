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

| 变量名                     | 说明                                                            | 默认值     |
| -------------------------- | --------------------------------------------------------------- | ---------- |
| `SECRET_DOMAIN`            | 允许访问的域名白名单，逗号分隔                                  | 无         |
| `DEBUG_ALLOW_ALL_REFERERS` | 本地调试时跳过 `Origin/Referer` 校验                            | `false`    |
| `AUTH_ENABLED` / `AUTH`    | 可选，显式开启鉴权，语义对齐原项目 `AUTH`                       | 空         |
| `AUTH_SECRET`              | 鉴权密钥；若未显式配置 `AUTH_ENABLED`，设置了它也会自动开启鉴权 | 空         |
| `DEFAULT_SERVER`           | 默认音乐源                                                      | `netease`  |
| `DEFAULT_BR`               | 目标音质，单位 kbps                                             | `320`      |
| `CACHE_MAX_AGE`            | Worker 响应缓存秒数                                             | `300`      |
| `PICSIZE`                  | 封面尺寸，例如 `300`、`500`                                     | `300`      |
| `LRCTYPE`                  | `0=原歌词`，`1=原文+翻译合并`，`2=仅翻译`                       | `0`        |
| `NETEASE_COOKIE`           | 可选，网易云 Cookie                                             | 内置默认值 |
| `TENCENT_COOKIE`           | 可选，QQ 音乐 Cookie                                            | 内置默认值 |

说明：

- `CACHE_MAX_AGE` 不建议设太大，音频直链本身会过期。
- 如果你只服务自己站点，建议把 `SECRET` 只填精确域名或 IP。
- 代码里额外支持 `*.example.com` 这种通配规则。

## 本地调试

1. 复制配置示例

```bash
cd cloudflare-worker
cp .dev.vars.example .dev.vars
cp wrangler.toml.example wrangler.toml
```

2. 按需修改 `.dev.vars`

```txt
SECRET=blog.esing.dev,192.168.31.222
DEBUG_ALLOW_ALL_REFERERS=true
AUTH_ENABLED=true
AUTH_SECRET=meting-secret
DEFAULT_BR=320
CACHE_MAX_AGE=300
PICSIZE=300
LRCTYPE=0
```

3. 本地启动

```bash
wrangler dev
```

本地调试时，如果你希望跳过来源校验，把 `DEBUG_ALLOW_ALL_REFERERS=true` 即可。

## 部署

```bash
cd cloudflare-worker
cp wrangler.toml.example wrangler.toml
wrangler secret put SECRET
wrangler secret put AUTH_SECRET
wrangler secret put NETEASE_COOKIE
wrangler secret put TENCENT_COOKIE
wrangler deploy
```

其中：

- `AUTH_ENABLED` 建议直接写在 `wrangler.toml` 的 `[vars]`
- `AUTH_SECRET`、`NETEASE_COOKIE`、`TENCENT_COOKIE` 建议用 `wrangler secret put`

## 设计说明

- `type=song` 的输出结构改成更接近老版 Meting API 的 `title` / `author` / `url` / `pic` / `lrc`。
- `type=song` 只取歌曲元数据，`url` / `pic` / `lrc` 的真实内容改由二级接口返回。
- 白名单校验放在缓存读取之前，避免缓存命中绕过来源限制。
- 鉴权语义对齐原项目：只对 `url` / `pic` / `lrc` 强制校验 `auth`，`song` 只负责生成带签名的二级链接。
- 如果启用了 `AUTH_ENABLED`（或直接配置了 `AUTH_SECRET`），会仿照原项目对 `url` / `pic` / `lrc` 生成 HMAC-SHA1 `auth` 参数；缺失或错误签名会返回 `403 {"error":"非法请求"}`。
- 缓存使用 `caches.default`，缓存键会包含 `type`、`server`、`id`、`DEFAULT_BR`、`PICSIZE`、`LRCTYPE`。

## 已知限制

- 网易云加密逻辑已经迁到 Worker 里，但仍依赖上游接口可用性。
- QQ 音乐部分歌曲可能依赖可用 Cookie。
- 当前没有做请求限流；如果要继续收敛公开访问，建议后续接入 Cloudflare Rate Limiting 或 Turnstile。
