const GoogleSheets = require("../../google/sheets");
const { createIdPageTracker } = require("../../lib/page-progress");
const formatPublicError = require("../../lib/public-error");
const createZohoClient = require("../api");
const { extractZohoRecords } = require("../response");
const {
  digitsToNumber,
  toDateCell,
  toDateTimeCell,
  toMonthCell,
  toTimeCell,
} = require("./value-types");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function secureLog(message, isError = false) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${isError ? "ERROR" : "INFO"}] ${message}`);
}

function formatZohoValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "object" ? item.display_value || item.ID || "" : item,
    ).join(", ");
  }
  if (typeof value === "object") {
    return String(value.display_value || value.ID || "");
  }
  return String(value);
}

function todayInSaoPaulo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function formatZohoDate(date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function parseSheetDate(value) {
  const text = String(value || "").replace(/^'/, "").split(" ")[0];
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  match = text.match(/^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/);
  if (match) {
    const month = MONTHS.indexOf(match[2]);
    if (month >= 0) return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }
  match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (match) {
    const month = MONTHS.indexOf(match[2]);
    if (month >= 0) return new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  }
  return null;
}

function applySchedulingTypes(row) {
  if (!Array.isArray(row) || row.length !== 34) {
    throw new Error("Zoho Scheduling gerou linha com largura diferente de 34");
  }
  const typed = [...row];
  typed[0] = digitsToNumber(typed[0]);
  typed[3] = GoogleSheets.textCell(typed[3]);
  typed[4] = toDateTimeCell(typed[4], { pattern: "dd-mm-yyyy hh:mm" });
  typed[5] = toDateTimeCell(typed[5], { pattern: "dd-mm-yyyy hh:mm" });
  typed[12] = toDateTimeCell(typed[12], { pattern: "dd/MM/yyyy HH:mm:ss" });
  typed[16] = GoogleSheets.textCell(typed[16]);
  typed[17] = toDateCell(typed[17], { pattern: "dd/MM/yyyy" });
  typed[18] = toTimeCell(typed[18], { pattern: "HH:mm:ss" });
  typed[19] = toDateCell(typed[19], { pattern: "dd/MM/yyyy" });
  typed[20] = toTimeCell(typed[20], { pattern: "HH:mm:ss" });
  typed[33] = toMonthCell(typed[33], { pattern: "mm/yyyy" });
  return typed;
}

async function run() {
  try {
    const {
      ZOHO_ACCOUNT_OWNER,
      ZOHO_APP_NAME,
      ZOHO_REPORT_NAME,
      REPORT_SPREADSHEET_ID,
      REPORT_SHEET_NAME,
      GOOGLE_TOKEN,
      REPORT_COLUMN_MAPPING,
    } = process.env;
    if (
      !ZOHO_ACCOUNT_OWNER ||
      !ZOHO_APP_NAME ||
      !ZOHO_REPORT_NAME ||
      !REPORT_SPREADSHEET_ID ||
      !REPORT_SHEET_NAME ||
      !GOOGLE_TOKEN ||
      !REPORT_COLUMN_MAPPING
    ) {
      throw new Error("Variaveis obrigatorias do Zoho Scheduling Sheets ausentes");
    }

    const mapping = JSON.parse(REPORT_COLUMN_MAPPING);
    if (!Array.isArray(mapping) || mapping.length !== 15) {
      throw new Error("REPORT_COLUMN_MAPPING precisa ter exatamente 15 campos");
    }

    const sheets = new GoogleSheets({
      spreadsheetId: REPORT_SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const currentHeader = (await sheets.getValues(`'${REPORT_SHEET_NAME}'!A1:AH1`))[0];
    if (!currentHeader || currentHeader.length !== 34) {
      throw new Error("Cabecalho do Zoho Scheduling precisa ter 34 colunas (A:AH)");
    }

    const today = todayInSaoPaulo();
    const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const criteria =
      `(Data_e_hora_de_inicio_do_formulario >= "${formatZohoDate(startDate)} 00:00:00" && ` +
      `Data_e_hora_de_inicio_do_formulario <= "${formatZohoDate(today)} 23:59:59")`;

    const zoho = await createZohoClient();
    const zohoRecords = [];
    let fromIndex = 1;
    let pages = 0;
    const pageTracker = createIdPageTracker({
      source: "Zoho agendamentos Sheets",
      idOf: (record) => record?.ID,
    });
    const maxPages = Number(process.env.ZOHO_MAX_PAGES || 10000);
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error("ZOHO_MAX_PAGES precisa ser inteiro >= 1");
    }

    while (true) {
      if (++pages > maxPages) throw new Error("Zoho excedeu o limite seguro de paginas");
      let response;
      try {
        response = await zoho.get(
          `https://creator.zoho.com/api/v2/${ZOHO_ACCOUNT_OWNER}/${ZOHO_APP_NAME}/report/${ZOHO_REPORT_NAME}`,
          { params: { from: fromIndex, limit: 200, criteria } },
        );
      } catch (error) {
        if (Number(error.providerCode) === 3100) break;
        throw error;
      }
      const data = extractZohoRecords(response, "agendamentos Sheets");
      if (!data.length) break;
      pageTracker.observe(data);
      zohoRecords.push(...data);
      if (data.length < 200) break;
      fromIndex += 200;
    }

    const dictionaryRows = await sheets.getValues("'Dicionário'!A:B");
    const dictionary = Object.fromEntries(
      dictionaryRows.slice(1).filter((row) => row[0]).map((row) => [row[0], row[1] || ""]),
    );
    const countMap = {};
    for (const record of zohoRecords) {
      const valueM = formatZohoValue(record[mapping[12]]);
      const dayM = valueM.split(" ")[0] || "";
      const key = `${formatZohoValue(record[mapping[2]])}|${dayM}`;
      countMap[key] = (countMap[key] || 0) + 1;
    }

    const finalData = zohoRecords.map((record) => {
      const row = mapping.map((field) => formatZohoValue(record[field]));
      let [A, B, C, D, E, F, G, , , , , , M, N, O] = row;
      if (A.startsWith("+")) A = A.slice(1);
      if (F && F.includes(":") && !F.includes("-") && !F.includes("/")) {
        const datePart = (E || "").split(" ")[0];
        if (datePart) F = `${datePart} ${F}`;
      }

      const dayM = (M || "").split(" ")[0] || "";
      const dayE = (E || "").split(" ")[0] || "";
      const columnR = dayM.split("-").join("/");
      const columnT = dayE.split("-").join("/");
      const typedColumnT = toDateCell(dayE);
      const serialT = typedColumnT === "" ? "" : Math.floor(Number(typedColumnT));

      row[0] = A;
      row[3] = D;
      row[5] = F;
      return applySchedulingTypes([
        ...row,
        dictionary[N] || "",
        `${serialT}${D}`,
        columnR,
        (M || "").split(" ")[1] || "",
        columnT,
        (E || "").split(" ")[1] || "",
        G === "Novo serviço" ? 1 : 0,
        G === "Avaliação Store" ? 1 : 0,
        G === "Retirada" ? 1 : 0,
        G === "Garantia" ? 1 : 0,
        countMap[`${C}|${dayM}`] === 1 ? 1 : 0,
        1,
        B === "Cliente realizou o serviço" ? 1 : 0,
        O === "Cliente reagendou" ? 0 : 1,
        B === "Cliente faltou" ? 1 : 0,
        B === "Cliente cancelou o serviço" && O !== "Cliente reagendou" ? 1 : 0,
        B === "Cliente realizou o serviço" ? 1 : 0,
        0,
        columnR.includes("/") ? `${columnR.split("/")[1]}/${columnR.split("/")[2]}` : "",
      ]);
    });
    if (finalData.some((row) => row.length !== 34)) {
      throw new Error("Zoho Scheduling gerou linha com largura diferente de 34");
    }

    const result = await sheets.replaceRows({
      sheetTitle: REPORT_SHEET_NAME,
      columnRange: "A:AH",
      header: currentHeader,
      newRows: finalData,
      matchColumnIndexes: [17],
      shouldReplace: (row) => {
        const date = parseSheetDate(row[17]);
        return date && date >= startDate && date <= today;
      },
    });
    secureLog(`Sincronizacao concluida: removidas=${result.removed}; inseridas=${result.inserted}`);
  } catch (error) {
    secureLog(`Falha na sincronizacao: ${formatPublicError(error)}`, true);
    throw error;
  }
}

run.applySchedulingTypes = applySchedulingTypes;
module.exports = run;

if (require.main === module) {
  run().catch(() => {
    process.exitCode = 1;
  });
}
