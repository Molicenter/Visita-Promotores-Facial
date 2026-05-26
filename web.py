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

# Bibliotecas do Google para baixar gabaritos do Drive de forma segura (LGPD)
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
import io

# --- CONFIGURAÇÃO E LOGO ---
USER_GITHUB = "adrianormartins86-lab"
REPO_GITHUB = "Python"
NOME_IMAGEM = "passaro_logo.png"
URL_ICONE = f"https://raw.githubusercontent.com/{USER_GITHUB}/{REPO_GITHUB}/main/{NOME_IMAGEM}"

st.set_page_config(
    page_title="Registro Promotores", 
    layout="wide", 
    page_icon=URL_ICONE,
    initial_sidebar_state="collapsed"
)

# --- FUNÇÃO DE CONEXÃO COM GOOGLE DRIVE (API SEGURA PARA GABARITOS) ---
def obter_servico_drive():
    try:
        info_projeto = {
            "type": st.secrets["connections"]["gsheets"]["type"],
            "project_id": st.secrets["connections"]["gsheets"]["project_id"],
            "private_key_id": st.secrets["connections"]["gsheets"]["private_key_id"],
            "private_key": st.secrets["connections"]["gsheets"]["private_key"],
            "client_email": st.secrets["connections"]["gsheets"]["client_email"],
            "client_id": st.secrets["connections"]["gsheets"]["client_id"],
            "auth_uri": st.secrets["connections"]["gsheets"]["auth_uri"],
            "token_uri": st.secrets["connections"]["gsheets"]["token_uri"],
            "auth_provider_x509_cert_url": st.secrets["connections"]["gsheets"]["auth_provider_x509_cert_url"],
            "client_x509_cert_url": st.secrets["connections"]["gsheets"]["client_x509_cert_url"]
        }
        creds = service_account.Credentials.from_service_account_info(
            info_projeto, 
            scopes=["https://www.googleapis.com/auth/drive"]
        )
        return build('drive', 'v3', credentials=creds)
    except Exception as e:
        st.error(f"Erro ao conectar com o Google Drive: {e}")
        return None

# --- SISTEMA DE LOGIN COM SELEÇÃO DE FLUXO ---
def check_password():
    if "authenticated" not in st.session_state:
        st.session_state["authenticated"] = False
    if "tela_ativa" not in st.session_state:
        st.session_state["tela_ativa"] = "menu_inicial" # Opções: menu_inicial, login_admin, camera_promotor
        
    if st.session_state["authenticated"]:
        return True

    col1, col2, col3 = st.columns([1,2,1])
    with col2:
        try: st.image(URL_ICONE, width=100)
        except: st.write("🐦")
        st.title("Controle de Acesso")
        st.write("Laboratório de Reconhecimento Facial")
        st.markdown("---")

        # --- 1. TELA INTERMÉDIA: MENU INICIAL ---
        if st.session_state["tela_ativa"] == "menu_inicial":
            st.write("### Escolha seu perfil para acessar:")
            
            if st.button("📷 SOU PROMOTOR (Validação Facial)", use_container_width=True, type="primary"):
                st.session_state["tela_ativa"] = "camera_promotor"
                st.rerun()
                
            st.write("") # Espaçamento
            
            if st.button("👤 SOU FUNCIONÁRIO (Login Administrativo)", use_container_width=True):
                st.session_state["tela_ativa"] = "login_admin"
                st.rerun()

        # --- 2. TELA EXCLUSIVA: LOGIN DO FUNCIONÁRIO ---
        elif st.session_state["tela_ativa"] == "login_admin":
            st.subheader("Login Administrativo")
            email = st.text_input("E-mail", placeholder="seu_email@molicenter.com.br").lower().strip()
            senha = st.text_input("Senha", type="password")
            
            col_b1, col_b2 = st.columns(2)
            with col_b1:
                if st.button("⬅️ Voltar", use_container_width=True):
                    st.session_state["tela_ativa"] = "menu_inicial"
                    st.rerun()
            with col_b2:
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

        # --- 3. TELA EXCLUSIVA: CÂMERA DO PROMOTOR (MODO BANCO) ---
        elif st.session_state["tela_ativa"] == "camera_promotor":
            st.subheader("📸 Identificação Automática de Promotores")
            st.warning("Atenção: Aproxime bem o rosto da câmera (Estilo aplicativo de banco) para validar o enquadramento.")
            
            foto_capturada = st.camera_input("Centralize seu rosto e dê zoom se aproximando da câmera")
            
            if foto_capturada:
                with st.spinner('Validando enquadramento e buscando cadastro...'):
                    try:
                        # Salva a foto tirada para análise inicial de enquadramento
                        caminho_temp_captura = "temp_identifica.jpg"
                        with open(caminho_temp_captura, "wb") as f:
                            f.write(foto_capturada.getbuffer())
                        
                        # --- MODAL BANCO: VERIFICAÇÃO DE ZOOM DO ROSTO ---
                        faces_detectadas = DeepFace.extract_faces(
                            img_path = caminho_temp_captura, 
                            detector_backend = 'opencv', 
                            enforce_detection = True
                        )
                        
                        if len(faces_detectadas) > 0:
                            dados_rosto = faces_detectadas[0]
                            # Pega a largura do rosto detectado e a largura total do quadro da câmera
                            largura_rosto = dados_rosto["facial_area"]["w"]
                            largura_total_imagem = dados_rosto["facial_area"]["w"] + dados_rosto["facial_area"]["x"] # Estimativa aproximada do frame completo
                            
                            # Usamos um valor padrão de proporção (por exemplo, o rosto deve ocupar pelo menos 30% a 35% da tela)
                            # Para blindar o Streamlit que varia resoluções de câmera, checamos a área do recorte
                            confiança_face = dados_rosto["confidence"]
                            
                            # Se o rosto estiver muito longe (largura menor que 130 pixels costuma ser o padrão de distância excessiva)
                            if largura_rosto < 140:
                                st.error("⚠️ Você está muito longe! Fique mais perto da câmera para dar zoom no rosto.")
                                if os.path.exists(caminho_temp_captura): os.remove(caminho_temp_captura)
                                st.stop()
                        
                        # --- FIM DA VALIDAÇÃO DE ZOOM, INICIA BUSCA NO DRIVE ---
                        drive_service = obter_servico_drive()
                        folder_id = st.secrets["google_drive"]["folder_id"]
                        
                        pasta_local_temp = "temp_db_facial"
                        os.makedirs(pasta_local_temp, exist_ok=True)
                        
                        # Sincroniza imagens do Drive corporativo
                        query = f"'{folder_id}' in parents and mimeType = 'image/jpeg' and trashed = false"
                        resultados_drive = drive_service.files().list(q=query, fields="files(id, name)").execute()
                        arquivos_drive = resultados_drive.get('files', [])
                        
                        if not arquivos_drive:
                            st.error("❌ Base biométrica vazia no Google Drive.")
                        else:
                            for arquivo in arquivos_drive:
                                caminho_local_foto = os.path.join(pasta_local_temp, arquivo['name'])
                                if not os.path.exists(caminho_local_foto):
                                    request_download = drive_service.files().get_media(fileId=arquivo['id'])
                                    fh = io.FileIO(caminho_local_foto, 'wb')
                                    downloader = MediaIoBaseDownload(fh, request_download)
                                    done = False
                                    while not done:
                                        status, done = downloader.next_chunk()
                            
                            # Varredura DeepFace cruzando com a base do Drive
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
                                
                                conn = st.connection("gsheets", type=GSheetsConnection)
                                try: df_atual = conn.read(ttl=0)
                                except: df_atual = pd.DataFrame()
                                
                                fuso_br = pytz.timezone('America/Sao_Paulo')
                                agora_br = datetime.now(fuso_br)
                                
                                api_key = st.secrets["imgbb"]["api_key"]
                                foto_base64 = base64.b64encode(foto_capturada.getvalue()).decode('utf-8')
                                res_imgbb = requests.post("https://api.imgbb.com/1/upload", {"key": api_key, "image": foto_base64}).json()
                                link_auditoria = res_imgbb['data']['url'] if res_imgbb['success'] else "Erro Link"
                                
                                novo_registro = pd.DataFrame([{
                                    "Data": agora_br.strftime("%d/%m/%Y %H:%M:%S"),
                                    "Loja": "RECONHECIMENTO_AUTOMATICO", 
                                    "Fornecedor": forn_detectado,
                                    "Frequencia": "FACIAL_PASSIVO_ZOOM", 
                                    "Observacao": "[CHECK-IN ENQUADRAMENTO FORÇADO SUCESSO]",
                                    "Arquivo_Foto": link_auditoria, 
                                    "Usuario": "totem_biometrico"
                                }])
                                
                                df_final = pd.concat([df_atual, novo_registro], ignore_index=True)
                                conn.update(data=df_final)
                                
                                st.success(f"🎉 Enquadramento Perfeito e Reconhecido! Empresa: {forn_detectado}")
                                st.balloons()
                                time.sleep(3)
                                st.session_state["tela_ativa"] = "menu_inicial"
                                st.rerun()
                            else:
                                st.error("❌ Rosto não reconhecido na base. Procure a gerência para atualizar seu cadastro.")
                                
                    except Exception as e:
                        if "Face could not be detected" in str(e):
                            st.error("❌ Nenhum rosto detectado. Centralize-se melhor na tela.")
                        else:
                            st.error(f"Erro na análise: {e}")
            
            if st.button("⬅️ Voltar para o Menu Inicial", use_container_width=True):
                st.session_state["tela_ativa"] = "menu_inicial"
                st.rerun()
                
    return False

# --- O RESTANTE DO CÓDIGO PERMANECE IDENTICO ---
if check_password():
    with st.sidebar:
        with st.expander("⚙️ Opções de Conta"):
            st.write(f"👤 **Usuário:** {st.session_state['usuario_logado']}")
            st.write(f"📊 **Perfil:** {st.session_state['perfil'].capitalize()}")
            if st.button("Sair / Logout", use_container_width=True):
                st.session_state.clear()
                st.rerun()

    def upload_para_imgbb(arquivo_foto):
        try:
            api_key = st.secrets["imgbb"]["api_key"]
            url = "https://api.imgbb.com/1/upload"
            foto_base64 = base64.b64encode(arquivo_foto.getvalue()).decode('utf-8')
            payload = {"key": api_key, "image": foto_base64}
            response = requests.post(url, payload)
            res = response.json()
            return res['data']['url'] if res['success'] else "Erro no Upload"
        except: return "Erro no Upload"

    st.title("Visita Promotores")
    st.markdown("---")

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
        
        fuso_br = pytz.timezone('America/Sao_Paulo')
        agora = datetime.now(fuso_br)
        dias_map = {0: 'SEG', 1:
