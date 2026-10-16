# App web dos Promotores (pasta docs)

Versão em HTML/CSS/JavaScript do registro de visitas de promotores, para o computador da fiscal de loja.
Usa o **mesmo banco** do app Streamlit (`web.py`), então os registros aparecem nos dois e no Export_Promotores / Power BI.

## Arquivos

| Arquivo | Para que serve |
|---|---|
| `index.html` | As telas (login, Check-in facial, Agenda, Registro manual, Fornecedores, Cadastro facial) |
| `style.css` | Visual (azul-marinho e magenta Molicenter) |
| `app.js` | A lógica: câmera, reconhecimento facial, chamadas ao banco |
| `config.js` | Endereço do Supabase, chave **pública** e a régua do reconhecimento |
| `logo.png` | Passarinho |
| `../sql/` (fora do docs, não é publicado) | Funções do banco e o script de senhas |
| `../supabase/functions/promot-fotos/` | Código da função que envia as fotos ao ImgBB |

## Como funciona o reconhecimento

- Roda no próprio navegador (biblioteca face-api). Não depende mais do tensorflow no Streamlit.
- Cada rosto cadastrado tem uma "assinatura" de 128 números guardada na coluna `descritor` de `promot_biometria_gabaritos`.
  Rostos cadastrados pelo Streamlit ganham a assinatura sozinhos na primeira vez que o app abre.
- O check-in grava a **loja de quem está logado**, `Frequencia = FACIAL` e `Observacao = [CHECK-IN FACIAL]`.
- O mesmo rosto não gera 2 registros em menos de 30 minutos na mesma loja.
- Régua no `config.js`: `LIMIAR_ROSTO` (0.5; menor = mais exigente) e `TAMANHO_MIN_ROSTO` (quão perto precisa estar).

## Segurança

A chave em `config.js` é a pública. O app só chama as funções `promot_web_*`, que exigem login.
As senhas ficam com hash no banco (`promot_web_segredos`). A chave do ImgBB fica só no servidor.

## Como atualizar

1. Edite o arquivo aqui no GitHub (ícone de lápis) e clique em **Commit changes**.
2. Em ~1 minuto o GitHub Pages publica. No navegador, aperte **Ctrl + F5**.
3. Ao mexer no visual ou na lógica, aumente a `VERSAO` em `config.js`.
