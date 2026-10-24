// Service worker: deixa o app instalável no celular e abre mesmo com a internet ruim.
// "Rede primeiro": sempre busca a versão nova; só usa a cópia guardada se estiver sem internet.
// As chamadas ao Supabase e aos sites de bibliotecas NÃO passam por aqui (são sempre ao vivo).
const PREFIXO = "molicenter-promotores-";
const CACHE = PREFIXO + "v2";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "manifest.json"])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  // apaga só as cópias antigas DESTE app (os outros apps da Molicenter ficam no mesmo endereço)
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith(PREFIXO) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp.ok) { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === "navigate" ? caches.match("./") : undefined)))
  );
});
