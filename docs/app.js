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
  VISITA_NAO_ENCONTRADA: "Só dá para alterar visitas de hoje desta loja. Atualize a tela.",
  promot_web_cancelar_visita: "O cancelamento ainda não foi ativado no banco (falta rodar o SQL 06).",
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
  checkin: ["Entrada facial", "O promotor se posiciona na frente da câmera e a entrada é registrada sozinha."],
  agenda: ["Agenda de hoje", ""],
  manual: ["Registro manual", "Para quando a câmera não reconhecer ou o promotor não tiver rosto cadastrado."],
  promotores: ["Fornecedores e promotores", "Cadastro da loja: quem atende, telefone e dias de visita."],
  facial: ["Cadastro facial", "Foto de referência que a entrada facial usa para reconhecer o promotor."],
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
// tempo na loja: "1h25" / "40 min"
function fmtTempo(min) {
  min = Math.max(0, Math.round(Number(min) || 0));
  if (min < 60) return min + " min";
  return Math.floor(min / 60) + "h" + String(min % 60).padStart(2, "0");
}
function minutosDesde(dataTxt) {
  // "DD/MM/AAAA HH:MM:SS" no horário de São Paulo → minutos até agora
  const m = String(dataTxt || "").match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (!m) return 0;
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const ini = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  return Math.max(0, Math.round((agora - ini) / 60000));
}
const temSaida = (v) => !!(v && v.saida);
function situacaoHtml(r) {
  if (!r) return '<span class="tag pend">Pendente</span>';
  if (temSaida(r)) return `<span class="tag saiu num">Entrada ${horaDe(r.data)} · Saída ${horaDe(r.saida)}</span><div class="tempo num">${fmtTempo(r.minutos)} na loja</div>`;
  return `<span class="tag ok num">Na loja desde ${horaDe(r.data)}</span><div class="tempo num">há ${fmtTempo(minutosDesde(r.data))}</div>`;
}
function botaoSaida(r) {
  return r && !temSaida(r) ? `<button class="btn btn-saida" type="button" data-saida="${r.id}">Registrar saída</button>` : "";
}
function botaoEntrada(f, r) {
  return !r ? `<button class="btn btn-entrada" type="button" data-entrada="${f.id}">Registrar entrada</button>` : "";
}
function botaoCancelar(r) {
  return r ? `<button class="btn btn-cancelar" type="button" data-cancelar="${r.id}">Cancelar</button>` : "";
}

// botões de 2 cliques: o 1º pede confirmação no próprio botão, o 2º executa
function pedirConfirmacao(b, textoConfirma) {
  if (b.classList.contains("confirmar")) { clearTimeout(b._t); return true; }
  document.querySelectorAll("button.confirmar[data-txt]").forEach((x) => { x.classList.remove("confirmar"); x.textContent = x.dataset.txt; });
  b.dataset.txt = b.textContent;
  b.classList.add("confirmar"); b.textContent = textoConfirma;
  clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove("confirmar"); b.textContent = b.dataset.txt; }, 4000);
  return false;
}
function voltarBotao(b) { b.disabled = false; b.classList.remove("confirmar"); if (b.dataset.txt) b.textContent = b.dataset.txt; }

// "Registrar entrada" direto da Agenda (registro manual, sem foto nem comentário — dá para editar depois)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-entrada]");
  if (!b || !pedirConfirmacao(b, "Confirmar entrada?")) return;
  const f = dados.fornecedores.find((x) => String(x.id) === b.dataset.entrada);
  if (!f) return;
  b.disabled = true; b.textContent = "Registrando...";
  try {
    const r = await rpc("promot_web_registrar", {
      p_token: sessao.token, p_loja: lojaAtual, p_fornecedor: f.fornecedor, p_obs: "", p_foto: "", p_facial: false,
    });
    await recarregar(false);
    toast(`Entrada de ${f.fornecedor} às ${horaDe(r.data)}`, "ok");
  } catch (err) { toast(err.message, "erro"); voltarBotao(b); }
});

// "Cancelar": apaga o registro de hoje (para quando registrou o fornecedor errado)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cancelar]");
  if (!b || !pedirConfirmacao(b, "Apagar registro?")) return;
  b.disabled = true; b.textContent = "Apagando...";
  try {
    const r = await rpc("promot_web_cancelar_visita", { p_token: sessao.token, p_loja: lojaAtual, p_id: Number(b.dataset.cancelar) });
    await recarregar(false);
    toast(`Registro de ${r.fornecedor} cancelado`, "ok");
  } catch (err) { toast(err.message, "erro"); voltarBotao(b); }
});

// clique em "Registrar saída": pede confirmação no próprio botão (evita clique sem querer)
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-saida]");
  if (!b) return;
  if (!b.classList.contains("confirmar")) {
    document.querySelectorAll(".btn-saida.confirmar").forEach((x) => { x.classList.remove("confirmar"); x.textContent = "Registrar saída"; });
    b.classList.add("confirmar"); b.textContent = "Confirmar saída?";
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove("confirmar"); b.textContent = "Registrar saída"; }, 4000);
    return;
  }
  clearTimeout(b._t);
  b.disabled = true; b.textContent = "Registrando...";
  const v = dados.visitas.find((x) => String(x.id) === b.dataset.saida);
  try {
    const r = await rpc("promot_web_registrar_saida", { p_token: sessao.token, p_loja: lojaAtual, p_id: Number(b.dataset.saida) });
    await recarregar(false);
    toast(`Saída de ${v ? v.fornecedor : "promotor"} às ${horaDe(r.saida)} · ${fmtTempo(r.minutos)} na loja`, "ok");
  } catch (err) {
    toast(err.message, "erro");
    b.disabled = false; b.classList.remove("confirmar"); b.textContent = "Registrar saída";
  }
});

function renderRegistrosHoje() {
  const v = dados.visitas;
  $("#qtd-hoje").textContent = v.length + (v.length === 1 ? " visita" : " visitas");
  $("#lista-hoje").innerHTML = v.length ? v.map((r) => {
    const facialR = r.frequencia === "FACIAL";
    const temFoto = temFotoValida(r.foto);
    const obs = obsDe(r);
    return `<div class="registro"><div class="avatar">${esc(iniciais(r.fornecedor))}</div>
      <div><b>${esc(r.fornecedor)}</b><small><span class="tag ${facialR ? "facial" : "manual"}">${facialR ? "FACIAL" : "MANUAL"}</span>
      ${temFoto ? ` · <a class="ver-foto" href="${esc(r.foto)}" target="_blank" rel="noopener">ver foto</a>` : ""}
      ${obs ? ` · ${esc(obs)}` : ""}
      · <button class="link-editar btn-editar-visita" type="button" data-visita="${r.id}">editar</button>
      · <button class="link-editar link-cancelar" type="button" data-cancelar="${r.id}">cancelar</button></small>
      ${botaoSaida(r) ? `<div style="margin-top:6px">${botaoSaida(r)}</div>` : ""}</div>
      <div class="hora num">${horaDe(r.data)}${temSaida(r) ? `<small>até ${horaDe(r.saida)}</small><small>${fmtTempo(r.minutos)}</small>` : "<small>na loja</small>"}</div></div>`;
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
    <div class="kpi"><small>Fora da agenda</small><strong class="num">${fora}</strong><span>vieram em dia não previsto</span></div>
    <div class="kpi magenta"><small>Na loja agora</small><strong class="num">${dados.visitas.filter((v) => !temSaida(v)).length}</strong><span>entraram e ainda não saíram</span></div>`;
  const q = norm($("#busca-agenda").value);
  const linhas = dia.filter((f) => {
    const r = visitaDe(f.fornecedor);
    if (filtroAgenda === "pend" && r) return false;
    if (filtroAgenda === "naloja" && !(r && !temSaida(r))) return false;
    if (filtroAgenda === "saiu" && !(r && temSaida(r))) return false;
    return !q || norm([f.fornecedor, f.marca, f.promotor].join(" ")).includes(q);
  });
  $("#tb-agenda").innerHTML = linhas.length ? linhas.map((f) => {
    const r = visitaDe(f.fornecedor);
    return `<tr><td><div class="principal-cel">${esc(f.fornecedor)}</div><div class="sub-cel">${esc(f.marca)}</div></td>
      <td><div>${esc(f.promotor)}</div><div class="sub-cel num">${esc(f.telefone)}</div></td><td>${esc(f.comprador)}</td>
      <td>${diasHtml(f.frequencia)}</td>
      <td>${situacaoHtml(r)}</td>
      <td style="text-align:right"><div class="acoes-linha">${botaoEntrada(f, r)}${botaoSaida(r)}${r ?`<button class="btn btn-texto btn-editar-visita" type="button" data-visita="${r.id}">${obsDe(r) || temFotoValida(r.foto) ? "Ver / editar" : "Editar"}</button>` : ""}${botaoCancelar(r)}</div></td></tr>`;
  }).join("") : `<tr><td colspan="6" class="vazio">${dia.length ? "Nada para mostrar com esse filtro." : "Nenhum fornecedor com visita prevista para hoje."}</td></tr>`;
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
  buscas.manual?.sincronizar();
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
// ============================================================
// Editar uma visita do dia (comentário e foto)
// ============================================================
const MARCAS_FACIAL = ["[CHECK-IN FACIAL]", "[ENTRADA FACIAL]"];
function temFotoValida(f) { return !!f && /^https?:\/\//.test(f); }
function obsDe(v) { let t = String(v.obs || ""); MARCAS_FACIAL.forEach((m) => (t = t.replace(m, ""))); return t.trim(); }

let fotoEdicao = null;
function abrirEdicaoVisita(v) {
  if (!v) return;
  fornEditando = null;
  fotoEdicao = null;
  const facialV = v.frequencia === "FACIAL";
  const temFoto = temFotoValida(v.foto);
  const podeTrocarFoto = !(facialV && temFoto);
  const g = $("#gaveta");
  g.innerHTML = `<div class="gaveta-topo"><h3 id="gav-titulo">Registro da visita</h3><button class="btn-fechar" type="button" id="gav-fechar" aria-label="Fechar">×</button></div>
    <form class="gaveta-corpo" id="gav-form" autocomplete="off">
      <div class="cartao-forn"><div class="cabeca"><div class="avatar">${esc(iniciais(v.fornecedor))}</div><div><h4>${esc(v.fornecedor)}</h4>
        <span class="tag ${facialV ? "facial" : "manual"}">${facialV ? "FACIAL" : "MANUAL"}</span> <span class="tag ok num">Entrada ${horaDe(v.data)}</span>
        ${temSaida(v) ? `<span class="tag saiu num">Saída ${horaDe(v.saida)} · ${fmtTempo(v.minutos)}</span>` : '<span class="tag pend">Ainda na loja</span>'}</div></div></div>
      ${temFoto ? `<div class="campo"><span>${facialV ? "Foto da câmera (prova da visita)" : "Foto atual"}</span>
        <a href="${esc(v.foto)}" target="_blank" rel="noopener"><img class="foto-visita" src="${esc(v.foto)}" alt="Foto do registro"></a></div>` : ""}
      <label class="campo"><span>Comentário sobre a visita</span>
        <textarea id="ed-obs" placeholder="Ex.: reposição incompleta, gôndola desorganizada, promotor saiu antes do horário">${esc(obsDe(v))}</textarea></label>
      ${podeTrocarFoto ? `<div class="campo"><span>${temFoto ? "Trocar a foto (opcional)" : "Foto (opcional)"}</span>
        <label class="soltar" id="ed-soltar" for="ed-foto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/></svg>
          <span id="ed-soltar-txt">Toque para tirar ou escolher uma foto</span>
          <img id="ed-previa" alt="" hidden>
        </label>
        <input id="ed-foto" type="file" accept="image/*" hidden></div>`
      : '<p class="dica">Na entrada facial a foto da câmera não pode ser trocada. Você pode registrar o que aconteceu no comentário.</p>'}
      <p id="ed-erro" class="erro" hidden></p>
    </form>
    <div class="gaveta-rodape"><button class="btn btn-secundario" type="button" id="gav-cancelar">Cancelar</button><button class="btn btn-primario" type="button" id="ed-salvar">Salvar</button></div>`;
  $("#veu").hidden = false; g.hidden = false;
  $("#gav-fechar").onclick = $("#gav-cancelar").onclick = fecharGaveta;
  $("#gav-form").addEventListener("submit", (e) => { e.preventDefault(); salvarEdicaoVisita(v); });
  $("#ed-salvar").onclick = () => salvarEdicaoVisita(v);
  const inpFoto = $("#ed-foto");
  if (inpFoto) inpFoto.addEventListener("change", async (e) => {
    const arq = e.target.files[0];
    if (!arq || !arq.type.startsWith("image/")) return;
    const url = URL.createObjectURL(arq);
    try {
      fotoEdicao = reduzirImagem(await carregarImagem(url));
      const p = $("#ed-previa"); p.src = fotoEdicao; p.hidden = false;
      $("#ed-soltar-txt").textContent = arq.name + " (toque para trocar)";
    } catch { toast("Não consegui abrir essa imagem.", "erro"); }
    finally { URL.revokeObjectURL(url); }
  });
  setTimeout(() => $("#ed-obs").focus(), 50);
}
async function salvarEdicaoVisita(v) {
  const btn = $("#ed-salvar"), erro = $("#ed-erro");
  btn.disabled = true; btn.textContent = fotoEdicao ? "Enviando foto..." : "Salvando...";
  try {
    const link = fotoEdicao ? await enviarFoto(fotoEdicao) : "";
    await rpc("promot_web_editar_visita", { p_token: sessao.token, p_loja: lojaAtual, p_id: v.id, p_obs: $("#ed-obs").value, p_foto: link });
    fecharGaveta(); await recarregar(false);
    toast("Registro de " + v.fornecedor + " atualizado", "ok");
  } catch (err) {
    erro.textContent = err.message; erro.hidden = false;
    btn.disabled = false; btn.textContent = "Salvar";
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".btn-editar-visita");
  if (b) abrirEdicaoVisita(dados.visitas.find((x) => String(x.id) === b.dataset.visita));
});

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

function medidor(proporcao, alvo = CFG.TAMANHO_MIN_ROSTO, sufixo = "") {
  const pct = Math.max(0, Math.min(100, (proporcao / alvo) * 100));
  const barra = $("#medidor-barra" + sufixo), txt = $("#medidor-txt" + sufixo);
  if (!barra || !txt) return;
  barra.style.width = pct + "%";
  barra.style.background = pct >= 100 ? "var(--verde)" : "var(--magenta)";
  txt.textContent = proporcao <= 0 ? "Sem rosto" : pct >= 100 ? "Distância boa" : pct >= 65 ? "Quase lá" : "Muito longe";
}

function iniciarLoop() {
  clearTimeout(facial.timer);
  const passo = async () => {
    try { if (paginaAtual === "facial") await verificarQuadroCadastro(); else await verificarQuadro(); } catch { /* quadro ruim: tenta o próximo */ }
    facial.timer = setTimeout(passo, 300);
  };
  passo();
}

// tela de Cadastro facial: só mostra a distância, sem registrar nada
let ultimoCadastroOk = false;
async function verificarQuadroCadastro() {
  const v = $("#video-cad");
  if (!sessao || !facial.modelos || !facial.stream || cadastrando || document.hidden || v.readyState < 2) return;
  const det = await faceapi.detectSingleFace(v, opcoesRapidas());
  const prop = det ? det.box.width / v.videoWidth : 0;
  medidor(prop, TAMANHO_CADASTRO, "-cad");
  ultimoCadastroOk = prop >= TAMANHO_CADASTRO;
  $("#camera-cad").classList.toggle("ok", ultimoCadastroOk);
  $("#dica-cad").textContent = !det ? "Posicione o rosto do promotor no contorno"
    : ultimoCadastroOk ? "Rosto bem posicionado, pode tirar a foto" : "Peça para chegar um pouco mais perto";
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
    if (!r.duplicado) toast("Entrada de " + melhor.empresa + " registrada", "ok");
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
    espera: `<div class="estado"><div class="icone">${ICONES.pessoa}</div><strong>Aguardando promotor</strong><p>Quando um rosto cadastrado aparecer bem perto da câmera, a entrada é registrada sozinha.</p></div>`,
    registrando: `<div class="estado processando">${foto || `<div class="icone">${ICONES.girando}</div>`}<strong>Registrando entrada...</strong>${ficha}</div>`,
    sucesso: `<div class="estado sucesso">${foto || `<div class="icone">${ICONES.ok}</div>`}<strong>Entrada registrada</strong><p>Pode seguir para a loja. Na saída, a fiscal registra pela Agenda.</p>${ficha}</div>`,
    duplicado: `<div class="estado info">${foto || `<div class="icone">${ICONES.relogio}</div>`}<strong>Já registrado há pouco</strong><p>A entrada já tinha sido registrada às ${esc(d.hora)}. Nada foi duplicado.</p>${ficha}</div>`,
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
  buscas.facial?.sincronizar();
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
  const falta = [];
  if (!fotoCadastro) falta.push("tirar a foto");
  if (!$("#fac-empresa").value) falta.push("escolher a empresa");
  if (!$("#fac-nome").value.trim()) falta.push("o nome do promotor");
  if (!$("#fac-lgpd").checked) falta.push("marcar o termo");
  $("#btn-facial").disabled = falta.length > 0;
  $("#fac-falta").textContent = falta.length ? "Para salvar, falta: " + falta.join(", ") + "." : "";
}
["change", "input"].forEach((ev) => $("#form-facial").addEventListener(ev, validarFacial));
$("#fac-empresa").addEventListener("change", () => {
  const f = dados.fornecedores.find((x) => x.fornecedor === $("#fac-empresa").value);
  if (f && !$("#fac-nome").value.trim()) $("#fac-nome").value = f.promotor || "";
  if (f && !$("#fac-tel").value.trim()) $("#fac-tel").value = f.telefone || "";
  validarFacial();
});

// cadastro aceita o rosto um pouco mais longe que a entrada facial (o Streamlit não exigia distância no cadastro)
const TAMANHO_CADASTRO = Math.max(0.10, CFG.TAMANHO_MIN_ROSTO * 0.6);
let cadastrando = false;
async function lerRosto(fonte) {
  // detector preciso primeiro; se não achar, tenta o rápido com resolução maior
  let det = await faceapi.detectSingleFace(fonte, opcoesPrecisas()).withFaceLandmarks().withFaceDescriptor();
  if (!det) det = await faceapi.detectSingleFace(fonte, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.4 })).withFaceLandmarks().withFaceDescriptor();
  return det;
}
// foto do cadastro: tirada no botão "Tirar foto", conferida na hora e guardada até salvar
let fotoCadastro = null;   // { foto: dataURL, descritor: Float32Array }
function mostrarCaptura(foto, ok, texto) {
  const box = $("#captura");
  $("#captura-img").src = foto;
  $("#captura-txt").textContent = texto;
  box.classList.toggle("ok", ok); box.classList.toggle("falha", !ok);
  box.hidden = false;
  $("#btn-tirar").hidden = true;
}
function limparCaptura() {
  fotoCadastro = null;
  $("#captura").hidden = true;
  $("#btn-tirar").hidden = false;
  validarFacial();
}
$("#btn-refazer").addEventListener("click", limparCaptura);
$("#btn-tirar").addEventListener("click", async () => {
  const v = $("#video-cad"), btn = $("#btn-tirar");
  if (!facial.stream || v.readyState < 2) {
    ligarCamera();
    return toast("A câmera não está ligada. Permita o acesso à câmera no ícone da barra de endereço e tente de novo.", "erro");
  }
  btn.disabled = true; btn.lastChild.textContent = " Lendo o rosto...";
  cadastrando = true;
  try {
    await carregarModelos();
    const foto = reduzirImagem(v, 960, 0.9);
    const img = await carregarImagem(foto);
    const det = await lerRosto(img);
    if (!det) return mostrarCaptura(foto, false, "Não encontrei um rosto. Peça para olhar de frente, sem boné ou óculos escuros, com o rosto iluminado.");
    if (det.detection.box.width / img.width < TAMANHO_CADASTRO) return mostrarCaptura(foto, false, "Rosto muito distante. Peça para chegar mais perto, até a barra de distância ficar verde.");
    const empresa = $("#fac-empresa").value;
    const parecido = facial.rostos.find((r) => r.empresa !== empresa && faceapi.euclideanDistance(det.descriptor, r.descritor) < CFG.LIMIAR_ROSTO * 0.8);
    fotoCadastro = { foto, descritor: det.descriptor };
    mostrarCaptura(foto, true, parecido
      ? `Foto boa. Atenção: este rosto parece o já cadastrado em "${parecido.empresa}". Confira a empresa.`
      : "Foto boa. Agora preencha os dados abaixo e salve.");
  } catch (err) {
    toast(err.message, "erro");
  } finally {
    cadastrando = false;
    btn.disabled = false; btn.lastChild.textContent = " Tirar foto";
    validarFacial();
  }
});

$("#form-facial").addEventListener("submit", async (e) => {
  e.preventDefault();
  const erro = $("#fac-erro"); erro.hidden = true;
  const mostrarErro = (m) => { erro.textContent = m; erro.hidden = false; toast(m, "erro"); };
  if (!fotoCadastro) return mostrarErro("Tire a foto do promotor primeiro (botão Tirar foto, abaixo da câmera).");
  const btn = $("#btn-facial"); btn.disabled = true; btn.textContent = "Salvando foto...";
  try {
    const empresa = $("#fac-empresa").value, nome = $("#fac-nome").value.trim();
    const link = await enviarFoto(fotoCadastro.foto);
    await rpc("promot_web_salvar_gabarito", {
      p_token: sessao.token, p_empresa: empresa, p_nome: nome,
      p_telefone: $("#fac-tel").value.trim(), p_link: link, p_descritor: Array.from(fotoCadastro.descritor),
    });
    $("#form-facial").reset();
    limparCaptura();
    await recarregar(false);
    toast("Rosto de " + nome + " (" + empresa + ") cadastrado", "ok");
  } catch (err) {
    mostrarErro(err.message);
  } finally {
    btn.textContent = "Salvar cadastro"; validarFacial();
  }
});

// ============================================================
// Campo de busca no lugar da lista (select): abre o teclado e filtra enquanto digita
// O <select> original continua existindo (escondido) e guarda o valor escolhido.
// ============================================================
const buscas = {};
function criarBusca(sel, placeholder) {
  sel.hidden = true;
  const caixa = document.createElement("div");
  caixa.className = "busca-lista";
  caixa.innerHTML = `<div class="busca-lista-campo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" placeholder="${esc(placeholder)}">
      <button type="button" class="busca-lista-limpar" aria-label="Limpar" hidden>×</button>
    </div>
    <ul class="busca-lista-opcoes" role="listbox" hidden></ul>`;
  sel.after(caixa);
  const inp = caixa.querySelector("input"), ul = caixa.querySelector("ul"), limpar = caixa.querySelector(".busca-lista-limpar");
  let ativo = -1;

  const opcoes = () => [...sel.options].filter((o) => o.value !== "");
  function textoEscolhido() { const o = sel.selectedOptions[0]; return o && o.value !== "" ? o.textContent : ""; }
  function sincronizar() { inp.value = textoEscolhido(); limpar.hidden = !inp.value; fechar(); }
  function fechar() { ul.hidden = true; ativo = -1; }
  function abrir() {
    const q = norm(inp.value === textoEscolhido() ? "" : inp.value);
    const lista = opcoes().filter((o) => !q || norm(o.textContent).includes(q)).slice(0, 80);
    ul.innerHTML = lista.length
      ? lista.map((o, i) => `<li role="option" data-v="${esc(o.value)}" class="${o.value === sel.value ? "escolhido" : ""}">${esc(o.textContent)}</li>`).join("")
      : '<li class="nada">Nenhum resultado</li>';
    ul.hidden = false; ativo = -1;
  }
  function escolher(v) {
    sel.value = v;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    sincronizar();
    inp.blur();
  }
  inp.addEventListener("focus", () => { inp.select(); abrir(); });
  inp.addEventListener("input", () => { limpar.hidden = !inp.value; abrir(); });
  inp.addEventListener("keydown", (e) => {
    const itens = [...ul.querySelectorAll("li[data-v]")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (ul.hidden) abrir();
      ativo = Math.max(0, Math.min(itens.length - 1, ativo + (e.key === "ArrowDown" ? 1 : -1)));
      itens.forEach((li, i) => li.classList.toggle("ativo", i === ativo));
      itens[ativo]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const alvo = itens[ativo >= 0 ? ativo : 0];
      if (alvo) escolher(alvo.dataset.v);
    } else if (e.key === "Escape") { sincronizar(); inp.blur(); }
  });
  // pointerdown antes do blur: o toque no item não se perde quando o teclado fecha
  ul.addEventListener("pointerdown", (e) => { const li = e.target.closest("li[data-v]"); if (li) { e.preventDefault(); escolher(li.dataset.v); } });
  inp.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== inp) sincronizar(); }, 150));
  limpar.addEventListener("pointerdown", (e) => { e.preventDefault(); sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true })); inp.value = ""; limpar.hidden = true; inp.focus(); });
  sel.form?.addEventListener("reset", () => setTimeout(() => { sel.dispatchEvent(new Event("change", { bubbles: true })); sincronizar(); }, 0));
  return { sincronizar };
}
buscas.manual = criarBusca($("#man-forn"), "Digite o nome do fornecedor...");
buscas.facial = criarBusca($("#fac-empresa"), "Digite o nome da empresa...");

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
