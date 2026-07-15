const GoogleSheets = require("../../google/sheets");
const { backoffMs, sleep } = require("../../lib/http-retry");
const formatPublicError = require("../../lib/public-error");
const getHabllaClient = require("../api");
const collectHabllaCards = require("../card-collector");
const {
  CARD_HEADERS,
  buildCardSheet,
  normalizePhoneValue,
  stripLeadingApostrophes,
} = require("../card-sheet-schema");
const {
  extractAttendants,
  extractClients,
} = require("../response-contracts");
const saoPauloDayRange = require("../date-range");

const ATTENDANT_HEADERS = [
  "Data",
  "Workspace ID",
  "Setor ID",
  "Setor",
  "Usuário ID",
  "Atendente",
  "E-mail",
  "Total de atendimentos",
  "TME",
  "TMA",
  "Conexão ID",
  "Conexão",
  "Tipo de conexão",
  "Total CSAT",
  "CSAT maior que 4",
  "CSAT",
  "Total FCR",
];

const CLIENT_HEADERS = [
  "id",
  "name",
  "Telefone Principal",
  "WhatsApp",
  "Emails",
  "created_at",
  "updated_at",
  "Setores",
  "Tags",
  "Cliente Loja do Sapo",
  "Bairro",
  "CEP",
  "CPF",
  "Telefone extra de contato",
  "Avaliação Negativa",
  "Outros Campos",
  "Usuários Relacionados",
];

const CLIENT_CUSTOM_FIELD_IDS = [
  "6887db7cc2a3a46cebf75ea7",
  "67e6d711eb31b8892b75849a",
  "67e6d70ae8d3a28c98616065",
  "67ec621f8deaf73871b405d5",
  "67e6d5b88d506fc6c09408f9",
  "67af906d0b7fbf296df82ea4",
];

function positiveInteger(value, fallback, name) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return number;
}

function booleanOption(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "sim"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "não"].includes(normalized)) return false;
  throw new Error(`${name} precisa ser true ou false`);
}

function selectedDatasets(value) {
  const allowed = new Set(["cards", "attendants", "clients"]);
  const selected = String(value || "cards,attendants,clients")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!selected.length || selected.some((item) => !allowed.has(item))) {
    throw new Error(
      "HABLLA_SHEETS_DATASETS aceita cards, attendants e clients",
    );
  }
  return new Set(selected);
}

function columnLetter(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Indice de coluna invalido");
  }
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function completedDayRanges(days) {
  const safeDays = positiveInteger(
    days,
    1,
    "Quantidade de dias concluidos do Hablla Sheets",
  );
  return Array.from({ length: safeDays }, (_, index) =>
    saoPauloDayRange(safeDays - index),
  );
}

function parseBrazilianDateKey(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function shouldReplaceCardRow(
  row,
  cardIds,
  cutoffDay,
  { preserveUnfetched = false } = {},
) {
  const createdDay = parseBrazilianDateKey(row[1]);
  return (
    cardIds.has(String(row[14] || "")) ||
    (!preserveUnfetched && Boolean(createdDay && createdDay >= cutoffDay))
  );
}

function mergeCardSnapshots(cardsById, cards) {
  for (const card of cards) {
    const id = String(card.id || "");
    if (!id) throw new Error("Hablla retornou card sem id ao consolidar coletas");
    const updatedAt = new Date(card.updated_at).getTime();
    if (!Number.isFinite(updatedAt)) {
      throw new Error("Hablla retornou updated_at invalido ao consolidar coletas");
    }
    const current = cardsById.get(id);
    if (!current || updatedAt >= current.updatedAt) {
      cardsById.set(id, { card, updatedAt });
    }
  }
}

async function collectCardSnapshots({
  hablla,
  workspaceId,
  boardId,
  cutoff,
  exhaustive,
  passes,
  attempts,
  collect = collectHabllaCards,
  wait = sleep,
}) {
  const cardsById = new Map();
  for (let pass = 1; pass <= passes; pass += 1) {
    let cards;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        console.log(`>>> Coleta de cards ${pass}/${passes}, tentativa ${attempt}/${attempts}...`);
        cards = await collect({
          hablla,
          workspaceId,
          boardId,
          cutoff,
          exhaustive,
        });
        break;
      } catch (error) {
        if (attempt === attempts) throw error;
        const waitMs = backoffMs(attempt - 1, {
          baseMs: 5000,
          maxMs: 30000,
        });
        console.log(
          `>>> Coleta inconsistente; reiniciando em ${Math.ceil(waitMs / 1000)}s.`,
        );
        await wait(waitMs);
      }
    }
    mergeCardSnapshots(cardsById, cards);
    console.log(
      `>>> Coleta ${pass}/${passes} concluida; ${cardsById.size} cards unicos consolidados.`,
    );
  }
  return [...cardsById.values()].map(({ card }) => card);
}

function uniqueAttendantRows(rows) {
  const value = (row, index) => String(row[index] || "").trim();
  const byKey = new Map();
  for (const row of rows) {
    const sector = value(row, 2) || value(row, 3);
    const user = value(row, 4) || value(row, 6) || value(row, 5);
    const connection = value(row, 10) || `${value(row, 11)}|${value(row, 12)}`;
    const hasStableKey = sector && user && connection !== "|";
    const key = hasStableKey
      ? JSON.stringify([value(row, 0), sector, user, connection])
      : `row:${JSON.stringify(row)}`;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function assertEmptyAttendantDaysAreSafe(emptyLabels, existingValues) {
  const existingLabels = new Set(
    (Array.isArray(existingValues) ? existingValues : []).map((row) =>
      String(row?.[0] || "").split(" ")[0],
    ),
  );
  const protectedLabels = emptyLabels.filter((label) =>
    existingLabels.has(label),
  );
  if (protectedLabels.length) {
    throw new Error(
      `Hablla retornou zero atendentes em ${protectedLabels.length} dias que ja possuem linhas; substituicao cancelada`,
    );
  }
}

function formatBrazilianDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
    .replace(",", "");
}

function assertRowWidth(rows, width, dataset) {
  const invalidIndex = rows.findIndex((row) => row.length !== width);
  if (invalidIndex !== -1) {
    throw new Error(
      `${dataset} gerou largura ${rows[invalidIndex].length}; esperado ${width}`,
    );
  }
}

async function fetchClients(hablla, workspaceId, range) {
  const maxPages = positiveInteger(
    process.env.HABLLA_CLIENTS_MAX_PAGES,
    150,
    "HABLLA_CLIENTS_MAX_PAGES",
  );
  const clientsById = new Map();
  const pageFingerprints = new Set();
  let completed = false;

  for (let page = 1; page <= maxPages; page++) {
    const response = await hablla.get(
      `/v1/workspaces/${workspaceId}/persons`,
      {
        params: {
          start_date: range.start,
          end_date: range.end,
          page,
          limit: 50,
          field_date: "created_at",
          populate: true,
        },
      },
    );
    const clients = extractClients(response.data);
    if (!clients.length) {
      completed = true;
      break;
    }

    const fingerprint = `${clients.length}:${clients[0]?.id || ""}:${clients.at(-1)?.id || ""}`;
    if (pageFingerprints.has(fingerprint)) {
      throw new Error("Hablla repetiu uma pagina de clients");
    }
    pageFingerprints.add(fingerprint);

    for (const client of clients) {
      if (!client.id) throw new Error("Hablla retornou client sem id");
      const id = String(client.id);
      const current = clientsById.get(id);
      const updatedAt = new Date(client.updated_at || client.created_at).getTime();
      const currentUpdatedAt = current
        ? new Date(current.updated_at || current.created_at).getTime()
        : Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(updatedAt)) {
        throw new Error("Hablla retornou client sem data valida");
      }
      if (!current || updatedAt >= currentUpdatedAt) {
        clientsById.set(id, client);
      }
    }

    if (clients.length < 50) {
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new Error(
      `Hablla atingiu o limite seguro de ${maxPages} paginas de clients`,
    );
  }
  return [...clientsById.values()];
}

function formatCustomFieldValue(value) {
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (value && typeof value === "object") return JSON.stringify(value);
  return value ?? "";
}

function clientRow(person) {
  const primaryPhone = Array.isArray(person.phones) ? person.phones[0] : null;
  const emails = Array.isArray(person.emails)
    ? person.emails
        .map((email) =>
          typeof email === "string" ? email : email?.email || "",
        )
        .filter(Boolean)
        .join("; ")
    : "";
  const sectors = Array.isArray(person.sectors)
    ? person.sectors.join("; ")
    : "";
  const tags = Array.isArray(person.tags)
    ? person.tags
        .map((tag) => (typeof tag === "string" ? tag : tag?.name || ""))
        .filter(Boolean)
        .join("; ")
    : "";
  const users = Array.isArray(person.users) ? person.users.join("; ") : "";
  const customFields = {};
  const otherFields = [];

  for (const field of person.custom_fields || []) {
    if (!field.custom_field) continue;
    const value = formatCustomFieldValue(field.value);
    if (CLIENT_CUSTOM_FIELD_IDS.includes(field.custom_field)) {
      customFields[field.custom_field] = value;
    } else {
      otherFields.push(`${field.custom_field}: ${value}`);
    }
  }

  const knownFields = new Set([
    "name",
    "emails",
    "phones",
    "sectors",
    "tags",
    "custom_fields",
    "users",
    "id",
    "created_at",
    "updated_at",
    "workspace",
    "duplicate_keys",
    "instagrams",
    "facebooks",
    "followers",
    "sla_config_id",
    "workspace_id",
  ]);
  for (const [key, value] of Object.entries(person)) {
    if (knownFields.has(key) || value === null || value === undefined) continue;
    otherFields.push(
      `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`,
    );
  }

  const row = [
    person.id,
    person.name || "",
    normalizePhoneValue(primaryPhone?.phone || ""),
    primaryPhone?.is_whatsapp ? "Sim" : "",
    emails,
    GoogleSheets.dateTimeCell(formatBrazilianDateTime(person.created_at), {
      pattern: "dd/MM/yyyy HH:mm:ss",
    }),
    GoogleSheets.dateTimeCell(formatBrazilianDateTime(person.updated_at), {
      pattern: "dd/MM/yyyy HH:mm:ss",
    }),
    sectors,
    tags,
    customFields[CLIENT_CUSTOM_FIELD_IDS[0]] || "",
    customFields[CLIENT_CUSTOM_FIELD_IDS[1]] || "",
    customFields[CLIENT_CUSTOM_FIELD_IDS[2]] || "",
    customFields[CLIENT_CUSTOM_FIELD_IDS[3]] || "",
    normalizePhoneValue(customFields[CLIENT_CUSTOM_FIELD_IDS[4]] || ""),
    customFields[CLIENT_CUSTOM_FIELD_IDS[5]] || "",
    otherFields.join("; "),
    users,
  ];
  return row.map((value, index) =>
    index === 5 || index === 6 ? value : stripLeadingApostrophes(value),
  );
}

async function run() {
  try {
    const {
      GOOGLE_TOKEN,
      HABLLA_WORKSPACE_ID,
      HABLLA_BOARD_ID,
      HABLLA_SPREADSHEET_ID,
    } = process.env;
    const datasets = selectedDatasets(process.env.HABLLA_SHEETS_DATASETS);
    const allowEmpty = booleanOption(
      process.env.HABLLA_SHEETS_ALLOW_EMPTY_REPLACEMENT,
      false,
      "HABLLA_SHEETS_ALLOW_EMPTY_REPLACEMENT",
    );

    if (!GOOGLE_TOKEN) throw new Error("GOOGLE_TOKEN ausente");
    if (!HABLLA_WORKSPACE_ID) throw new Error("HABLLA_WORKSPACE_ID ausente");
    if (datasets.has("cards") && !HABLLA_BOARD_ID) {
      throw new Error("HABLLA_BOARD_ID ausente");
    }
    if (!HABLLA_SPREADSHEET_ID) {
      throw new Error("HABLLA_SPREADSHEET_ID ausente");
    }

    const sheets = new GoogleSheets({
      spreadsheetId: HABLLA_SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const hablla = await getHabllaClient();
    const sheetIds = await sheets.getSheetIdByTitle();
    if (
      datasets.has("cards") &&
      sheetIds["Base Hablla Card"] === undefined
    ) {
      throw new Error("Aba Base Hablla Card nao encontrada");
    }
    if (
      datasets.has("attendants") &&
      sheetIds["Base Atendente"] === undefined
    ) {
      throw new Error("Aba Base Atendente nao encontrada");
    }
    const hasClientSheet =
      datasets.has("clients") && sheetIds["Base Cliente"] !== undefined;

    if (datasets.has("cards")) {
      const cardDays = positiveInteger(
        process.env.HABLLA_CARDS_DAYS,
        7,
        "HABLLA_CARDS_DAYS",
      );
      const cardRange = saoPauloDayRange(cardDays);
      const exhaustive = booleanOption(
        process.env.HABLLA_CARDS_EXHAUSTIVE,
        false,
        "HABLLA_CARDS_EXHAUSTIVE",
      );
      const passes = positiveInteger(
        process.env.HABLLA_CARDS_CRAWL_PASSES,
        1,
        "HABLLA_CARDS_CRAWL_PASSES",
      );
      const attempts = positiveInteger(
        process.env.HABLLA_CARDS_CRAWL_ATTEMPTS,
        1,
        "HABLLA_CARDS_CRAWL_ATTEMPTS",
      );
      const preserveUnfetched = booleanOption(
        process.env.HABLLA_CARDS_PRESERVE_UNFETCHED,
        true,
        "HABLLA_CARDS_PRESERVE_UNFETCHED",
      );

      console.log(
        `>>> Sincronizando cards Hablla da janela de ${cardDays} dias...`,
      );
      const cards = await collectCardSnapshots({
        hablla,
        workspaceId: HABLLA_WORKSPACE_ID,
        boardId: HABLLA_BOARD_ID,
        cutoff: cardRange.start,
        exhaustive,
        passes,
        attempts,
      });
      const headerRows = await sheets.getValues("'Base Hablla Card'!1:1");
      const existingHeader = headerRows[0]?.length
        ? headerRows[0]
        : CARD_HEADERS;
      const { header: cardHeader, rows: cardRows } = buildCardSheet(
        cards,
        existingHeader,
      );
      assertRowWidth(cardRows, cardHeader.length, "Base Hablla Card");
      if (!cardRows.length && !allowEmpty) {
        throw new Error("Hablla retornou zero cards; substituicao cancelada");
      }

      const cardIds = new Set(cardRows.map((row) => String(row[14])));
      const cardResult = await sheets.replaceRowsViaStaging({
        sheetTitle: "Base Hablla Card",
        columnRange: `A:${columnLetter(cardHeader.length - 1)}`,
        header: cardHeader,
        newRows: cardRows,
        matchColumnIndexes: [1, 14],
        shouldReplace: (row) =>
          shouldReplaceCardRow(row, cardIds, cardRange.day, {
            preserveUnfetched,
          }),
      });
      console.log(
        `>>> ${cardResult.removed} cards substituidos por ${cardResult.inserted}; ` +
          `${cardHeader.length - CARD_HEADERS.length} colunas adicionais ativas.`,
      );
    }

    if (datasets.has("attendants")) {
      const attendantRanges = completedDayRanges(
        process.env.HABLLA_SHEETS_ATTENDANTS_DAYS || 1,
      );
      console.log(
        `>>> Sincronizando atendentes de ${attendantRanges.length} dias concluidos...`,
      );
      const rawAttendantRows = [];
      const attendantLabels = new Set();
      const emptyAttendantLabels = [];
      for (const range of attendantRanges) {
        const attendantsResponse = await hablla.get(
          `/v1/workspaces/${HABLLA_WORKSPACE_ID}/reports/services/summary`,
          {
            params: { start_date: range.start, end_date: range.end },
          },
        );
        const rangeRows = extractAttendants(attendantsResponse.data).map((item) => {
            const user = item.user || {};
            const sector = item.sector || {};
            const connection = item.connection || {};
            return [
              GoogleSheets.dateCell(range.label),
              HABLLA_WORKSPACE_ID,
              sector.id || "",
              sector.name || "",
              user.id || "",
              user.name || "",
              user.email || "",
              item.total_services ?? 0,
              item.tme ?? 0,
              item.tma ?? 0,
              connection.id || "",
              connection.name || "",
              connection.type || "",
              item.total_csat ?? 0,
              item.total_csat_greater_4 ?? 0,
              item.csat ?? 0,
              item.total_fcr ?? 0,
            ];
          });
        rawAttendantRows.push(...rangeRows);
        if (rangeRows.length || allowEmpty) {
          attendantLabels.add(range.label);
        } else {
          emptyAttendantLabels.push(range.label);
        }
      }
      if (emptyAttendantLabels.length) {
        const existingDates = await sheets.getValues("'Base Atendente'!A2:A");
        assertEmptyAttendantDaysAreSafe(emptyAttendantLabels, existingDates);
        console.log(
          `>>> ${emptyAttendantLabels.length} dias sem atendentes foram preservados sem remocao.`,
        );
      }
      const attendantRows = uniqueAttendantRows(rawAttendantRows);
      assertRowWidth(attendantRows, ATTENDANT_HEADERS.length, "Base Atendente");
      if (!attendantRows.length && !allowEmpty) {
        throw new Error("Hablla retornou zero atendentes; substituicao cancelada");
      }
      const attendantResult = await sheets.replaceRows({
        sheetTitle: "Base Atendente",
        columnRange: "A:Q",
        header: ATTENDANT_HEADERS,
        newRows: attendantRows,
        matchColumnIndexes: [0],
        shouldReplace: (row) =>
          attendantLabels.has(String(row[0] || "").split(" ")[0]),
      });
      console.log(
        `>>> ${attendantResult.removed} atendentes substituidos por ${attendantResult.inserted}.`,
      );
    }

    if (hasClientSheet) {
      const clientRanges = completedDayRanges(
        process.env.HABLLA_SHEETS_CLIENTS_DAYS || 1,
      );
      const clientRange = {
        start: clientRanges[0].start,
        end: clientRanges.at(-1).end,
      };
      console.log(
        `>>> Sincronizando clientes de ${clientRanges.length} dias concluidos...`,
      );
      const clients = await fetchClients(
        hablla,
        HABLLA_WORKSPACE_ID,
        clientRange,
      );
      const clientRows = clients.map(clientRow);
      assertRowWidth(clientRows, CLIENT_HEADERS.length, "Base Cliente");
      if (!clientRows.length && !allowEmpty) {
        throw new Error("Hablla retornou zero clientes; substituicao cancelada");
      }
      const clientIds = new Set(clientRows.map((row) => String(row[0])));
      const clientResult = await sheets.replaceRows({
        sheetTitle: "Base Cliente",
        columnRange: "A:Q",
        header: CLIENT_HEADERS,
        newRows: clientRows,
        matchColumnIndexes: [0],
        shouldReplace: (row) => clientIds.has(String(row[0] || "")),
      });
      console.log(
        `>>> ${clientResult.removed} clientes substituidos por ${clientResult.inserted}.`,
      );
    } else if (datasets.has("clients")) {
      console.log(">>> Aba Base Cliente ausente; sincronizacao ignorada.");
    }

    console.log(">>> Sincronizacao Hablla concluida.");
  } catch (error) {
    console.error(
      `>>> Falha na sincronizacao Hablla: ${formatPublicError(error)}`,
    );
    process.exitCode = 1;
  }
}

module.exports = run;
module.exports.uniqueAttendantRows = uniqueAttendantRows;
module.exports._internals = {
  CARD_HEADERS,
  CLIENT_HEADERS,
  assertEmptyAttendantDaysAreSafe,
  booleanOption,
  clientRow,
  collectCardSnapshots,
  columnLetter,
  completedDayRanges,
  formatCustomFieldValue,
  mergeCardSnapshots,
  selectedDatasets,
  shouldReplaceCardRow,
};
if (require.main === module) run();
