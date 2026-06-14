const NETEASE_MODULUS = '157794750267131502212476817800345498121872783333389747424011531025366277535262539913701806290766479189477533597854989606803194253978660329941980786072432806427833685472618792592200595694346872951301770580765135349259590167490536138082469680638514416594216629258349130257685001248172188325316586707301643237607';
const NETEASE_PUBKEY = 65537n;
const NETEASE_NONCE = '0CoJUm6Qyw8W8jud';
const NETEASE_IV = '0102030405060708';

const DEFAULT_NETEASE_COOKIE = 'appver=8.2.30; os=iPhone OS; osver=15.0; EVNSM=1.0.0; buildver=2206; channel=distribution; machineid=iPhone13.3';
const DEFAULT_NETEASE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CloudMusic/0.1.1 NeteaseMusic/8.2.30';
const DEFAULT_NETEASE_REFRESH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TENCENT_COOKIE = 'pgv_pvi=22038528; pgv_si=s3156287488; pgv_pvid=5535248600; yplayer_open=1; ts_last=y.qq.com/portal/player.html; ts_uid=4847550686; yq_index=0; qqmusic_fromtag=66; player_exist=1';
const DEFAULT_TENCENT_UA = 'QQ音乐/54409 CFNetwork/901.1 Darwin/17.6.0 (x86_64)';
const DEFAULT_NETEASE_COOKIE_KV_KEY = 'NETEASE_COOKIE';
const DEFAULT_NETEASE_COOKIE_META_KV_KEY = 'NETEASE_COOKIE_META';
const AUTH_SIGNATURE_VERSION = 'hmac-sha256-v1';
const COOKIE_ATTRIBUTE_NAMES = new Set(['domain', 'path', 'expires', 'max-age', 'httponly', 'secure', 'samesite', 'priority']);
const TELEGRAM_PUSH_TEST_MESSAGE = 'Meting Worker Telegram 推送测试';
const TELEGRAM_MESSAGE_MAX_LENGTH = 4000;
const DEFAULT_NETEASE_COOKIE_CHECK_URL = 'https://meting.esing.dev/?server=netease&type=song&id=31134338';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export default {
    async fetch(request, env, ctx) {
        try {
            return await handleRequest(request, env, ctx);
        } catch (error) {
            if (error instanceof ApiError) {
                return jsonResponse({ error: error.message }, error.status, {
                    'Cache-Control': 'no-store',
                });
            }
            console.error(error);
            return jsonResponse({ error: '服务内部错误' }, 500, {
                'Cache-Control': 'no-store',
            });
        }
    },

    async scheduled(controller, env, ctx) {
        ctx.waitUntil(checkNeteaseCookie(env, {
            scheduledTime: controller.scheduledTime,
            cron: controller.cron,
        }));
    },
};

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/relogin/163') {
        return handleManualNeteaseRelogin(request, env);
    }

    if (url.pathname === '/api/check') {
        return handleManualNeteaseCookieCheck(request, env);
    }

    if (url.pathname === '/api/putcookie') {
        return handleManualNeteaseCookiePut(request, env);
    }

    if (url.pathname === '/api/push') {
        return handleTelegramPushTest(request, env);
    }

    if (request.method === 'OPTIONS') {
        return handleOptions(request, env);
    }

    if (request.method !== 'GET') {
        return jsonResponse({ error: '仅支持 GET 和 OPTIONS 请求' }, 405, {
            Allow: 'GET, OPTIONS',
            'Cache-Control': 'no-store',
        });
    }

    if (url.pathname === '/health') {
        return jsonResponse(
            {
                ok: true,
                time: new Date().toISOString(),
            },
            200,
            {
                'Cache-Control': 'no-store',
            }
        );
    }

    if (!isSongRoute(url.pathname)) {
        return jsonResponse({ error: '未找到对应路由' }, 404, {
            'Cache-Control': 'no-store',
        });
    }

    const authResult = authorizeRequest(request, env);
    if (!authResult.allowed) {
        return jsonResponse({ error: authResult.reason }, 403, {
            'Cache-Control': 'no-store',
        });
    }

    const config = readConfig(url, env);
    if (!config.id) {
        return jsonResponse({ error: '缺少歌曲 ID' }, 400, {
            'Cache-Control': 'no-store',
        });
    }

    if (!/^[0-9A-Za-z_]+$/.test(config.id)) {
        return jsonResponse({ error: '歌曲 ID 格式不合法' }, 400, {
            'Cache-Control': 'no-store',
        });
    }

    if (!['song', 'url', 'pic', 'lrc'].includes(config.type)) {
        return jsonResponse({ error: '不支持的 type' }, 400, {
            'Cache-Control': 'no-store',
        });
    }

    const authCheck = await verifyTypeAuth(request, config, env);
    if (!authCheck.allowed) {
        return jsonResponse({ error: authCheck.reason }, 403, {
            'Cache-Control': 'no-store',
        });
    }

    const cacheKey = buildCacheKey(request, config, env);
    if (config.cacheMaxAge > 0) {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
            return cloneResponse(cached, {
                'X-Meting-Cache': 'HIT',
                'X-Meting-Server': config.server,
            });
        }
    }

    const response = await handleApiType(request, config, env);
    response.headers.set('X-Meting-Cache', 'MISS');
    response.headers.set('X-Meting-Server', config.server);
    response.headers.set('Cache-Control', buildCacheControl(config.cacheMaxAge));

    if (config.cacheMaxAge > 0) {
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    }

    return response;
}

function handleOptions(request, env) {
    const authResult = authorizeRequest(request, env);
    if (!authResult.allowed) {
        return jsonResponse({ error: authResult.reason }, 403, {
            'Cache-Control': 'no-store',
        });
    }

    return new Response(null, {
        status: 204,
        headers: createCorsHeaders({
            'Access-Control-Max-Age': '86400',
            'Cache-Control': 'public, max-age=86400',
        }),
    });
}

async function handleManualNeteaseRelogin(request, env) {
    const now = new Date().toISOString();

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: createCorsHeaders({
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Max-Age': '86400',
                'Cache-Control': 'public, max-age=86400',
            }),
        });
    }

    if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 405,
                timestamp: now,
                error: '仅支持 GET 或 POST 手动刷新',
            },
            405,
            {
                Allow: 'GET, POST',
                'Cache-Control': 'no-store',
            }
        );
    }

    const authResult = await verifyBearerAuthorization(request, env);
    if (!authResult.allowed) {
        return jsonResponse(
            {
                ok: false,
                statusCode: authResult.status,
                timestamp: now,
                error: authResult.reason,
            },
            authResult.status,
            {
                ...(authResult.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
                'Cache-Control': 'no-store',
            }
        );
    }

    const result = await refreshNeteaseCookie(
        env,
        {
            manual: true,
            path: new URL(request.url).pathname,
            requestedAt: now,
        },
        {
            force: true,
            includeWriteDetails: true,
        }
    );
    const statusCode = result.statusCode || (result.ok ? 200 : 500);

    return jsonResponse(
        {
            ...result,
            statusCode,
            timestamp: result.timestamp || now,
        },
        statusCode,
        {
            'Cache-Control': 'no-store',
        }
    );
}

async function handleManualNeteaseCookieCheck(request, env) {
    const now = new Date().toISOString();

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: createCorsHeaders({
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Max-Age': '86400',
                'Cache-Control': 'public, max-age=86400',
            }),
        });
    }

    if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 405,
                timestamp: now,
                error: '仅支持 GET 或 POST 手动检查',
            },
            405,
            {
                Allow: 'GET, POST',
                'Cache-Control': 'no-store',
            }
        );
    }

    const authResult = await verifyBearerAuthorization(request, env);
    if (!authResult.allowed) {
        return jsonResponse(
            {
                ok: false,
                statusCode: authResult.status,
                timestamp: now,
                error: authResult.reason,
            },
            authResult.status,
            {
                ...(authResult.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
                'Cache-Control': 'no-store',
            }
        );
    }

    const requestUrl = new URL(request.url);
    const checkSongId = (requestUrl.searchParams.get('id') || '').trim();
    if (checkSongId && !/^[0-9A-Za-z_]+$/.test(checkSongId)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 400,
                timestamp: now,
                error: '歌曲 ID 格式不合法',
            },
            400,
            {
                'Cache-Control': 'no-store',
            }
        );
    }

    const result = await checkNeteaseCookie(env, {
        manual: true,
        path: requestUrl.pathname,
        requestedAt: now,
        id: checkSongId || null,
    });
    const statusCode = result.statusCode || (result.ok ? 200 : 502);

    return jsonResponse(
        {
            ...result,
            statusCode,
            timestamp: result.timestamp || now,
        },
        statusCode,
        {
            'Cache-Control': 'no-store',
        }
    );
}

async function handleManualNeteaseCookiePut(request, env) {
    const now = new Date().toISOString();

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: createCorsHeaders({
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Max-Age': '86400',
                'Cache-Control': 'public, max-age=86400',
            }),
        });
    }

    if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 405,
                timestamp: now,
                error: '仅支持 GET 或 POST 写入 Cookie',
            },
            405,
            {
                Allow: 'GET, POST',
                'Cache-Control': 'no-store',
            }
        );
    }

    const authResult = await verifyBearerAuthorization(request, env);
    if (!authResult.allowed) {
        return jsonResponse(
            {
                ok: false,
                statusCode: authResult.status,
                timestamp: now,
                error: authResult.reason,
            },
            authResult.status,
            {
                ...(authResult.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
                'Cache-Control': 'no-store',
            }
        );
    }

    const kv = getCookieKv(env);
    if (!kv) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 500,
                timestamp: now,
                error: '未绑定 METING_COOKIE_KV 或 COOKIE_KV',
            },
            500,
            {
                'Cache-Control': 'no-store',
            }
        );
    }

    const url = new URL(request.url);
    const musicU = normalizeNeteaseMusicUInput(url.searchParams.get('MUSIC_U') || url.searchParams.get('music_u') || '');
    if (!musicU) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 400,
                timestamp: now,
                error: '缺少 MUSIC_U 参数',
            },
            400,
            {
                'Cache-Control': 'no-store',
            }
        );
    }

    if (!isValidNeteaseMusicUValue(musicU)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 400,
                timestamp: now,
                error: 'MUSIC_U 参数格式不合法',
            },
            400,
            {
                'Cache-Control': 'no-store',
            }
        );
    }

    const cookieKey = getNeteaseCookieKvKey(env);
    const metaKey = getNeteaseCookieMetaKvKey(env);
    const cookieValue = `MUSIC_U=${musicU}`;
    const metadata = {
        updatedAt: now,
        manual: true,
        path: url.pathname,
        source: 'manual_put_cookie',
        storedCookieNames: ['MUSIC_U'],
    };

    await Promise.all([
        kv.put(cookieKey, cookieValue),
        kv.put(metaKey, JSON.stringify(metadata)),
    ]);

    return jsonResponse(
        {
            ok: true,
            statusCode: 200,
            timestamp: now,
            storedCookieNames: ['MUSIC_U'],
            kv: {
                binding: getCookieKvBindingName(env),
                writes: await describeNeteaseCookieKvWrites(cookieKey, cookieValue, metaKey, metadata),
            },
        },
        200,
        {
            'Cache-Control': 'no-store',
        }
    );
}

async function handleTelegramPushTest(request, env) {
    const now = new Date().toISOString();

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: createCorsHeaders({
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                'Access-Control-Max-Age': '86400',
                'Cache-Control': 'public, max-age=86400',
            }),
        });
    }

    if (!['GET', 'POST'].includes(request.method)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 405,
                timestamp: now,
                error: '仅支持 GET 或 POST 推送测试',
            },
            405,
            {
                Allow: 'GET, POST',
                'Cache-Control': 'no-store',
            }
        );
    }

    const authResult = await verifyBearerAuthorization(request, env);
    if (!authResult.allowed) {
        return jsonResponse(
            {
                ok: false,
                statusCode: authResult.status,
                timestamp: now,
                error: authResult.reason,
            },
            authResult.status,
            {
                ...(authResult.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
                'Cache-Control': 'no-store',
            }
        );
    }

    if (!isTelegramPushEnabled(env)) {
        return jsonResponse(
            {
                ok: false,
                statusCode: 503,
                timestamp: now,
                error: 'TELEGRAM_BOT_ID 和 TELEGRAM_CHAT_ID 未完整配置',
            },
            503,
            {
                'Cache-Control': 'no-store',
            }
        );
    }

    const result = await sendTelegramMessage(env, TELEGRAM_PUSH_TEST_MESSAGE);
    const statusCode = result.ok ? 200 : 502;

    return jsonResponse(
        {
            ok: result.ok,
            statusCode,
            timestamp: now,
            message: TELEGRAM_PUSH_TEST_MESSAGE,
            telegram: {
                status: result.status,
                ok: result.telegramOk,
                description: result.description || null,
                chatId: redactTelegramChatId(getTelegramChatId(env)),
            },
        },
        statusCode,
        {
            'Cache-Control': 'no-store',
        }
    );
}

function isSongRoute(pathname) {
    return pathname === '/' || pathname === '/song';
}

function readConfig(url, env) {
    return {
        id: (url.searchParams.get('id') || '').trim(),
        type: normalizeType(url.searchParams.get('type')),
        server: normalizeServer(url.searchParams.get('server') || env.DEFAULT_SERVER || 'netease'),
        br: clampInteger(url.searchParams.get('br') || env.DEFAULT_BR, 320, 24, 999999),
        cacheMaxAge: clampInteger(env.CACHE_MAX_AGE, 300, 0, 86400),
        picsize: normalizePictureSize(url.searchParams.get('picsize') || env.PICSIZE),
        lrctype: normalizeLrcType(url.searchParams.get('lrctype') || env.LRCTYPE),
        apiPath: url.pathname,
    };
}

function normalizeType(value) {
    const type = String(value || 'song').trim().toLowerCase();
    return type || 'song';
}

function normalizeServer(value) {
    return value === 'tencent' ? 'tencent' : 'netease';
}

function normalizePictureSize(value) {
    const size = clampInteger(value, 300, 0, 4096);
    return size > 0 ? String(size) : '';
}

function normalizeLrcType(value) {
    const type = String(value || '0').trim();
    if (type === '1' || type === '2') {
        return type;
    }
    return '0';
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function buildCacheKey(request, config, env) {
    const cacheUrl = new URL(request.url);
    cacheUrl.pathname = `/__cache${config.apiPath === '/' ? '' : config.apiPath}`;
    cacheUrl.search = new URLSearchParams({
        type: config.type,
        server: config.server,
        id: config.id,
        br: String(config.br),
        picsize: config.picsize,
        lrctype: config.lrctype,
        auth_enabled: isAuthEnabled(env) ? '1' : '0',
        auth_signature: AUTH_SIGNATURE_VERSION,
    }).toString();
    return new Request(cacheUrl.toString(), { method: 'GET' });
}

function authorizeRequest(request, env) {
    if (isTruthy(env.DEBUG_ALLOW_ALL_REFERERS)) {
        return { allowed: true };
    }

    const allowlist = parseAllowlist(env.SECRET_DOMAIN);
    if (!allowlist.length) {
        return { allowed: false, reason: '未配置允许访问的 Referer 白名单' };
    }

    const incomingHosts = getIncomingHosts(request);
    if (!incomingHosts.length) {
        return { allowed: false, reason: '请求缺少 Origin 或 Referer' };
    }

    for (const incomingHost of incomingHosts) {
        for (const rule of allowlist) {
            if (hostMatches(incomingHost, rule)) {
                return { allowed: true };
            }
        }
    }

    return { allowed: false, reason: '当前 Origin/Referer 不在允许列表中' };
}

function parseAllowlist(raw) {
    return String(raw || '')
        .split(',')
        .map((item) => normalizeHostRule(item))
        .filter(Boolean);
}

function normalizeHostRule(value) {
    let raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }

    const isWildcard = raw.startsWith('*.');
    if (raw.includes('://')) {
        try {
            raw = new URL(raw).hostname.toLowerCase();
        } catch (_) {
            return '';
        }
    } else {
        raw = raw.replace(/^https?:\/\//, '').split('/')[0];
    }

    if (isWildcard && !raw.startsWith('*.')) {
        raw = `*.${raw.replace(/^\*\./, '')}`;
    }

    return raw.replace(/:\d+$/, '');
}

function getIncomingHosts(request) {
    const headers = ['Origin', 'Referer'];
    const hosts = [];

    for (const header of headers) {
        const value = request.headers.get(header);
        if (!value) {
            continue;
        }

        const host = extractHostname(value);
        if (host && !hosts.includes(host)) {
            hosts.push(host);
        }
    }

    return hosts;
}

function extractHostname(value) {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

function hostMatches(hostname, rule) {
    if (rule.startsWith('*.')) {
        const suffix = rule.slice(2);
        return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return hostname === rule;
}

function isTruthy(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isExplicitlyFalse(value) {
    return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function getCookieKv(env) {
    const kv = env && (env.METING_COOKIE_KV || env.COOKIE_KV);
    return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? kv : null;
}

function getCookieKvBindingName(env) {
    if (env && env.METING_COOKIE_KV) {
        return 'METING_COOKIE_KV';
    }
    if (env && env.COOKIE_KV) {
        return 'COOKIE_KV';
    }
    return '';
}

function getNeteaseCookieKvKey(env) {
    return String((env && env.NETEASE_COOKIE_KV_KEY) || DEFAULT_NETEASE_COOKIE_KV_KEY).trim() || DEFAULT_NETEASE_COOKIE_KV_KEY;
}

function getNeteaseCookieMetaKvKey(env) {
    return String((env && env.NETEASE_COOKIE_META_KV_KEY) || DEFAULT_NETEASE_COOKIE_META_KV_KEY).trim() || DEFAULT_NETEASE_COOKIE_META_KV_KEY;
}

function hasNeteaseLoginCookie(cookie) {
    return Boolean(extractCookieValue(cookie, 'MUSIC_U'));
}

function extractNeteaseMusicUCookie(cookie) {
    const musicU = extractCookieValue(cookie, 'MUSIC_U');
    return musicU ? `MUSIC_U=${musicU}` : '';
}

function normalizeNeteaseMusicUInput(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    if (text.includes('=') || text.includes(';')) {
        return extractCookieValue(text, 'MUSIC_U').trim();
    }

    return text;
}

function isValidNeteaseMusicUValue(value) {
    const text = String(value || '');
    return Boolean(text)
        && !/[;\r\n]/.test(text)
        && text.length <= 4096;
}

function extractCookieValue(cookie, name) {
    return parseCookieHeader(cookie).get(name) || '';
}

function parseCookieHeader(cookie) {
    const jar = new Map();
    for (const part of String(cookie || '').split(';')) {
        const item = part.trim();
        const equalIndex = item.indexOf('=');
        if (equalIndex <= 0) {
            continue;
        }

        const key = item.slice(0, equalIndex).trim();
        const value = item.slice(equalIndex + 1).trim();
        if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) {
            continue;
        }

        jar.set(key, value);
    }
    return jar;
}

async function describeNeteaseCookieKvWrites(cookieKey, cookieValue, metaKey, metadata) {
    return [
        {
            key: cookieKey,
            value: await describeCookieValue(cookieValue),
        },
        {
            key: metaKey,
            value: metadata,
        },
    ];
}

async function describeCookieValue(cookieValue) {
    const cookieJar = parseCookieHeader(cookieValue);
    return {
        redacted: true,
        length: String(cookieValue || '').length,
        sha256: await sha256Hex(cookieValue),
        hasMusicU: cookieJar.has('MUSIC_U'),
        cookieNames: Array.from(cookieJar.keys()),
        preview: redactCookieHeader(cookieValue),
    };
}

function redactCookieHeader(cookieValue) {
    const cookieJar = parseCookieHeader(cookieValue);
    return Array.from(cookieJar.keys())
        .map((key) => `${key}=<redacted>`)
        .join('; ');
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value || '')));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function readJsonSafely(response) {
    try {
        return await response.json();
    } catch (_) {
        return null;
    }
}

function getSetCookieHeaders(headers) {
    if (!headers) {
        return [];
    }

    if (typeof headers.getSetCookie === 'function') {
        const values = headers.getSetCookie();
        if (Array.isArray(values) && values.length) {
            return values.filter(Boolean);
        }
    }

    if (typeof headers.getAll === 'function') {
        const values = headers.getAll('Set-Cookie');
        if (Array.isArray(values) && values.length) {
            return values.filter(Boolean);
        }
    }

    const combined = headers.get('Set-Cookie');
    return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function splitCombinedSetCookieHeader(value) {
    const text = String(value || '');
    const parts = [];
    let start = 0;

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== ',') {
            continue;
        }

        const rest = text.slice(index + 1).trimStart();
        if (/^[A-Za-z0-9_.-]+=/.test(rest)) {
            parts.push(text.slice(start, index).trim());
            start = index + 1;
        }
    }

    parts.push(text.slice(start).trim());
    return parts.filter(Boolean);
}

function mergeCookieUpdates(currentCookie, setCookieHeaders) {
    const jar = parseCookieHeader(currentCookie);

    for (const header of setCookieHeaders) {
        const firstPart = String(header || '').split(';')[0].trim();
        const equalIndex = firstPart.indexOf('=');
        if (equalIndex <= 0) {
            continue;
        }

        const key = firstPart.slice(0, equalIndex).trim();
        const value = firstPart.slice(equalIndex + 1).trim();
        if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) {
            continue;
        }

        if (isExpiredSetCookie(header)) {
            jar.delete(key);
        } else {
            jar.set(key, value);
        }
    }

    return Array.from(jar.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
}

function isExpiredSetCookie(header) {
    const value = String(header || '').toLowerCase();
    const maxAgeMatch = value.match(/;\s*max-age=(-?\d+)/);
    if (maxAgeMatch && Number.parseInt(maxAgeMatch[1], 10) <= 0) {
        return true;
    }

    const expiresMatch = String(header || '').match(/;\s*expires=([^;]+)/i);
    if (!expiresMatch) {
        return false;
    }

    const expiresAt = Date.parse(expiresMatch[1].trim());
    return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function hasAuthSecretFromEnv(env) {
    return Boolean(String((env && env.AUTH_SECRET) || '').trim());
}

async function verifyBearerAuthorization(request, env) {
    if (!hasAuthSecretFromEnv(env)) {
        return { allowed: false, status: 500, reason: 'AUTH_SECRET 未配置' };
    }

    const token = getBearerToken(request);
    if (!token) {
        return { allowed: false, status: 401, reason: '缺少 Bearer Token' };
    }

    const matched = await timingSafeEqualText(token, String(env.AUTH_SECRET));
    if (!matched) {
        return { allowed: false, status: 401, reason: 'Bearer Token 无效' };
    }

    return { allowed: true, status: 200 };
}

function getBearerToken(request) {
    const authorization = request.headers.get('Authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function timingSafeEqualText(actual, expected) {
    const [actualDigest, expectedDigest] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(String(actual || ''))),
        crypto.subtle.digest('SHA-256', encoder.encode(String(expected || ''))),
    ]);
    const actualBytes = new Uint8Array(actualDigest);
    const expectedBytes = new Uint8Array(expectedDigest);
    let diff = actualBytes.length ^ expectedBytes.length;

    for (let index = 0; index < Math.max(actualBytes.length, expectedBytes.length); index += 1) {
        diff |= (actualBytes[index] || 0) ^ (expectedBytes[index] || 0);
    }

    return diff === 0;
}

function getTelegramBotId(env) {
    const value = String((env && (env.TELEGRAM_BOT_ID || env.TELEGRAM_BOT_TOKEN)) || '').trim();
    return value.toLowerCase().startsWith('bot') ? value.slice(3).trim() : value;
}

function getTelegramChatId(env) {
    return String((env && env.TELEGRAM_CHAT_ID) || '').trim();
}

function isTelegramPushEnabled(env) {
    return Boolean(getTelegramBotId(env) && getTelegramChatId(env));
}

async function sendTelegramMessage(env, text) {
    const botId = getTelegramBotId(env);
    const chatId = getTelegramChatId(env);

    if (!botId || !chatId) {
        return {
            ok: false,
            status: 0,
            telegramOk: false,
            description: 'telegram_not_configured',
        };
    }

    if (/[/?#\s]/.test(botId)) {
        return {
            ok: false,
            status: 0,
            telegramOk: false,
            description: 'TELEGRAM_BOT_ID 格式不合法',
        };
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${botId}/sendMessage`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: chatId,
                text: clampTelegramMessage(text),
                disable_web_page_preview: true,
            }),
        });
        const data = await readJsonSafely(response);
        const telegramOk = Boolean(data && data.ok === true);

        return {
            ok: response.ok && telegramOk,
            status: response.status,
            telegramOk,
            description: data?.description || (response.ok ? '' : response.statusText),
        };
    } catch (error) {
        return {
            ok: false,
            status: 0,
            telegramOk: false,
            description: error && error.message ? error.message : String(error),
        };
    }
}

async function finishNeteaseCookieCheck(env, result) {
    const push = await notifyNeteaseCookieCheck(env, result);
    return push ? { ...result, push } : result;
}

async function notifyNeteaseCookieCheck(env, result) {
    if (!isTelegramPushEnabled(env)) {
        return null;
    }

    const pushResult = await sendTelegramMessage(env, buildNeteaseCookieCheckMessage(result));
    if (!pushResult.ok) {
        console.warn(`Telegram 推送失败: ${pushResult.description || pushResult.status || 'unknown error'}`);
    }

    return {
        enabled: true,
        ok: pushResult.ok,
        status: pushResult.status,
        description: pushResult.description || null,
    };
}

async function finishNeteaseCookieRefreshFailure(env, failure) {
    const push = await notifyNeteaseCookieRefreshFailure(env, failure);
    return push ? { ...failure, push } : failure;
}

async function finishNeteaseCookieRefreshSuccess(env, success) {
    const push = await notifyNeteaseCookieRefreshSuccess(env, success);
    return push ? { ...success, push } : success;
}

async function notifyNeteaseCookieRefreshSuccess(env, success) {
    if (!isTelegramPushEnabled(env)) {
        return null;
    }

    const result = await sendTelegramMessage(env, buildNeteaseCookieRefreshSuccessMessage(success));
    if (!result.ok) {
        console.warn(`Telegram 推送失败: ${result.description || result.status || 'unknown error'}`);
    }

    return {
        enabled: true,
        ok: result.ok,
        status: result.status,
        description: result.description || null,
    };
}

async function notifyNeteaseCookieRefreshFailure(env, failure) {
    if (!isTelegramPushEnabled(env)) {
        return null;
    }

    const result = await sendTelegramMessage(env, buildNeteaseCookieRefreshFailureMessage(failure));
    if (!result.ok) {
        console.warn(`Telegram 推送失败: ${result.description || result.status || 'unknown error'}`);
    }

    return {
        enabled: true,
        ok: result.ok,
        status: result.status,
        description: result.description || null,
    };
}

function buildNeteaseCookieCheckMessage(result) {
    const check = result.check || {};
    const lines = [
        `Meting Worker 网易云 Cookie 检查${result.ok ? '成功' : '失败'}`,
        `时间: ${formatTelegramValue(result.checkedAt || result.timestamp)}`,
        `状态码: ${formatTelegramValue(result.statusCode)}`,
    ];

    if (result.error) {
        lines.push(`错误: ${formatTelegramValue(result.error, 500)}`);
    }
    if (check.songEndpoint) {
        lines.push(`检查接口: ${formatTelegramValue(check.songEndpoint, 500)}`);
    }
    if (check.songTitle || check.songAuthor) {
        lines.push(`歌曲: ${formatTelegramValue([check.songTitle, check.songAuthor].filter(Boolean).join(' / '), 300)}`);
    }
    if (check.song) {
        lines.push(`歌曲信息响应: HTTP ${formatTelegramValue(check.song.status)}${check.song.redirected ? ' redirected' : ''}`);
    }
    if (check.url) {
        lines.push(`歌曲 URL 响应: HTTP ${formatTelegramValue(check.url.status)}${check.url.redirected ? ' redirected' : ''}`);
    }
    if (check.url?.location) {
        lines.push(`Location: ${formatTelegramValue(check.url.location, 500)}`);
    }
    if (check.audio) {
        lines.push(`音频地址响应: HTTP ${formatTelegramValue(check.audio.status)}${check.audio.redirected ? ' redirected' : ''}`);
    }
    if (check.audio?.url) {
        lines.push(`最终地址: ${formatTelegramValue(check.audio.url, 500)}`);
    }
    appendNeteaseCookieRefreshTriggerLines(lines, result.trigger || {});

    return clampTelegramMessage(lines.join('\n'));
}

function buildNeteaseCookieRefreshSuccessMessage(success) {
    const trigger = success.trigger || {};
    const lines = [
        'Meting Worker 网易云 Cookie 刷新成功',
        `时间: ${formatTelegramValue(success.refreshedAt || success.timestamp)}`,
        `状态码: ${formatTelegramValue(success.statusCode)}`,
    ];

    if (success.upstream) {
        lines.push(`网易云上游: HTTP ${formatTelegramValue(success.upstream.status)} / code ${formatTelegramValue(success.upstream.code)}`);
    }
    if (success.setCookieCount !== undefined) {
        lines.push(`上游 Set-Cookie 数: ${formatTelegramValue(success.setCookieCount)}`);
    }
    if (success.storedCookieNames?.length) {
        lines.push(`KV Cookie 字段: ${success.storedCookieNames.map((name) => formatTelegramValue(name)).join(', ')}`);
    }
    if (success.kv?.binding) {
        lines.push(`KV 绑定: ${formatTelegramValue(success.kv.binding)}`);
    }
    appendNeteaseCookieRefreshTriggerLines(lines, trigger);

    return clampTelegramMessage(lines.join('\n'));
}

function buildNeteaseCookieRefreshFailureMessage(failure) {
    const trigger = failure.trigger || {};
    const lines = [
        'Meting Worker 网易云 Cookie 刷新失败',
        `时间: ${formatTelegramValue(failure.timestamp)}`,
        `状态码: ${formatTelegramValue(failure.statusCode)}`,
    ];

    if (failure.error) {
        lines.push(`错误: ${formatTelegramValue(failure.error, 500)}`);
    }
    if (failure.skipped) {
        lines.push(`跳过原因: ${formatTelegramValue(failure.skipped)}`);
    }
    if (failure.upstream) {
        lines.push(`网易云上游: HTTP ${formatTelegramValue(failure.upstream.status)} / code ${formatTelegramValue(failure.upstream.code)}`);
    }
    if (failure.kv?.binding) {
        lines.push(`KV 绑定: ${formatTelegramValue(failure.kv.binding)}`);
    }
    appendNeteaseCookieRefreshTriggerLines(lines, trigger);

    return clampTelegramMessage(lines.join('\n'));
}

function appendNeteaseCookieRefreshTriggerLines(lines, trigger) {
    if (trigger.manual) {
        lines.push(`触发方式: manual${trigger.path ? ` ${formatTelegramValue(trigger.path)}` : ''}`);
    } else if (trigger.cron || trigger.scheduledTime) {
        lines.push(`触发方式: cron ${formatTelegramValue(trigger.cron)}`);
    }
    if (trigger.scheduledTime) {
        lines.push(`计划时间: ${formatTelegramValue(trigger.scheduledTime)}`);
    }
    if (trigger.requestedAt) {
        lines.push(`请求时间: ${formatTelegramValue(trigger.requestedAt)}`);
    }
    if (trigger.id) {
        lines.push(`检查歌曲 ID: ${formatTelegramValue(trigger.id)}`);
    }
}

function formatTelegramValue(value, maxLength = 200) {
    if (value === null || value === undefined || value === '') {
        return '-';
    }

    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clampTelegramMessage(text) {
    const value = String(text || '').trim();
    if (value.length <= TELEGRAM_MESSAGE_MAX_LENGTH) {
        return value;
    }
    return `${value.slice(0, TELEGRAM_MESSAGE_MAX_LENGTH - 3)}...`;
}

function redactTelegramChatId(chatId) {
    const value = String(chatId || '').trim();
    if (!value) {
        return '';
    }
    if (value.length <= 4) {
        return '<configured>';
    }
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function isAuthEnabled(env) {
    const explicit = env ? (env.AUTH_ENABLED ?? env.AUTH) : undefined;
    if (explicit !== undefined && String(explicit).trim() !== '') {
        return isTruthy(explicit);
    }
    return hasAuthSecretFromEnv(env);
}

async function verifyTypeAuth(request, config, env) {
    if (!['url', 'pic', 'lrc'].includes(config.type)) {
        return { allowed: true };
    }

    if (!isAuthEnabled(env)) {
        return { allowed: true };
    }

    if (!hasAuthSecretFromEnv(env)) {
        return { allowed: false, reason: 'AUTH_SECRET 未配置' };
    }

    const auth = new URL(request.url).searchParams.get('auth') || '';
    const expected = await createAuthSignature(`${config.server}${config.type}${config.id}`, env.AUTH_SECRET);
    if (auth && await timingSafeEqualText(auth, expected)) {
        return { allowed: true };
    }

    return { allowed: false, reason: '非法请求' };
}

async function handleApiType(request, config, env) {
    if (config.type === 'song') {
        return handleSongType(request, config, env);
    }
    if (config.type === 'url') {
        return handleUrlType(config, env);
    }
    if (config.type === 'pic') {
        return handlePicType(config);
    }
    if (config.type === 'lrc') {
        return handleLrcType(config, env);
    }
    throw new ApiError(400, '不支持的 type');
}

async function handleSongType(request, config, env) {
    if (config.server === 'tencent') {
        return buildSongResponse(request, config, formatTencentSong(await fetchTencentSong(config.id, env)), env);
    }
    return buildSongResponse(request, config, await fetchNeteaseSong(config.id, env), env);
}

async function buildSongResponse(request, config, song, env) {
    const payload = [
        {
            title: song.name,
            author: song.artist.join('/'),
            url: await buildApiEndpointUrl(request, config, 'url', song.urlId || config.id, env),
            pic: await buildApiEndpointUrl(request, config, 'pic', song.picId, env),
            lrc: await buildApiEndpointUrl(request, config, 'lrc', song.lyricId || config.id, env),
        },
    ];

    return jsonResponse(payload, 200);
}

async function handleUrlType(config, env) {
    const urlData = config.server === 'tencent'
        ? await fetchTencentUrl(await fetchTencentSong(config.id, env), config.br, env)
        : await fetchNeteaseUrl(config.id, config.br, env);

    if (!urlData.url) {
        throw new ApiError(502, `${config.server === 'tencent' ? 'QQ 音乐' : '网易云'}未返回可用音频地址`);
    }

    return redirectResponse(normalizeHttps(urlData.url));
}

function handlePicType(config) {
    const picUrl = config.server === 'tencent'
        ? buildTencentPicture(config.id, config.picsize)
        : buildNeteasePicture(config.id, config.picsize);

    if (!picUrl) {
        throw new ApiError(404, '封面不存在');
    }

    return redirectResponse(picUrl);
}

async function handleLrcType(config, env) {
    const lyricData = config.server === 'tencent'
        ? await fetchTencentLyric(config.id, env)
        : await fetchNeteaseLyric(config.id, env);

    return textResponse(selectLyricContent(lyricData, config.lrctype), 200);
}

async function buildApiEndpointUrl(request, config, type, id, env) {
    const url = new URL(request.url);
    url.pathname = config.apiPath;
    url.search = new URLSearchParams({
        server: config.server,
        type,
        id: String(id),
    }).toString();

    if (isAuthEnabled(env) && hasAuthSecretFromEnv(env)) {
        const auth = await createAuthSignature(`${config.server}${type}${id}`, env.AUTH_SECRET);
        url.searchParams.set('auth', auth);
    }

    return url.toString();
}

async function fetchNeteaseSong(id, env) {
    const numericId = Number.parseInt(id, 10);
    if (!Number.isFinite(numericId)) {
        throw new ApiError(400, '网易云歌曲 ID 必须是数字');
    }

    const data = await callNeteaseApi(
        '/api/v3/song/detail/',
        {
            c: JSON.stringify([{ id: numericId, v: 0 }]),
        },
        env
    );

    const song = data && Array.isArray(data.songs) ? data.songs[0] : null;
    if (!song) {
        throw new ApiError(404, '网易云歌曲不存在');
    }

    return formatNeteaseSong(song);
}

async function fetchNeteaseUrl(id, br, env) {
    const numericId = Number.parseInt(id, 10);
    if (!Number.isFinite(numericId)) {
        throw new ApiError(400, '网易云歌曲 ID 必须是数字');
    }

    const data = await callNeteaseApi(
        '/api/song/enhance/player/url',
        {
            ids: [numericId],
            br: br * 1000,
        },
        env
    );

    const item = data && Array.isArray(data.data) ? data.data[0] : null;
    const url = item ? item.url || item.uf?.url || '' : '';

    return {
        url,
        size: item ? item.size || 0 : 0,
        br: item ? item.br || -1 : -1,
    };
}

async function fetchNeteaseLyric(id, env) {
    const numericId = Number.parseInt(id, 10);
    if (!Number.isFinite(numericId)) {
        throw new ApiError(400, '网易云歌曲 ID 必须是数字');
    }

    const data = await callNeteaseApi(
        '/api/song/lyric',
        {
            id: numericId,
            os: 'pc',
            lv: -1,
            kv: -1,
            tv: -1,
            rv: -1,
            yv: 1,
            showRole: 'False',
            cp: 'False',
            e_r: 'False',
        },
        env
    );

    return {
        lyric: data?.lrc?.lyric || '',
        tlyric: data?.tlyric?.lyric || '',
    };
}

async function callNeteaseApi(pathname, body, env) {
    const response = await postNeteaseWeapi(pathname, body, env, await getNeteaseCookie(env));

    if (!response.ok) {
        throw new ApiError(502, `网易云上游请求失败: ${response.status}`);
    }

    return response.json();
}

async function postNeteaseWeapi(pathname, body, env, cookie, options = {}) {
    const encryptedBody = await createNeteaseBody(body);
    return fetch(`https://music.163.com${pathname.replace('/api/', '/weapi/')}`, {
        method: 'POST',
        headers: createNeteaseHeaders(env, cookie, options),
        body: new URLSearchParams(encryptedBody).toString(),
    });
}

async function getNeteaseCookie(env) {
    const storedCookie = await readStoredNeteaseCookie(env);
    if (hasNeteaseLoginCookie(storedCookie) || !env.NETEASE_COOKIE) {
        return storedCookie || env.NETEASE_COOKIE || DEFAULT_NETEASE_COOKIE;
    }

    console.warn('KV 中的网易云 Cookie 缺少 MUSIC_U，改用 NETEASE_COOKIE 兜底');
    return env.NETEASE_COOKIE || DEFAULT_NETEASE_COOKIE;
}

async function readStoredNeteaseCookie(env) {
    const kv = getCookieKv(env);
    if (!kv) {
        return '';
    }

    try {
        const value = await kv.get(getNeteaseCookieKvKey(env));
        return String(value || '').trim();
    } catch (error) {
        console.warn(`读取 KV 网易云 Cookie 失败，改用环境变量兜底: ${error && error.message ? error.message : String(error)}`);
        return '';
    }
}

function createNeteaseHeaders(env, cookie, options = {}) {
    return {
        Referer: 'https://music.163.com/',
        Cookie: cookie || env.NETEASE_COOKIE || DEFAULT_NETEASE_COOKIE,
        'User-Agent': options.userAgent || DEFAULT_NETEASE_UA,
        'X-Real-IP': randomNeteaseIp(),
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.8',
        Connection: 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
    };
}

function createTriggerDetails(trigger = {}) {
    return {
        scheduledTime: trigger.scheduledTime || null,
        cron: trigger.cron || null,
        manual: Boolean(trigger.manual),
        path: trigger.path || null,
        requestedAt: trigger.requestedAt || null,
        id: trigger.id || null,
    };
}

async function checkNeteaseCookie(env, trigger = {}) {
    const triggerDetails = createTriggerDetails(trigger);
    const checkUrl = getNeteaseCookieCheckUrl(env, triggerDetails.id);
    const check = {
        songEndpoint: redactSensitiveUrl(checkUrl),
        mode: 'internal',
    };

    try {
        const songResponse = await fetchNeteaseCookieCheckSongResponse(checkUrl, env);
        check.song = summarizeHttpResponse(songResponse, checkUrl);

        if (isHttpErrorStatus(songResponse.status)) {
            throw new Error(`歌曲信息检查失败: HTTP ${songResponse.status}`);
        }

        const songPayload = await readJsonSafely(songResponse);
        const song = Array.isArray(songPayload) ? songPayload[0] : null;
        if (!song || typeof song !== 'object') {
            throw new Error('歌曲信息检查返回格式不合法');
        }

        const songUrl = String(song.url || '').trim();
        if (!songUrl) {
            throw new Error('歌曲信息检查未返回 url 字段');
        }

        check.songTitle = String(song.title || '');
        check.songAuthor = String(song.author || '');
        check.songUrl = redactSensitiveUrl(songUrl);

        const urlResponse = await fetchNeteaseCookieCheckUrlResponse(songUrl, env);
        check.url = summarizeHttpResponse(urlResponse, songUrl);

        if (isHttpErrorStatus(urlResponse.status)) {
            throw new Error(`歌曲 URL 检查失败: HTTP ${urlResponse.status}`);
        }

        if (isRedirectStatus(urlResponse.status)) {
            const audioUrl = getRedirectLocation(urlResponse, songUrl);
            if (!audioUrl) {
                throw new Error(`歌曲 URL 检查失败: HTTP ${urlResponse.status} 缺少 Location`);
            }

            check.url.location = redactSensitiveUrl(audioUrl);
            const audioResponse = await fetch(audioUrl, {
                method: 'GET',
                headers: createNeteaseCookieAudioCheckHeaders({
                    Accept: '*/*',
                    Range: 'bytes=0-0',
                }),
                redirect: 'follow',
            });
            check.audio = summarizeHttpResponse(audioResponse);

            if (isHttpErrorStatus(audioResponse.status)) {
                throw new Error(`音频地址检查失败: HTTP ${audioResponse.status}`);
            }
        }

        const checkedAt = new Date().toISOString();
        return finishNeteaseCookieCheck(env, {
            ok: true,
            statusCode: 200,
            timestamp: checkedAt,
            checkedAt,
            trigger: triggerDetails,
            check,
        });
    } catch (error) {
        const timestamp = new Date().toISOString();
        console.error(`网易云 Cookie 检查失败: ${error && error.message ? error.message : String(error)}`);
        return finishNeteaseCookieCheck(env, {
            ok: false,
            statusCode: 502,
            timestamp,
            error: error && error.message ? error.message : String(error),
            trigger: triggerDetails,
            check,
        });
    }
}

function getNeteaseCookieCheckUrl(env, songId = '') {
    const rawUrl = String((env && env.NETEASE_COOKIE_CHECK_URL) || DEFAULT_NETEASE_COOKIE_CHECK_URL).trim() || DEFAULT_NETEASE_COOKIE_CHECK_URL;
    const id = String(songId || '').trim();
    if (!id) {
        return rawUrl;
    }

    const url = new URL(rawUrl);
    url.searchParams.set('id', id);
    url.searchParams.set('server', normalizeServer(url.searchParams.get('server') || 'netease'));
    url.searchParams.set('type', 'song');
    return url.toString();
}

async function fetchNeteaseCookieCheckSongResponse(checkUrl, env) {
    const url = new URL(checkUrl);
    const config = readConfig(url, env);
    if (config.server !== 'netease') {
        throw new Error('Cookie 检查仅支持 netease 音乐源');
    }
    if (config.type !== 'song') {
        throw new Error('Cookie 检查接口 type 必须为 song');
    }
    if (!config.id) {
        throw new Error('Cookie 检查接口缺少歌曲 ID');
    }

    return handleSongType(new Request(url.toString(), { method: 'GET' }), config, env);
}

async function fetchNeteaseCookieCheckUrlResponse(songUrl, env) {
    const url = new URL(songUrl);
    const config = readConfig(url, env);
    if (config.server !== 'netease') {
        throw new Error('Cookie 检查返回的歌曲 URL 不是 netease 音乐源');
    }
    if (config.type !== 'url') {
        throw new Error('Cookie 检查返回的歌曲 URL type 必须为 url');
    }
    if (!config.id) {
        throw new Error('Cookie 检查返回的歌曲 URL 缺少歌曲 ID');
    }

    return handleUrlType(config, env);
}

function createNeteaseCookieAudioCheckHeaders(extraHeaders = {}) {
    const headers = {
        Accept: '*/*',
        'User-Agent': DEFAULT_NETEASE_REFRESH_UA,
    };

    for (const [key, value] of Object.entries(extraHeaders)) {
        if (value !== undefined && value !== null) {
            headers[key] = value;
        }
    }

    return headers;
}

function summarizeHttpResponse(response, fallbackUrl = '') {
    return {
        status: response.status,
        ok: !isHttpErrorStatus(response.status),
        redirected: Boolean(response.redirected),
        url: redactSensitiveUrl(response.url || fallbackUrl),
        contentType: response.headers.get('Content-Type') || '',
    };
}

function isHttpErrorStatus(status) {
    return status >= 400 && status <= 599;
}

function isRedirectStatus(status) {
    return status >= 300 && status <= 399;
}

function getRedirectLocation(response, baseUrl) {
    const location = response.headers.get('Location') || response.headers.get('location') || '';
    if (!location) {
        return '';
    }

    try {
        return new URL(location, baseUrl).toString();
    } catch (_) {
        return String(location || '').trim();
    }
}

function redactSensitiveUrl(value) {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    try {
        const url = new URL(text);
        for (const key of Array.from(url.searchParams.keys())) {
            if (isSensitiveQueryName(key)) {
                url.searchParams.set(key, 'redacted');
            }
        }
        return url.toString();
    } catch (_) {
        return formatTelegramValue(text, 500);
    }
}

function isSensitiveQueryName(name) {
    const key = String(name || '').toLowerCase();
    return key.includes('auth')
        || key.includes('token')
        || key.includes('key')
        || key.includes('sign')
        || key === 'cookie'
        || key === 'vkey';
}

async function refreshNeteaseCookie(env, trigger = {}, options = {}) {
    const timestamp = new Date().toISOString();
    const triggerDetails = createTriggerDetails(trigger);

    if (!options.force && isExplicitlyFalse(env.NETEASE_COOKIE_REFRESH_ENABLED)) {
        console.log('网易云 Cookie 刷新已关闭');
        return {
            ok: true,
            statusCode: 200,
            timestamp,
            skipped: 'disabled',
        };
    }

    const kv = getCookieKv(env);
    if (!kv) {
        console.warn('未绑定 METING_COOKIE_KV 或 COOKIE_KV，跳过网易云 Cookie 刷新');
        return finishNeteaseCookieRefreshFailure(env, {
            ok: false,
            statusCode: 500,
            timestamp,
            skipped: 'kv_not_configured',
            error: '未绑定 METING_COOKIE_KV 或 COOKIE_KV',
            trigger: triggerDetails,
            kv: {
                binding: getCookieKvBindingName(env) || null,
            },
        });
    }

    const currentCookie = await getNeteaseCookie(env);
    if (!hasNeteaseLoginCookie(currentCookie)) {
        console.warn('NETEASE_COOKIE 缺少 MUSIC_U，跳过网易云 Cookie 刷新');
        return finishNeteaseCookieRefreshFailure(env, {
            ok: false,
            statusCode: 409,
            timestamp,
            skipped: 'missing_music_u',
            error: 'NETEASE_COOKIE 缺少 MUSIC_U',
            trigger: triggerDetails,
            kv: {
                binding: getCookieKvBindingName(env) || null,
            },
        });
    }

    let upstream = null;

    try {
        const csrfToken = extractCookieValue(currentCookie, '__csrf') || extractCookieValue(currentCookie, '_csrf');
        const response = await postNeteaseWeapi(
            '/weapi/login/token/refresh',
            {
                csrf_token: csrfToken || '',
            },
            env,
            currentCookie,
            {
                userAgent: DEFAULT_NETEASE_REFRESH_UA,
            }
        );
        const data = await readJsonSafely(response);
        const upstreamCode = data && data.code !== undefined ? Number(data.code) : null;
        upstream = {
            status: response.status,
            code: upstreamCode,
        };

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        if (upstreamCode !== null && upstreamCode !== 200) {
            throw new Error(`upstream code ${upstreamCode}`);
        }

        const setCookieHeaders = getSetCookieHeaders(response.headers);
        if (!setCookieHeaders.length) {
            throw new Error('upstream did not return Set-Cookie');
        }

        const refreshedCookie = mergeCookieUpdates(currentCookie, setCookieHeaders);
        if (!hasNeteaseLoginCookie(refreshedCookie)) {
            throw new Error('refreshed cookie is missing MUSIC_U');
        }
        const storedCookie = extractNeteaseMusicUCookie(refreshedCookie);
        if (!storedCookie) {
            throw new Error('failed to extract MUSIC_U from refreshed cookie');
        }

        const now = new Date().toISOString();
        const cookieKey = getNeteaseCookieKvKey(env);
        const metaKey = getNeteaseCookieMetaKvKey(env);
        const metadata = {
            refreshedAt: now,
            scheduledTime: triggerDetails.scheduledTime,
            cron: triggerDetails.cron,
            manual: triggerDetails.manual,
            path: triggerDetails.path,
            requestedAt: triggerDetails.requestedAt,
            upstreamStatus: response.status,
            upstreamCode,
            setCookieCount: setCookieHeaders.length,
            storedCookieNames: ['MUSIC_U'],
            source: 'netease_login_token_refresh',
        };

        await Promise.all([
            kv.put(cookieKey, storedCookie),
            kv.put(metaKey, JSON.stringify(metadata)),
        ]);

        console.log(`网易云 Cookie 刷新完成，更新 ${setCookieHeaders.length} 个 Cookie 字段，KV 仅保存 MUSIC_U`);
        return finishNeteaseCookieRefreshSuccess(env, {
            ok: true,
            statusCode: 200,
            timestamp: now,
            refreshedAt: now,
            trigger: triggerDetails,
            upstream: {
                status: response.status,
                code: upstreamCode,
            },
            setCookieCount: setCookieHeaders.length,
            storedCookieNames: ['MUSIC_U'],
            kv: {
                binding: getCookieKvBindingName(env),
                writes: options.includeWriteDetails
                    ? await describeNeteaseCookieKvWrites(cookieKey, storedCookie, metaKey, metadata)
                    : [
                        { key: cookieKey },
                        { key: metaKey },
                    ],
            },
        });
    } catch (error) {
        console.error(`网易云 Cookie 刷新失败: ${error && error.message ? error.message : String(error)}`);
        return finishNeteaseCookieRefreshFailure(env, {
            ok: false,
            statusCode: 502,
            timestamp: new Date().toISOString(),
            error: error && error.message ? error.message : String(error),
            trigger: triggerDetails,
            upstream,
            kv: {
                binding: getCookieKvBindingName(env) || null,
            },
        });
    }
}

async function createNeteaseBody(body) {
    const secretKey = randomHex(16);
    const payload = JSON.stringify(body);
    const firstPass = await aesCbcEncryptBase64(payload, NETEASE_NONCE);
    const secondPass = await aesCbcEncryptBase64(firstPass, secretKey);
    return {
        params: secondPass,
        encSecKey: rsaEncryptSecretKey(secretKey),
    };
}

function randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    let hex = '';
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex.slice(0, length);
}

async function aesCbcEncryptBase64(text, keyText) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(keyText),
        { name: 'AES-CBC' },
        false,
        ['encrypt']
    );

    const payload = pkcs7Pad(encoder.encode(text), 16);
    const encrypted = await crypto.subtle.encrypt(
        {
            name: 'AES-CBC',
            iv: encoder.encode(NETEASE_IV),
        },
        cryptoKey,
        payload
    );

    return bytesToBase64(new Uint8Array(encrypted));
}

function pkcs7Pad(bytes, blockSize) {
    const remainder = bytes.length % blockSize;
    const padding = remainder === 0 ? blockSize : blockSize - remainder;
    const output = new Uint8Array(bytes.length + padding);
    output.set(bytes);
    output.fill(padding, bytes.length);
    return output;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function rsaEncryptSecretKey(secretKey) {
    const reversed = secretKey.split('').reverse().join('');
    let hex = '';
    for (const char of reversed) {
        hex += char.charCodeAt(0).toString(16).padStart(2, '0');
    }

    const base = BigInt(`0x${hex}`);
    const modulus = BigInt(NETEASE_MODULUS);
    const encrypted = modPow(base, NETEASE_PUBKEY, modulus);
    return encrypted.toString(16).padStart(256, '0');
}

function modPow(base, exponent, modulus) {
    let result = 1n;
    let current = base % modulus;
    let power = exponent;

    while (power > 0n) {
        if (power & 1n) {
            result = (result * current) % modulus;
        }
        current = (current * current) % modulus;
        power >>= 1n;
    }

    return result;
}

function randomNeteaseIp() {
    const start = 1884815360;
    const end = 1884890111;
    const value = start + Math.floor(Math.random() * (end - start + 1));

    const octet1 = Math.floor(value / 16777216) % 256;
    const octet2 = Math.floor(value / 65536) % 256;
    const octet3 = Math.floor(value / 256) % 256;
    const octet4 = value % 256;

    return `${octet1}.${octet2}.${octet3}.${octet4}`;
}

function formatNeteaseSong(song) {
    let picId = song?.al?.pic_str || song?.al?.pic || '';

    if (song?.al?.picUrl) {
        const match = song.al.picUrl.match(/\/(\d+)\./);
        if (match) {
            picId = match[1];
        }
    }

    return {
        id: String(song.id),
        name: song.name || '',
        artist: Array.isArray(song.ar) ? song.ar.map((item) => item.name).filter(Boolean) : [],
        album: song?.al?.name || '',
        picId: String(picId || ''),
        urlId: String(song.id),
        lyricId: String(song.id),
    };
}

function buildNeteasePicture(picId, picSize) {
    if (!picId) {
        return '';
    }
    const encryptedId = neteaseEncryptId(picId);
    const suffix = picSize ? `?param=${picSize}y${picSize}` : '';
    return normalizeHttps(`https://p3.music.126.net/${encryptedId}/${picId}.jpg${suffix}`);
}

function neteaseEncryptId(id) {
    const magic = '3go8&$8*3*3h0k(2)2';
    const chars = String(id).split('');
    let mixed = '';

    for (let index = 0; index < chars.length; index += 1) {
        const charCode = chars[index].charCodeAt(0) ^ magic.charCodeAt(index % magic.length);
        mixed += String.fromCharCode(charCode);
    }

    const digest = new Uint8Array(md5Binary(mixed));
    return bytesToBase64(digest).replace(/\//g, '_').replace(/\+/g, '-');
}

async function fetchTencentSong(id, env) {
    const url = new URL('https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg');
    url.search = new URLSearchParams({
        songmid: id,
        platform: 'yqq',
        format: 'json',
    }).toString();

    const response = await fetch(url.toString(), {
        headers: createTencentHeaders(env),
    });

    if (!response.ok) {
        throw new ApiError(502, `QQ 音乐歌曲信息请求失败: ${response.status}`);
    }

    const data = await response.json();
    const song = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!song) {
        throw new ApiError(404, 'QQ 音乐歌曲不存在');
    }

    return song;
}

async function fetchTencentUrl(rawSong, br, env) {
    const song = rawSong?.musicData || rawSong;
    const file = song?.file || {};
    if (!song?.mid || !file.media_mid) {
        throw new ApiError(502, 'QQ 音乐返回的歌曲数据不完整');
    }
    const guid = String(Math.floor(Math.random() * 10000000000));
    const uinMatch = (env.TENCENT_COOKIE || DEFAULT_TENCENT_COOKIE).match(/uin=(\d+)/);
    const uin = uinMatch ? uinMatch[1] : '0';
    const types = [
        ['size_flac', 999999, 'F000', 'flac'],
        ['size_320mp3', 320, 'M800', 'mp3'],
        ['size_192aac', 192, 'C600', 'm4a'],
        ['size_128mp3', 128, 'M500', 'mp3'],
        ['size_96aac', 96, 'C400', 'm4a'],
        ['size_48aac', 48, 'C200', 'm4a'],
        ['size_24aac', 24, 'C100', 'm4a'],
    ];

    const payload = {
        req_0: {
            module: 'vkey.GetVkeyServer',
            method: 'CgiGetVkey',
            param: {
                guid,
                songmid: [],
                filename: [],
                songtype: [],
                uin,
                loginflag: 1,
                platform: '20',
            },
        },
    };

    for (const [, , prefix, ext] of types) {
        payload.req_0.param.songmid.push(song.mid);
        payload.req_0.param.filename.push(`${prefix}${file.media_mid}.${ext}`);
        payload.req_0.param.songtype.push(song.type);
    }

    const url = new URL('https://u6.y.qq.com/cgi-bin/musicu.fcg');
    url.search = new URLSearchParams({
        format: 'json',
        platform: 'yqq.json',
        needNewCode: '0',
        data: JSON.stringify(payload),
    }).toString();

    const response = await fetch(url.toString(), {
        headers: createTencentHeaders(env),
    });

    if (!response.ok) {
        throw new ApiError(502, `QQ 音乐音频地址请求失败: ${response.status}`);
    }

    const data = await response.json();
    const midurlinfo = data?.req_0?.data?.midurlinfo || [];
    const sip = data?.req_0?.data?.sip?.[0] || '';

    for (let index = 0; index < types.length; index += 1) {
        const [sizeKey, quality] = types[index];
        if (!file[sizeKey] || quality > br) {
            continue;
        }

        const item = midurlinfo[index];
        if (item?.vkey && item?.purl) {
            return {
                url: `${sip}${item.purl}`,
                size: file[sizeKey],
                br: quality,
            };
        }
    }

    return {
        url: '',
        size: 0,
        br: -1,
    };
}

async function fetchTencentLyric(id, env) {
    const url = new URL('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg');
    url.search = new URLSearchParams({
        songmid: id,
        g_tk: '5381',
    }).toString();

    const response = await fetch(url.toString(), {
        headers: createTencentHeaders(env),
    });

    if (!response.ok) {
        throw new ApiError(502, `QQ 音乐歌词请求失败: ${response.status}`);
    }

    const raw = await response.text();
    const payload = stripTencentJsonp(raw);
    const data = JSON.parse(payload);

    return {
        lyric: base64ToUtf8(data.lyric || ''),
        tlyric: base64ToUtf8(data.trans || ''),
    };
}

function stripTencentJsonp(raw) {
    const match = raw.match(/^[^(]+\((.*)\)\s*;?\s*$/s);
    return match ? match[1] : raw;
}

function createTencentHeaders(env) {
    return {
        Referer: 'https://y.qq.com',
        Cookie: env.TENCENT_COOKIE || DEFAULT_TENCENT_COOKIE,
        'User-Agent': DEFAULT_TENCENT_UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.8',
        Connection: 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
    };
}

function formatTencentSong(rawSong) {
    const song = rawSong?.musicData || rawSong;
    return {
        id: String(song.mid || ''),
        name: song.name || '',
        artist: Array.isArray(song.singer) ? song.singer.map((item) => item.name).filter(Boolean) : [],
        album: song?.album?.title ? String(song.album.title).trim() : '',
        picId: song?.album?.mid || '',
        urlId: String(song.mid || ''),
        lyricId: String(song.mid || ''),
    };
}

function buildTencentPicture(picId, picSize) {
    if (!picId) {
        return '';
    }
    if (!picSize) {
        return normalizeHttps(`https://y.gtimg.cn/music/photo_new/T002M000${picId}.jpg`);
    }
    return normalizeHttps(`https://y.gtimg.cn/music/photo_new/T002R${picSize}x${picSize}M000${picId}.jpg`);
}

function selectLyricContent(lyricData, lrctype) {
    const lyric = lyricData?.lyric || '';
    const tlyric = lyricData?.tlyric || '';

    if (!lyric) {
        return '';
    }

    if (lrctype === '2') {
        return normalizeLyricText(tlyric);
    }

    if (lrctype === '1') {
        return normalizeLyricText(mergeTranslatedLyric(lyric, tlyric));
    }

    return normalizeLyricText(lyric);
}

function mergeTranslatedLyric(lyric, translatedLyric) {
    const lyricLines = lyric.split('\n');
    const translatedLines = translatedLyric.split('\n');
    const translatedMap = {};

    for (const line of translatedLines) {
        if (!line) {
            continue;
        }

        const splitIndex = line.indexOf(']');
        if (splitIndex === -1) {
            continue;
        }

        const key = line.slice(0, splitIndex);
        const value = normalizeSpaces(line.slice(splitIndex + 1));
        translatedMap[key] = value;
    }

    const output = [];

    for (let index = 0; index < lyricLines.length; index += 1) {
        const line = lyricLines[index];
        if (!line) {
            continue;
        }

        output.push(line);

        const splitIndex = line.indexOf(']');
        if (splitIndex === -1) {
            continue;
        }

        const key = line.slice(0, splitIndex);
        const content = line.slice(splitIndex + 1);
        const translated = translatedMap[key];

        if (!translated || translated === '//' || !translated.trim()) {
            continue;
        }

        let shouldOutput = true;
        if (/(作词|作曲|制作人|编曲|歌手|演唱|专辑|发行)/u.test(content)) {
            let conflict = false;
            let nextKey = '';

            for (let nextIndex = index + 1; nextIndex < lyricLines.length; nextIndex += 1) {
                const nextLine = lyricLines[nextIndex];
                if (!nextLine) {
                    continue;
                }

                const nextSplitIndex = nextLine.indexOf(']');
                if (nextSplitIndex === -1) {
                    continue;
                }

                nextKey = nextLine.slice(0, nextSplitIndex);
                if (nextKey !== key && translatedMap[nextKey] && translatedMap[nextKey] !== '//') {
                    conflict = true;
                }
                break;
            }

            if (!conflict && nextKey) {
                translatedMap[nextKey] = translated;
                shouldOutput = false;
            }
        }

        if (shouldOutput) {
            output.push(`${key}]${translated}`);
        }
    }

    return output.join('\n');
}

function normalizeLyricText(lyric) {
    return String(lyric || '').replace(/(\[[0-9:.]+\])[ \t]+/g, '$1');
}

function normalizeSpaces(text) {
    return String(text || '').trim().replace(/\s\s+/g, ' ');
}

function normalizeHttps(url) {
    const value = String(url || '').trim();
    if (!value) {
        return '';
    }
    if (value.startsWith('http://')) {
        return `https://${value.slice(7)}`;
    }
    if (value.startsWith('//')) {
        return `https:${value}`;
    }
    if (!/^https?:\/\//i.test(value)) {
        return `https://${value.replace(/^\/+/, '')}`;
    }
    return value;
}

function base64ToUtf8(value) {
    if (!value) {
        return '';
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return decoder.decode(bytes);
}

function buildCacheControl(cacheMaxAge) {
    if (cacheMaxAge <= 0) {
        return 'no-store';
    }
    return `public, max-age=${cacheMaxAge}, s-maxage=${cacheMaxAge}`;
}

function createCorsHeaders(extraHeaders = {}) {
    const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });

    for (const [key, value] of Object.entries(extraHeaders)) {
        headers.set(key, value);
    }

    return headers;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    const headers = createCorsHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        ...extraHeaders,
    });

    return new Response(JSON.stringify(data), {
        status,
        headers,
    });
}

function textResponse(data, status = 200, extraHeaders = {}) {
    const headers = createCorsHeaders({
        'Content-Type': 'text/plain; charset=utf-8',
        ...extraHeaders,
    });

    return new Response(String(data || ''), {
        status,
        headers,
    });
}

function redirectResponse(location, status = 302, extraHeaders = {}) {
    const headers = createCorsHeaders({
        Location: location,
        ...extraHeaders,
    });

    return new Response(null, {
        status,
        headers,
    });
}

function cloneResponse(response, extraHeaders = {}) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(extraHeaders)) {
        headers.set(key, value);
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function md5Binary(input) {
    const message = typeof input === 'string' ? binaryStringToBytes(input) : new Uint8Array(input);
    const originalBitLength = message.length * 8;
    const withPaddingLength = (((message.length + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(withPaddingLength);
    buffer.set(message);
    buffer[message.length] = 0x80;

    const dataView = new DataView(buffer.buffer);
    dataView.setUint32(buffer.length - 8, originalBitLength >>> 0, true);
    dataView.setUint32(buffer.length - 4, Math.floor(originalBitLength / 0x100000000), true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const shifts = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    const constants = Array.from({ length: 64 }, (_, index) =>
        Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
    );

    for (let offset = 0; offset < buffer.length; offset += 64) {
        const words = new Uint32Array(16);
        for (let index = 0; index < 16; index += 1) {
            words[index] = dataView.getUint32(offset + index * 4, true);
        }

        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;

        for (let index = 0; index < 64; index += 1) {
            let f;
            let g;

            if (index < 16) {
                f = (b & c) | (~b & d);
                g = index;
            } else if (index < 32) {
                f = (d & b) | (~d & c);
                g = (5 * index + 1) % 16;
            } else if (index < 48) {
                f = b ^ c ^ d;
                g = (3 * index + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * index) % 16;
            }

            const next = d;
            d = c;
            c = b;

            const rotated = leftRotate((a + f + constants[index] + words[g]) >>> 0, shifts[index]);
            b = (b + rotated) >>> 0;
            a = next;
        }

        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const digest = new Uint8Array(16);
    const digestView = new DataView(digest.buffer);
    digestView.setUint32(0, a0, true);
    digestView.setUint32(4, b0, true);
    digestView.setUint32(8, c0, true);
    digestView.setUint32(12, d0, true);
    return digest;
}

function leftRotate(value, amount) {
    return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function binaryStringToBytes(input) {
    const output = new Uint8Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
        output[index] = input.charCodeAt(index) & 0xff;
    }
    return output;
}

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

async function createAuthSignature(text, secret) {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        {
            name: 'HMAC',
            hash: 'SHA-256',
        },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
    return Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
