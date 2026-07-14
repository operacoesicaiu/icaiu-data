const axios = require("axios");
const GoogleSheets = require("../../google/sheets");
const { withHttpRetry } = require("../../lib/http-retry");
const { createIdPageTracker } = require("../../lib/page-progress");
const formatPublicError = require("../../lib/public-error");
const { extractZenviaList } = require("../response");

const HEADERS = [
  "ID",
  "Data/Hora",
  "Data/Hora Início Origem",
  "Data/Hora Fim Origem",
  "Data/Hora Início Destino",
  "Data/Hora Fim Destino",
  "Origem",
  "Destino",
  "RAMAL",
  "Agente Ramal",
  "Status",
  "Status Origem",
  "Status Destino",
  "Status Gravação",
  "Duracao",
  "Espera",
  "Tempo Ring Origem",
  "Tempo Ring Destino",
  "Tempo Espera Fila",
  "Motivo Desconexao Origem",
  "Motivo Desconexao Destino",
  "Ramal ID Origem",
  "CDR ID Origem",
  "CDR ID Destino",
  "Fila ID",
  "Gravação",
  "Gravação ID",
  "Ativa",
];

const {
  GOOGLE_TOKEN,
  ZENVIA_ACCESS_TOKEN,
  ZENVIA_QUEUE_ID,
  ZENVIA_SPREADSHEET_ID,
  ZENVIA_SHEET_NAME,
} = process.env;
const SPREADSHEET_ID = ZENVIA_SPREADSHEET_ID;
const SHEET_NAME = ZENVIA_SHEET_NAME;

// Função para registrar eventos sem expor dados sensíveis
function secureLog(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logLevel = isError ? "ERROR" : "INFO";
  console.log(`[${timestamp}] [${logLevel}] ${message}`);
}

function validateEnvironment() {
  if (!GOOGLE_TOKEN || GOOGLE_TOKEN === "undefined") {
    throw new Error("GOOGLE_TOKEN nao definido");
  }
  if (!ZENVIA_ACCESS_TOKEN) {
    throw new Error("ZENVIA_ACCESS_TOKEN nao definido");
  }
  if (!SPREADSHEET_ID || !SHEET_NAME) {
    throw new Error("Destino Google Sheets da Zenvia ausente");
  }
}

const formatarParaBR = (dataISO) => {
  if (!dataISO || dataISO === "null" || dataISO === "") return "";
  try {
    const data = new Date(dataISO);
    if (isNaN(data.getTime())) return dataISO;
    return data
      .toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(",", "");
  } catch (e) {
    return dataISO;
  }
};

async function runIntegration() {
  secureLog(`Iniciando sincronização com filtro`);
  try {
    validateEnvironment();
    const sheets = new GoogleSheets({
      spreadsheetId: SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    // Definir o que é "ONTEM" no fuso de Brasília para o filtro
    const agoraBR = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }),
    );
    const ontemBR = new Date(agoraBR);
    ontemBR.setDate(agoraBR.getDate() - 1);

    const dataOntemAlvo = ontemBR.toISOString().split("T")[0]; // Ex: "2026-03-19"

    // Definir busca ampla (D-2 até hoje) para a API
    const dataInicioBusca = new Date(agoraBR);
    dataInicioBusca.setDate(agoraBR.getDate() - 2);

    const dsInicio = dataInicioBusca.toISOString().split("T")[0];
    const dsFim = agoraBR.toISOString().split("T")[0];

    secureLog(`Buscando intervalo amplo de ${dsInicio} até ${dsFim}`);
    secureLog(`Filtrando apenas registros do dia ${dataOntemAlvo}`);

    const allCalls = [];
    let posicao = 0;
    const limite = 200;
    const pageTracker = createIdPageTracker({
      source: "Zenvia chamadas Sheets",
      idOf: (item) => item?.id,
    });

    while (true) {
      const endpoint = ZENVIA_QUEUE_ID
        ? `https://voice-api.zenvia.com/fila/${ZENVIA_QUEUE_ID}/relatorio`
        : `https://voice-api.zenvia.com/chamada/relatorio`;

      secureLog(`Requisitando posição: ${posicao}`);

      const response = await withHttpRetry(() => axios.get(endpoint, {
          params: {
            data_inicio: dsInicio,
            data_fim: dsFim,
            posicao: posicao,
            limite: limite,
          },
          timeout: 60000,
          headers: {
            "Access-Token": ZENVIA_ACCESS_TOKEN,
            "Content-Type": "application/json",
          },
        }), { maxAttempts: 5, baseMs: 1500 });

      const calls = extractZenviaList(response, "relatorio", "chamadas Sheets");
      if (calls.length === 0) break;

      pageTracker.observe(calls);
      allCalls.push(...calls);
      if (calls.length < limite) break;
      posicao += limite;

      if (posicao > 50000) throw new Error("Zenvia excedeu o limite seguro de paginacao");
    }

    secureLog(`Capturados da API: ${allCalls.length} registros totais`);

    // FILTRO: Filtrar apenas os registros onde data_inicio é igual a dataOntemAlvo
    // A Zenvia costuma retornar data_inicio como "YYYY-MM-DD HH:MM:SS"
    const uniqueCalls = new Map();
    for (const item of allCalls) {
      if (item.id === undefined || item.id === null || item.id === "") {
        throw new Error("Zenvia retornou chamada sem ID");
      }
      uniqueCalls.set(String(item.id), item);
    }
    const registrosFiltrados = [...uniqueCalls.values()].filter(
      (item) => item.data_inicio && item.data_inicio.startsWith(dataOntemAlvo),
    );

    secureLog(`Após filtro: ${registrosFiltrados.length} registros de ontem`);

    // Mapeamento para o Google Sheets
    const rows = registrosFiltrados.map((item) => {
      const fila_data_inicio = item.fila?.data_inicio || "";
      const ramal_numero = item.ramal?.numero || "";
      const atendida = item.atendida ? "Atendida" : "Não atendida";

      return [
        item.id || "", // ID (A)
        formatarParaBR(item.data_inicio), // Data/Hora (B)
        formatarParaBR(item.data_inicio), // Data/Hora Início Origem (C)
        formatarParaBR(fila_data_inicio), // Data/Hora Fim Origem (D)
        formatarParaBR(fila_data_inicio), // Data/Hora Início Destino (E)
        formatarParaBR(fila_data_inicio), // Data/Hora Fim Destino (F)
        item.numero_origem || "", // Origem (G)
        item.numero_destino || "", // Destino (H)
        ramal_numero, // RAMAL (I)
        ramal_numero, // Agente Ramal (J)
        item.status || "", // Status (K)
        item.status || "", // Status Origem (L)
        item.status || "", // Status Destino (M)
        item.url_gravacao ? "Disponível" : "Não disponível", // Status Gravação (N)
        item.duracao || "0", // Duracao (min) (O)
        item.tempo_espera || "0", // Espera (min) (P)
        item.tempo_espera || "0", // Tempo Ring Origem (Q)
        item.tempo_espera || "0", // Tempo Ring Destino (R)
        item.tempo_espera || "0", // Tempo Espera Fila (S)
        atendida, // Motivo Desconexao Origem (T)
        atendida, // Motivo Desconexao Destino (U)
        item.ramal?.id || "", // Ramal ID Origem (X)
        item.id || "", // CDR ID Origem (Y)
        item.id || "", // CDR ID Destino (Z)
        item.fila?.id || "", // Fila ID (AA)
        item.url_gravacao || "", // Gravação (AD)
        item.id || "", // Gravação ID (AE)
        item.ativa || "", // Ativa (AI)
      ];
    });

    const dataOntemBR = `${String(ontemBR.getDate()).padStart(2, "0")}/${String(ontemBR.getMonth() + 1).padStart(2, "0")}/${ontemBR.getFullYear()}`;
    const result = await sheets.replaceRows({
      sheetTitle: SHEET_NAME,
      columnRange: "A:AB",
      header: HEADERS,
      newRows: rows,
      matchColumnIndexes: [1],
      shouldReplace: (row) => String(row[1] || "").startsWith(dataOntemBR),
    });

    secureLog(
      `Processo finalizado: ${result.removed} removidas e ${result.inserted} inseridas`,
    );
  } catch (error) {
    secureLog(`Erro no processo: ${formatPublicError(error)}`, true);
    throw error;
  }
}

module.exports = runIntegration;

if (require.main === module) {
  runIntegration().catch(() => {
    process.exitCode = 1;
  });
}
