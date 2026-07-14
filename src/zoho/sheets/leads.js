const GoogleSheets = require("../../google/sheets");
const { createIdPageTracker } = require("../../lib/page-progress");
const formatPublicError = require("../../lib/public-error");
const createZohoClient = require("../api");
const { extractZohoRecords } = require("../response");
const { digitsToNumber, toDateTimeCell } = require("./value-types");

// Função para registrar eventos sem expor dados sensíveis
function secureLog(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logLevel = isError ? "ERROR" : "INFO";
  console.log(`[${timestamp}] [${logLevel}] ${message}`);
}

// Função para impedir Spreadsheet Formula Injection
// Processa campos complexos do Zoho (Lookups, Multi-select, etc)
function extractValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const extracted = value.display_value ?? value.ID;
    if (extracted === null || extracted === undefined || extracted === "") {
      return String(value);
    }
    return typeof extracted === "number" || typeof extracted === "boolean"
      ? extracted
      : String(extracted);
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "object" ? v.display_value || v : v))
      .join(", ");
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function applyLeadTypes(row) {
  const typed = [...row];
  typed[1] = digitsToNumber(typed[1]);
  typed[5] = digitsToNumber(typed[5]);
  typed[17] = toDateTimeCell(typed[17], {
    pattern: "dd-mm-yyyy hh:mm:ss",
  });
  typed[22] = toDateTimeCell(typed[22], {
    pattern: "dd/MM/yyyy HH:mm:ss",
  });
  return typed;
}

function dateInSaoPaulo(daysAgo) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

async function run() {
  const {
    ZOHO_CLIENT_ID,
    ZOHO_ACCOUNT_OWNER,
    ZOHO_LEADS_APP_NAME,
    ZOHO_LEADS_REPORT_NAME,
    ZOHO_LEADS_SPREADSHEET_ID,
    ZOHO_LEADS_SHEET_NAME,
    GOOGLE_TOKEN,
    ZOHO_LEADS_COLUMN_MAPPING,
  } = process.env;
  const SPREADSHEET_ID = ZOHO_LEADS_SPREADSHEET_ID;
  const SHEET_NAME = ZOHO_LEADS_SHEET_NAME;
  const ZOHO_APP_LINK_NAME = ZOHO_LEADS_APP_NAME;
  const ZOHO_REPORT_LINK_NAME = ZOHO_LEADS_REPORT_NAME;
  const COLUMN_MAPPING = ZOHO_LEADS_COLUMN_MAPPING;

  // Validação de variáveis essenciais
  if (
    !ZOHO_CLIENT_ID ||
    !GOOGLE_TOKEN ||
    !COLUMN_MAPPING ||
    !SPREADSHEET_ID ||
    !SHEET_NAME ||
    !ZOHO_ACCOUNT_OWNER ||
    !ZOHO_APP_LINK_NAME ||
    !ZOHO_REPORT_LINK_NAME
  ) {
    throw new Error("Variaveis obrigatorias do Zoho Leads ausentes");
  }

  const mapping = JSON.parse(COLUMN_MAPPING);
  const headers = Object.keys(mapping);
  const dateColumn = Object.values(mapping).findIndex((name) =>
    String(name).includes("Data_e_hora_de_inicio"),
  );
  if (dateColumn < 0) {
    throw new Error(
      "Coluna de data do formulário não encontrada no mapeamento",
    );
  }
  const sheets = new GoogleSheets({
    spreadsheetId: SPREADSHEET_ID,
    accessToken: GOOGLE_TOKEN,
  });

  try {
    secureLog("Iniciando autenticação Zoho");
    const zoho = await createZohoClient();
    secureLog("Autenticação Zoho realizada com sucesso");

    // Cálculo do "Dia de Ontem"
    // O Zoho espera o formato DD-Mon-YYYY (Ex: 19-Mar-2026)
    const mesesIngles = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const dataReferencia = dateInSaoPaulo(1);

    const dia = String(dataReferencia.getUTCDate()).padStart(2, "0");
    const mes = mesesIngles[dataReferencia.getUTCMonth()];
    const ano = dataReferencia.getUTCFullYear();

    const dataFiltro = `${dia}-${mes}-${ano}`;
    secureLog(`Filtrando registros de ontem (${dataFiltro})`);

    const allProcessed = [];
    let fromIndex = 1; // API do Zoho Creator v2 inicia em 1
    const limit = 200;
    let pages = 0;
    const pageTracker = createIdPageTracker({
      source: "Zoho leads Sheets",
      idOf: (record) => record?.ID,
    });
    const maxPages = Number(process.env.ZOHO_MAX_PAGES || 10000);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error("ZOHO_MAX_PAGES precisa ser inteiro >= 1");
    }

    // Loop de Captura de Dados com Critério de Data
    while (true) {
      if (++pages > maxPages) throw new Error("Zoho excedeu o limite seguro de paginas");
      const queryUrl = `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_APP_LINK_NAME}/report/${ZOHO_REPORT_LINK_NAME}`;

      // Critério: Pega registros onde a data de início é IGUAL ao dia de ontem
      // Usamos >= 00:00:00 e <= 23:59:59 para garantir o dia cheio
      const criteria = `(Data_e_hora_de_inicio_do_formul_rio >= "${dataFiltro} 00:00:00" && Data_e_hora_de_inicio_do_formul_rio <= "${dataFiltro} 23:59:59")`;

      secureLog(`Buscando registros: índice ${fromIndex}`);

      try {
        const resp = await zoho.get(queryUrl, {
          params: { from: fromIndex, limit: limit, criteria: criteria },
        });

        const data = extractZohoRecords(resp, "leads Sheets");
        if (data.length === 0) break;
        pageTracker.observe(data);

        data.forEach((record) => {
          // Mapeia os campos conforme o JSON configurado no COLUMN_MAPPING
          const row = Object.values(mapping).map((zohoKey) =>
            extractValue(record[zohoKey]),
          );
          allProcessed.push(applyLeadTypes(row));
        });

        if (data.length < limit) break; // Se veio menos que o limite, acabou a base
        fromIndex += limit;
      } catch (err) {
        if (Number(err.providerCode) === 3100) {
          secureLog("Fim dos registros alcançado");
          break;
        }
        throw err;
      }
    }

    const dataBR = `${dia}/${String(dataReferencia.getUTCMonth() + 1).padStart(2, "0")}/${ano}`;
    const dataDash = `${dia}-${String(dataReferencia.getUTCMonth() + 1).padStart(2, "0")}-${ano}`;
    const result = await sheets.replaceRows({
      sheetTitle: SHEET_NAME,
      columnRange: "A:AC",
      header: headers,
      newRows: allProcessed,
      matchColumnIndexes: [dateColumn],
      shouldReplace: (row) => {
        const value = String(row[dateColumn] || "");
        return (
          value.startsWith(dataBR) ||
          value.startsWith(dataDash) ||
          value.startsWith(dataFiltro)
        );
      },
    });
    secureLog(
      `Processo concluído: ${result.removed} removidas e ${result.inserted} inseridas`,
    );
  } catch (e) {
    secureLog(`Falha no processo: ${formatPublicError(e)}`, true);
    throw e;
  }
}

run.applyLeadTypes = applyLeadTypes;
run.extractValue = extractValue;
module.exports = run;

if (require.main === module) {
  run().catch(() => {
    process.exitCode = 1;
  });
}
