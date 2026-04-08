const NETEASE_MODULUS = '157794750267131502212476817800345498121872783333389747424011531025366277535262539913701806290766479189477533597854989606803194253978660329941980786072432806427833685472618792592200595694346872951301770580765135349259590167490536138082469680638514416594216629258349130257685001248172188325316586707301643237607';
const NETEASE_PUBKEY = 65537n;
const NETEASE_NONCE = '0CoJUm6Qyw8W8jud';
const NETEASE_IV = '0102030405060708';

const DEFAULT_NETEASE_COOKIE = 'appver=8.2.30; os=iPhone OS; osver=15.0; EVNSM=1.0.0; buildver=2206; channel=distribution; machineid=iPhone13.3';
const DEFAULT_NETEASE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CloudMusic/0.1.1 NeteaseMusic/8.2.30';
const DEFAULT_TENCENT_COOKIE = 'pgv_pvi=22038528; pgv_si=s3156287488; pgv_pvid=5535248600; yplayer_open=1; ts_last=y.qq.com/portal/player.html; ts_uid=4847550686; yq_index=0; qqmusic_fromtag=66; player_exist=1';
const DEFAULT_TENCENT_UA = 'QQ音乐/54409 CFNetwork/901.1 Darwin/17.6.0 (x86_64)';

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
};

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

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

function hasAuthSecretFromEnv(env) {
    return Boolean(String((env && env.AUTH_SECRET) || '').trim());
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
    if (auth && auth === expected) {
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
    const encryptedBody = await createNeteaseBody(body);
    const response = await fetch(`https://music.163.com${pathname.replace('/api/', '/weapi/')}`, {
        method: 'POST',
        headers: createNeteaseHeaders(env),
        body: new URLSearchParams(encryptedBody).toString(),
    });

    if (!response.ok) {
        throw new ApiError(502, `网易云上游请求失败: ${response.status}`);
    }

    return response.json();
}

function createNeteaseHeaders(env) {
    return {
        Referer: 'https://music.163.com/',
        Cookie: env.NETEASE_COOKIE || DEFAULT_NETEASE_COOKIE,
        'User-Agent': DEFAULT_NETEASE_UA,
        'X-Real-IP': randomNeteaseIp(),
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.8',
        Connection: 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
    };
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
            hash: 'SHA-1',
        },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
    return Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
