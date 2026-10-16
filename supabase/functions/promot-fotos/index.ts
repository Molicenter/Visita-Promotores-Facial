// promot-fotos — fotos do app web dos Promotores
// (já publicada no Supabase; este arquivo é a cópia do código, para referência)
// - action "upload": recebe a foto (base64) e envia ao ImgBB com a chave guardada no servidor
// - action "baixar": devolve uma foto-gabarito do ImgBB em base64 (evita bloqueio de CORS no navegador)
// Toda chamada exige o token de sessão do app (tabela promot_web_sessoes).
// A autenticação é feita aqui dentro (verify_jwt desligado), porque o app usa a chave publishable.

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function rest(caminho: string) {
  const r = await fetch(`${URL_BASE}/rest/v1/${caminho}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error("falha ao consultar o banco");
  return await r.json();
}

async function sessaoValida(token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token || "")) return false;
  const agora = new Date().toISOString();
  const linhas = await rest(`promot_web_sessoes?select=token&token=eq.${token}&expira_em=gt.${encodeURIComponent(agora)}`);
  return Array.isArray(linhas) && linhas.length > 0;
}

async function chaveImgbb() {
  const env = Deno.env.get("IMGBB_API_KEY");
  if (env) return env;
  const linhas = await rest("promot_web_segredos?select=valor&chave=eq.imgbb_api_key");
  return linhas?.[0]?.valor || "";
}

function paraBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) bin += String.fromCharCode(...bytes.subarray(i, i + passo));
  return btoa(bin);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return resposta({ erro: "METODO_INVALIDO" }, 405);

  let corpo: any;
  try { corpo = await req.json(); } catch { return resposta({ erro: "JSON_INVALIDO" }, 400); }

  try {
    if (!(await sessaoValida(corpo.token))) return resposta({ erro: "SESSAO_INVALIDA" }, 401);

    if (corpo.action === "upload") {
      const imagem = String(corpo.imagem || "").replace(/^data:image\/\w+;base64,/, "");
      if (!imagem || imagem.length > 12_000_000) return resposta({ erro: "IMAGEM_INVALIDA" }, 400);
      const chave = await chaveImgbb();
      if (!chave) return resposta({ erro: "IMGBB_NAO_CONFIGURADO" }, 500);
      const form = new FormData();
      form.append("key", chave);
      form.append("image", imagem);
      const r = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: form });
      const j = await r.json().catch(() => ({}));
      if (!j?.success) return resposta({ erro: "IMGBB_FALHOU" }, 502);
      return resposta({ url: j.data.url });
    }

    if (corpo.action === "baixar") {
      const url = String(corpo.url || "");
      let host = "";
      try { host = new URL(url).hostname; } catch { /* inválida */ }
      if (!(host === "i.ibb.co" || host.endsWith(".ibb.co") || host === "ibb.co")) return resposta({ erro: "URL_NAO_PERMITIDA" }, 400);
      const r = await fetch(url);
      if (!r.ok) return resposta({ erro: "FOTO_NAO_ENCONTRADA" }, 404);
      const tipo = r.headers.get("content-type") || "image/jpeg";
      return resposta({ dataUrl: `data:${tipo};base64,${paraBase64(await r.arrayBuffer())}` });
    }

    return resposta({ erro: "ACAO_INVALIDA" }, 400);
  } catch (_e) {
    return resposta({ erro: "ERRO_INTERNO" }, 500);
  }
});
