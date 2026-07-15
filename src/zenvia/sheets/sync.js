const axios = require("axios");
const GoogleSheets = require("../../google/sheets");
const { withHttpRetry } = require("../../lib/http-retry");
const { createIdPageTracker } = require("../../lib/page-progress");
const formatPublicError = require("../../lib/public-error");
const {
  TIME_ZONE,
  addDays,
  isoDay,
  today: saoPauloToday,
} = require("../../lib/sao-paulo-date");
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

function positiveIntegerOption(value, fallback, name) {
  const candidate = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return candidate;
}

function completedDayWindow(value, now = new Date()) {
  const days = positiveIntegerOption(value, 1, "ZENVIA_SHEETS_DAYS");
  const today = saoPauloToday(now);
  const startDate = addDays(today, -days);
  const endDate = addDays(today, -1);
  return {
    days,
    startDate,
    endDate,
    startDay: isoDay(startDate),
    endDay: isoDay(endDate),
    // A margem preserva a busca ampla historica para absorver diferencas de
    // fuso na API. Somente os dias completos abaixo entram na planilha.
    apiStartDay: isoDay(addDays(startDate, -1)),
    apiEndDay: isoDay(today),
  };
}

function parseIsoDayOption(value, name) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${name} precisa usar YYYY-MM-DD`);
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (isoDay(date) !== text) throw new Error(`${name} invalida`);
  return date;
}

function booleanOption(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "sim"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "não"].includes(normalized)) return false;
  throw new Error(`${name} precisa ser true ou false`);
}

function resolveZenviaWindow(env = process.env, now = new Date()) {
  const startValue = String(env.ZENVIA_SHEETS_START_DATE || "").trim();
  const endValue = String(env.ZENVIA_SHEETS_END_DATE || "").trim();
  const today = saoPauloToday(now);

  if (startValue || endValue) {
    if (!startValue || !endValue) {
      throw new Error(
        "ZENVIA_SHEETS_START_DATE e ZENVIA_SHEETS_END_DATE devem ser informadas juntas",
      );
    }
    const startDate = parseIsoDayOption(startValue, "ZENVIA_SHEETS_START_DATE");
    const endDate = parseIsoDayOption(endValue, "ZENVIA_SHEETS_END_DATE");
    if (startDate > endDate) throw new Error("Janela Zenvia esta invertida");
    if (endDate >= today) {
      throw new Error("ZENVIA_SHEETS_END_DATE precisa ser anterior a hoje");
    }
    return {
      explicit: true,
      days: Math.round((endDate - startDate) / 86400000) + 1,
      startDate,
      endDate,
      startDay: isoDay(startDate),
      endDay: isoDay(endDate),
      apiStartDay: isoDay(addDays(startDate, -1)),
      apiEndDay: isoDay(addDays(endDate, 1)),
    };
  }

  return {
    explicit: false,
    ...completedDayWindow(env.ZENVIA_SHEETS_DAYS, now),
  };
}

function sheetDay(value) {
  const text = String(value ?? "").trim().replace(/^'/, "");
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
  ) {
    const instant = new Date(text);
    if (Number.isNaN(instant.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\D|$)/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\D|$)/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function isDayInWindow(value, startDay, endDay) {
  const day = sheetDay(value);
  return Boolean(day && day >= startDay && day <= endDay);
}

function assertNonEmptyWindowReplacement({
  incomingCount,
  existingValues,
  startDay,
  endDay,
  allowEmpty,
}) {
  if (incomingCount > 0 || allowEmpty) return;
  const existingCount = (Array.isArray(existingValues) ? existingValues : [])
    .filter((row) => isDayInWindow(row?.[0], startDay, endDay)).length;
  if (existingCount > 0) {
    throw new Error(
      `Zenvia retornou zero registros para uma janela que possui ${existingCount} linhas; substituicao cancelada`,
    );
  }
}

const toSheetDateTime = (dataISO) => {
  if (!dataISO || dataISO === "null" || dataISO === "") return "";
  let displayValue;
  try {
    const data = new Date(dataISO);
    if (isNaN(data.getTime())) return dataISO;
    displayValue = data
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
  return GoogleSheets.dateTimeCell(displayValue);
};

function numericSheetValue(value, fallback = 0) {
  const candidate = value === null || value === undefined || value === ""
    ? fallback
    : value;
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate)) throw new Error("Numero Zenvia invalido");
    return candidate;
  }
  if (typeof candidate !== "string") return candidate;
  const text = candidate.trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) return candidate;
  const number = Number(text.replace(",", "."));
  if (!Number.isFinite(number)) throw new Error("Numero Zenvia invalido");
  if (!text.includes(".") && !text.includes(",") && !Number.isSafeInteger(number)) {
    throw new Error("Inteiro Zenvia excede a precisao segura");
  }
  return number;
}

function durationSheetValue(value) {
  const candidate = value === null || value === undefined || value === ""
    ? "00:00:00"
    : value;
  if (typeof candidate === "number") {
    if (!Number.isFinite(candidate)) throw new Error("Duracao Zenvia invalida");
    if (candidate === 0) {
      return GoogleSheets.timeCell("00:00:00", { pattern: "hh:mm:ss" });
    }
    return candidate;
  }

  const text = String(candidate).trim();
  const match = text.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (match) {
    const normalized = `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}`;
    return GoogleSheets.timeCell(normalized, { pattern: "hh:mm:ss" });
  }
  if (/^-?\d+(?:[.,]\d+)?$/.test(text)) {
    const number = numericSheetValue(text);
    return number === 0
      ? GoogleSheets.timeCell("00:00:00", { pattern: "hh:mm:ss" })
      : number;
  }
  throw new Error("Duracao Zenvia em formato inesperado");
}

async function runIntegration() {
  secureLog(`Iniciando sincronização com filtro`);
  try {
    validateEnvironment();
    const sheets = new GoogleSheets({
      spreadsheetId: SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const window = resolveZenviaWindow(process.env);
    secureLog(
      `Buscando intervalo amplo de ${window.apiStartDay} ate ${window.apiEndDay}`,
    );
    secureLog(
      `Sincronizando ${window.days} dias concluidos: ${window.startDay} a ${window.endDay}`,
    );

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
            data_inicio: window.apiStartDay,
            data_fim: window.apiEndDay,
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

    // A Zenvia costuma retornar data_inicio como "YYYY-MM-DD HH:MM:SS".
    // A filtragem local impede que a margem ampla altere dias fora da janela.
    const uniqueCalls = new Map();
    for (const item of allCalls) {
      if (item.id === undefined || item.id === null || item.id === "") {
        throw new Error("Zenvia retornou chamada sem ID");
      }
      uniqueCalls.set(String(item.id), item);
    }
    const registrosFiltrados = [...uniqueCalls.values()].filter((item) =>
      isDayInWindow(item.data_inicio, window.startDay, window.endDay),
    );

    secureLog(
      `Apos filtro: ${registrosFiltrados.length} registros nos dias concluidos`,
    );

    // Mapeamento para o Google Sheets
    const rows = registrosFiltrados.map((item) => {
      const fila_data_inicio = item.fila?.data_inicio || "";
      const ramal_numero = item.ramal?.numero || "";
      const atendida = item.atendida ? "Atendida" : "Não atendida";

      return [
        item.id || "", // ID (A)
        toSheetDateTime(item.data_inicio), // Data/Hora (B)
        toSheetDateTime(item.data_inicio), // Data/Hora Início Origem (C)
        toSheetDateTime(fila_data_inicio), // Data/Hora Fim Origem (D)
        toSheetDateTime(fila_data_inicio), // Data/Hora Início Destino (E)
        toSheetDateTime(fila_data_inicio), // Data/Hora Fim Destino (F)
        item.numero_origem ? numericSheetValue(item.numero_origem, "") : "", // Origem (G)
        item.numero_destino ? numericSheetValue(item.numero_destino, "") : "", // Destino (H)
        ramal_numero, // RAMAL (I)
        ramal_numero, // Agente Ramal (J)
        item.status || "", // Status (K)
        item.status || "", // Status Origem (L)
        item.status || "", // Status Destino (M)
        item.url_gravacao ? "Disponível" : "Não disponível", // Status Gravação (N)
        durationSheetValue(item.duracao), // Duracao (O)
        numericSheetValue(item.tempo_espera, 0), // Espera (min) (P)
        numericSheetValue(item.tempo_espera, 0), // Tempo Ring Origem (Q)
        numericSheetValue(item.tempo_espera, 0), // Tempo Ring Destino (R)
        numericSheetValue(item.tempo_espera, 0), // Tempo Espera Fila (S)
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

    if (!rows.length) {
      const escapedSheetName = SHEET_NAME.replace(/'/g, "''");
      const existingDates = await sheets.getValues(
        `'${escapedSheetName}'!B2:B`,
      );
      assertNonEmptyWindowReplacement({
        incomingCount: 0,
        existingValues: existingDates,
        startDay: window.startDay,
        endDay: window.endDay,
        allowEmpty: booleanOption(
          process.env.ZENVIA_SHEETS_ALLOW_EMPTY_REPLACEMENT,
          false,
          "ZENVIA_SHEETS_ALLOW_EMPTY_REPLACEMENT",
        ),
      });
    }

    const result = await sheets.replaceRows({
      sheetTitle: SHEET_NAME,
      columnRange: "A:AB",
      header: HEADERS,
      newRows: rows,
      matchColumnIndexes: [1],
      shouldReplace: (row) =>
        isDayInWindow(row[1], window.startDay, window.endDay),
    });

    secureLog(
      `Processo finalizado: ${result.removed} removidas e ${result.inserted} inseridas`,
    );
  } catch (error) {
    secureLog(`Erro no processo: ${formatPublicError(error)}`, true);
    throw error;
  }
}

runIntegration.toSheetDateTime = toSheetDateTime;
runIntegration.numericSheetValue = numericSheetValue;
runIntegration.durationSheetValue = durationSheetValue;
runIntegration.completedDayWindow = completedDayWindow;
runIntegration.resolveZenviaWindow = resolveZenviaWindow;
runIntegration.isDayInWindow = isDayInWindow;
runIntegration.assertNonEmptyWindowReplacement = assertNonEmptyWindowReplacement;
module.exports = runIntegration;

if (require.main === module) {
  runIntegration().catch(() => {
    process.exitCode = 1;
  });
}
