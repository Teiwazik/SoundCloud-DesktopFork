/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {any} */ (self);

/** @type {string[]} */
const WHITELIST = [
    'localhost',
    '127.0.0.1',
    'tauri.localhost',
    'ipc.localhost',
    'scproxy.localhost',
    'api.scdinternal.site',
    'proxy.scdinternal.site',
    'stream.scdinternal.site',
    'stream-premium.scdinternal.site',
    'storage.scdinternal.site',
    'unpkg.com',
];
/** @type {string | null} */
const PORT = new URL(sw.location.href).searchParams.get('port');

/** @type {string[]} */
const HOST_SUFFIX_BYPASS = ['.cloud.qdrant.io', '.qdrant.io'];

sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (shouldBypassProxy(url, event.request.method)) return;
    if (!PORT) return;

    event.respondWith(proxyRequest(event.request));
});

/**
 * @param {URL} url
 * @param {string} method
 */
function shouldBypassProxy(url, method) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    if (method === 'OPTIONS') return true;
    if (WHITELIST.some((w) => url.hostname === w)) return true;
    if (HOST_SUFFIX_BYPASS.some((suffix) => url.hostname.endsWith(suffix))) return true;
    return false;
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function proxyRequest(request) {
    const requestForBody = request.clone();
    const requestForFallback = request.clone();
    const proxyUrl = `http://127.0.0.1:${PORT}/p/${btoa(request.url)}`;

    /** @type {RequestInit} */
    const init = {
        method: request.method,
        headers: {},
    };

    // Forward relevant headers
    for (const [key, value] of request.headers) {
        const k = key.toLowerCase();
        if (['content-type', 'range', 'accept', 'accept-encoding', 'authorization', 'api-key'].includes(k)) {
            init.headers[k] = value;
        }
    }

    // Forward body for non-GET/HEAD
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await requestForBody.arrayBuffer();
    }

    try {
        const res = await fetch(proxyUrl, init);
        if (res.ok || res.status === 206) {
            return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
            });
        }
    } catch {
    }

    // Fallback: direct request
    try {
        return await fetch(requestForFallback);
    } catch {
        return Response.error();
    }
}
