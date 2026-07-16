const GoogleSheets = require("../google/sheets");

const MAX_CELL_CHARACTERS = 50_000;
const MAX_COLUMNS = 18_278;

const TECHNICAL_CARD_HEADERS = Object.freeze([
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
]);

const CARD_HEADERS = Object.freeze([
  "Atualizado",
  "Criado",
  "workspace",
  "Quadro",
  "Lista",
  "Device",
  "Aparelho",
  "Serviço",
  "Nome",
  "Descrição",
  "Origem do Card",
  "Status",
  "Usuário",
  "Finalizado",
  "ID",
  "Atendente",
  "Motivo de Contato",
  "Tags",
  "Telefone",
]);

const CUSTOM_FIELD_DISPLAY_NAMES = Object.freeze({
  "67ca3b1b2a2005b0e7c0b67f": "utm_medium",
  "67ca3ad19698c9a231679c09": "utm_source",
  "67ca3d7709af47405f94b336": "Página de Conversão",
  "6a341e0a9794a6f45768e4c8": "Cidade",
  "6a34243f43dae636168814f5": "Browser",
  "6a34240d54956e3f17031590": "CEP_Conversao",
  "6a342421be3df912c7e28014": "Device Mobile",
  "6a342458ddddb2628027186c": "Data/Hora de Entrada no Site",
  "6a34244898b6bf2dfd2796b2": "Dimensões da Tela",
  "6a342434c2e6bd1fdedab9ca": "Sistema Operacional do Device",
  "6a3424608582742305e4af34": "Origin",
  "6a341b60fbf9c9ef3b3bff65": "ID da Conversão no Site",
  "67ca3b3bfa1aacf9258e4dbb": "utm_campaign",
  "67ca3cc6abf8dede928b7f07": "utm_content",
  "67ca3c4d75a80329df8eeff5": "utm_term",
  "6a1494ab3dae0a68cd239a93": "Cidade - Preferência",
  "6a14950aa329fb75151f7dae": "Unidade - Preferência",
  "67dc6a0a17925c23d8365708": "Serviço (campo personalizado)",
  "67b5fd0a6ee6fcbb66ae93c2": "Loja de agendamento",
  "67b5fc4b9d6e187ed4fa31fa": "Motivo do não agendamento?",
  "67b5fd5e5f04cc2397fc2fd3": "Observação do não agendamento",
  "67b5fbad827b187ab70ab641": "Agendamento realizado?",
  "69e8d49592607a5877e699d5": "Telefone (Campo)",
});

const BASE_HEADER_ALIASES = new Map();
for (let index = 0; index < CARD_HEADERS.length; index += 1) {
  const logical = TECHNICAL_CARD_HEADERS[index];
  for (const alias of new Set([logical, CARD_HEADERS[index]])) {
    const existing = BASE_HEADER_ALIASES.get(alias);
    if (existing && existing !== logical) {
      throw new Error(`Alias base Hablla Card ambiguo: ${alias}`);
    }
    BASE_HEADER_ALIASES.set(alias, logical);
  }
}

const CUSTOM_FIELD_LOGICAL_TO_DISPLAY = new Map();
const CUSTOM_FIELD_DISPLAY_TO_LOGICAL = new Map();
for (const [id, display] of Object.entries(CUSTOM_FIELD_DISPLAY_NAMES)) {
  const logical = `custom_field.${id}`;
  if (BASE_HEADER_ALIASES.has(display) || CUSTOM_FIELD_DISPLAY_TO_LOGICAL.has(display)) {
    throw new Error(`Nome visual Hablla Card ambiguo: ${display}`);
  }
  CUSTOM_FIELD_LOGICAL_TO_DISPLAY.set(logical, display);
  CUSTOM_FIELD_DISPLAY_TO_LOGICAL.set(display, logical);
}

const CARD_CUSTOM_FIELD_IDS = Object.freeze([
  "67b39131ee792966f3fba492",
  "67b608470787782ce7acafba",
  "67dc6a0a17925c23d8365708",
  "679120ec177ff6d2c7597156",
]);

const PHONE_CUSTOM_FIELD_ID = "69e8d49592607a5877e699d5";

const FULLY_REPRESENTED_TOP_LEVEL_KEYS = new Set([
  "updated_at",
  "created_at",
  "workspace",
  "board",
  "list",
  "name",
  "description",
  "source",
  "status",
  "finished_at",
  "id",
  "phone",
  "tags",
  "user",
  "custom_fields",
]);

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

function assertCellSize(value, label) {
  if (String(value).length > MAX_CELL_CHARACTERS) {
    throw new Error(`${label} excede ${MAX_CELL_CHARACTERS} caracteres`);
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isValidIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const match = value.match(ISO_DATE_TIME_PATTERN);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] || 0);
  const offsetMinute = Number(match[9] || 0);
  if (
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function formatBrazilianDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
    .replace(",", "");
}

function canonicalize(value, seen = new WeakSet()) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("JSON de card contem referencia circular");
    seen.add(value);
    const result = value.map((item) => {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        return null;
      }
      return canonicalize(item, seen);
    });
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("JSON de card contem referencia circular");
    seen.add(value);
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        continue;
      }
      result[key] = canonicalize(item, seen);
    }
    seen.delete(value);
    return result;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON de card contem numero invalido");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  throw new Error(`JSON de card contem tipo nao suportado: ${typeof value}`);
}

function canonicalStringify(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const properties = Object.keys(value)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
  return `{${properties.join(",")}}`;
}

function canonicalJson(value, label = "Valor do card") {
  const json = canonicalStringify(canonicalize(value));
  assertCellSize(json, label);
  return GoogleSheets.textCell(json);
}

function logicalKeyForHeader(header) {
  const logical =
    BASE_HEADER_ALIASES.get(header) ||
    CUSTOM_FIELD_DISPLAY_TO_LOGICAL.get(header) ||
    header;
  if (logical.startsWith("card.")) return logical.slice("card.".length);
  if (logical.startsWith("custom_field.")) {
    return logical.slice("custom_field.".length);
  }
  return logical;
}

function stripLeadingApostrophes(value) {
  return typeof value === "string" ? value.replace(/^'+/, "") : value;
}

function normalizePhoneValue(value) {
  const literal = stripLeadingApostrophes(value);
  return typeof literal === "string" ? literal.replace(/^\++/, "") : literal;
}

function sheetValue(value, header) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const literal = stripLeadingApostrophes(value);
    if (!literal) return "";
    assertCellSize(literal, `Valor de ${header}`);
    if (logicalKeyForHeader(header).endsWith("_at") && isValidIsoDateTime(literal)) {
      return GoogleSheets.dateTimeCell(formatBrazilianDateTime(literal));
    }
    return GoogleSheets.textCell(literal);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Valor numerico invalido em ${header}`);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return canonicalJson(value, `Valor de ${header}`);
  throw new Error(`Tipo nao suportado em ${header}: ${typeof value}`);
}

function logicalExtraHeader(header) {
  const mappedCustomField = CUSTOM_FIELD_DISPLAY_TO_LOGICAL.get(header);
  if (mappedCustomField) return mappedCustomField;
  if (header.startsWith("custom_field.")) {
    return header.length > "custom_field.".length ? header : null;
  }
  if (!header.startsWith("card.")) return null;
  const key = header.slice("card.".length);
  return Boolean(key) && !FULLY_REPRESENTED_TOP_LEVEL_KEYS.has(key)
    ? header
    : null;
}

function displayHeaderForLogical(logical) {
  return CUSTOM_FIELD_LOGICAL_TO_DISPLAY.get(logical) || logical;
}

function validateCardSheetHeader(header) {
  if (!Array.isArray(header)) throw new Error("Cabecalho Hablla Card precisa ser uma lista");
  if (header.length < CARD_HEADERS.length) {
    throw new Error(`Cabecalho Hablla Card precisa manter ${CARD_HEADERS.length} colunas base`);
  }
  if (header.length > MAX_COLUMNS) {
    throw new Error(`Cabecalho Hablla Card excede ${MAX_COLUMNS} colunas`);
  }

  const seen = new Set();
  const seenLogical = new Set();
  const seenDisplay = new Set();
  const normalized = [];
  for (let index = 0; index < header.length; index += 1) {
    const value = header[index];
    if (typeof value !== "string" || !value) {
      throw new Error(`Cabecalho Hablla Card invalido na coluna ${index + 1}`);
    }
    assertCellSize(value, `Cabecalho Hablla Card na coluna ${index + 1}`);
    if (seen.has(value)) throw new Error(`Cabecalho Hablla Card duplicado: ${value}`);
    seen.add(value);

    let logical;
    let display;
    if (index < CARD_HEADERS.length) {
      logical = TECHNICAL_CARD_HEADERS[index];
      if (value !== logical && value !== CARD_HEADERS[index]) {
        throw new Error(`Coluna base Hablla Card alterada na posicao ${index + 1}`);
      }
      display = CARD_HEADERS[index];
    } else {
      logical = logicalExtraHeader(value);
      if (!logical) {
        throw new Error(`Cabecalho extra Hablla Card nao reconhecido: ${value}`);
      }
      display = displayHeaderForLogical(logical);
    }

    if (seenLogical.has(logical)) {
      throw new Error(`Cabecalho Hablla Card duplicado: ${value}`);
    }
    if (seenDisplay.has(display)) {
      throw new Error(`Cabecalho Hablla Card visual duplicado: ${display}`);
    }
    seenLogical.add(logical);
    seenDisplay.add(display);
    normalized.push(display);
  }
  return normalized;
}

function assertCards(cards) {
  if (!Array.isArray(cards)) throw new Error("Cards Hablla precisam ser uma lista");
  cards.forEach((card, index) => {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      throw new Error(`Card Hablla invalido no indice ${index}`);
    }
  });
}

function customFieldId(field) {
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const id = field.custom_field;
  if (id === null || id === undefined || id === "") return null;
  if (!["string", "number", "boolean"].includes(typeof id)) {
    throw new Error("ID de custom field Hablla precisa ser escalar");
  }
  const text = String(id);
  assertCellSize(text, "ID de custom field Hablla");
  return text;
}

function discoverCardSheetHeaders(cards, existingHeader = CARD_HEADERS) {
  assertCards(cards);
  const header = validateCardSheetHeader(existingHeader);
  const known = new Set(
    header.map((value, index) =>
      index < CARD_HEADERS.length
        ? TECHNICAL_CARD_HEADERS[index]
        : logicalExtraHeader(value),
    ),
  );
  const discovered = new Set();

  for (const card of cards) {
    for (const key of Object.keys(card)) {
      if (FULLY_REPRESENTED_TOP_LEVEL_KEYS.has(key)) continue;
      const logical = `card.${key}`;
      assertCellSize(logical, "Cabecalho dinamico Hablla Card");
      if (!known.has(logical)) discovered.add(logical);
    }

    if (Array.isArray(card.custom_fields)) {
      for (const field of card.custom_fields) {
        const id = customFieldId(field);
        if (id === null || CARD_CUSTOM_FIELD_IDS.includes(id)) continue;
        const logical = `custom_field.${id}`;
        assertCellSize(logical, "Cabecalho dinamico Hablla Card");
        if (!known.has(logical)) discovered.add(logical);
      }
    }
  }

  const additions = [...discovered]
    .sort(compareText)
    .map(displayHeaderForLogical);
  if (header.length + additions.length > MAX_COLUMNS) {
    throw new Error(`Cabecalho Hablla Card excede ${MAX_COLUMNS} colunas`);
  }
  return [...header, ...additions];
}

function buildBaseCardRow(card, { customFieldIds = CARD_CUSTOM_FIELD_IDS } = {}) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    throw new Error("Card Hablla invalido");
  }
  if (!Array.isArray(customFieldIds) || customFieldIds.length !== 4) {
    throw new Error("Hablla Card exige exatamente quatro custom fields base");
  }

  const normalizedIds = customFieldIds.map(String);
  const fields = ["", "", "", "", ""];
  for (const field of card.custom_fields || []) {
    const id = customFieldId(field);
    if (id === null) continue;
    const index = normalizedIds.indexOf(id);
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
    normalizePhoneValue(card.phone || ""),
  ];
}

function duplicateCustomFieldValue(values, header) {
  const canonicalValues = values.map((value) => {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`Valor numerico invalido em ${header}`);
      return value;
    }
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "object") return canonicalize(value);
    throw new Error(`Tipo nao suportado em ${header}: ${typeof value}`);
  });
  canonicalValues.sort((left, right) =>
    compareText(canonicalStringify(left), canonicalStringify(right)),
  );
  return canonicalJson(canonicalValues, `Valores duplicados de ${header}`);
}

function dynamicCardValue(card, header) {
  const logical = logicalExtraHeader(header);
  if (!logical) throw new Error(`Cabecalho dinamico Hablla Card invalido: ${header}`);

  if (logical.startsWith("card.")) {
    const key = logical.slice("card.".length);
    return Object.prototype.hasOwnProperty.call(card, key)
      ? sheetValue(card[key], logical)
      : "";
  }

  const id = logical.slice("custom_field.".length);
  const values = [];
  if (Array.isArray(card.custom_fields)) {
    for (const field of card.custom_fields) {
      if (customFieldId(field) === id) {
        values.push(
          id === PHONE_CUSTOM_FIELD_ID
            ? normalizePhoneValue(field.value)
            : field.value,
        );
      }
    }
  }
  if (!values.length) return "";
  if (values.length === 1) return sheetValue(values[0], logical);
  return duplicateCustomFieldValue(values, logical);
}

function buildCardSheetRow(card, header, options = {}) {
  const validatedHeader = validateCardSheetHeader(header);
  const typedDateIndexes = new Set([0, 1, 13]);
  const row = buildBaseCardRow(card, options).map((value, index) =>
    typedDateIndexes.has(index) ? value : sheetValue(value, CARD_HEADERS[index]),
  );
  for (const extraHeader of validatedHeader.slice(CARD_HEADERS.length)) {
    row.push(dynamicCardValue(card, extraHeader));
  }
  if (row.length !== validatedHeader.length) {
    throw new Error("Largura da linha Hablla Card diverge do cabecalho");
  }
  return row;
}

function buildCardSheet(cards, existingHeader = CARD_HEADERS, options = {}) {
  const header = discoverCardSheetHeaders(cards, existingHeader);
  const rows = cards.map((card) => buildCardSheetRow(card, header, options));
  return { header, rows };
}

module.exports = {
  CARD_CUSTOM_FIELD_IDS,
  CARD_HEADERS,
  CUSTOM_FIELD_DISPLAY_NAMES,
  MAX_CELL_CHARACTERS,
  TECHNICAL_CARD_HEADERS,
  buildBaseCardRow,
  buildCardSheet,
  buildCardSheetRow,
  canonicalJson,
  discoverCardSheetHeaders,
  normalizePhoneValue,
  sheetValue,
  stripLeadingApostrophes,
  validateCardSheetHeader,
};
