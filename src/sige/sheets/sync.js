const GoogleSheets = require("../../google/sheets");
const formatPublicError = require("../../lib/public-error");
const {
  TIME_ZONE,
  addDays,
  isoDay,
  today: saoPauloToday,
} = require("../../lib/sao-paulo-date");
const { getSigePersonByCpfCnpj, listSigeOrdersForDay } = require("../api");

// ================================
// UTILITÁRIOS
// ================================

function secureLog(message, isError = false) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${isError ? "ERROR" : "INFO"}] ${message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const days = positiveIntegerOption(value, 5, "SIGE_SHEETS_DAYS");
  const today = saoPauloToday(now);
  return {
    days,
    startDate: addDays(today, -days),
    endDate: addDays(today, -1),
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

function resolveSigeWindow(env = process.env, now = new Date()) {
  const startValue = String(env.SIGE_SHEETS_START_DATE || "").trim();
  const endValue = String(env.SIGE_SHEETS_END_DATE || "").trim();
  const today = saoPauloToday(now);

  if (startValue || endValue) {
    if (!startValue || !endValue) {
      throw new Error(
        "SIGE_SHEETS_START_DATE e SIGE_SHEETS_END_DATE devem ser informadas juntas",
      );
    }
    const startDate = parseIsoDayOption(startValue, "SIGE_SHEETS_START_DATE");
    const endDate = parseIsoDayOption(endValue, "SIGE_SHEETS_END_DATE");
    if (startDate > endDate) throw new Error("Janela SIGE esta invertida");
    if (endDate >= today) {
      throw new Error("SIGE_SHEETS_END_DATE precisa ser anterior a hoje");
    }
    return {
      explicit: true,
      days: Math.round((endDate - startDate) / 86400000) + 1,
      startDate,
      endDate,
    };
  }

  return { explicit: false, ...completedDayWindow(env.SIGE_SHEETS_DAYS, now) };
}

function assertNonEmptyWindowReplacement({
  incomingCount,
  existingValues,
  startDate,
  endDate,
  allowEmpty,
}) {
  if (incomingCount > 0 || allowEmpty) return;
  const existingCount = (Array.isArray(existingValues) ? existingValues : [])
    .filter((row) => isFaturamentoRowInWindow(["", "", "", row?.[0]], startDate, endDate))
    .length;
  if (existingCount > 0) {
    throw new Error(
      `SIGE retornou zero registros para uma janela que possui ${existingCount} linhas; substituicao cancelada`,
    );
  }
}

function sigeBusinessDay(dataInput) {
  if (!dataInput) return null;
  const text = String(dataInput).trim();
  const naiveIso = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)$/,
  );
  if (naiveIso) {
    return `${naiveIso[1]}-${naiveIso[2]}-${naiveIso[3]}`;
  }

  const instant = dataInput instanceof Date ? dataInput : new Date(dataInput);
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

function formatarDataBR(dataInput) {
  const day = sigeBusinessDay(dataInput);
  if (!day) return "";
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year}`;
}

function formatarMesBR(dataInput) {
  const day = sigeBusinessDay(dataInput);
  if (!day) return "";
  const [year, month] = day.split("-");
  return `${month}/${year}`;
}

function dateToExcelSerial(dateStr) {
  if (!dateStr || typeof dateStr !== "string" || !dateStr.includes("/")) {
    return "";
  }

  const [d, m, y] = dateStr.split("/");

  const date = new Date(y, m - 1, d);

  if (isNaN(date)) return "";

  return Math.floor(
    25569 + (date.getTime() - date.getTimezoneOffset() * 60000) / 86400000,
  );
}

function parseSheetDate(value) {
  const text = String(value || "").split(" ")[0];
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    return new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1])));
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }
  return null;
}

function digitsToNumber(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Identificador numerico SIGE excede a precisao segura");
  }
  return number;
}

function normalizeContact(value) {
  return typeof value === "string"
    ? value.replace(/^['+]+/, "").trim()
    : "";
}

function contactByCpfFromRows(rows) {
  const contacts = new Map();
  for (const row of rows || []) {
    const cpf = String(row?.[10] || "").replace(/\D/g, "");
    const contact = normalizeContact(row?.[0]);
    if (cpf && contact && !contacts.has(cpf)) contacts.set(cpf, contact);
  }
  return contacts;
}

const DOCUMENT_COLUMN_INDEX = 9;
const FATURAMENTO_COLUMN_COUNT = 18;

function documentKey(row) {
  return String(row?.[DOCUMENT_COLUMN_INDEX] ?? "");
}

function isFaturamentoRowInWindow(row, startDate, endDate) {
  const date = parseSheetDate(row?.[3]);
  return Boolean(date && date >= startDate && date <= endDate);
}

function dedupeDocumentRowsKeepLast(rows) {
  const seen = new Set();
  const reversed = [];

  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const document = documentKey(row);
    if (!document || seen.has(document)) continue;
    seen.add(document);
    reversed.push(row);
  }

  return reversed.reverse();
}

function duplicateDocumentIndexes(documents) {
  const seen = new Set();
  const duplicates = [];

  for (let index = documents.length - 1; index >= 0; index--) {
    const document = String(documents[index] ?? "");
    if (!document) continue;
    if (seen.has(document)) duplicates.push(index);
    else seen.add(document);
  }

  return duplicates.sort((left, right) => left - right);
}

function contiguousBlocks(indexes) {
  const blocks = [];
  for (const index of indexes) {
    const last = blocks.at(-1);
    if (last && last.end === index) last.end = index + 1;
    else blocks.push({ start: index, end: index + 1 });
  }
  return blocks;
}

function documentDeleteRequests(sheetId, duplicateIndexes) {
  return contiguousBlocks(duplicateIndexes)
    .reverse()
    .map((block) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          // Data index zero is physical row 2; grid indexes are zero-based.
          startIndex: block.start + 1,
          endIndex: block.end + 1,
        },
      },
    }));
}

function normalizeFaturamentoSnapshot(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) =>
    Array.from({ length: FATURAMENTO_COLUMN_COUNT }, (_, columnIndex) => {
      const value = Array.isArray(row) ? row[columnIndex] : undefined;
      return value === undefined || value === null ? "" : value;
    }),
  );
}

function sameFaturamentoSnapshot(left, right) {
  return (
    left.length === right.length &&
    left.every((leftRow, rowIndex) =>
      leftRow.every((value, columnIndex) =>
        Object.is(value, right[rowIndex]?.[columnIndex]),
      ),
    )
  );
}

async function readFaturamentoSnapshot(sheets) {
  const [rows = []] = await sheets.getValuesBatch(["Faturamento!A2:R"], {
    valueRenderOption: "FORMULA",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  return normalizeFaturamentoSnapshot(rows);
}

async function cleanupGlobalDocumentDuplicates(sheets) {
  const initialRows = await readFaturamentoSnapshot(sheets);
  const duplicateIndexes = duplicateDocumentIndexes(
    initialRows.map(documentKey),
  );
  if (!duplicateIndexes.length) {
    return {
      previous: initialRows.length,
      removed: 0,
      final: initialRows.length,
      recoveredAmbiguousWrite: false,
    };
  }

  const sheetIds = await sheets.getSheetIdByTitle();
  const sheetId = sheetIds.Faturamento;
  if (sheetId === undefined) throw new Error("Aba nao encontrada: Faturamento");

  const preWriteRows = await readFaturamentoSnapshot(sheets);
  if (!sameFaturamentoSnapshot(initialRows, preWriteRows)) {
    throw new Error(
      "Aba Faturamento mudou antes da deduplicacao global; exclusao cancelada com seguranca",
    );
  }

  const duplicateSet = new Set(duplicateIndexes);
  const expectedRows = preWriteRows.filter(
    (_, index) => !duplicateSet.has(index),
  );
  const requests = documentDeleteRequests(sheetId, duplicateIndexes);
  let writeError;
  try {
    await sheets.batchUpdate(requests, { idempotent: false });
  } catch (error) {
    writeError = error;
  }

  let finalRows;
  try {
    finalRows = await readFaturamentoSnapshot(sheets);
  } catch (validationError) {
    if (writeError) throw writeError;
    throw validationError;
  }

  if (!sameFaturamentoSnapshot(finalRows, expectedRows)) {
    if (writeError) throw writeError;
    throw new Error("Validacao da deduplicacao global de Faturamento falhou");
  }

  return {
    previous: preWriteRows.length,
    removed: duplicateIndexes.length,
    final: finalRows.length,
    recoveredAmbiguousWrite: Boolean(writeError),
  };
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const FATURAMENTO_HEADER = [
  "Contato",
  "Código",
  "Status Venda",
  "Data",
  "Nome Cliente",
  "Telefone Cliente",
  "E-mail Cliente",
  "Valor Venda",
  "Local Técnico",
  "Nº Documento",
  "CPF/CNPJ Cliente",
  "Dia agendado novos serviços",
  "Colaborador",
  "Valor de venda do novo serviço",
  "Dia agendado retirada",
  "Responsável pela venda Retirada",
  "Valor de venda da retirada",
  "Mês",
].map(normalizeHeader);

function validateFaturamentoHeader(header) {
  if (!Array.isArray(header) || header.length !== FATURAMENTO_HEADER.length) {
    throw new Error("Cabecalho Faturamento invalido");
  }
  const normalized = header.map(normalizeHeader);
  const valid = normalized.every(
    (value, index) => value === FATURAMENTO_HEADER[index],
  );
  if (!valid) throw new Error("Ordem das colunas de Faturamento esta invalida");
}

// ================================
// EXECUÇÃO PRINCIPAL
// ================================

async function run() {
  try {
    const {
      GOOGLE_TOKEN,
      SIGE_SPREADSHEET_ID,
    } = process.env;
    const SPREADSHEET_ID = SIGE_SPREADSHEET_ID;

    const sheets = new GoogleSheets({
      spreadsheetId: SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const currentHeader = (await sheets.getValues("Faturamento!A1:R1"))[0];
    validateFaturamentoHeader(currentHeader);
    const existingFaturamentoRows = await sheets.getValues("Faturamento!A2:K");
    const contactByCpf = contactByCpfFromRows(existingFaturamentoRows);
    const personByCpf = new Map();

    // ================================
    // RANGE DE DATAS
    // ================================

    const window = resolveSigeWindow(process.env);
    const {
      days: reprocessDays,
      startDate: inicio,
      endDate: ontem,
    } = window;

    secureLog(
      `Reprocessando ${reprocessDays} dias concluidos: ${isoDay(inicio)} a ${isoDay(ontem)}.`,
    );

    // ================================
    // CARREGA ERP
    // ================================

    const erpRows = await sheets.getValues("ERP!A:AH");

    const COL = {
      CPF: 3,
      TIPO: 6,
      RESP: 15,
      DATA: 19,
    };
    const erpByCpf = new Map();
    for (let index = erpRows.length - 1; index >= 1; index--) {
      const row = erpRows[index];
      const cpf = String(row[COL.CPF] || "").replace(/\D/g, "");
      if (!cpf) continue;
      if (!erpByCpf.has(cpf)) erpByCpf.set(cpf, []);
      erpByCpf.get(cpf).push(row);
    }

    // ================================
    // PROCESSA DIAS
    // ================================

    let dataAtual = new Date(inicio);
    const collectedRows = [];

    while (dataAtual <= ontem) {
      const dataBusca = isoDay(dataAtual);

      secureLog(`Processando ${dataBusca}`);

      const pedidos = await listSigeOrdersForDay(dataBusca);

      if (pedidos.length === 0) {
        secureLog(`Nenhum pedido encontrado em ${dataBusca}`);

        dataAtual = addDays(dataAtual, 1);

        await sleep(3000);

        continue;
      }

      const rowsFinal = [];

      for (const p of pedidos) {
        if (p.Codigo === undefined || p.Codigo === null || p.Codigo === "") {
          throw new Error("SIGE retornou pedido sem Codigo");
        }
        const clienteCpf = p.ClienteCNPJ || "";

        const clienteCpfLimpo = clienteCpf.replace(/\D/g, "");
        let contato = contactByCpf.get(clienteCpfLimpo) || "";
        if (!contato && clienteCpfLimpo) {
          if (!personByCpf.has(clienteCpfLimpo)) {
            personByCpf.set(clienteCpfLimpo, getSigePersonByCpfCnpj(clienteCpfLimpo));
          }
          const pessoa = await personByCpf.get(clienteCpfLimpo);
          contato = normalizeContact(pessoa?.Celular || p.ClienteTelefone || "");
          if (contato) contactByCpf.set(clienteCpfLimpo, contato);
        }

        let serialNovo = "";
        let respNovo = "Sem vendedor";

        let serialRetirada = "";
        let respRetirada = "Sem vendedor";

        const dataVendaInput = p.DataFaturamento || p.Data;
        const dataVenda = new Date(dataVendaInput);
        if (Number.isNaN(dataVenda.getTime())) {
          throw new Error("SIGE retornou pedido com data de faturamento invalida");
        }

        const valorTotal = Number(p.ValorFinal || 0);

        // ================================
        // PROCURA NO ERP
        // ================================

        for (const r of erpByCpf.get(clienteCpfLimpo) || []) {
            const tipo = (r[COL.TIPO] || "").toLowerCase();

            const dataERPStr = r[COL.DATA];

            // NOVO
            if (tipo.includes("novo") && serialNovo === "") {
              serialNovo = dateToExcelSerial(dataERPStr);

              respNovo = r[COL.RESP] || "Sem vendedor";
            }

            // RETIRADA
            if (tipo.includes("retirada") && serialRetirada === "") {
              if (!dataERPStr || !dataERPStr.includes("/")) {
                continue;
              }

              const [d, m, y] = dataERPStr.split("/");

              const dataERP = new Date(y, m - 1, d);

              if (dataERP <= dataVenda) {
                serialRetirada = dateToExcelSerial(dataERPStr);

                respRetirada = r[COL.RESP] || "Sem vendedor";
              }
            }
            if (serialNovo !== "" && serialRetirada !== "") break;
        }

        const displayNovo = serialNovo !== "" ? serialNovo : 0;

        const displayRetirada =
          serialRetirada !== "" ? serialRetirada : 0;

        rowsFinal.push([
          contato,
          p.Codigo,
          p.StatusSistema || "",
          GoogleSheets.dateCell(formatarDataBR(dataVendaInput), {
            pattern: "dd/MM/yyyy",
          }),
          p.Cliente || "",
          "",
          p.ClienteEmail || "",
          valorTotal,
          p.Vendedor || "",
          `Pedido ${p.Codigo}`,
          digitsToNumber(clienteCpf),
          displayNovo,
          respNovo,
          serialRetirada !== "" ? valorTotal * 0.5 : valorTotal,
          displayRetirada,
          respRetirada,
          serialRetirada !== "" ? valorTotal * 0.5 : 0,
          GoogleSheets.monthCell(
            formatarMesBR(dataVendaInput),
            { pattern: "m/yyyy" },
          ),
        ]);
      }

      // ================================
      // APPEND
      // ================================

      collectedRows.push(...rowsFinal);
      secureLog(`${rowsFinal.length} registros adicionados (${dataBusca})`);

      dataAtual = addDays(dataAtual, 1);

      await sleep(4000);
    }

    // ================================
    // REMOVE DUPLICADOS
    // ================================

    const missingDocumentIndex = collectedRows.findIndex((row) => !documentKey(row));
    if (missingDocumentIndex !== -1) {
      throw new Error(
        `Registro SIGE sem documento na coluna J: collectedRows[${missingDocumentIndex}]`,
      );
    }
    const uniqueRows = dedupeDocumentRowsKeepLast(collectedRows);
    const latestHeader = (await sheets.getValues("Faturamento!A1:R1"))[0] || [];
    validateFaturamentoHeader(latestHeader);
    secureLog(
      `Deduplicacao SIGE na coleta: repetidos removidos=${collectedRows.length - uniqueRows.length}.`,
    );
    if (!uniqueRows.length) {
      const existingDates = await sheets.getValues("Faturamento!D2:D");
      assertNonEmptyWindowReplacement({
        incomingCount: 0,
        existingValues: existingDates,
        startDate: inicio,
        endDate: ontem,
        allowEmpty: booleanOption(
          process.env.SIGE_SHEETS_ALLOW_EMPTY_REPLACEMENT,
          false,
          "SIGE_SHEETS_ALLOW_EMPTY_REPLACEMENT",
        ),
      });
    }
    const result = await sheets.replaceRows({
      sheetTitle: "Faturamento",
      columnRange: "A:R",
      header: latestHeader,
      newRows: uniqueRows,
      matchColumnIndexes: [3],
      shouldReplace: (row) => isFaturamentoRowInWindow(row, inicio, ontem),
    });
    secureLog(
      `${result.removed} registros substituidos por ${result.inserted}.`,
    );

    if (window.explicit) {
      secureLog(
        "Deduplicacao SIGE global ignorada no backfill explicito para preservar linhas fora da janela.",
      );
    } else {
      const cleanup = await cleanupGlobalDocumentDuplicates(sheets);
      secureLog(
        `Deduplicacao SIGE global: ${cleanup.removed} linhas anteriores removidas${
          cleanup.recoveredAmbiguousWrite ? " apos validacao de resposta ambigua" : ""
        }.`,
      );
    }

    secureLog("Processo finalizado com sucesso.");
  } catch (err) {
    secureLog(`Erro critico: ${formatPublicError(err)}`, true);
    throw err;
  }
}

module.exports = run;
module.exports.validateFaturamentoHeader = validateFaturamentoHeader;
module.exports.digitsToNumber = digitsToNumber;
module.exports.dedupeDocumentRowsKeepLast = dedupeDocumentRowsKeepLast;
module.exports.cleanupGlobalDocumentDuplicates = cleanupGlobalDocumentDuplicates;
module.exports.documentDeleteRequests = documentDeleteRequests;
module.exports.duplicateDocumentIndexes = duplicateDocumentIndexes;
module.exports.isFaturamentoRowInWindow = isFaturamentoRowInWindow;
module.exports.completedDayWindow = completedDayWindow;
module.exports.resolveSigeWindow = resolveSigeWindow;
module.exports.assertNonEmptyWindowReplacement = assertNonEmptyWindowReplacement;
module.exports.formatarDataBR = formatarDataBR;
module.exports.formatarMesBR = formatarMesBR;
module.exports.contactByCpfFromRows = contactByCpfFromRows;

if (require.main === module) {
  run().catch(() => {
    process.exitCode = 1;
  });
}
