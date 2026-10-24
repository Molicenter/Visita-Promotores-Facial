-- =====================================================================
-- SQL 09 — Marcas na apuração (out/2026)
-- As marcas ficam em promot_fornecedores.marca separadas por ";".
-- 1) A RPC da apuração passa a devolver "marcas" de cada fornecedor/loja
-- 2) View promot_vw_fornecedor_marcas: uma linha por loja x fornecedor x marca
--    (para o Power BI relacionar com promot_vw_apuracao_dia por loja+fornecedor)
-- =====================================================================
create or replace function public.promot_web_apuracao(p_token uuid, p_ini date, p_fim date, p_loja int default null)
returns json language plpgsql security definer set search_path = public as $$
declare s promot_web_sessoes;
begin
  s := _promot_web_sessao(p_token);
  if s.perfil = 'gerente' then raise exception 'SEM_PERMISSAO'; end if;
  if p_ini is null or p_fim is null or p_fim < p_ini then raise exception 'PERIODO_INVALIDO'; end if;
  if p_fim - p_ini > 400 then raise exception 'PERIODO_MUITO_LONGO'; end if;

  return (
    with b as (
      select * from promot_apuracao_base(p_ini, p_fim) where p_loja is null or loja = p_loja),
    lin as (
      select loja, fornecedor, max(comprador) comprador, max(frequencia) frequencia,
             sum(previsto)::int previstas,
             sum(previsto * visitou)::int realizadas,
             sum((1 - previsto) * visitou)::int fora,
             sum(registros)::int registros,
             round(avg(minutos_loja))::int media_min,
             max(data) filter (where visitou = 1) ultima
        from b group by loja, fornecedor),
    mar as (
      select loja, chave, string_agg(marca, '; ' order by _promot_chave(marca)) marcas
        from (select f.loja, _promot_chave(f.fornecedor) chave, min(trim(m)) marca
                from promot_fornecedores f, unnest(string_to_array(coalesce(f.marca, ''), ';')) m
               where trim(m) <> ''
               group by 1, 2, _promot_chave(m)) x
       group by 1, 2),
    fim as (
      select lin.*, mar.marcas from lin
        left join mar on mar.loja = lin.loja and mar.chave = _promot_chave(lin.fornecedor))
    select json_build_object(
      'ini', p_ini, 'fim', p_fim,
      'linhas', coalesce((select json_agg(row_to_json(fim) order by loja, fornecedor) from fim), '[]'::json))
  );
end $$;
grant execute on function public.promot_web_apuracao(uuid, date, date, int) to anon, authenticated;

create or replace view public.promot_vw_fornecedor_marcas as
  select f.loja, min(trim(f.fornecedor)) fornecedor, min(trim(m)) marca
    from promot_fornecedores f, unnest(string_to_array(coalesce(f.marca, ''), ';')) m
   where trim(m) <> '' and coalesce(trim(f.fornecedor), '') <> ''
   group by f.loja, _promot_chave(f.fornecedor), _promot_chave(m);
grant select on public.promot_vw_fornecedor_marcas to anon, authenticated;
