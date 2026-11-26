// 備品台帳 service worker（公開版だけで使う。deploy.sh が ec789acdb340 と ["https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js","https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js","https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js","https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"] を書き換えて公開する）
// ・通信できるときは、いつも最新の版を開く
// ・通信できない、または返事が遅いとき（3.5秒）は、前回開いた版で開く。ホーム画面から開いたときも同じ
// ・PDF・Excel・QRコードの部品（CDN）と文字の形（フォント）は、一度取ったものを使い回す（どれも版の決まったURL）
// 登録内容は localStorage にあり、ここでは扱わない。キャッシュの名前は bihin- で始める
// （同じ vvkumav.github.io のほかのアプリのキャッシュには触れない）
const BUILD = 'ec789acdb340';
const LIBS = ["https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js","https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js","https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js","https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"];
const SHELL = 'bihin-shell';
const LIB_CACHE = 'bihin-libs';
const FONT_CACHE = 'bihin-fonts';
const OURS = [SHELL, LIB_CACHE, FONT_CACHE];
const SHELL_FILES = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const WAIT_MS = 3500;
const SCOPE = self.registration.scope;          // 例：https://vvkumav.github.io/bihin-daicho/
const SCOPE_PATH = new URL(SCOPE).pathname;

// 部品は CORS で取る（中身が確かめられる）。CORS に応じない場所だけ no-cors
async function fetchLib(url) {
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (r.ok) return r;
  } catch (e) {}
  const r = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
  return r.ok || r.type === 'opaque' ? r : null;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const page = await fetch(new Request(SCOPE, { cache: 'reload' }));
    if (!page.ok) throw new Error('page ' + page.status);
    await shell.put(SCOPE, page);
    await Promise.all(SHELL_FILES.map(async (f) => {
      try { const r = await fetch(new Request(f, { cache: 'reload' })); if (r.ok) await shell.put(new URL(f, SCOPE).href, r); } catch (e) {}
    }));
    const libs = await caches.open(LIB_CACHE);
    await Promise.all(LIBS.map(async (u) => {
      if (await libs.match(u, { ignoreVary: true })) return;
      try { const r = await fetchLib(u); if (r) await libs.put(u, r); } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('bihin-') && !OURS.includes(k)) await caches.delete(k);
    const libs = await caches.open(LIB_CACHE);   // 使わなくなった版の部品を消す
    for (const req of await libs.keys()) if (!LIBS.includes(req.url)) await libs.delete(req);
    await self.clients.claim();
  })());
});

// 転送（リダイレクト）を経た返事は、そのままでは画面の読み込みに使えないため作り直す
function plain(res) {
  if (!res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// 画面（index.html）：最新を取りに行き、だめなら前回の版
function page(event) {
  const req = event.request;
  const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      const cache = await caches.open(SHELL);
      await cache.put(SCOPE, res.clone());
    }
    return res;
  });
  event.waitUntil(net.catch(() => {}));
  return (async () => {
    const cached = () => caches.open(SHELL).then((c) => c.match(SCOPE));
    let timer;
    const slow = new Promise((resolve) => { timer = setTimeout(resolve, WAIT_MS, 'slow'); });
    try {
      const first = await Promise.race([net, slow]);
      if (first !== 'slow') {
        if (first.ok) return plain(first);
        return (await cached()) || plain(first);
      }
      const hit = await cached();          // 返事が遅い：前回の版を先に出す（最新は裏で保存しておく）
      return hit || plain(await net);
    } catch (e) {
      const hit = await cached();          // 通信できない
      if (hit) return hit;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  })();
}

async function cacheFirst(name, req) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(event, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(event.request, { ignoreVary: true });
  const net = fetch(event.request).then((res) => {
    if (res.ok || res.type === 'opaque') return cache.put(event.request, res.clone()).then(() => res);
    return res;
  });
  if (hit) { event.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(SCOPE_PATH)) return;
    const path = url.pathname.slice(SCOPE_PATH.length);
    if (path === '' || path === 'index.html') { event.respondWith(page(event)); return; }
    if (SHELL_FILES.includes(path)) {
      event.respondWith(caches.open(SHELL).then((c) => c.match(url.origin + url.pathname)).then((hit) => hit || fetch(req)));
    }
    return;   // version.json など：いつも通信する
  }
  if (LIBS.includes(req.url)) { event.respondWith(cacheFirst(LIB_CACHE, req)); return; }
  if (url.hostname === 'fonts.gstatic.com') { event.respondWith(cacheFirst(FONT_CACHE, req)); return; }
  if (url.hostname === 'fonts.googleapis.com') event.respondWith(staleWhileRevalidate(event, FONT_CACHE));
});
