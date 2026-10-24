-- =====================================================================
-- SQL 10 — Agenda com "Lojas TT" para o administrador (out/2026)
-- promot_web_dados com p_loja = 0 (só administrador) devolve fornecedores
-- e visitas de hoje de TODAS as lojas; cada item passa a trazer "loja".
-- =====================================================================
create or replace function public.promot_web_dados(p_token uuid, p_loja integer)
returns json language plpgsql security definer set search_path to 'public' as $function$
declare s promot_web_sessoes; v_loja int; v_hoje text; v_todas boolean;
begin
  s := _promot_web_sessao(p_token);
  v_todas := (p_loja = 0 and s.perfil <> 'gerente');
  v_loja := case when v_todas then 0 else _promot_web_loja(s, p_loja) end;
  v_hoje := to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY');
  return json_build_object(
    'loja', v_loja,
    'agora', _promot_web_agora(),
    'fornecedores', coalesce((
      select json_agg(json_build_object('id', id, 'loja', loja, 'cod', cod, 'fornecedor', fornecedor, 'marca', marca,
        'comprador', comprador, 'promotor', promotor, 'telefone', telefone, 'frequencia', frequencia_visita)
        order by fornecedor, loja, id)
      from promot_fornecedores where v_todas or loja = v_loja), '[]'::json),
    'visitas', coalesce((
      select json_agg(json_build_object('id', id, 'loja', "Loja"::int, 'data', "Data", 'fornecedor', "Fornecedor",
        'frequencia', "Frequencia", 'obs', "Observacao", 'foto', "Arquivo_Foto", 'usuario', "Usuario",
        'saida', "Saida", 'minutos', "Minutos_Loja")
        order by "Data" desc)
      from promot_registro_visitas
      where (v_todas and "Loja" ~ '^\d+$' or "Loja" = v_loja::text) and "Data" like v_hoje || '%'), '[]'::json),
    'gabaritos', coalesce((
      select json_agg(json_build_object('id', id, 'empresa', "Empresa", 'nome', "Nome_Promotor",
        'telefone', "Telefone", 'link', "Link_Gabarito", 'data', "Data_Cadastro", 'descritor', descritor)
        order by "Empresa")
      from promot_biometria_gabaritos), '[]'::json)
  );
end $function$;
