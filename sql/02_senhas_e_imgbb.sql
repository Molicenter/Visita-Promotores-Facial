-- ============================================================
-- Senhas do app web dos Promotores + chave do ImgBB
-- Rodar DEPOIS do 01_funcoes_web.sql, no SQL Editor do Supabase.
--
-- 1) Troque os 3 textos entre aspas pelos valores reais
--    (os mesmos que estão no Secrets do Streamlit:
--     SENHA_ADMIN, SENHA_GERENTE e imgbb.api_key).
-- 2) Clique em Run.
-- 3) NÃO salve este arquivo com as senhas reais no GitHub
--    (o repositório é público). Depois de rodar, pode fechar a aba
--    sem salvar a query.
--
-- As senhas ficam guardadas com hash (bcrypt): nem quem abre a
-- tabela consegue ler a senha original. Para trocar uma senha
-- no futuro, basta rodar a linha dela de novo com o valor novo.
-- ============================================================

-- senha do usuário "Administrador"
select public.promot_web_definir_senha('analista', 'COLOQUE_AQUI_A_SENHA_ADMIN');

-- senha das lojas ("Loja 01" a "Loja 08"), a mesma para todas, como hoje
select public.promot_web_definir_senha('gerente', 'COLOQUE_AQUI_A_SENHA_GERENTE');

-- chave do ImgBB (fica só no servidor; a página nunca vê esta chave)
insert into public.promot_web_segredos (chave, valor)
values ('imgbb_api_key', 'COLOQUE_AQUI_A_CHAVE_DO_IMGBB')
on conflict (chave) do update set valor = excluded.valor;

select chave, case when chave like 'senha_%' then '(hash guardado)' else '(chave guardada)' end as situacao
from public.promot_web_segredos order by chave;
