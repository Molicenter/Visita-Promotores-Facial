// Configuração do Supabase (projeto da empresa).
// A chave abaixo é a PÚBLICA (publishable) — pode ficar no GitHub sem problema:
// o app só chama as funções promot_web_* do banco, e todas exigem login.
window.CONFIG = {
  SUPABASE_URL: "https://eemfqkxshqqlhdyofgoz.supabase.co",
  SUPABASE_KEY: "sb_publishable_ZwBOMu1KwPQB2AwNeh08tw_g93KC9d5",
  MODELOS_URL: "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/",
  // quanto menor, mais exigente (0.45 = bem rígido, 0.55 = mais tolerante)
  LIMIAR_ROSTO: 0.5,
  // entrada facial: rosto precisa ocupar pelo menos esta fração da largura da imagem (o cadastro aceita 60% disso)
  TAMANHO_MIN_ROSTO: 0.20,
  VERSAO: "1.1.0",
};
