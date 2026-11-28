const SCOPE = new URL('./',self.location.href);
const PREFIX = 'yomu-tracker-shell-' + SCOPE.pathname + '-';
const NAME = PREFIX + 'v8';
const SHELL = [
  './','./index.html','./style.css','./app.mjs','./geometry.mjs','./source.mjs','./storage.mjs',
  './render.mjs','./gestures.mjs','./icons.mjs','./manifest.webmanifest','./icon-192.png','./icon-512.png',
  './page-rail.mjs','./note-export.mjs','./settings-card.mjs',
  './app-icon.png','./favicon.png','./apple-touch-icon.png','./icon-maskable-512.png',
  './vendor/pdf.mjs','./vendor/pdf.worker.mjs','./asset-list.json'
];
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(NAME);
    await cache.addAll(SHELL.map(path=>new Request(new URL(path,SCOPE),{cache:'reload'})));
    const list=await (await cache.match('./asset-list.json')).json();
    // Small batches prevent a first-launch burst of simultaneous requests.
    for(let i=0;i<list.length;i+=16) await cache.addAll(list.slice(i,i+16));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key!==NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if (request.method!=='GET' || url.origin!==SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  event.respondWith((async()=>{
    const cache=await caches.open(NAME);
    if (request.mode==='navigate' && (url.pathname===SCOPE.pathname || url.pathname===SCOPE.pathname+'index.html')) {
      return (await cache.match('./index.html')) || fetch(request);
    }
    return (await cache.match(request)) || fetch(request);
  })());
});
