// 缓存名称
const CACHE_NAME = 'puzzle-ultimate-v1';

// 安装事件
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// 激活事件
self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// 简单的 Fetch 事件处理（防止报错）
self.addEventListener('fetch', (event) => {
    // 暂时直接通过网络请求，不进行复杂缓存，保证流畅度
    event.respondWith(fetch(event.request));
});
