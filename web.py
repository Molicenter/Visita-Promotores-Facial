import streamlit as st
import pandas as pd
from streamlit_gsheets import GSheetsConnection
from datetime import datetime
import pytz
import os
import requests
import base64
import re
import time
from deepface import DeepFace
import io

# --- CONFIGURAÇÃO E LOGO ---
USER_GITHUB = "adrianormartins86-lab"
# ⚠️ ADICIONE AQUI O NOME DO SEU NOVO REPOSITÓRIO DO GITHUB:
REPO_GITHUB = "NOME_DO_SEU_NOVO_REPOSITORIO" 
NOME_IMAGEM = "passaro_logo.png"
URL_ICONE = f"https://raw.githubusercontent.com/{USER_GITHUB}/{REPO_GITHUB}/main/{NOME_IMAGEM}"

# Tratamento para evitar que o app quebre caso a imagem suma da nuvem novamente
try:
    res_logo = requests.head(URL_ICONE)
    if res_logo.status_code != 200:
        page_icon_fallback = "🐦"
    else:
        page_icon_fallback = URL_ICONE
except:
    page_icon_fallback = "🐦"

st.set_page_config(
    page_title="Registro Promotores", 
    layout="wide", 
    page_icon=page_icon_fallback,
    initial_sidebar_state="collapsed"
)

# --- FUNÇÃO AUXILIAR DE UPLOAD IMGBB ---
def upload_para_imgbb(arquivo_bytes):
    try:
        api_key = st.secrets["imgbb"]["api_key"]
        url = "https://api.imgbb.com/1/upload"
        foto_base64 = base64.b64encode(arquivo_bytes).decode('utf-8')
        payload = {"key": api_key, "image": foto_base64}
        response = requests.post(url, payload)
        res = response.json()
        return res['data']['url'] if res['success'] else None
    except:
        return None

# --- SISTEMA DE LOGIN COM SELEÇÃO DE FLUXO ---
def check_password():
    if "authenticated" not in st.session_state:
        st.session_state["authenticated"] = False
    if "tela_ativa" not in st.session_state:
        st.session_state["tela_ativa"] = "menu_inicial"
        
    if st.session_state["authenticated"]:
        return True

    col1, col2, col3 = st.columns([1,2,1])
    with col2:
        try: st.image(URL_ICONE, width=100)
        except: st.write("🐦")
        st.title("Supermercado Molicenter")
        st.write("Gerenciamento Promotores")
        st.markdown("---")

        if st.session_state["tela_ativa"] == "menu_inicial":
            st.write("### Perfil de acesso:")
            if st.button("📷 SOU PROMOTOR (Validação Facial)", use_container_width=True, type="primary"):
                st.session_state["tela_ativa"] = "camera_promotor"
                st.rerun()
            st.write("") 
            if st.button("👤 SOU FUNCIONÁRIO (Login Administrativo)", use_container_width=True):
                st.session_state["tela_ativa"] = "login_admin"
                st.rerun()

        elif st.session_state["tela_ativa"] == "login_admin":
            st.subheader("Login Administrativo")
            email = st.text_input("E-mail", placeholder="seu_email@molicenter.com.br").lower().strip()
            senha = st.text_input("Senha", type="password")
            
            col_b1, col_b2 = st.columns(2)
            with col_b1:
                if st.button("Entrar", use_container_width=True, type="primary"):
                    emails_gerentes = [f"gerente{i}@molicenter.com.br" for i in range(1, 15)]
                    email_analista = "analista@molicenter.com.br"
                    if (email in emails_gerentes or email == email_analista) and senha == "moli1234":
                        st.session_state["authenticated"] = True
                        st.session_state["usuario_logado"] = email
                        if email == email_analista:
                            st.session_state["perfil"] = "analista"
                        else:
                            st.session_state["perfil"] = "gerente"
                            st.session_state["loja_id"] = re.search(r'\d+', email).group()
                        st.session_state["form_count"] = 0
                        st.rerun()
                    else:
                        st.error("❌ E-mail ou senha incorretos.")
            with col_b2:
                if st.button("⬅️ Voltar", use_container_width=True):
                    st.session_state["tela_ativa"] = "menu_inicial"
                    st.rerun()

        elif st.session_state["tela_ativa"] == "camera_promotor":
            st.subheader("📸 Identificação Automática de Promotores")
            st.markdown(
                """
                <div style="background-color:#0e1117; padding:15px; border:2px dashed #ff4b4b; border-radius:10px; text-align:center; margin-bottom:15px;">
                    <h4 style="color:#ff4b4b; margin:0;">[ 🔲 ENQUADRAMENTO OBRIGATÓRIO ]</h4>
                    <p style="color:#ffffff; margin:5px 0 0 0; font-size:14px;">
                        Aproxime seu rosto da câmera até que ele ocupe <b>quase toda a área central</b>. Fotos de longe serão recusadas automaticamente.
                    </p>
                </div>
                """, 
                unsafe_allow_html=True
            )
            
            foto_capturada = st.camera_input("Centralize e aproxime o rosto da tela:")
            
            if foto_capturada:
                with st.spinner('Validando enquadramento e buscando na base de dados...'):
                    try:
                        caminho_temp_captura = "temp_identifica.jpg"
                        with open(caminho_temp_captura, "wb") as f:
                            f.write(foto_capturada.getbuffer())
                        
                        faces_detectadas = DeepFace.extract_faces(
                            img_path = caminho_temp_captura, 
                            detector_backend = 'opencv', 
                            enforce_detection = True
                        )
                        
                        if len(faces_detectadas) > 0:
                            dados_rosto = faces_detectadas[0]
                            largura_rosto = dados_rosto["facial_area"]["w"]
                            if largura_rosto < 200:
                                st.error("⚠️ REGISTRO NEGADO: Rosto muito distante! Fique mais perto da câmera.")
                                if os.path.exists(caminho_temp_captura): os.remove(caminho_temp_captura)
                                st.stop()
                        
                        # --- DOWNLOAD DOS GABARITOS BIOMÉTRICOS VIA PLANILHA (SEM GOOGLE DRIVE) ---
                        conn = st.connection("gsheets", type=GSheetsConnection)
                        try:
                            df_biometria = conn.read(worksheet="BIOMETRIA_GABARITOS", ttl=0)
                        except:
                            df_biometria = pd.DataFrame()
                        
                        pasta_local_temp = "temp_db_facial"
                        os.makedirs(pasta_local_temp, exist_ok=True)
                        
                        # Limpa pasta temporária local antes de rodar
                        for f_limpar in os.listdir(pasta_local_temp):
                            if f_limpar.endswith('.jpg'): os.remove(os.path.join(pasta_local_temp, f_limpar))

                        if df_biometria.empty or "Link_Gabarito" not in df_biometria.columns:
                            st.error("❌ Nenhuma biometria cadastrada no sistema.")
                        else:
                            # Faz o download temporário de cada imagem cadastrada no ImgBB
                            for _, row in df_biometria.iterrows():
                                url_gabarito = row["Link_Gabarito"]
                                nome_arquivo = f"{row['Empresa']}.jpg"
                                caminho_local_foto = os.path.join(pasta_local_temp, nome_arquivo)
                                
                                try:
                                    res_foto = requests.get(url_gabarito)
                                    if res_foto.status_code == 200:
                                        with open(caminho_local_foto, "wb") as f_img:
                                            f_img.write(res_foto.content)
                                except:
                                    pass
                            
                            # Executa o algoritmo de comparação facial
                            lista_resultados = DeepFace.find(
                                img_path = caminho_temp_captura,
                                db_path = pasta_local_temp,
                                enforce_detection = True,
                                detector_backend = 'opencv',
                                silent = True
                            )
                            
                            if os.path.exists(caminho_temp_captura): os.remove(caminho_temp_captura)
                            
                            if len(lista_resultados) > 0 and not lista_resultados[0].empty:
                                melhor_match = lista_resultados[0].iloc[0]
                                nome_arquivo = os.path.basename(melhor_match['identity'])
                                forn_detectado = os.path.splitext(nome_arquivo)[0]
                                
                                # --- AJUSTADO: Lendo e atualizando a aba correta (padrão) para não perder histórico ---
                                try: df_atual = conn.read(ttl=0)
                                except: df_atual = pd.DataFrame()
                                
                                fuso_br = pytz.timezone('America/Sao_Paulo')
                                agora_br = datetime.now(fuso_br)
                                
                                link_auditoria = upload_para_imgbb(foto_capturada.getvalue()) or "Erro Link"
                                
                                novo_registro = pd.DataFrame([{
                                    "Data": agora_br.strftime("%d/%m/%Y %H:%M:%S"),
                                    "Loja": "FACE", 
                                    "Fornecedor": forn_detectado,
                                    "Frequencia": "FACIAL", 
                                    "Observacao": "[CHECK-IN FACIAL]",
                                    "Arquivo_Foto": link_auditoria, 
                                    "Usuario": "totem_biometrico"
                                }])
                                
                                df_final = pd.concat([df_atual, novo_registro], ignore_index=True)
                                conn.update(data=df_final) # Salva mantendo a consistência na aba principal
                                
                                st.success(f"🎉 Reconhecido com sucesso! Empresa: {forn_detectado}")
                                st.balloons()
                                time.sleep(3)
                                st.session_state["tela_ativa"] = "menu_inicial"
                                st.rerun()
                            else:
                                st.error("❌ Rosto não reconhecido na base biométrica.")
                                
                    except Exception as e:
                        if "Face could not be detected" in str(e):
                            st.error("❌ Nenhum rosto detectado. Centralize-se melhor na tela.")
                        else:
                            st.error(f"Erro na análise: {e}")
            
            if st.button("⬅️ Voltar para o Menu Inicial", use_container_width=True):
                st.session_state["tela_ativa"] = "menu_inicial"
                st.rerun()
                
    return False

if check_password():
    conn = st.connection("gsheets", type=GSheetsConnection)

    @st.cache_data
    def carregar_fornecedores():
        arquivo = 'fornecedores.xlsx'
        if os.path.exists(arquivo):
            try:
                df = pd.read_excel(arquivo, engine='openpyxl').dropna(how='all')
                df.columns = [str(col).strip() for col in df.columns]
                return df
            except Exception as e:
                st.error(f"Erro ao ler Excel: {e}")
        return None

    df_forn = carregar_fornecedores()

    if df_forn is not None:
        col_fornecedor = df_forn.columns[1]  
        col_marcas = df_forn.columns[2]      
        col_comprador = df_forn.columns[3]    
        col_promotor = df_forn.columns[4]     
        col_telefone = df_forn.columns[5]     
        col_frequencia = df_forn.columns[6] 
        col_loja = df_forn.columns[-1]

    with st.sidebar:
        st.header("🎛️ Menu de Controle")
        
        with st.expander("👤 Opções de Conta", expanded=True):
            perfil_str = str(st.session_state.get('perfil', '')).capitalize()
            st.write(f"**Usuário:** {st.session_state.get('usuario_logado', '')}")
            st.write(f"**Perfil:** {perfil_str}")
            if st.button("Sair / Logout", use_container_width=True):
                st.session_state.clear()
                st.rerun()
                
        st.markdown("---")
        
        if df_forn is not None:
            with st.expander("⚙️ CADASTRO PROMOTOR", expanded=False):
                st.caption("Registre novos rostos de forma segura via nuvem.")
                lista_empresas_cadastro = sorted(df_forn[col_fornecedor].dropna().unique().tolist())
                empresa_alvo = st.selectbox("1. Empresa:", ["Escolha..."] + lista_empresas_cadastro, key="sb_cad_sidebar")
                
                if empresa_alvo != "Escolha...":
                    nome_digitado = st.text_input("2. Nome do Promotor:", placeholder="Digite o nome completo", key="txt_nome_sidebar").strip()
                    tel_opcional = st.text_input("3. Telefone (Opcional):", placeholder="(DDD) 00000-0000", key="txt_tel_sidebar").strip()
                    
                    foto_gabarito = st.camera_input("4. Foto de perto (Gabarito)", key="cam_cad_sidebar")
                    
                    st.markdown(
                        """
                        <div style="background-color:#1e222b; padding:10px; border-radius:5px; height:130px; overflow-y:scroll; font-size:11px; color:#bdc3c7; border:1px solid #34495e; margin-bottom:10px; line-height:1.4;">
                            <b>**TERMOS DE USO E PROTEÇÃO DE DADOS (LGPD)**</b><br><br>
                            Declaramos para os devidos fins legais, em conformidade com a Lei Geral de Proteção de Dados (LGPD), que a imagem capturada para este cadastro biométrico (gabarito) será utilizada estritamente para o registro interno de ponto e controle de acesso de promotores nas unidades Molicenter.<br><br>
                            Os dados biométricos serão armazenados de forma segura e jamais serão compartilhados com terceiros sem consentimento explícito.<br><br>
                            Declaro ciência e autorizo o uso da minha imagem.
                        </div>
                        """, 
                        unsafe_allow_html=True
                    )
                    
                    consentimento = st.checkbox("Termo assinado (LGPD)", key="chk_cad_sidebar")
                    botao_desabilitado = not (consentimento and len(nome_digitado) > 0)
                    
                    if st.button(f"Salvar Promotor", use_container_width=True, disabled=botao_desabilitado, key="btn_cad_sidebar"):
                        if foto_gabarito is not None:
                            with st.spinner("Processando e salvando promotor..."):
                                try:
                                    caminho_local_salvar = "upload_gabarito.jpg"
                                    with open(caminho_local_salvar, "wb") as f:
                                        f.write(foto_gabarito.getbuffer())
                                        
                                    try:
                                        DeepFace.extract_faces(img_path=caminho_local_salvar, detector_backend='opencv')
                                    except:
                                        st.error("❌ Nenhum rosto nítido encontrado. Refaça de perto.")
                                        if os.path.exists(caminho_local_salvar): os.remove(caminho_local_salvar)
                                        st.stop()
                                    
                                    # Faz o upload estável para o ImgBB (Independente de cotas do Drive)
                                    url_gabarito_salvo = upload_para_imgbb(foto_gabarito.getvalue())
                                    
                                    if url_gabarito_salvo:
                                        # Salva o metadado numa aba exclusiva do Google Sheets ("BIOMETRIA_GABARITOS")
                                        try:
                                            df_bio_atual = conn.read(worksheet="BIOMETRIA_GABARITOS", ttl=0)
                                        except:
                                            df_bio_atual = pd.DataFrame(columns=["Data_Cadastro", "Empresa", "Nome_Promotor", "Telefone", "Link_Gabarito"])
                                        
                                        fuso_br = pytz.timezone('America/Sao_Paulo')
                                        agora_br = datetime.now(fuso_br)
                                        
                                        # Se a empresa já existir, remove o gabarito antigo para atualizar
                                        if not df_bio_atual.empty and "Empresa" in df_bio_atual.columns:
                                            df_bio_atual = df_bio_atual[df_bio_atual["Empresa"] != empresa_alvo]
                                        
                                        novo_gabarito_row = pd.DataFrame([{
                                            "Data_Cadastro": agora_br.strftime("%d/%m/%Y %H:%M:%S"),
                                            "Empresa": empresa_alvo,
                                            "Nome_Promotor": nome_digitado,
                                            "Telefone": tel_opcional,
                                            "Link_Gabarito": url_gabarito_salvo
                                        }])
                                        
                                        df_bio_final = pd.concat([df_bio_atual, novo_gabarito_row], ignore_index=True)
                                        conn.update(worksheet="BIOMETRIA_GABARITOS", data=df_bio_final)
                                        
                                        st.success(f"✅ Biometria de {nome_digitado} salva!")
                                        if os.path.exists(caminho_local_salvar): os.remove(caminho_local_salvar)
                                        time.sleep(1.5)
                                        st.rerun()
                                    else:
                                        st.error("❌ Erro ao gerar link da imagem no ImgBB.")
                                        
                                except Exception as err:
                                    st.error(f"Erro no Processamento: {err}")

    # --- FLUXO DA TELA CENTRAL ---
    if df_forn is not None:
        fuso_br = pytz.timezone('America/Sao_Paulo')
        agora = datetime.now(fuso_br)
        dias_map = {0: 'SEG', 1: 'TER', 2: 'QUA', 3: 'QUI', 4: 'SEX', 5: 'SAB', 6: 'DOM'}
        dia_hoje = dias_map[agora.weekday()]

        st.subheader(f"📅 Hoje é {agora.strftime('%d/%m')} ({dia_hoje})")

        lista_lojas = sorted(df_forn[col_loja].dropna().astype(str).unique().tolist())
        if st.session_state.get("perfil") == "analista":
            loja_sel = st.selectbox("Selecione a Loja:", ["Escolha..."] + lista_lojas)
        else:
            id_g = st.session_state.get("loja_id", "")
            loja_sel = next((l for l in lista_lojas if l.startswith(id_g) or l.startswith(id_g.zfill(2))), "Escolha...")
            st.info(f"📍 **Loja: {loja_sel}**")

        if loja_sel != "Escolha...":
            df_loja = df_forn[df_forn[col_loja].astype(str) == loja_sel]
            df_hoje = df_loja[df_loja[col_frequencia].astype(str).str.contains(dia_hoje, case=False, na=False)]

            st.markdown("### 📋 Agenda de Visitas (Hoje)")
            
            if not df_hoje.empty:
                colunas_exibir = [col_fornecedor, col_marcas, col_comprador, col_promotor, col_telefone, col_frequencia]
                tabela_exibicao = df_hoje[colunas_exibir].copy().sort_values(by=col_fornecedor)
                st.dataframe(tabela_exibicao, use_container_width=True, hide_index=True)
            else:
                st.warning("Nenhum fornecedor programado para hoje.")

            st.markdown("---")

            if "form_count" not in st.session_state:
                st.session_state["form_count"] = 0
            
            with st.container():
                st.markdown("### 2. Realizar Registro Manual")
                opcoes_forn = ["Escolha..."] + sorted(df_loja[col_fornecedor].unique().tolist())
                
                forn_sel = st.selectbox(
                    "Selecione o fornecedor para registrar a visita:", 
                    opcoes_forn, 
                    key=f"forn_{st.session_state['form_count']}"
                )

                if forn_sel != "Escolha...":
                    dados_linha = df_loja[df_loja[col_fornecedor] == forn_sel].iloc[0]
                    freq_cadastrada = dados_linha[col_frequencia]
                    
                    st.success(f"✅ **Fornecedor:** {forn_sel}")
                    
                    obs = st.text_input("3. Observação (Opcional):", key=f"obs_{st.session_state['form_count']}")
                    foto = st.file_uploader("📸 Foto do Registro", type=["jpg", "jpeg", "png"], key=f"foto_{st.session_state['form_count']}")
                    
                    if foto: st.image(foto, width=250)

                    if st.button("Confirmar Registro", use_container_width=True):
                        try:
                            with st.spinner('🚀 Gravando com segurança...'):
                                link_f = upload_para_imgbb(foto.getvalue()) if foto else "Sem foto"
                                
                                if link_f:
                                    try:
                                        df_atual = conn.read(ttl=0)
                                    except:
                                        df_atual = pd.DataFrame()

                                    novo_registro = pd.DataFrame([{
                                        "Data": agora.strftime("%d/%m/%Y %H:%M:%S"),
                                        "Loja": loja_sel, 
                                        "Fornecedor": forn_sel,
                                        "Frequencia": freq_cadastrada, 
                                        "Observacao": obs,
                                        "Arquivo_Foto": link_f, 
                                        "Usuario": st.session_state["usuario_logado"]
                                    }])
                                    
                                    df_final = pd.concat([df_atual, novo_registro], ignore_index=True)
                                    conn.update(data=df_final)
                                    
                                    st.success(f"✅ Registro concluído!")
                                    st.balloons()
                                    
                                    st.session_state["form_count"] += 1
                                    time.sleep(2)
                                    st.rerun()
                                else:
                                    st.error("❌ Falha no upload da foto. Verifique a chave da API do ImgBB.")
                        except Exception as e:
                            st.error(f"Erro ao salvar: {e}")
    else:
        st.error("Erro: Arquivo 'fornecedores.xlsx' não encontrado.")
