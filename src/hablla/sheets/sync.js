const GoogleSheets = require("../../google/sheets");
const formatPublicError = require("../../lib/public-error");
const getHabllaClient = require("../api");
const collectHabllaCards = require("../card-collector");
const {
  extractAttendants,
  extractClients,
} = require("../response-contracts");
const saoPauloDayRange = require("../date-range");

const CARD_HEADERS = [
  "updated_at",
  "created_at",
  "workspace",
  "board",
  "list",
  "custom_field_1",
  "custom_field_2",
  "custom_field_3",
  "name",
  "description",
  "source",
  "status",
  "user",
  "finished_at",
  "id",
  "Atendente",
  "Motivo de Contato",
  "Tags",
  "Telefone",
];

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

function parseBrazilianDateKey(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function shouldReplaceCardRow(row, cardIds, cutoffDay) {
  const createdDay = parseBrazilianDateKey(row[1]);
  return (
    cardIds.has(String(row[14] || "")) ||
    Boolean(createdDay && createdDay >= cutoffDay)
  );
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
      clientsById.set(String(client.id), client);
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

  return [
    person.id,
    person.name || "",
    primaryPhone?.phone || "",
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
    customFields[CLIENT_CUSTOM_FIELD_IDS[4]] || "",
    customFields[CLIENT_CUSTOM_FIELD_IDS[5]] || "",
    otherFields.join("; "),
    users,
  ];
}

async function run() {
  try {
    const {
      GOOGLE_TOKEN,
      HABLLA_WORKSPACE_ID,
      HABLLA_BOARD_ID,
      HABLLA_SPREADSHEET_ID,
    } = process.env;

    if (!GOOGLE_TOKEN) throw new Error("GOOGLE_TOKEN ausente");
    if (!HABLLA_WORKSPACE_ID) throw new Error("HABLLA_WORKSPACE_ID ausente");
    if (!HABLLA_BOARD_ID) throw new Error("HABLLA_BOARD_ID ausente");
    if (!HABLLA_SPREADSHEET_ID) {
      throw new Error("HABLLA_SPREADSHEET_ID ausente");
    }

    const sheets = new GoogleSheets({
      spreadsheetId: HABLLA_SPREADSHEET_ID,
      accessToken: GOOGLE_TOKEN,
    });
    const hablla = await getHabllaClient();
    const sheetIds = await sheets.getSheetIdByTitle();
    if (sheetIds["Base Hablla Card"] === undefined) {
      throw new Error("Aba Base Hablla Card nao encontrada");
    }
    if (sheetIds["Base Atendente"] === undefined) {
      throw new Error("Aba Base Atendente nao encontrada");
    }
    const hasClientSheet = sheetIds["Base Cliente"] !== undefined;

    const sevenDays = saoPauloDayRange(7);
    console.log(">>> Sincronizando cards Hablla...");
    const cards = await collectHabllaCards({
      hablla,
      workspaceId: HABLLA_WORKSPACE_ID,
      boardId: HABLLA_BOARD_ID,
      cutoff: sevenDays.start,
    });
    const cardCustomFieldIds = [
      "67b39131ee792966f3fba492",
      "67b608470787782ce7acafba",
      "67dc6a0a17925c23d8365708",
      "679120ec177ff6d2c7597156",
      "69e8d49592607a5877e699d5",
    ];
    const cardRows = cards.map((card) => {
      const fields = ["", "", "", "", ""];
      for (const field of card.custom_fields || []) {
        const index = cardCustomFieldIds.indexOf(field.custom_field);
        if (index !== -1) fields[index] = field.value;
      }
      const userId =
        card.user && typeof card.user === "object"
          ? card.user.id || ""
          : card.user || "";
      const userName =
        card.user && typeof card.user === "object"
          ? card.user.name || card.user.email || ""
          : "";
      return [
        GoogleSheets.dateTimeCell(formatBrazilianDateTime(card.updated_at)),
        GoogleSheets.dateTimeCell(formatBrazilianDateTime(card.created_at)),
        card.workspace || "",
        card.board || "",
        card.list || "",
        fields[0],
        fields[1],
        fields[2],
        card.name || "",
        card.description || "",
        card.source || "",
        card.status || "",
        userId,
        GoogleSheets.dateTimeCell(formatBrazilianDateTime(card.finished_at)),
        card.id,
        userName,
        fields[3],
        (card.tags || []).map((tag) => tag.name).join(", "),
        fields[4],
      ];
    });
    assertRowWidth(cardRows, CARD_HEADERS.length, "Base Hablla Card");

    const cardIds = new Set(cardRows.map((row) => String(row[14])));
    const cardResult = await sheets.replaceRows({
      sheetTitle: "Base Hablla Card",
      columnRange: "A:S",
      header: CARD_HEADERS,
      newRows: cardRows,
      matchColumnIndexes: [1, 14],
      shouldReplace: (row) =>
        shouldReplaceCardRow(row, cardIds, sevenDays.day),
    });
    console.log(
      `>>> ${cardResult.removed} cards substituidos por ${cardResult.inserted}.`,
    );

    const yesterday = saoPauloDayRange(1);
    console.log(`>>> Sincronizando atendentes de ${yesterday.day}...`);
    const attendantsResponse = await hablla.get(
      `/v1/workspaces/${HABLLA_WORKSPACE_ID}/reports/services/summary`,
      {
        params: { start_date: yesterday.start, end_date: yesterday.end },
      },
    );
    const rawAttendantRows = extractAttendants(attendantsResponse.data).map(
      (item) => {
        const user = item.user || {};
        const sector = item.sector || {};
        const connection = item.connection || {};
        return [
          GoogleSheets.dateCell(yesterday.label),
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
      },
    );
    const attendantRows = uniqueAttendantRows(rawAttendantRows);
    assertRowWidth(attendantRows, ATTENDANT_HEADERS.length, "Base Atendente");
    const attendantResult = await sheets.replaceRows({
      sheetTitle: "Base Atendente",
      columnRange: "A:Q",
      header: ATTENDANT_HEADERS,
      newRows: attendantRows,
      matchColumnIndexes: [0],
      shouldReplace: (row) =>
        String(row[0] || "").startsWith(yesterday.label),
    });
    console.log(
      `>>> ${attendantResult.removed} atendentes substituidos por ${attendantResult.inserted}.`,
    );

    if (hasClientSheet) {
      console.log(`>>> Sincronizando clientes de ${yesterday.day}...`);
      const clients = await fetchClients(
        hablla,
        HABLLA_WORKSPACE_ID,
        yesterday,
      );
      const clientRows = clients.map(clientRow);
      assertRowWidth(clientRows, CLIENT_HEADERS.length, "Base Cliente");
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
    } else {
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
  clientRow,
  formatCustomFieldValue,
  shouldReplaceCardRow,
};
if (require.main === module) run();
