// ============================================================
// Registro de Promotores — Molicenter (app web)
// Conversa com o Supabase só pelas funções promot_web_* (ver sql/)
// e com a função promot-fotos (upload/download no ImgBB).
// Reconhecimento facial: face-api (roda no próprio navegador).
// ============================================================
"use strict";

const CFG = window.CONFIG;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CHAVE_SESSAO = "promot_web_sessao";
const DIAS = ["SEG", "TER", "QUA", "QUI", "SEX", "SAB", "DOM"];
const LOJAS = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(2, "0"));

// ---------------- estado ----------------
let sessao = lerSessao();     // { token, usuario, email, perfil, loja }
let lojaAtual = null;         // número (1..8)
let dados = { fornecedores: [], visitas: [], gabaritos: [], agora: "" };
let paginaAtual = "agenda";
let filtroAgenda = "todos";
let fornEditando = null;

const facial = {
  modelos: false,        // modelos carregados
  carregandoModelos: null,
  stream: null,
  rostos: [],            // [{ id, empresa, nome, descritor: Float32Array }]
  ocupado: false,
  estavel: 0,
  falhas: 0,
  pausaAte: 0,
  ultimo: {},            // empresa -> horário (ms) do último registro nesta tela
  timer: null,
};

// ============================================================
// Utilidades
// ============================================================
function lerSessao() {
  try { return JSON.parse(localStorage.getItem(CHAVE_SESSAO)) || null; } catch { return null; }
}
function gravarSessao(s) {
  try { s ? localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)) : localStorage.removeItem(CHAVE_SESSAO); } catch {}
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const iniciais = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

function hojeSP() {
  // dia da semana e data no fuso de São Paulo (não depende do relógio/fuso do PC)
  const partes = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date());
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const ds = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })).getDay();
  return { sigla: DIAS[(ds + 6) % 7], data: `${p.day}/${p.month}/${p.year}`, curto: `${p.weekday.replace(".", "")}, ${p.day}/${p.month}` };
}
const horaDe = (dataTxt) => String(dataTxt || "").slice(11, 16);
const temDia = (freq, d) => String(freq || "").toUpperCase().includes(d);

let toastTimer;
function toast(msg, tipo = "") {
  const t = $("#toast");
  t.className = "toast " + tipo;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), tipo === "erro" ? 5000 : 3200);
}
function carregando(on) { $("#carregando").hidden = !on; }

const MENSAGENS = {
  SENHA_INCORRETA: "Senha incorreta.",
  USUARIO_INVALIDO: "Escolha um usuário da lista.",
  SENHA_NAO_CONFIGURADA: "A senha deste usuário ainda não foi configurada no banco.",
  MUITAS_TENTATIVAS: "Muitas tentativas erradas. Espere 10 minutos e tente de novo.",
  LOJA_INVALIDA: "Escolha uma loja de 01 a 08.",
  FORNECEDOR_VAZIO: "Preencha o nome do fornecedor.",
  FORNECEDOR_NAO_ENCONTRADO: "Esse fornecedor não existe mais nesta loja. Atualize a tela.",
  DADOS_INCOMPLETOS: "Preencha a empresa e o nome do promotor.",
  DESCRITOR_INVALIDO: "Não foi possível ler o rosto. Tire a foto de novo.",
  FOTO_AUSENTE: "A foto não foi enviada. Tente de novo.",
  IMGBB_NAO_CONFIGURADO: "A chave do ImgBB ainda não foi configurada no banco.",
  IMGBB_FALHOU: "O ImgBB não aceitou a foto agora. Tente de novo em instantes.",
};
function traduzir(msg) {
  for (const k in MENSAGENS) if (String(msg).includes(k)) return MENSAGENS[k];
  return msg;
}

// ============================================================
// Supabase: funções do banco (RPC) e função de fotos
// ============================================================
async function rpc(fn, args = {}) {
  let resp;
  try {
    resp = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: CFG.SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error("Sem conexão com a internet. Tente de novo.");
  }
  const texto = await resp.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = texto; }
  if (!resp.ok) {
    const msg = (corpo && (corpo.message || corpo.hint)) || `Erro ${resp.status}`;
    if (String(msg).includes("SESSAO_INVALIDA")) {
      sair(true);
      throw new Error("Sua sessão expirou. Entre de novo.");
    }
    throw new Error(traduzir(msg));
  }
  return corpo;
}

async function fotos(action, extra) {
  let resp;
  try {
    resp = await fetch(`${CFG.SUPABASE_URL}/functions/v1/promot-fotos`, {
      method: "POST",
      headers: { apikey: CFG.SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: sessao?.token, ...extra }),
    });
  } catch {
    throw new Error("Sem conexão para enviar a foto.");
  }
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (j.erro === "SESSAO_INVALIDA") { sair(true); throw new Error("Sua sessão expirou. Entre de novo."); }
    throw new Error(traduzir(j.erro || `Erro ${resp.status}`));
  }
  return j;
}
const enviarFoto = async (dataUrl) => (await fotos("upload", { imagem: dataUrl })).url;

// reduz a foto para no máximo 1280 px (envio mais rápido)
function reduzirImagem(fonte, max = 1280, qualidade = 0.85) {
  const w0 = fonte.videoWidth || fonte.naturalWidth || fonte.width;
  const h0 = fonte.videoHeight || fonte.naturalHeight || fonte.height;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext("2d").drawImage(fonte, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", qualidade);
}
function carregarImagem(src) {
  return new Promise((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = erro; i.src = src; });
}

// ============================================================
// Login
// ============================================================
function mostrarLogin() {
  pararCamera();
  $("#app").hidden = true;
  $("#tela-login").hidden = false;
  $("#versao-login").textContent = `versão ${CFG.VERSAO}`;
  const sel = $("#login-usuario");
  sel.innerHTML = '<option value="">Escolha...</option>' +
    ["Administrador", ...LOJAS.map((l) => "Loja " + l)].map((u) => `<option>${u}</option>`).join("");
  try { const u = localStorage.getItem("promot_web_ultimo_usuario"); if (u) sel.value = u; } catch {}
  setTimeout(() => (sel.value ? $("#login-senha") : sel).focus(), 50);
}
function erroLogin(msg) { const p = $("#login-erro"); p.textContent = msg || ""; p.hidden = !msg; }

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const usuario = $("#login-usuario").value;
  const senha = $("#login-senha").value;
  if (!usuario) return erroLogin("Escolha o usuário.");
  if (!senha) return erroLogin("Digite a senha.");
  erroLogin("");
  $("#btn-entrar").disabled = true;
  try {
    const r = await rpc("promot_web_login", { p_usuario: usuario, p_senha: senha });
    sessao = r;
    gravarSessao(sessao);
    try { localStorage.setItem("promot_web_ultimo_usuario", usuario); } catch {}
    $("#login-senha").value = "";
    await iniciarApp();
  } catch (err) {
    erroLogin(err.message);
  } finally {
    $("#btn-entrar").disabled = false;
  }
});

function sair(silencioso = false) {
  if (sessao && !silencioso) rpc("promot_web_sair", { p_token: sessao.token }).catch(() => {});
  sessao = null;
  gravarSessao(null);
  dados = { fornecedores: [], visitas: [], gabaritos: [], agora: "" };
  facial.rostos = [];
  fecharGaveta();
  mostrarLogin();
}
$("#btn-sair").addEventListener("click", () => sair());

// ============================================================
// Início do app
// ============================================================
async function iniciarApp() {
  $("#tela-login").hidden = true;
  $("#app").hidden = false;
  const admin = sessao.perfil === "analista";
  $("#conta-nome").textContent = sessao.usuario;
  $("#conta-perfil").textContent = admin ? "Administrador · vê todas as lojas" : "Fiscal de loja";

  if (admin) {
    let salva = null;
    try { salva = localStorage.getItem("promot_web_loja_admin"); } catch {}
    lojaAtual = Number(salva) || 1;
    $("#pilula-loja").innerHTML = 'Loja <select id="sel-loja" aria-label="Loja">' +
      LOJAS.map((l) => `<option value="${+l}" ${+l === lojaAtual ? "selected" : ""}>${l}</option>`).join("") + "</select>";
    $("#sel-loja").addEventListener("change", async (ev) => {
      lojaAtual = Number(ev.target.value);
      try { localStorage.setItem("promot_web_loja_admin", lojaAtual); } catch {}
      await recarregar(true);
      toast("Mostrando a Loja " + String(lojaAtual).padStart(2, "0"));
    });
  } else {
    lojaAtual = Number(sessao.loja);
    $("#pilula-loja").textContent = "Loja " + String(lojaAtual).padStart(2, "0");
  }
  $("#pilula-data").textContent = hojeSP().curto;

  irPara("agenda");
  const ok = await recarregar(true);
  if (!ok) return;
  prepararFacial();          // modelos + câmera (em segundo plano)
}

async function recarregar(comSpinner = false) {
  if (!sessao) return false;
  if (comSpinner) carregando(true);
  try {
    dados = await rpc("promot_web_dados", { p_token: sessao.token, p_loja: lojaAtual });
    renderTudo();
    prepararRostos();
    return true;
  } catch (e) {
    toast(e.message, "erro");
    return false;
  } finally {
    if (comSpinner) carregando(false);
  }
}
// atualiza a cada 2 minutos (registros feitos em outro computador aparecem sozinhos)
setInterval(() => { if (sessao && !document.hidden && !facial.ocupado) recarregar(false); }, 120000);

// ============================================================
// Navegação
// ============================================================
const PAGINAS = {
  checkin: ["Check-in facial", "O promotor se posiciona na frente da câmera e a visita é registrada sozinha."],
  agenda: ["Agenda de hoje", ""],
  manual: ["Registro manual", "Para quando a câmera não reconhecer ou o promotor não tiver rosto cadastrado."],
  promotores: ["Fornecedores e promotores", "Cadastro da loja: quem atende, telefone e dias de visita."],
  facial: ["Cadastro facial", "Foto de referência que o check-in usa para reconhecer o promotor."],
};
function irPara(pg) {
  paginaAtual = pg;
  $$("#nav button").forEach((b) => b.classList.toggle("ativo", b.dataset.pg === pg));
  Object.keys(PAGINAS).forEach((k) => ($("#pg-" + k).hidden = k !== pg));
  $("#pg-titulo").textContent = PAGINAS[pg][0];
  $("#pg-sub").textContent = pg === "agenda"
    ? `Fornecedores com visita prevista para ${hojeSP().sigla} e quem já passou pela loja.`
    : PAGINAS[pg][1];
  window.scrollTo(0, 0);
}
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("button[data-pg]"); if (b) irPara(b.dataset.pg); });

function renderTudo() {
  renderRegistrosHoje();
  renderAgenda();
  renderManual();
  renderForn();
  renderFacial();
}

// ============================================================
// Visitas de hoje
// ============================================================
const fornDoDia = () => dados.fornecedores.filter((f) => temDia(f.frequencia, hojeSP().sigla));
function visitaDe(nome) {
  const n = norm(nome);
  return dados.visitas.find((v) => norm(v.fornecedor) === n);
}
function renderRegistrosHoje() {
  const v = dados.visitas;
  $("#qtd-hoje").textContent = v.length + (v.length === 1 ? " visita" : " visitas");
  $("#lista-hoje").innerHTML = v.length ? v.map((r) => {
    const facialR = r.frequencia === "FACIAL";
    const temFoto = r.foto && /^https?:\/\//.test(r.foto);
    return `<div class="registro"><div class="avatar">${esc(iniciais(r.fornecedor))}</div>
      <div><b>${esc(r.fornecedor)}</b><small><span class="tag ${facialR ? "facial" : "manual"}">${facialR ? "FACIAL" : "MANUAL"}</span>
      ${temFoto ? ` · <a class="ver-foto" href="${esc(r.foto)}" target="_blank" rel="noopener">ver foto</a>` : ""}
      ${r.obs && !facialR ? ` · ${esc(r.obs)}` : ""}</small></div>
      <div class="hora num">${horaDe(r.data)}</div></div>`;
  }).join("") : '<p class="vazio">Nenhuma visita registrada hoje nesta loja.</p>';
  const pend = fornDoDia().filter((f) => !visitaDe(f.fornecedor)).length;
  const c = $("#nav-pendentes"); c.textContent = pend; c.hidden = pend === 0;
}

// ============================================================
// Agenda de hoje
// ============================================================
function diasHtml(freq) {
  const hoje = hojeSP().sigla;
  return '<span class="dias">' + DIAS.map((d) => `<i class="${temDia(freq, d) ? (d === hoje ? "hoje" : "on") : ""}">${d}</i>`).join("") + "</span>";
}
function renderAgenda() {
  const hj = hojeSP();
  const dia = fornDoDia();
  const ok = dia.filter((f) => visitaDe(f.fornecedor)).length;
  const pend = dia.length - ok;
  const nomesDia = new Set(dia.map((f) => norm(f.fornecedor)));
  const fora = new Set(dados.visitas.filter((v) => !nomesDia.has(norm(v.fornecedor))).map((v) => norm(v.fornecedor))).size;
  const pct = dia.length ? Math.round((ok / dia.length) * 100) : 0;
  $("#kpis").innerHTML = `
    <div class="kpi destaque"><small>Previstos hoje</small><strong class="num">${dia.length}</strong><span>${hj.sigla}, ${hj.data}</span></div>
    <div class="kpi verde"><small>Já passaram</small><strong class="num">${ok}</strong><div class="progresso"><i style="width:${pct}%;background:var(--verde)"></i></div></div>
    <div class="kpi laranja"><small>Pendentes</small><strong class="num">${pend}</strong><span>ainda não registraram</span></div>
    <div class="kpi"><small>Fora da agenda</small><strong class="num">${fora}</strong><span>vieram em dia não previsto</span></div>`;
  const q = norm($("#busca-agenda").value);
  const linhas = dia.filter((f) => {
    const r = visitaDe(f.fornecedor);
    if (filtroAgenda === "pend" && r) return false;
    if (filtroAgenda === "ok" && !r) return false;
    return !q || norm([f.fornecedor, f.marca, f.promotor].join(" ")).includes(q);
  });
  $("#tb-agenda").innerHTML = linhas.length ? linhas.map((f) => {
    const r = visitaDe(f.fornecedor);
    return `<tr><td><div class="principal-cel">${esc(f.fornecedor)}</div><div class="sub-cel">${esc(f.marca)}</div></td>
      <td><div>${esc(f.promotor)}</div><div class="sub-cel num">${esc(f.telefone)}</div></td><td>${esc(f.comprador)}</td>
      <td>${diasHtml(f.frequencia)}</td>
      <td>${r ? `<span class="tag ok num">Registrado ${horaDe(r.data)}</span>` : '<span class="tag pend">Pendente</span>'}</td></tr>`;
  }).join("") : `<tr><td colspan="5" class="vazio">${dia.length ? "Nada para mostrar com esse filtro." : "Nenhum fornecedor com visita prevista para hoje."}</td></tr>`;
}
$("#filtro-agenda").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  filtroAgenda = b.dataset.f;
  $$("#filtro-agenda button").forEach((x) => x.classList.toggle("sel", x === b));
  renderAgenda();
});
$("#busca-agenda").addEventListener("input", renderAgenda);

// ============================================================
// Registro manual
// ============================================================
let fotoManual = null;   // dataURL reduzida
function renderManual() {
  const sel = $("#man-forn"), atual = sel.value;
  sel.innerHTML = '<option value="">Escolha...</option>' +
    dados.fornecedores.map((f) => `<option value="${f.id}">${esc(f.fornecedor)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
  mostrarInfoForn();
}
function mostrarInfoForn() {
  const f = dados.fornecedores.find((x) => String(x.id) === $("#man-forn").value);
  $("#btn-manual").disabled = !f;
  if (!f) {
    $("#info-forn").innerHTML = `<div class="estado"><div class="icone"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h18M3 12h18M3 17h12"/></svg></div><strong>Escolha um fornecedor</strong><p>Os dados do cadastro aparecem aqui para conferir antes de registrar.</p></div>`;
    return;
  }
  const r = visitaDe(f.fornecedor);
  const tag = r ? `<span class="tag ok num">Já registrado hoje às ${horaDe(r.data)}</span>`
    : temDia(f.frequencia, hojeSP().sigla) ? '<span class="tag pend">Previsto para hoje</span>' : '<span class="tag fora">Fora do dia previsto</span>';
  $("#info-forn").innerHTML = `<div class="cartao-forn"><div class="cabeca"><div class="avatar">${esc(iniciais(f.fornecedor))}</div><div><h4>${esc(f.fornecedor)}</h4>${tag}</div></div>
    <dl><dt>Marcas</dt><dd>${esc(f.marca) || "—"}</dd><dt>Promotor</dt><dd>${esc(f.promotor) || "—"}</dd>
    <dt>Telefone</dt><dd class="num">${esc(f.telefone) || "—"}</dd><dt>Comprador</dt><dd>${esc(f.comprador) || "—"}</dd>
    <dt>Visitas</dt><dd>${diasHtml(f.frequencia)}</dd></dl></div>`;
}
$("#man-forn").addEventListener("change", mostrarInfoForn);

async function previaFoto(arq) {
  if (!arq || !arq.type.startsWith("image/")) return;
  const url = URL.createObjectURL(arq);
  try {
    const img = await carregarImagem(url);
    fotoManual = reduzirImagem(img);
    const p = $("#man-previa"); p.src = fotoManual; p.hidden = false;
    $("#soltar-txt").textContent = arq.name + " (clique para trocar)";
  } catch { toast("Não consegui abrir essa imagem.", "erro"); }
  finally { URL.revokeObjectURL(url); }
}
function limparFotoManual() {
  fotoManual = null; $("#man-previa").hidden = true; $("#man-foto").value = "";
  $("#soltar-txt").textContent = "Arraste a foto aqui ou clique para escolher";
}
$("#man-foto").addEventListener("change", (e) => previaFoto(e.target.files[0]));
const soltar = $("#soltar");
["dragenter", "dragover"].forEach((ev) => soltar.addEventListener(ev, (e) => { e.preventDefault(); soltar.classList.add("sobre"); }));
["dragleave", "drop"].forEach((ev) => soltar.addEventListener(ev, (e) => { e.preventDefault(); soltar.classList.remove("sobre"); }));
soltar.addEventListener("drop", (e) => previaFoto(e.dataTransfer.files[0]));

$("#form-manual").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = dados.fornecedores.find((x) => String(x.id) === $("#man-forn").value);
  if (!f) return;
  const btn = $("#btn-manual");
  btn.disabled = true; btn.textContent = "Gravando...";
  try {
    let link = "";
    if (fotoManual) link = await enviarFoto(fotoManual);
    await rpc("promot_web_registrar", {
      p_token: sessao.token, p_loja: lojaAtual, p_fornecedor: f.fornecedor,
      p_obs: $("#man-obs").value.trim(), p_foto: link, p_facial: false,
    });
    $("#form-manual").reset(); limparFotoManual();
    await recarregar(false);
    toast("Registro de " + f.fornecedor + " salvo", "ok");
  } catch (err) {
    toast(err.message, "erro");
  } finally {
    btn.textContent = "Confirmar registro"; mostrarInfoForn();
  }
});

// ============================================================
// Fornecedores (cadastro da loja)
// ============================================================
function renderForn() {
  const q = norm($("#busca-forn").value);
  const lista = dados.fornecedores.filter((f) => !q || norm([f.cod, f.fornecedor, f.marca, f.promotor, f.telefone].join(" ")).includes(q));
  $("#tb-forn").innerHTML = lista.length ? lista.map((f) => `<tr>
    <td class="num">${esc(f.cod)}</td>
    <td><div class="principal-cel">${esc(f.fornecedor)}</div><div class="sub-cel">${esc(f.marca)}</div></td>
    <td>${esc(f.promotor)}</td><td class="num">${esc(f.telefone)}</td><td>${diasHtml(f.frequencia)}</td>
    <td style="text-align:right"><button class="btn btn-texto" data-editar="${f.id}" type="button">Editar</button></td></tr>`).join("")
    : `<tr><td colspan="6" class="vazio">${dados.fornecedores.length ? "Nenhum fornecedor encontrado." : "Nenhum fornecedor cadastrado nesta loja."}</td></tr>`;
}
$("#busca-forn").addEventListener("input", renderForn);
$("#tb-forn").addEventListener("click", (e) => {
  const b = e.target.closest("[data-editar]");
  if (b) abrirGaveta(dados.fornecedores.find((f) => String(f.id) === b.dataset.editar));
});
$("#btn-novo-forn").addEventListener("click", () => abrirGaveta(null));

function abrirGaveta(f) {
  const novo = !f;
  fornEditando = f;
  f = f || { cod: "", fornecedor: "", marca: "", comprador: "", promotor: "", telefone: "", frequencia: "" };
  const g = $("#gaveta");
  g.innerHTML = `<div class="gaveta-topo"><h3 id="gav-titulo">${novo ? "Novo fornecedor" : "Editar fornecedor"}</h3><button class="btn-fechar" type="button" id="gav-fechar" aria-label="Fechar">×</button></div>
    <form class="gaveta-corpo" id="gav-form" autocomplete="off">
      <div class="linha-2"><label class="campo"><span>Código</span><input id="g-cod" value="${esc(f.cod)}"></label>
      <label class="campo"><span>Comprador</span><input id="g-comp" value="${esc(f.comprador)}"></label></div>
      <label class="campo"><span>Fornecedor</span><input id="g-forn" value="${esc(f.fornecedor)}"></label>
      <label class="campo"><span>Marcas</span><input id="g-marca" value="${esc(f.marca)}"></label>
      <div class="linha-2"><label class="campo"><span>Promotor</span><input id="g-prom" value="${esc(f.promotor)}"></label>
      <label class="campo"><span>Telefone</span><input id="g-tel" value="${esc(f.telefone)}"></label></div>
      <div class="campo"><span>Dias de visita</span><div class="dias-escolha" id="g-dias">${DIAS.map((d) => `<button type="button" class="${temDia(f.frequencia, d) ? "sel" : ""}" data-d="${d}">${d}</button>`).join("")}</div></div>
      <p id="g-erro" class="erro" hidden></p>
      ${novo ? "" : '<div id="g-excluir-area"><button class="btn btn-texto" type="button" id="g-excluir" style="color:var(--vermelho)">Remover este fornecedor da loja</button></div>'}
    </form>
    <div class="gaveta-rodape"><button class="btn btn-secundario" type="button" id="gav-cancelar">Cancelar</button><button class="btn btn-primario" type="button" id="gav-salvar">Salvar</button></div>`;
  $("#veu").hidden = false; g.hidden = false; $("#g-forn").focus();
  $("#g-dias").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) b.classList.toggle("sel"); });
  $("#gav-form").addEventListener("submit", (e) => { e.preventDefault(); salvarForn(novo); });
  $("#gav-fechar").onclick = $("#gav-cancelar").onclick = fecharGaveta;
  $("#gav-salvar").onclick = () => salvarForn(novo);
  const ex = $("#g-excluir");
  if (ex) ex.onclick = () => {
    $("#g-excluir-area").innerHTML = `<div class="confirmar-excluir">Remover ${esc(f.fornecedor)} desta loja? Os registros de visita já feitos continuam guardados.
      <div><button class="btn btn-secundario" type="button" id="g-nao">Manter</button><button class="btn btn-perigo" type="button" id="g-sim">Remover</button></div></div>`;
    $("#g-nao").onclick = () => abrirGaveta(fornEditando);
    $("#g-sim").onclick = async () => {
      try {
        await rpc("promot_web_remover_fornecedor", { p_token: sessao.token, p_loja: lojaAtual, p_id: f.id });
        fecharGaveta(); await recarregar(false); toast(f.fornecedor + " removido da loja");
      } catch (err) { toast(err.message, "erro"); }
    };
  };
}
async function salvarForn(novo) {
  const nome = $("#g-forn").value.trim();
  const erro = $("#g-erro");
  if (!nome) { erro.textContent = "Preencha o nome do fornecedor."; erro.hidden = false; return; }
  const dadosForn = {
    cod: $("#g-cod").value.trim(), fornecedor: nome, marca: $("#g-marca").value.trim(),
    comprador: $("#g-comp").value.trim(), promotor: $("#g-prom").value.trim(), telefone: $("#g-tel").value.trim(),
    frequencia: $$("#g-dias button.sel").map((b) => b.dataset.d).join("/"),
  };
  const btn = $("#gav-salvar"); btn.disabled = true;
  try {
    await rpc("promot_web_salvar_fornecedor", { p_token: sessao.token, p_loja: lojaAtual, p_id: novo ? null : fornEditando.id, p_dados: dadosForn });
    fecharGaveta(); await recarregar(false);
    toast(novo ? nome + " cadastrado" : "Alterações de " + nome + " salvas", "ok");
  } catch (err) {
    erro.textContent = err.message; erro.hidden = false; btn.disabled = false;
  }
}
function fecharGaveta() { $("#gaveta").hidden = true; $("#veu").hidden = true; fornEditando = null; }
$("#veu").addEventListener("click", fecharGaveta);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#gaveta").hidden) fecharGaveta(); });

// ============================================================
// Reconhecimento facial
// ============================================================
const opcoesRapidas = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
const opcoesPrecisas = () => new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });

function carregarModelos() {
  if (facial.carregandoModelos) return facial.carregandoModelos;
  facial.carregandoModelos = (async () => {
    if (!window.faceapi) throw new Error("Não foi possível baixar o reconhecimento facial. Verifique a internet e recarregue a página.");
    const u = CFG.MODELOS_URL;
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(u),
      faceapi.nets.ssdMobilenetv1.loadFromUri(u),
      faceapi.nets.faceLandmark68Net.loadFromUri(u),
      faceapi.nets.faceRecognitionNet.loadFromUri(u),
    ]);
    facial.modelos = true;
  })();
  facial.carregandoModelos.catch(() => (facial.carregandoModelos = null));
  return facial.carregandoModelos;
}

async function prepararFacial() {
  estadoCheckin("espera");
  ligarCamera();
  try {
    await carregarModelos();
    $("#status-modelos").innerHTML = '<span class="ok">● Reconhecimento pronto</span>';
    await prepararRostos();
    iniciarLoop();
  } catch (e) {
    $("#status-modelos").innerHTML = `<span class="aviso">● ${esc(e.message)}</span>`;
  }
}

// assinatura dos rostos cadastrados; as que vieram do Streamlit (sem assinatura) são calculadas aqui a partir da foto
let preparandoRostos = false;
async function prepararRostos() {
  if (!facial.modelos || preparandoRostos) return;
  preparandoRostos = true;
  try {
    const prontos = [];
    let semFoto = 0;
    for (const g of dados.gabaritos) {
      let desc = Array.isArray(g.descritor) && g.descritor.length === 128 ? g.descritor : null;
      if (!desc && g.link) {
        try {
          const { dataUrl } = await fotos("baixar", { url: g.link });
          const img = await carregarImagem(dataUrl);
          const det = await faceapi.detectSingleFace(img, opcoesPrecisas()).withFaceLandmarks().withFaceDescriptor();
          if (det) {
            desc = Array.from(det.descriptor);
            g.descritor = desc;
            rpc("promot_web_salvar_descritor", { p_token: sessao.token, p_id: g.id, p_descritor: desc }).catch(() => {});
          }
        } catch { /* foto indisponível: segue sem esse rosto */ }
      }
      if (desc) prontos.push({ id: g.id, empresa: g.empresa, nome: g.nome, descritor: new Float32Array(desc) });
      else semFoto++;
    }
    facial.rostos = prontos;
    $("#status-rostos").textContent = `${prontos.length} ${prontos.length === 1 ? "rosto cadastrado" : "rostos cadastrados"}` +
      (semFoto ? ` · ${semFoto} sem foto válida` : "");
    renderFacial();
  } finally {
    preparandoRostos = false;
  }
}

async function ligarCamera() {
  const sem = $("#camera-sem");
  if (facial.stream) { ligarVideos(); return; }
  if (!navigator.mediaDevices?.getUserMedia) {
    mostrarSemCamera("Este navegador não libera a câmera", "Abra o app no Chrome ou no Edge atualizado.");
    return;
  }
  try {
    facial.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
    sem.hidden = true;
    ligarVideos();
  } catch (e) {
    const negou = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    mostrarSemCamera(negou ? "A câmera foi bloqueada" : "Câmera não encontrada",
      negou ? "Clique no ícone de câmera na barra de endereço do navegador, escolha Permitir e depois clique em Ligar câmera."
            : "Confira se a webcam está conectada e não está aberta em outro programa.");
  }
}
function ligarVideos() {
  for (const id of ["video", "video-cad"]) {
    const v = $("#" + id);
    if (v.srcObject !== facial.stream) v.srcObject = facial.stream;
    v.play().catch(() => {});
  }
  $("#camera").classList.add("ligada"); $("#camera-cad").classList.add("ligada");
  $("#camera-dica").textContent = "Aproxime o rosto até preencher o contorno";
}
function mostrarSemCamera(titulo, texto) {
  $("#camera-sem-titulo").textContent = titulo;
  $("#camera-sem-texto").textContent = texto;
  $("#camera-sem").hidden = false;
  $("#camera-dica").textContent = "Câmera desligada";
}
function pararCamera() {
  clearTimeout(facial.timer); facial.timer = null;
  if (facial.stream) facial.stream.getTracks().forEach((t) => t.stop());
  facial.stream = null;
  $("#camera").classList.remove("ligada", "lendo", "ok"); $("#camera-cad").classList.remove("ligada");
}
$("#btn-ligar-camera").addEventListener("click", ligarCamera);

function medidor(proporcao) {
  const alvo = CFG.TAMANHO_MIN_ROSTO;
  const pct = Math.max(0, Math.min(100, (proporcao / alvo) * 100));
  $("#medidor-barra").style.width = pct + "%";
  $("#medidor-barra").style.background = pct >= 100 ? "var(--verde)" : "var(--magenta)";
  $("#medidor-txt").textContent = proporcao <= 0 ? "Sem rosto" : pct >= 100 ? "Distância boa" : pct >= 65 ? "Quase lá" : "Muito longe";
}

function iniciarLoop() {
  clearTimeout(facial.timer);
  const passo = async () => {
    try { await verificarQuadro(); } catch { /* quadro ruim: tenta o próximo */ }
    facial.timer = setTimeout(passo, 300);
  };
  passo();
}

async function verificarQuadro() {
  const v = $("#video");
  if (!sessao || !facial.modelos || !facial.stream || facial.ocupado) return;
  if (paginaAtual !== "checkin" || document.hidden || v.readyState < 2) return;
  if (Date.now() < facial.pausaAte) return;

  const det = await faceapi.detectSingleFace(v, opcoesRapidas());
  const cam = $("#camera");
  if (!det) {
    medidor(0); facial.estavel = 0; cam.classList.remove("lendo");
    $("#camera-dica").textContent = "Aproxime o rosto até preencher o contorno";
    return;
  }
  const prop = det.box.width / v.videoWidth;
  medidor(prop);
  if (prop < CFG.TAMANHO_MIN_ROSTO) {
    facial.estavel = 0; cam.classList.remove("lendo");
    $("#camera-dica").textContent = prop < CFG.TAMANHO_MIN_ROSTO * 0.65 ? "Chegue mais perto da câmera" : "Mais um pouco perto";
    return;
  }
  facial.estavel++;
  cam.classList.add("lendo");
  $("#camera-dica").textContent = "Fique parado, conferindo...";
  if (facial.estavel >= 2) await reconhecer();
}

async function reconhecer() {
  facial.ocupado = true;
  const v = $("#video"), cam = $("#camera");
  try {
    if (!facial.rostos.length) {
      estadoCheckin("semrostos");
      facial.pausaAte = Date.now() + 6000;
      return;
    }
    const det = await faceapi.detectSingleFace(v, opcoesRapidas()).withFaceLandmarks().withFaceDescriptor();
    if (!det) return;
    let melhor = null;
    for (const r of facial.rostos) {
      const d = faceapi.euclideanDistance(det.descriptor, r.descritor);
      if (!melhor || d < melhor.d) melhor = { ...r, d };
    }
    if (!melhor || melhor.d > CFG.LIMIAR_ROSTO) {
      facial.falhas++;
      if (facial.falhas >= 4) {
        facial.falhas = 0; facial.estavel = 0;
        cam.classList.remove("lendo");
        $("#camera-dica").textContent = "Rosto não encontrado";
        estadoCheckin("falha");
        facial.pausaAte = Date.now() + 5000;
      }
      return;
    }
    facial.falhas = 0;
    // mesmo promotor reconhecido há pouco nesta tela: não registra de novo
    if (facial.ultimo[melhor.empresa] && Date.now() - facial.ultimo[melhor.empresa] < 90000) {
      facial.pausaAte = Date.now() + 4000;
      return;
    }
    const foto = reduzirImagem(v, 960, 0.82);
    cam.classList.remove("lendo"); cam.classList.add("ok");
    $("#camera-dica").textContent = "Reconhecido: " + melhor.empresa;
    estadoCheckin("registrando", { empresa: melhor.empresa, nome: melhor.nome, foto });

    let link = "";
    try { link = await enviarFoto(foto); } catch { link = ""; /* registra mesmo sem foto, como antes */ }
    const r = await rpc("promot_web_registrar", {
      p_token: sessao.token, p_loja: lojaAtual, p_fornecedor: melhor.empresa, p_obs: "", p_foto: link, p_facial: true,
    });
    facial.ultimo[melhor.empresa] = Date.now();
    estadoCheckin(r.duplicado ? "duplicado" : "sucesso", { empresa: melhor.empresa, nome: melhor.nome, foto, hora: horaDe(r.data) });
    if (!r.duplicado) toast("Visita de " + melhor.empresa + " registrada", "ok");
    await recarregar(false);
    facial.pausaAte = Date.now() + 7000;
    setTimeout(() => { if (Date.now() >= facial.pausaAte - 100) { cam.classList.remove("ok"); estadoCheckin("espera"); } }, 7000);
  } catch (e) {
    toast(e.message, "erro");
    estadoCheckin("espera");
    facial.pausaAte = Date.now() + 4000;
  } finally {
    facial.estavel = 0;
    facial.ocupado = false;
  }
}

const ICONES = {
  pessoa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="9" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m5 12 5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  girando: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-9-9"/></svg>',
  relogio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
function estadoCheckin(tipo, d = {}) {
  const el = $("#estado-checkin");
  const ficha = d.empresa ? `<dl class="ficha"><dt>Empresa</dt><dd>${esc(d.empresa)}</dd><dt>Promotor</dt><dd>${esc(d.nome || "—")}</dd>
    ${d.hora ? `<dt>Horário</dt><dd class="num">${d.hora}</dd>` : ""}<dt>Loja</dt><dd>${String(lojaAtual).padStart(2, "0")}</dd></dl>` : "";
  const foto = d.foto ? `<img class="foto-mini" src="${d.foto}" alt="">` : "";
  const html = {
    espera: `<div class="estado"><div class="icone">${ICONES.pessoa}</div><strong>Aguardando promotor</strong><p>Quando um rosto cadastrado aparecer bem perto da câmera, a visita é registrada sozinha.</p></div>`,
    registrando: `<div class="estado processando">${foto || `<div class="icone">${ICONES.girando}</div>`}<strong>Registrando visita...</strong>${ficha}</div>`,
    sucesso: `<div class="estado sucesso">${foto || `<div class="icone">${ICONES.ok}</div>`}<strong>Visita registrada</strong><p>Pode seguir para a loja.</p>${ficha}</div>`,
    duplicado: `<div class="estado info">${foto || `<div class="icone">${ICONES.relogio}</div>`}<strong>Já registrado há pouco</strong><p>Esta visita já tinha sido registrada às ${esc(d.hora)}. Nada foi duplicado.</p>${ficha}</div>`,
    falha: `<div class="estado falha"><div class="icone">${ICONES.x}</div><strong>Rosto não reconhecido</strong><p>Peça para o promotor tentar de novo, bem de frente e mais perto. Se ele não tiver cadastro, use o registro manual.</p>
      <button class="btn btn-secundario" type="button" data-ir="manual" style="margin-top:8px">Fazer registro manual</button></div>`,
    semrostos: `<div class="estado falha"><div class="icone">${ICONES.x}</div><strong>Nenhum rosto cadastrado</strong><p>Cadastre o rosto do promotor em Cadastro facial ou use o registro manual.</p>
      <button class="btn btn-secundario" type="button" data-ir="facial" style="margin-top:8px">Ir para Cadastro facial</button></div>`,
  }[tipo];
  el.innerHTML = html;
}
$("#estado-checkin").addEventListener("click", (e) => { const b = e.target.closest("[data-ir]"); if (b) irPara(b.dataset.ir); });

// ============================================================
// Cadastro facial
// ============================================================
function renderFacial() {
  const sel = $("#fac-empresa"), atual = sel.value;
  const nomes = [...new Set(dados.fornecedores.map((f) => f.fornecedor))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  sel.innerHTML = '<option value="">Escolha...</option>' + nomes.map((n) => `<option>${esc(n)}</option>`).join("");
  if (nomes.includes(atual)) sel.value = atual;
  const g = dados.gabaritos;
  $("#qtd-gab").textContent = g.length + (g.length === 1 ? " promotor" : " promotores");
  $("#lista-gab").innerHTML = g.length ? g.map((x) => {
    const pronto = Array.isArray(x.descritor) && x.descritor.length === 128;
    return `<div class="gabarito"><div class="rosto">${esc(iniciais(x.nome))}</div>
      <div><b>${esc(x.nome)}</b><small>${esc(x.empresa)}</small><small class="num">desde ${esc(String(x.data || "").slice(0, 10))}</small>
      ${pronto ? "" : '<small class="sem-assinatura">preparando...</small>'}</div></div>`;
  }).join("") : '<p class="vazio">Nenhum rosto cadastrado ainda.</p>';
  validarFacial();
}
function validarFacial() {
  $("#btn-facial").disabled = !($("#fac-empresa").value && $("#fac-nome").value.trim() && $("#fac-lgpd").checked);
}
["change", "input"].forEach((ev) => $("#form-facial").addEventListener(ev, validarFacial));
$("#fac-empresa").addEventListener("change", () => {
  const f = dados.fornecedores.find((x) => x.fornecedor === $("#fac-empresa").value);
  if (f && !$("#fac-nome").value.trim()) $("#fac-nome").value = f.promotor || "";
  if (f && !$("#fac-tel").value.trim()) $("#fac-tel").value = f.telefone || "";
  validarFacial();
});

$("#form-facial").addEventListener("submit", async (e) => {
  e.preventDefault();
  const erro = $("#fac-erro"); erro.hidden = true;
  const mostrarErro = (m) => { erro.textContent = m; erro.hidden = false; };
  const v = $("#video-cad");
  if (!facial.stream || v.readyState < 2) return mostrarErro("Ligue a câmera primeiro (permita o acesso no navegador).");
  const btn = $("#btn-facial"); btn.disabled = true; btn.textContent = "Lendo o rosto...";
  try {
    await carregarModelos();
    const foto = reduzirImagem(v, 960, 0.9);
    const img = await carregarImagem(foto);
    const det = await faceapi.detectSingleFace(img, opcoesPrecisas()).withFaceLandmarks().withFaceDescriptor();
    if (!det) return mostrarErro("Nenhum rosto nítido encontrado. Peça para o promotor olhar de frente para a câmera.");
    if (det.detection.box.width / img.width < CFG.TAMANHO_MIN_ROSTO * 0.9) return mostrarErro("Rosto muito distante. Peça para o promotor chegar mais perto da câmera.");
    const empresa = $("#fac-empresa").value;
    // o mesmo rosto já cadastrado em outra empresa? avisa para não confundir o reconhecimento
    const parecido = facial.rostos.find((r) => r.empresa !== empresa && faceapi.euclideanDistance(det.descriptor, r.descritor) < CFG.LIMIAR_ROSTO * 0.8);
    if (parecido) return mostrarErro(`Este rosto é muito parecido com o cadastrado em "${parecido.empresa}". Confira a empresa antes de salvar.`);
    btn.textContent = "Salvando foto...";
    const link = await enviarFoto(foto);
    await rpc("promot_web_salvar_gabarito", {
      p_token: sessao.token, p_empresa: empresa, p_nome: $("#fac-nome").value.trim(),
      p_telefone: $("#fac-tel").value.trim(), p_link: link, p_descritor: Array.from(det.descriptor),
    });
    const nome = $("#fac-nome").value.trim();
    $("#form-facial").reset();
    await recarregar(false);
    toast("Rosto de " + nome + " (" + empresa + ") cadastrado", "ok");
  } catch (err) {
    mostrarErro(err.message);
  } finally {
    btn.textContent = "Tirar foto e salvar"; validarFacial();
  }
});

// ============================================================
// Tema claro / escuro
// ============================================================
function aplicarTema(t) {
  document.documentElement.dataset.theme = t;
  $("#txt-tema").textContent = t === "dark" ? "Claro" : "Escuro";
  try { localStorage.setItem("promot_web_tema", t); } catch {}
}
$("#btn-tema").addEventListener("click", () => aplicarTema(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
aplicarTema(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

// ============================================================
// Partida
// ============================================================
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sessao) $("#pilula-data").textContent = hojeSP().curto;
});
if (sessao && sessao.token) iniciarApp(); else mostrarLogin();
