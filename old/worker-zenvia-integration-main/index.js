const axios = require('axios');
const { google } = require('googleapis');

const {
  GOOGLE_TOKEN,
  ZENVIA_ACCESS_TOKEN,
  ZENVIA_QUEUE_ID,
  SPREADSHEET_ID,
  SHEET_NAME
} = process.env;

// Função para mascarar dados sensíveis
function maskSensitiveData(data, maxLength = 8) {
    if (!data || typeof data !== 'string') return '[MASKED]';
    if (data.length <= maxLength) return '[MASKED]';
    return data.substring(0, 4) + '*'.repeat(data.length - 8) + data.substring(data.length - 4);
}

// Função para registrar eventos sem expor dados sensíveis
function secureLog(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logLevel = isError ? 'ERROR' : 'INFO';
    console.log(`[${timestamp}] [${logLevel}] ${message}`);
}

// Validação de variáveis essenciais
if (!GOOGLE_TOKEN || GOOGLE_TOKEN === 'undefined') {
  secureLog("GOOGLE_TOKEN não definido", true);
  process.exit(1);
}

if (!ZENVIA_ACCESS_TOKEN) {
  secureLog("ZENVIA_ACCESS_TOKEN não definido", true);
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2();
oauth2Client.setCredentials({ access_token: GOOGLE_TOKEN });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

const formatarParaBR = (dataISO) => {
  if (!dataISO || dataISO === "null" || dataISO === "") return "";
  try {
    const data = new Date(dataISO);
    if (isNaN(data.getTime())) return dataISO;
    return data.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(',', '');
  } catch (e) {
    return dataISO;
  }
};

async function runIntegration() {
  secureLog(`Iniciando sincronização com filtro`);

  try {
    // Definir o que é "ONTEM" no fuso de Brasília para o filtro
    const agoraBR = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
    const ontemBR = new Date(agoraBR);
    ontemBR.setDate(agoraBR.getDate() - 1);
    
    const dataOntemAlvo = ontemBR.toISOString().split('T')[0]; // Ex: "2026-03-19"

    // Definir busca ampla (D-2 até hoje) para a API
    const dataInicioBusca = new Date(agoraBR);
    dataInicioBusca.setDate(agoraBR.getDate() - 2);
    
    const dsInicio = dataInicioBusca.toISOString().split('T')[0];
    const dsFim = agoraBR.toISOString().split('T')[0];

    secureLog(`Buscando intervalo amplo de ${dsInicio} até ${dsFim}`);
    secureLog(`Filtrando apenas registros do dia ${dataOntemAlvo}`);

    const allCalls = [];
    let posicao = 0;
    const limite = 200;

    while (true) {
      const endpoint = ZENVIA_QUEUE_ID 
        ? `https://voice-api.zenvia.com/fila/${ZENVIA_QUEUE_ID}/relatorio`
        : `https://voice-api.zenvia.com/chamada/relatorio`;

      secureLog(`Requisitando posição: ${posicao}`);
      
      const response = await axios.get(endpoint, {
        params: {
          data_inicio: dsInicio,
          data_fim: dsFim,
          posicao: posicao,
          limite: limite
        },
        headers: { 
          'Access-Token': ZENVIA_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });

      const calls = response.data?.dados?.relatorio || [];
      if (calls.length === 0) break;

      allCalls.push(...calls);
      if (calls.length < limite) break;
      posicao += limite;
      
      if (posicao > 50000) break;
    }

    secureLog(`Capturados da API: ${allCalls.length} registros totais`);

    // FILTRO: Filtrar apenas os registros onde data_inicio é igual a dataOntemAlvo
    // A Zenvia costuma retornar data_inicio como "YYYY-MM-DD HH:MM:SS"
    const registrosFiltrados = allCalls.filter(item => {
      return item.data_inicio && item.data_inicio.startsWith(dataOntemAlvo);
    });

    secureLog(`Após filtro: ${registrosFiltrados.length} registros de ontem`);

    if (registrosFiltrados.length === 0) {
      secureLog("Nenhum registro de ontem após filtragem");
      return;
    }

    // Mapeamento para o Google Sheets
    const rows = registrosFiltrados.map(item => {
      const fila_data_inicio = item.fila?.data_inicio || "";
      const ramal_numero = item.ramal?.numero || "";
      const atendida = item.atendida ? "Atendida" : "Não atendida";

      return [
        item.id || "",                          // ID (A)
        formatarParaBR(item.data_inicio),       // Data/Hora (B)
        formatarParaBR(item.data_inicio),       // Data/Hora Início Origem (C)
        formatarParaBR(fila_data_inicio),       // Data/Hora Fim Origem (D)
        formatarParaBR(fila_data_inicio),       // Data/Hora Início Destino (E)
        formatarParaBR(fila_data_inicio),       // Data/Hora Fim Destino (F)
        item.numero_origem || "",               // Origem (G)
        item.numero_destino || "",              // Destino (H)
        ramal_numero,                           // RAMAL (I)
        ramal_numero,                           // Agente Ramal (J)
        item.status || "",                      // Status (K)
        item.status || "",                      // Status Origem (L)
        item.status || "",                      // Status Destino (M)
        item.url_gravacao ? "Disponível" : "Não disponível", // Status Gravação (N)
        item.duracao || "0",                    // Duracao (min) (O)
        item.tempo_espera || "0",               // Espera (min) (P)
        item.tempo_espera || "0",               // Tempo Ring Origem (Q)
        item.tempo_espera || "0",               // Tempo Ring Destino (R)
        item.tempo_espera || "0",               // Tempo Espera Fila (S)
        atendida,                               // Motivo Desconexao Origem (T)
        atendida,                               // Motivo Desconexao Destino (U)
        item.ramal?.id || "",                   // Ramal ID Origem (X)
        item.id || "",                          // CDR ID Origem (Y)
        item.id || "",                          // CDR ID Destino (Z)
        item.fila?.id || "",                    // Fila ID (AA)
        item.url_gravacao || "",                // Gravação (AD)
        item.id || "",                          // Gravação ID (AE)
        item.ativa || "",                       // Ativa (AI)
      ];
    });

    const chunk_size = 5000;
    for (let i = 0; i < rows.length; i += chunk_size) {
      const chunk = rows.slice(i, i + chunk_size);
      secureLog(`Enviando bloco ${Math.floor(i/chunk_size) + 1} para o Sheets`);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A2`,
        valueInputOption: 'USER_ENTERED', 
        requestBody: { values: chunk },
      });
    }

    secureLog(`Processo finalizado: ${registrosFiltrados.length} linhas adicionadas de ${dataOntemAlvo}`);

  } catch (error) {
    secureLog("Erro no processo de sincronização", true);
    process.exit(1);
  }
}

runIntegration();
