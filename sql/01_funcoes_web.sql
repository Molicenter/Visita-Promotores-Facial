-- ============================================================
-- App web dos Promotores (HTML/JS) — funções seguras
-- Projeto Supabase da empresa (eemfqkxshqqlhdyofgoz)
--
-- COMO RODAR: Supabase → SQL Editor → New query → colar TUDO → Run.
-- Pode rodar mais de uma vez sem problema (não duplica nada).
--
-- O app usa a chave PÚBLICA; tudo passa por estas funções, que
-- exigem login. Nenhuma tabela existente perde dados ou muda de
-- estrutura — só ganha a coluna nova (opcional) "descritor" nos
-- gabaritos, que o Streamlit ignora.
-- ============================================================

create table if not exists public.promot_web_sessoes (
  token     uuid primary key default gen_random_uuid(),
  usuario   text not null,          -- "Administrador" ou "Loja 03"
  email     text not null,          -- mesmo padrão do Streamlit (vai para a coluna Usuario)
  perfil    text not null,          -- 'analista' | 'gerente'
  loja      int,                    -- vazio para o analista
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null
);
create table if not exists public.promot_web_segredos (
  chave text primary key,
  valor text not null
);
create table if not exists public.promot_web_tentativas (
  id      bigserial primary key,
  usuario text,
  em      timestamptz not null default now(),
  ok      boolean not null
);
alter table public.promot_web_sessoes    enable row level security;
alter table public.promot_web_segredos   enable row level security;
alter table public.promot_web_tentativas enable row level security;
revoke all on public.promot_web_sessoes, public.promot_web_segredos, public.promot_web_tentativas from anon, authenticated;

-- assinatura do rosto calculada no navegador (128 números)
alter table public.promot_biometria_gabaritos add column if not exists descritor jsonb;

-- ---------- definir senhas (só pelo SQL Editor, nunca pelo app) ----------
create or replace function public.promot_web_definir_senha(p_perfil text, p_senha text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_perfil not in ('analista', 'gerente') then raise exception 'perfil deve ser analista ou gerente'; end if;
  if coalesce(length(p_senha), 0) < 4 then raise exception 'senha muito curta'; end if;
  insert into promot_web_segredos (chave, valor) values ('senha_' || p_perfil, crypt(p_senha, gen_salt('bf')))
  on conflict (chave) do update set valor = excluded.valor;
  return 'senha de ' || p_perfil || ' definida';
end $$;
revoke all on function public.promot_web_definir_senha(text, text) from public, anon, authenticated;

-- ---------- helpers internos ----------
create or replace function public._promot_web_sessao(p_token uuid)
returns public.promot_web_sessoes
language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes;
begin
  select * into s from promot_web_sessoes where token = p_token and expira_em > now();
  if not found then raise exception 'SESSAO_INVALIDA'; end if;
  return s;
end $$;

create or replace function public._promot_web_loja(s public.promot_web_sessoes, p_loja int)
returns int language plpgsql immutable as $$
begin
  if s.perfil = 'gerente' then return s.loja; end if;
  if p_loja is null or p_loja < 1 or p_loja > 8 then raise exception 'LOJA_INVALIDA'; end if;
  return p_loja;
end $$;

create or replace function public._promot_web_agora()
returns text language sql stable as $$
  select to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS')
$$;

revoke all on function public._promot_web_sessao(uuid) from public, anon, authenticated;
revoke all on function public._promot_web_loja(public.promot_web_sessoes, int) from public, anon, authenticated;

-- ---------- login / logout ----------
create or replace function public.promot_web_login(p_usuario text, p_senha text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_perfil text; v_loja int; v_email text; v_hash text; v_token uuid;
begin
  if (select count(*) from promot_web_tentativas
      where usuario = p_usuario and not ok and em > now() - interval '10 minutes') >= 8 then
    raise exception 'MUITAS_TENTATIVAS';
  end if;

  if p_usuario = 'Administrador' then
    v_perfil := 'analista'; v_loja := null; v_email := 'analista@molicenter.com.br';
  elsif p_usuario ~ '^Loja 0[1-8]$' then
    v_perfil := 'gerente'; v_loja := substr(p_usuario, 6)::int; v_email := 'gerente' || v_loja || '@molicenter.com.br';
  else
    raise exception 'USUARIO_INVALIDO';
  end if;

  select valor into v_hash from promot_web_segredos where chave = 'senha_' || v_perfil;
  if v_hash is null then raise exception 'SENHA_NAO_CONFIGURADA'; end if;

  if v_hash <> crypt(coalesce(p_senha, ''), v_hash) then
    insert into promot_web_tentativas (usuario, ok) values (p_usuario, false);
    raise exception 'SENHA_INCORRETA';
  end if;

  insert into promot_web_tentativas (usuario, ok) values (p_usuario, true);
  delete from promot_web_sessoes where expira_em < now();
  delete from promot_web_tentativas where em < now() - interval '30 days';

  insert into promot_web_sessoes (usuario, email, perfil, loja, expira_em)
  values (p_usuario, v_email, v_perfil, v_loja, now() + interval '18 hours')
  returning token into v_token;

  return json_build_object('token', v_token, 'usuario', p_usuario, 'email', v_email, 'perfil', v_perfil, 'loja', v_loja);
end $$;

create or replace function public.promot_web_sair(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from promot_web_sessoes where token = p_token
$$;

-- ---------- carga da tela (fornecedores da loja + visitas de hoje + rostos) ----------
create or replace function public.promot_web_dados(p_token uuid, p_loja int)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes; v_loja int; v_hoje text;
begin
  s := _promot_web_sessao(p_token);
  v_loja := _promot_web_loja(s, p_loja);
  v_hoje := to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY');
  return json_build_object(
    'loja', v_loja,
    'agora', _promot_web_agora(),
    'fornecedores', coalesce((
      select json_agg(json_build_object('id', id, 'cod', cod, 'fornecedor', fornecedor, 'marca', marca,
        'comprador', comprador, 'promotor', promotor, 'telefone', telefone, 'frequencia', frequencia_visita)
        order by fornecedor, id)
      from promot_fornecedores where loja = v_loja), '[]'::json),
    'visitas', coalesce((
      select json_agg(json_build_object('id', id, 'data', "Data", 'fornecedor', "Fornecedor",
        'frequencia', "Frequencia", 'obs', "Observacao", 'foto', "Arquivo_Foto", 'usuario', "Usuario")
        order by "Data" desc)
      from promot_registro_visitas where "Loja" = v_loja::text and "Data" like v_hoje || '%'), '[]'::json),
    'gabaritos', coalesce((
      select json_agg(json_build_object('id', id, 'empresa', "Empresa", 'nome', "Nome_Promotor",
        'telefone', "Telefone", 'link', "Link_Gabarito", 'data', "Data_Cadastro", 'descritor', descritor)
        order by "Empresa")
      from promot_biometria_gabaritos), '[]'::json)
  );
end $$;

-- ---------- registrar visita (manual ou facial) ----------
create or replace function public.promot_web_registrar(
  p_token uuid, p_loja int, p_fornecedor text, p_obs text, p_foto text, p_facial boolean)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes; v_loja int; v_freq text; v_agora text; v_ult record;
begin
  s := _promot_web_sessao(p_token);
  v_loja := _promot_web_loja(s, p_loja);
  if coalesce(trim(p_fornecedor), '') = '' then raise exception 'FORNECEDOR_VAZIO'; end if;
  v_agora := _promot_web_agora();

  if p_facial then
    -- trava de duplicidade: a câmera fica ligada, então o mesmo rosto
    -- não gera dois registros em menos de 30 minutos na mesma loja
    select "Data" into v_ult from promot_registro_visitas
     where "Loja" = v_loja::text and "Fornecedor" = p_fornecedor and "Frequencia" = 'FACIAL'
       and "Data" like left(v_agora, 10) || '%'
       and to_timestamp("Data", 'DD/MM/YYYY HH24:MI:SS') > (now() at time zone 'America/Sao_Paulo') - interval '30 minutes'
     order by id desc limit 1;
    if found then
      return json_build_object('ok', true, 'duplicado', true, 'data', v_ult."Data");
    end if;
    v_freq := 'FACIAL';
  else
    select frequencia_visita into v_freq from promot_fornecedores
     where loja = v_loja and fornecedor = p_fornecedor order by id limit 1;
  end if;

  insert into promot_registro_visitas ("Data", "Loja", "Fornecedor", "Frequencia", "Observacao", "Arquivo_Foto", "Usuario")
  values (v_agora, v_loja::text, p_fornecedor, coalesce(v_freq, ''),
          case when p_facial then '[CHECK-IN FACIAL]' else coalesce(p_obs, '') end,
          coalesce(nullif(p_foto, ''), case when p_facial then 'Erro Link' else 'Sem foto' end),
          s.email);
  return json_build_object('ok', true, 'duplicado', false, 'data', v_agora);
end $$;

-- ---------- fornecedores da loja ----------
create or replace function public.promot_web_salvar_fornecedor(p_token uuid, p_loja int, p_id bigint, p_dados json)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes; v_loja int; v_nome text; v_id bigint;
begin
  s := _promot_web_sessao(p_token);
  v_loja := _promot_web_loja(s, p_loja);
  v_nome := trim(coalesce(p_dados->>'fornecedor', ''));
  if v_nome = '' then raise exception 'FORNECEDOR_VAZIO'; end if;

  if p_id is null then
    insert into promot_fornecedores (loja, cod, fornecedor, marca, comprador, promotor, telefone, frequencia_visita)
    values (v_loja, nullif(trim(p_dados->>'cod'), ''), v_nome, trim(coalesce(p_dados->>'marca', '')),
            trim(coalesce(p_dados->>'comprador', '')), trim(coalesce(p_dados->>'promotor', '')),
            trim(coalesce(p_dados->>'telefone', '')), trim(coalesce(p_dados->>'frequencia', '')))
    returning id into v_id;
  else
    update promot_fornecedores set
      cod = nullif(trim(p_dados->>'cod'), ''), fornecedor = v_nome,
      marca = trim(coalesce(p_dados->>'marca', '')), comprador = trim(coalesce(p_dados->>'comprador', '')),
      promotor = trim(coalesce(p_dados->>'promotor', '')), telefone = trim(coalesce(p_dados->>'telefone', '')),
      frequencia_visita = trim(coalesce(p_dados->>'frequencia', '')), atualizado_em = now()
    where id = p_id and loja = v_loja
    returning id into v_id;
    if v_id is null then raise exception 'FORNECEDOR_NAO_ENCONTRADO'; end if;
  end if;
  return json_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.promot_web_remover_fornecedor(p_token uuid, p_loja int, p_id bigint)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes; v_loja int; v_n int;
begin
  s := _promot_web_sessao(p_token);
  v_loja := _promot_web_loja(s, p_loja);
  delete from promot_fornecedores where id = p_id and loja = v_loja;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'FORNECEDOR_NAO_ENCONTRADO'; end if;
  return json_build_object('ok', true);
end $$;

-- ---------- rostos (gabaritos) ----------
create or replace function public.promot_web_salvar_gabarito(
  p_token uuid, p_empresa text, p_nome text, p_telefone text, p_link text, p_descritor jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes;
begin
  s := _promot_web_sessao(p_token);
  if coalesce(trim(p_empresa), '') = '' or coalesce(trim(p_nome), '') = '' then raise exception 'DADOS_INCOMPLETOS'; end if;
  if coalesce(p_link, '') = '' then raise exception 'FOTO_AUSENTE'; end if;
  if p_descritor is null or jsonb_typeof(p_descritor) <> 'array' or jsonb_array_length(p_descritor) <> 128 then
    raise exception 'DESCRITOR_INVALIDO';
  end if;
  -- mesma regra do Streamlit: 1 rosto por empresa (substitui o anterior)
  delete from promot_biometria_gabaritos where "Empresa" = p_empresa;
  insert into promot_biometria_gabaritos ("Data_Cadastro", "Empresa", "Nome_Promotor", "Telefone", "Link_Gabarito", descritor)
  values (_promot_web_agora(), p_empresa, trim(p_nome), trim(coalesce(p_telefone, '')), p_link, p_descritor);
  return json_build_object('ok', true);
end $$;

-- preenche a assinatura de rostos cadastrados pelo Streamlit (calculada no navegador a partir da foto)
create or replace function public.promot_web_salvar_descritor(p_token uuid, p_id bigint, p_descritor jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes;
begin
  s := _promot_web_sessao(p_token);
  if p_descritor is null or jsonb_typeof(p_descritor) <> 'array' or jsonb_array_length(p_descritor) <> 128 then
    raise exception 'DESCRITOR_INVALIDO';
  end if;
  update promot_biometria_gabaritos set descritor = p_descritor where id = p_id;
  return json_build_object('ok', true);
end $$;

-- ---------- permissões: a chave pública só chama as funções do app ----------
grant execute on function public.promot_web_login(text, text) to anon;
grant execute on function public.promot_web_sair(uuid) to anon;
grant execute on function public.promot_web_dados(uuid, int) to anon;
grant execute on function public.promot_web_registrar(uuid, int, text, text, text, boolean) to anon;
grant execute on function public.promot_web_salvar_fornecedor(uuid, int, bigint, json) to anon;
grant execute on function public.promot_web_remover_fornecedor(uuid, int, bigint) to anon;
grant execute on function public.promot_web_salvar_gabarito(uuid, text, text, text, text, jsonb) to anon;
grant execute on function public.promot_web_salvar_descritor(uuid, bigint, jsonb) to anon;

select 'Funções do app web dos Promotores criadas' as resultado;
