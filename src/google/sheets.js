const crypto = require("crypto");
const axios = require("axios");
const { getGoogleAccessToken } = require("./auth");
const {
  RateGate,
  backoffMs,
  isRetryableNetworkError,
  isRetryableStatus,
  sleep,
} = require("../lib/http-retry");

const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_SPREADSHEET_CELLS = 10_000_000;
const TYPED_DATE_CELL = Symbol("typedDateCell");
const TYPED_DATE_TEXT = Symbol("typedDateText");

class TypedDateCell {
  constructor(text, metadata) {
    this[TYPED_DATE_TEXT] = text;
    this[TYPED_DATE_CELL] = metadata;
    Object.freeze(this);
  }

  toString() {
    return this[TYPED_DATE_TEXT];
  }

  valueOf() {
    return this[TYPED_DATE_CELL].numberValue;
  }
}

function encodeRange(range) {
  return encodeURIComponent(range).replace(/%21/g, "!");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function dateParts(text, withTime) {
  const pattern = withTime
    ? /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/
    : /^(\d{2})\/(\d{2})\/(\d{4})$/;
  const match = String(text).match(pattern);
  if (!match) return null;

  const [, dayText, monthText, yearText, hourText = "0", minuteText = "0", secondText = "0"] = match;
  const parts = {
    day: Number(dayText),
    month: Number(monthText),
    year: Number(yearText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText),
  };
  if (
    parts.year < 1900 ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) return null;

  const timestamp = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== parts.year ||
    parsed.getUTCMonth() !== parts.month - 1 ||
    parsed.getUTCDate() !== parts.day ||
    parsed.getUTCHours() !== parts.hour ||
    parsed.getUTCMinutes() !== parts.minute ||
    parsed.getUTCSeconds() !== parts.second
  ) return null;
  return { ...parts, timestamp };
}

function typedNumberCell(text, numberValue, numberFormat) {
  const metadata = Object.freeze({
    numberValue,
    numberFormat: Object.freeze(numberFormat),
  });
  return new TypedDateCell(text, metadata);
}

function typedDateCell(value, { withTime, pattern }) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  const parts = dateParts(text, withTime);
  const expected = withTime ? "DD/MM/AAAA HH:mm:ss" : "DD/MM/AAAA";
  if (!parts) throw new Error(`Data invalida para Google Sheets; esperado ${expected}`);

  return typedNumberCell(
    text,
    (parts.timestamp - GOOGLE_SHEETS_EPOCH_MS) / MILLISECONDS_PER_DAY,
    { type: withTime ? "DATE_TIME" : "DATE", pattern },
  );
}

function dateCell(value, { pattern = "dd/mm/yyyy" } = {}) {
  return typedDateCell(value, { withTime: false, pattern });
}

function dateTimeCell(value, { pattern = "dd/mm/yyyy hh:mm:ss" } = {}) {
  return typedDateCell(value, { withTime: true, pattern });
}

function timeCell(value, { pattern = "hh:mm:ss" } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  const match = text.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Hora invalida para Google Sheets; esperado HH:mm:ss");
  const [, hourText, minuteText, secondText] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("Hora invalida para Google Sheets; esperado HH:mm:ss");
  }
  const numberValue = (hour * 3600 + minute * 60 + second) / 86400;
  return typedNumberCell(text, numberValue, { type: "TIME", pattern });
}

function monthCell(value, { pattern = "mm/yyyy" } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value);
  const match = text.match(/^(\d{2})\/(\d{4})$/);
  if (!match) throw new Error("Mes invalido para Google Sheets; esperado MM/AAAA");
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (year < 1900 || month < 1 || month > 12) {
    throw new Error("Mes invalido para Google Sheets; esperado MM/AAAA");
  }
  const timestamp = Date.UTC(year, month - 1, 1);
  return typedNumberCell(
    text,
    (timestamp - GOOGLE_SHEETS_EPOCH_MS) / MILLISECONDS_PER_DAY,
    { type: "DATE", pattern },
  );
}

function textCell(value) {
  return value === null || value === undefined || value === "" ? "" : String(value);
}

function typedDateMetadata(value) {
  return value && typeof value === "object" ? value[TYPED_DATE_CELL] : null;
}

function literalCell(value) {
  const typedDate = typedDateMetadata(value);
  if (typedDate) {
    return {
      userEnteredValue: { numberValue: typedDate.numberValue },
      userEnteredFormat: { numberFormat: typedDate.numberFormat },
    };
  }
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "number")
    return { userEnteredValue: { numberValue: value } };
  if (typeof value === "boolean")
    return { userEnteredValue: { boolValue: value } };
  return { userEnteredValue: { stringValue: String(value) } };
}

function literalValueCell(value) {
  const cell = literalCell(value);
  return cell.userEnteredValue
    ? { userEnteredValue: cell.userEnteredValue }
    : {};
}

function columnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function columnIndex(letters) {
  let result = 0;
  for (const character of String(letters).toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function canonicalCell(value) {
  const typedDate = typedDateMetadata(value);
  if (typedDate) return canonicalCell(typedDate.numberValue);
  if (value === null || value === undefined || value === "") return ["empty"];
  if (typeof value === "number") {
    return ["number", Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value)];
  }
  if (typeof value === "boolean") return ["boolean", value];
  return ["string", String(value).replace(/\r\n/g, "\n")];
}

function canonicalRow(row, width) {
  return Array.from({ length: width }, (_, index) => canonicalCell(row[index]));
}

function rowsHash(rows, width, canonicalizeCell) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify([rows.length, width]));
  for (const row of rows) {
    hash.update("\n");
    hash.update(
      JSON.stringify(
        Array.from(
          { length: width },
          (_, index) => canonicalizeCell(row[index]),
        ),
      ),
    );
  }
  return hash.digest("hex");
}

function completeRowsHash(rows, width) {
  return rowsHash(rows, width, canonicalCell);
}

function preservedRowsHash(rows, width) {
  return rowsHash(rows, width, (value) => {
    // Deleting rows makes Google rewrite relative references (for example,
    // =B10 becomes =B9). The formula cell is still preserved, so compare
    // its presence while keeping exact comparison for every literal value.
    if (typeof value === "string" && value.startsWith("=")) {
      return ["formula"];
    }
    return canonicalCell(value);
  });
}

function selectorSnapshotHash(state, indexes, headerWidth) {
  const hash = crypto.createHash("sha256");
  hash.update(
    JSON.stringify({
      hasHeader: state.hasHeader,
      header: canonicalRow(state.first, headerWidth),
      rowCount: state.body.length,
      indexes,
    }),
  );
  for (const row of state.body) {
    hash.update("\n");
    hash.update(
      JSON.stringify(indexes.map((index) => canonicalCell(row[index]))),
    );
  }
  return hash.digest("hex");
}

function rowHasContent(row) {
  return Array.isArray(row) && row.some(
    (value) => value !== null && value !== undefined && value !== "",
  );
}

function trimTrailingEmptyRows(rows) {
  let length = rows.length;
  while (length > 0 && !rowHasContent(rows[length - 1])) length--;
  return rows.slice(0, length);
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

function typedNumberFormatBlocks(newRows, bodyIndexes, stateHasHeader) {
  const grouped = new Map();
  newRows.forEach((row, rowOffset) => {
    const bodyIndex = bodyIndexes[rowOffset];
    const gridRowIndex = bodyIndex + (stateHasHeader ? 1 : 0);
    row.forEach((value, columnIndex) => {
      const metadata = typedDateMetadata(value);
      if (!metadata) return;
      const { type, pattern } = metadata.numberFormat;
      const key = JSON.stringify([columnIndex, type, pattern]);
      if (!grouped.has(key)) {
        grouped.set(key, {
          columnIndex,
          numberFormat: { type, pattern },
          rowIndexes: [],
        });
      }
      grouped.get(key).rowIndexes.push(gridRowIndex);
    });
  });

  const blocks = [];
  for (const group of grouped.values()) {
    for (const block of contiguousBlocks(group.rowIndexes)) {
      blocks.push({
        columnIndex: group.columnIndex,
        startRowIndex: block.start,
        endRowIndex: block.end,
        numberFormat: group.numberFormat,
      });
    }
  }
  return blocks.sort(
    (left, right) =>
      left.columnIndex - right.columnIndex ||
      left.startRowIndex - right.startRowIndex,
  );
}

function numberFormatRequest(sheetId, block) {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: block.startRowIndex,
        endRowIndex: block.endRowIndex,
        startColumnIndex: block.columnIndex,
        endColumnIndex: block.columnIndex + 1,
      },
      cell: {
        userEnteredFormat: { numberFormat: block.numberFormat },
      },
      fields: "userEnteredFormat.numberFormat",
    },
  };
}

function numberFormatRange(quotedTitle, block) {
  const column = columnLetter(block.columnIndex);
  return (
    `${quotedTitle}!${column}${block.startRowIndex + 1}:` +
    `${column}${block.endRowIndex}`
  );
}

function sameNumberFormat(actual, expected) {
  return actual?.type === expected.type && actual?.pattern === expected.pattern;
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function allocateStagingSheetId(propertiesByTitle) {
  const usedIds = new Set(
    Object.values(propertiesByTitle).map((properties) => properties.sheetId),
  );
  let candidate = crypto.randomInt(1, 2_000_000_000);
  while (usedIds.has(candidate)) {
    candidate = candidate === 1_999_999_999 ? 1 : candidate + 1;
  }
  return candidate;
}

function stateSnapshot(state, matchColumnIndexes, width) {
  return {
    selectorHash: selectorSnapshotHash(
      state,
      matchColumnIndexes,
      width,
    ),
    completeHash: completeRowsHash(state.completeBody, width),
  };
}

function stateMatchesSnapshot(state, snapshot, matchColumnIndexes, width) {
  return (
    selectorSnapshotHash(state, matchColumnIndexes, width) ===
      snapshot.selectorHash &&
    completeRowsHash(state.completeBody, width) === snapshot.completeHash
  );
}

function* stagingRowChunks(rows, width, { maxRows, maxBytes }) {
  let currentRows = [];
  let currentBytes = 0;
  let startIndex = 0;

  for (const row of rows) {
    const rowData = {
      values: Array.from(
        { length: width },
        (_, index) => literalCell(row[index]),
      ),
    };
    const rowBytes = Buffer.byteLength(JSON.stringify(rowData), "utf8");
    if (rowBytes > maxBytes) {
      throw new Error(
        "Uma linha excede o tamanho seguro do batchUpdate da staging",
      );
    }
    if (
      currentRows.length &&
      (currentRows.length >= maxRows || currentBytes + rowBytes > maxBytes)
    ) {
      yield { startIndex, rows: currentRows };
      startIndex += currentRows.length;
      currentRows = [];
      currentBytes = 0;
    }
    currentRows.push(rowData);
    currentBytes += rowBytes;
  }
  if (currentRows.length) yield { startIndex, rows: currentRows };
}

class GoogleSheets {
  constructor({ spreadsheetId, accessToken, tokenExpiresAt, refreshAccessToken }) {
    if (!spreadsheetId) throw new Error("spreadsheetId obrigatorio");
    if (!accessToken) throw new Error("accessToken obrigatorio");

    this.spreadsheetId = spreadsheetId;
    this.tokenExpiresAt = Number(tokenExpiresAt || process.env.GOOGLE_TOKEN_EXPIRES_AT || 0);
    this.refreshAccessToken = refreshAccessToken || (() => getGoogleAccessToken({ forceRefresh: true }));
    this.refreshPromise = null;
    this.sheetPropertiesPromise = null;
    this.http = axios.create({
      baseURL: `${SHEETS_BASE_URL}/${spreadsheetId}`,
      timeout: 60000,
      headers: {
        "Content-Type": "application/json",
      },
    });
    this.http.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
  }

  async refreshToken() {
    if (!this.refreshPromise) {
      this.refreshPromise = Promise.resolve(this.refreshAccessToken()).then((token) => {
        const accessToken = typeof token === "string" ? token : token.accessToken;
        if (!accessToken) throw new Error("Google OAuth nao retornou access_token");
        this.http.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
        // Axios may retain a method-independent root header from older instances.
        // Removing it ensures the freshly renewed token is the one sent.
        delete this.http.defaults.headers.Authorization;
        this.tokenExpiresAt = typeof token === "object" && token.expiresAt ? token.expiresAt : Date.now() + 3600000;
      }).finally(() => { this.refreshPromise = null; });
    }
    await this.refreshPromise;
  }

  async ensureFreshToken() {
    if (this.tokenExpiresAt && this.tokenExpiresAt - Date.now() <= 300000) await this.refreshToken();
  }

  async request(config, { maxAttempts = 4, operation = config.url } = {}) {
    let attempt = 0;
    let refreshedAfter401 = false;
    while (attempt < maxAttempts) {
      await this.ensureFreshToken();
      try {
        return await this.http.request(config);
      } catch (error) {
        const status = error.response?.status;
        if (status === 401 && !refreshedAfter401) {
          await this.refreshToken();
          refreshedAfter401 = true;
          continue;
        }
        const reasons = error.response?.data?.error?.errors?.map((item) => item.reason) || [];
        const quota403 = status === 403 && reasons.some((reason) => ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(reason));
        const retryable = isRetryableStatus(status) || quota403 || isRetryableNetworkError(error);
        if (retryable && attempt < maxAttempts - 1) {
          await sleep(backoffMs(attempt, { baseMs: 1500, headers: error.response?.headers }));
          attempt++;
          continue;
        }

        throw new Error(
          `Google Sheets API falhou em ${operation}: ` +
            `status=${status || "network"} code=${error.code || "unknown"}`,
        );
      }
    }

    throw new Error("Google Sheets API falhou apos retries");
  }

  async getSpreadsheet() {
    const response = await this.request({
      method: "get",
      url: "",
      params: {
        fields:
          "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))",
      },
    });
    return response.data;
  }

  async getSheetPropertiesByTitle({ forceRefresh = false } = {}) {
    if (forceRefresh) this.sheetPropertiesPromise = null;
    if (!this.sheetPropertiesPromise) {
      this.sheetPropertiesPromise = this.getSpreadsheet().then((spreadsheet) => {
        const result = {};
        for (const sheet of spreadsheet.sheets || []) {
          result[sheet.properties.title] = sheet.properties;
        }
        return result;
      });
    }
    return this.sheetPropertiesPromise;
  }

  async getSheetIdByTitle() {
    const properties = await this.getSheetPropertiesByTitle();
    return Object.fromEntries(
      Object.entries(properties).map(([title, value]) => [title, value.sheetId]),
    );
  }

  async getValues(range) {
    const response = await this.request({
      method: "get",
      url: `/values/${encodeRange(range)}`,
      timeout: 180000,
      params: {
        valueRenderOption: "FORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      },
    });
    return response.data.values || [];
  }

  async getValuesBatch(
    ranges,
    {
      valueRenderOption = "FORMATTED_VALUE",
      dateTimeRenderOption = "FORMATTED_STRING",
      timeoutMs = positiveInteger(
        process.env.GOOGLE_SHEETS_READ_TIMEOUT_MS,
        180000,
      ),
      maxAttempts = positiveInteger(
        process.env.GOOGLE_SHEETS_READ_MAX_ATTEMPTS,
        5,
      ),
    } = {},
  ) {
    const params = new URLSearchParams({
      valueRenderOption,
      dateTimeRenderOption,
    });
    for (const range of ranges) params.append("ranges", range);

    const response = await this.request(
      {
        method: "get",
        url: "/values:batchGet",
        params,
        timeout: timeoutMs,
      },
      {
        maxAttempts,
        operation: `batchGet(${ranges.length} ranges)`,
      },
    );
    return (response.data.valueRanges || []).map((item) => item.values || []);
  }

  async numberFormatsMatch(sheetTitle, blocks) {
    if (!blocks.length) return true;
    const quotedTitle = `'${sheetTitle.replace(/'/g, "''")}'`;

    for (let start = 0; start < blocks.length; start += 100) {
      const chunk = blocks.slice(start, start + 100);
      const params = new URLSearchParams({
        includeGridData: "true",
        fields:
          "sheets.data(startRow,startColumn," +
          "rowData.values.userEnteredFormat.numberFormat)",
      });
      for (const block of chunk) {
        params.append("ranges", numberFormatRange(quotedTitle, block));
      }

      const response = await this.request(
        {
          method: "get",
          url: "",
          params,
          timeout: 180000,
        },
        {
          maxAttempts: 5,
          operation: `validar numberFormat(${chunk.length} ranges)`,
        },
      );
      const gridByStart = new Map();
      for (const sheet of response.data.sheets || []) {
        for (const grid of sheet.data || []) {
          const key = `${grid.startRow || 0}:${grid.startColumn || 0}`;
          gridByStart.set(key, grid);
        }
      }

      for (const block of chunk) {
        const key = `${block.startRowIndex}:${block.columnIndex}`;
        const grid = gridByStart.get(key);
        const rowCount = block.endRowIndex - block.startRowIndex;
        for (let offset = 0; offset < rowCount; offset++) {
          const actual =
            grid?.rowData?.[offset]?.values?.[0]?.userEnteredFormat
              ?.numberFormat;
          if (!sameNumberFormat(actual, block.numberFormat)) return false;
        }
      }
    }
    return true;
  }

  async batchUpdate(requests, { idempotent = false } = {}) {
    if (!requests.length) return { skipped: true };
    const response = await this.request(
      {
        method: "post",
        url: ":batchUpdate",
        timeout: 240000,
        data: { requests },
      },
      {
        // Only absolute-value rewrites are safe to retry after an ambiguous timeout.
        maxAttempts: idempotent ? 2 : 1,
        operation: "spreadsheets.batchUpdate",
      },
    );
    return response.data;
  }

  async appendValues(range, values) {
    if (!values.length) return { skipped: true };
    const response = await this.request({
      method: "post",
      url: `/values/${encodeRange(range)}:append`,
      params: {
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
      },
      data: { values },
    }, { maxAttempts: 1, operation: "values.append" });
    return response.data;
  }

  async replaceRows({
    sheetTitle,
    columnRange,
    header,
    newRows,
    shouldReplace,
    matchColumnIndexes,
  }) {
    if (!Array.isArray(header) || !header.length)
      throw new Error("header obrigatorio");
    if (!Array.isArray(newRows)) throw new Error("newRows precisa ser array");
    if (typeof shouldReplace !== "function") throw new Error("shouldReplace obrigatorio");

    const columnMatch = String(columnRange).match(/^([A-Z]+):([A-Z]+)$/i);
    if (!columnMatch) throw new Error("columnRange precisa usar o formato A:Z");
    const startColumnIndex = columnIndex(columnMatch[1]);
    const endColumnIndex = columnIndex(columnMatch[2]);
    if (startColumnIndex !== 0 || endColumnIndex < startColumnIndex) {
      throw new Error("replaceRows exige columnRange iniciado em A");
    }
    const comparisonWidth = endColumnIndex - startColumnIndex + 1;
    if (header.length > comparisonWidth) {
      throw new Error("header excede columnRange");
    }
    const invalidRow = newRows.findIndex(
      (row) => !Array.isArray(row) || row.length > comparisonWidth,
    );
    if (invalidRow !== -1) {
      throw new Error(`newRows[${invalidRow}] excede columnRange`);
    }

    const quotedTitle = `'${sheetTitle.replace(/'/g, "''")}'`;
    const hasSelectors = Array.isArray(matchColumnIndexes) && matchColumnIndexes.length;
    if (!hasSelectors) {
      throw new Error("matchColumnIndexes obrigatorio para substituicao segura");
    }
    if (
      matchColumnIndexes.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= comparisonWidth,
      )
    ) {
      throw new Error("matchColumnIndexes contem coluna invalida");
    }
    const readState = async () => {
      const ranges = [
        `${quotedTitle}!${columnMatch[1]}1:${columnMatch[2]}1`,
        ...matchColumnIndexes.map(
          (index) => `${quotedTitle}!${columnLetter(index)}:${columnLetter(index)}`,
        ),
      ];
      const [selectorValues, completeValues] = await Promise.all([
        this.getValuesBatch(ranges),
        this.getValuesBatch(
          [`${quotedTitle}!${columnMatch[1]}:${columnMatch[2]}`],
          {
            valueRenderOption: "FORMULA",
            dateTimeRenderOption: "SERIAL_NUMBER",
          },
        ),
      ]);
      const [headerRows, ...selectorColumns] = selectorValues;
      const first = headerRows[0] || [];
      const normalized = (value) => String(value ?? "").trim().toLowerCase();
      const headerMatches = header.filter((value, index) => normalized(first[index]) === normalized(value)).length;
      const stateHasHeader = headerMatches >= Math.min(3, header.length);
      const columns = selectorColumns.map((column) =>
        stateHasHeader ? column.slice(1) : column,
      );
      const completeRows = completeValues[0] || [];
      const completeBodySource = stateHasHeader
        ? completeRows.slice(1)
        : completeRows;
      const bodyLength = Math.max(
        completeBodySource.length,
        0,
        ...columns.map((column) => column.length),
      );
      const body = Array.from({ length: bodyLength }, (_, rowIndex) => {
        const row = [];
        matchColumnIndexes.forEach((columnIndexValue, selectorIndex) => {
          row[columnIndexValue] = columns[selectorIndex][rowIndex]?.[0] ?? "";
        });
        return row;
      });
      const completeBody = Array.from(
        { length: bodyLength },
        (_, rowIndex) => completeBodySource[rowIndex] || [],
      );
      return { body, completeBody, first, hasHeader: stateHasHeader };
    };

    const initialState = await readState();
    const sheetPropertiesByTitle = await this.getSheetPropertiesByTitle({
      forceRefresh: true,
    });
    const sheetProperties = sheetPropertiesByTitle[sheetTitle];
    if (!sheetProperties) throw new Error(`Aba nao encontrada: ${sheetTitle}`);
    const sheetId = sheetProperties.sheetId;
    const gridRowCount = Number(sheetProperties.gridProperties?.rowCount);
    if (!Number.isInteger(gridRowCount) || gridRowCount < 1) {
      throw new Error(`rowCount invalido para a aba: ${sheetTitle}`);
    }

    const preWriteState = await readState();
    if (
      selectorSnapshotHash(initialState, matchColumnIndexes, comparisonWidth) !==
        selectorSnapshotHash(preWriteState, matchColumnIndexes, comparisonWidth) ||
      completeRowsHash(initialState.completeBody, comparisonWidth) !==
        completeRowsHash(preWriteState.completeBody, comparisonWidth)
    ) {
      throw new Error(`Estado da planilha mudou antes da escrita: ${sheetTitle}`);
    }


    const { body, hasHeader } = preWriteState;
    const matched = body
      .map((row, index) => (shouldReplace(row, index) ? index + 1 : null))
      .filter((index) => index !== null);
    const invalidReplacement = newRows.findIndex(
      (row, index) => !shouldReplace(row, index),
    );
    if (invalidReplacement !== -1) {
      throw new Error(`newRows[${invalidReplacement}] nao pertence ao conjunto substituido`);
    }
    const matchedBodyIndexes = new Set(matched.map((index) => index - 1));
    const remainingCompleteRows = trimTrailingEmptyRows(
      preWriteState.completeBody.filter(
        (_, index) => !matchedBodyIndexes.has(index),
      ),
    );
    const remainingCompleteHashBefore = preservedRowsHash(
      remainingCompleteRows,
      comparisonWidth,
    );
    const writeBodyStartIndex = remainingCompleteRows.length;
    const writeGridStartIndex = writeBodyStartIndex + 1;
    const writeGridEndIndex = writeGridStartIndex + newRows.length;
    const writtenIndexes = Array.from(
      { length: newRows.length },
      (_, index) => writeBodyStartIndex + index,
    );
    const formatBlocks = typedNumberFormatBlocks(newRows, writtenIndexes, true);

    const blocks = contiguousBlocks(matched);
    const requests = [];
    if (!hasHeader)
      requests.push({
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          inheritFromBefore: false,
        },
      });
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: comparisonWidth,
        },
        rows: [{
          values: Array.from(
            { length: comparisonWidth },
            (_, index) => literalValueCell(header[index]),
          ),
        }],
        fields: "userEnteredValue",
      },
    });
    for (const block of blocks.reverse())
      requests.push({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: block.start,
            endIndex: block.end,
          },
        },
      });
    const rowCountAfterDeletes =
      gridRowCount + (hasHeader ? 0 : 1) - matched.length;
    if (writeGridEndIndex > rowCountAfterDeletes) {
      requests.push({
        appendDimension: {
          sheetId,
          dimension: "ROWS",
          length: writeGridEndIndex - rowCountAfterDeletes,
        },
      });
    }
    if (newRows.length) {
      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: writeGridStartIndex,
            endRowIndex: writeGridEndIndex,
            startColumnIndex: 0,
            endColumnIndex: comparisonWidth,
          },
          rows: newRows.map((row) => ({
            values: Array.from(
              { length: comparisonWidth },
              (_, index) => literalValueCell(row[index]),
            ),
          })),
          fields: "userEnteredValue",
        },
      });
    }
    requests.push(
      ...formatBlocks.map((block) => numberFormatRequest(sheetId, block)),
    );
    let writeError;
    try {
      await this.batchUpdate(requests, { idempotent: false });
    } catch (error) {
      writeError = error;
    }

    let afterValues;
    try {
      afterValues = await readState();
    } catch (validationReadError) {
      if (writeError) throw writeError;
      throw validationReadError;
    }
    const expectedBodyLength = writeBodyStartIndex + newRows.length;
    const headerMatchesAfterWrite =
      afterValues.hasHeader &&
      completeRowsHash([afterValues.first], comparisonWidth) ===
        completeRowsHash([header], comparisonWidth);
    const remainingRowsMatchAfterWrite =
      afterValues.completeBody.length === expectedBodyLength &&
      preservedRowsHash(
        afterValues.completeBody.slice(0, writeBodyStartIndex),
        comparisonWidth,
      ) === remainingCompleteHashBefore;

    const writtenRowsAfter = writtenIndexes.map(
      (index) => afterValues.completeBody[index] || [],
    );
    const writtenValuesMatch =
      afterValues.body.length === expectedBodyLength &&
      completeRowsHash(writtenRowsAfter, comparisonWidth) ===
        completeRowsHash(newRows, comparisonWidth);

    if (
      !headerMatchesAfterWrite ||
      !remainingRowsMatchAfterWrite ||
      !writtenValuesMatch
    ) {
      if (writeError) throw writeError;
      throw new Error(`Validacao completa apos escrita falhou: ${sheetTitle}`);
    }

    const targetIndexesAfter = afterValues.body
      .map((row, index) => (shouldReplace(row, index) ? index : null))
      .filter((index) => index !== null);
    const targetIndexesMatch =
      targetIndexesAfter.length === writtenIndexes.length &&
      targetIndexesAfter.every(
        (value, index) => value === writtenIndexes[index],
      );
    if (!targetIndexesMatch) {
      if (writeError) throw writeError;
      throw new Error(`Validacao completa apos escrita falhou: ${sheetTitle}`);
    }

    let formatsMatch;
    try {
      formatsMatch = await this.numberFormatsMatch(sheetTitle, formatBlocks);
    } catch (validationError) {
      if (writeError) throw writeError;
      throw validationError;
    }
    if (!formatsMatch) {
      if (writeError) throw writeError;
      throw new Error(`Validacao de numberFormat apos escrita falhou: ${sheetTitle}`);
    }

    return {
      previous: body.length,
      removed: matched.length,
      inserted: newRows.length,
      final: expectedBodyLength,
    };
  }

  async replaceRowsViaStaging({
    sheetTitle,
    columnRange,
    header,
    newRows,
    shouldReplace,
    matchColumnIndexes,
  }) {
    if (!Array.isArray(header) || !header.length) {
      throw new Error("header obrigatorio");
    }
    if (!Array.isArray(newRows)) {
      throw new Error("newRows precisa ser array");
    }
    if (typeof shouldReplace !== "function") {
      throw new Error("shouldReplace obrigatorio");
    }

    const columnMatch = String(columnRange).match(/^([A-Z]+):([A-Z]+)$/i);
    if (!columnMatch) {
      throw new Error("columnRange precisa usar o formato A:Z");
    }
    const startColumnIndex = columnIndex(columnMatch[1]);
    const endColumnIndex = columnIndex(columnMatch[2]);
    if (startColumnIndex !== 0 || endColumnIndex < startColumnIndex) {
      throw new Error("replaceRows exige columnRange iniciado em A");
    }
    const comparisonWidth = endColumnIndex - startColumnIndex + 1;
    if (header.length > comparisonWidth) {
      throw new Error("header excede columnRange");
    }
    const invalidRow = newRows.findIndex(
      (row) => !Array.isArray(row) || row.length > comparisonWidth,
    );
    if (invalidRow !== -1) {
      throw new Error(`newRows[${invalidRow}] excede columnRange`);
    }
    if (!Array.isArray(matchColumnIndexes) || !matchColumnIndexes.length) {
      throw new Error("matchColumnIndexes obrigatorio para substituicao segura");
    }
    if (
      matchColumnIndexes.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= comparisonWidth,
      )
    ) {
      throw new Error("matchColumnIndexes contem coluna invalida");
    }

    const readState = async (title, completeWidth) => {
      const quotedTitle = quoteSheetTitle(title);
      const completeEndColumn = columnLetter(completeWidth - 1);
      const ranges = [
        `${quotedTitle}!A1:${completeEndColumn}1`,
        ...matchColumnIndexes.map(
          (index) =>
            `${quotedTitle}!${columnLetter(index)}:${columnLetter(index)}`,
        ),
      ];
      const [selectorValues, completeValues] = await Promise.all([
        this.getValuesBatch(ranges),
        this.getValuesBatch(
          [`${quotedTitle}!A:${completeEndColumn}`],
          {
            valueRenderOption: "FORMULA",
            dateTimeRenderOption: "SERIAL_NUMBER",
          },
        ),
      ]);
      const [headerRows, ...selectorColumns] = selectorValues;
      const first = headerRows[0] || [];
      const normalized = (value) =>
        String(value ?? "").trim().toLowerCase();
      const headerMatches = header.filter(
        (value, index) => normalized(first[index]) === normalized(value),
      ).length;
      const stateHasHeader =
        headerMatches >= Math.min(3, header.length);
      const columns = selectorColumns.map((column) =>
        stateHasHeader ? column.slice(1) : column,
      );
      const completeRows = completeValues[0] || [];
      const completeBodySource = stateHasHeader
        ? completeRows.slice(1)
        : completeRows;
      const bodyLength = Math.max(
        completeBodySource.length,
        0,
        ...columns.map((column) => column.length),
      );
      const body = Array.from({ length: bodyLength }, (_, rowIndex) => {
        const row = [];
        matchColumnIndexes.forEach((columnIndexValue, selectorIndex) => {
          row[columnIndexValue] =
            columns[selectorIndex][rowIndex]?.[0] ?? "";
        });
        return row;
      });
      const completeBody = Array.from(
        { length: bodyLength },
        (_, rowIndex) => completeBodySource[rowIndex] || [],
      );
      return { body, completeBody, first, hasHeader: stateHasHeader };
    };

    const readCompleteRows = async (title, width) => {
      const quotedTitle = quoteSheetTitle(title);
      const endColumn = columnLetter(width - 1);
      const values = await this.getValuesBatch(
        [`${quotedTitle}!A:${endColumn}`],
        {
          valueRenderOption: "FORMULA",
          dateTimeRenderOption: "SERIAL_NUMBER",
        },
      );
      return trimTrailingEmptyRows(values[0] || []);
    };

    const propertiesByTitle = await this.getSheetPropertiesByTitle({
      forceRefresh: true,
    });
    const originalProperties = propertiesByTitle[sheetTitle];
    if (!originalProperties) {
      throw new Error(`Aba nao encontrada: ${sheetTitle}`);
    }
    const originalSheetId = originalProperties.sheetId;
    const originalRowCount = Number(
      originalProperties.gridProperties?.rowCount,
    );
    const originalColumnCount = Number(
      originalProperties.gridProperties?.columnCount,
    );
    if (!Number.isInteger(originalRowCount) || originalRowCount < 1) {
      throw new Error(`rowCount invalido para a aba: ${sheetTitle}`);
    }
    if (!Number.isInteger(originalColumnCount) || originalColumnCount < 1) {
      throw new Error(`columnCount invalido para a aba: ${sheetTitle}`);
    }
    const targetColumnCount = Math.max(
      originalColumnCount,
      comparisonWidth,
    );
    let initialState = await readState(sheetTitle, targetColumnCount);
    const initialSnapshot = stateSnapshot(
      initialState,
      matchColumnIndexes,
      targetColumnCount,
    );
    const expectedHeader = Array.from(
      { length: targetColumnCount },
      (_, index) => {
        if (index < comparisonWidth) return header[index] ?? "";
        return initialState.hasHeader ? initialState.first[index] ?? "" : "";
      },
    );

    const hasHeader = initialState.hasHeader;
    const previousBodyLength = initialState.body.length;
    const matched = initialState.body
      .map((row, index) => (shouldReplace(row, index) ? index + 1 : null))
      .filter((index) => index !== null);
    const invalidReplacement = newRows.findIndex(
      (row, index) => !shouldReplace(row, index),
    );
    if (invalidReplacement !== -1) {
      throw new Error(
        `newRows[${invalidReplacement}] nao pertence ao conjunto substituido`,
      );
    }

    const matchedBodyIndexes = new Set(matched.map((index) => index - 1));
    let remainingCompleteRows = trimTrailingEmptyRows(
      initialState.completeBody.filter(
        (_, index) => !matchedBodyIndexes.has(index),
      ),
    );
    const remainingCompleteHash = preservedRowsHash(
      remainingCompleteRows,
      targetColumnCount,
    );
    const writeBodyStartIndex = remainingCompleteRows.length;
    remainingCompleteRows = null;
    initialState = null;
    const writtenIndexes = Array.from(
      { length: newRows.length },
      (_, index) => writeBodyStartIndex + index,
    );
    const expectedBodyLength = writeBodyStartIndex + newRows.length;
    const expectedGridRowCount = Math.max(1, expectedBodyLength + 1);
    const formatBlocks = typedNumberFormatBlocks(
      newRows,
      writtenIndexes,
      true,
    );

    const finalStateMatches = (state) => {
      const headerMatches =
        state.hasHeader &&
        completeRowsHash([state.first], targetColumnCount) ===
          completeRowsHash([expectedHeader], targetColumnCount);
      if (
        !headerMatches ||
        state.body.length !== expectedBodyLength ||
        state.completeBody.length !== expectedBodyLength
      ) {
        return false;
      }
      if (
        preservedRowsHash(
          state.completeBody.slice(0, writeBodyStartIndex),
          targetColumnCount,
        ) !== remainingCompleteHash
      ) {
        return false;
      }
      if (
        completeRowsHash(
          state.completeBody.slice(writeBodyStartIndex),
          targetColumnCount,
        ) !== completeRowsHash(newRows, targetColumnCount)
      ) {
        return false;
      }
      const targetIndexes = state.body
        .map((row, index) => (shouldReplace(row, index) ? index : null))
        .filter((index) => index !== null);
      return (
        targetIndexes.length === writtenIndexes.length &&
        targetIndexes.every(
          (value, index) => value === writtenIndexes[index],
        )
      );
    };

    const stagingSheetId = allocateStagingSheetId(propertiesByTitle);
    const stagingTitle = `_data_staging_${stagingSheetId}`;
    const stagingRowCount = Math.max(1, newRows.length);
    const stagingColumnCount = comparisonWidth;
    const stagingFormatBlocks = typedNumberFormatBlocks(
      newRows,
      newRows.map((_, index) => index),
      false,
    );

    let totalCurrentCells = 0;
    for (const properties of Object.values(propertiesByTitle)) {
      if (!properties.gridProperties) continue;
      const rowCount = Number(properties.gridProperties?.rowCount);
      const columnCount = Number(properties.gridProperties?.columnCount);
      if (
        !Number.isInteger(rowCount) ||
        rowCount < 1 ||
        !Number.isInteger(columnCount) ||
        columnCount < 1
      ) {
        throw new Error("Propriedades de grade invalidas na planilha");
      }
      totalCurrentCells += rowCount * columnCount;
    }
    const originalCells = originalRowCount * originalColumnCount;
    const finalOriginalCells = expectedGridRowCount * targetColumnCount;
    const peakOriginalCells = Math.max(
      originalCells + (hasHeader ? 0 : originalColumnCount),
      finalOriginalCells,
    );
    const projectedPeakCells =
      totalCurrentCells -
      originalCells +
      peakOriginalCells +
      stagingRowCount * stagingColumnCount;
    if (projectedPeakCells > MAX_SPREADSHEET_CELLS) {
      throw new Error(
        `Staging excederia o limite de ${MAX_SPREADSHEET_CELLS} celulas da planilha`,
      );
    }

    const gridProperties = { rowCount: expectedGridRowCount };
    const propertyFields = ["gridProperties.rowCount"];
    if (targetColumnCount !== originalColumnCount) {
      gridProperties.columnCount = targetColumnCount;
      propertyFields.push("gridProperties.columnCount");
    }
    const promotionRequests = [];
    if (!hasHeader) {
      promotionRequests.push({
        insertDimension: {
          range: {
            sheetId: originalSheetId,
            dimension: "ROWS",
            startIndex: 0,
            endIndex: 1,
          },
          inheritFromBefore: false,
        },
      });
    }
    for (const block of contiguousBlocks(matched).reverse()) {
      promotionRequests.push({
        deleteDimension: {
          range: {
            sheetId: originalSheetId,
            dimension: "ROWS",
            startIndex: block.start,
            endIndex: block.end,
          },
        },
      });
    }
    promotionRequests.push(
      {
        updateSheetProperties: {
          properties: {
            sheetId: originalSheetId,
            gridProperties,
          },
          fields: propertyFields.join(","),
        },
      },
      {
        updateCells: {
          range: {
            sheetId: originalSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: comparisonWidth,
          },
          rows: [
            {
              values: Array.from(
                { length: comparisonWidth },
                (_, index) => literalValueCell(header[index]),
              ),
            },
          ],
          fields: "userEnteredValue",
        },
      },
    );
    if (newRows.length) {
      promotionRequests.push({
        copyPaste: {
          source: {
            sheetId: stagingSheetId,
            startRowIndex: 0,
            endRowIndex: newRows.length,
            startColumnIndex: 0,
            endColumnIndex: comparisonWidth,
          },
          destination: {
            sheetId: originalSheetId,
            startRowIndex: writeBodyStartIndex + 1,
            endRowIndex: writeBodyStartIndex + newRows.length + 1,
            startColumnIndex: 0,
            endColumnIndex: comparisonWidth,
          },
          pasteType: "PASTE_NORMAL",
        },
      });
    }
    const promotionMaxBytes = positiveInteger(
      process.env.GOOGLE_SHEETS_PROMOTION_MAX_BYTES,
      1_500_000,
    );
    if (
      Buffer.byteLength(
        JSON.stringify({ requests: promotionRequests }),
        "utf8",
      ) > promotionMaxBytes
    ) {
      throw new Error(
        "Promocao atomica excederia o tamanho seguro de batchUpdate",
      );
    }

    let stagingCreated = false;
    let promotionState = "not-started";

    const deleteStaging = async () => {
      const before = await this.getSheetPropertiesByTitle({
        forceRefresh: true,
      });
      if (before[stagingTitle]?.sheetId !== stagingSheetId) {
        stagingCreated = false;
        return;
      }

      let deleteError;
      try {
        await this.batchUpdate(
          [{ deleteSheet: { sheetId: stagingSheetId } }],
          { idempotent: false },
        );
      } catch (error) {
        deleteError = error;
      }
      const after = await this.getSheetPropertiesByTitle({
        forceRefresh: true,
      });
      if (after[stagingTitle]?.sheetId !== stagingSheetId) {
        stagingCreated = false;
        return;
      }
      if (deleteError) throw deleteError;
      throw new Error("Falha ao remover aba staging");
    };

    try {
      let setupError;
      try {
        await this.batchUpdate(
          [
            {
              addSheet: {
                properties: {
                  sheetId: stagingSheetId,
                  title: stagingTitle,
                  hidden: true,
                  gridProperties: {
                    rowCount: stagingRowCount,
                    columnCount: stagingColumnCount,
                  },
                },
              },
            },
          ],
          { idempotent: false },
        );
      } catch (error) {
        setupError = error;
      }
      const stagingPropertiesByTitle =
        await this.getSheetPropertiesByTitle({ forceRefresh: true });
      const stagingProperties = stagingPropertiesByTitle[stagingTitle];
      stagingCreated = stagingProperties?.sheetId === stagingSheetId;
      if (!stagingCreated) {
        if (setupError) throw setupError;
        throw new Error("Aba staging nao foi criada");
      }
      if (
        stagingProperties.gridProperties?.rowCount !== stagingRowCount ||
        stagingProperties.gridProperties?.columnCount < stagingColumnCount
      ) {
        if (setupError) throw setupError;
        throw new Error("Propriedades da staging invalidas");
      }

      const maxChunkRows = positiveInteger(
        process.env.GOOGLE_SHEETS_STAGING_CHUNK_ROWS,
        500,
      );
      const maxChunkBytes = positiveInteger(
        process.env.GOOGLE_SHEETS_STAGING_CHUNK_BYTES,
        1_500_000,
      );
      const chunkWriteGate = new RateGate(
        nonNegativeInteger(
          process.env.GOOGLE_SHEETS_STAGING_CHUNK_INTERVAL_MS,
          1_250,
        ),
      );
      const chunks = stagingRowChunks(newRows, stagingColumnCount, {
        maxRows: maxChunkRows,
        maxBytes: maxChunkBytes,
      });
      for (const chunk of chunks) {
        await chunkWriteGate.wait();
        const gridStart = chunk.startIndex;
        await this.batchUpdate(
          [
            {
              updateCells: {
                range: {
                  sheetId: stagingSheetId,
                  startRowIndex: gridStart,
                  endRowIndex: gridStart + chunk.rows.length,
                  startColumnIndex: 0,
                  endColumnIndex: stagingColumnCount,
                },
                rows: chunk.rows,
                fields:
                  "userEnteredValue,userEnteredFormat.numberFormat",
              },
            },
          ],
          { idempotent: true },
        );
      }

      {
        const stagingRows = await readCompleteRows(
          stagingTitle,
          stagingColumnCount,
        );
        if (
          stagingRows.length !== newRows.length ||
          completeRowsHash(stagingRows, stagingColumnCount) !==
            completeRowsHash(newRows, stagingColumnCount)
        ) {
          throw new Error("Validacao de valores da staging falhou");
        }
      }
      if (
        !(await this.numberFormatsMatch(
          stagingTitle,
          stagingFormatBlocks,
        ))
      ) {
        throw new Error("Validacao de formatos da staging falhou");
      }

      let prePromotionState = await readState(
        sheetTitle,
        targetColumnCount,
      );
      const prePromotionMatches = stateMatchesSnapshot(
        prePromotionState,
        initialSnapshot,
        matchColumnIndexes,
        targetColumnCount,
      );
      prePromotionState = null;
      const prePromotionPropertiesByTitle =
        await this.getSheetPropertiesByTitle({ forceRefresh: true });
      const prePromotionProperties =
        prePromotionPropertiesByTitle[sheetTitle];
      if (
        !prePromotionProperties ||
        prePromotionProperties.sheetId !== originalSheetId ||
        prePromotionProperties.gridProperties?.rowCount !==
          originalRowCount ||
        prePromotionProperties.gridProperties?.columnCount !==
          originalColumnCount ||
        !prePromotionMatches
      ) {
        throw new Error(
          `Estado da planilha mudou antes da promocao: ${sheetTitle}`,
        );
      }

      promotionState = "attempted";
      let promotionError;
      try {
        await this.batchUpdate(promotionRequests, { idempotent: false });
      } catch (error) {
        promotionError = error;
      }

      const promotedState = await readState(
        sheetTitle,
        targetColumnCount,
      );
      const promotedPropertiesByTitle =
        await this.getSheetPropertiesByTitle({ forceRefresh: true });
      const promotedProperties = promotedPropertiesByTitle[sheetTitle];
      const valuesWerePromoted =
        promotedProperties?.sheetId === originalSheetId &&
        promotedProperties.gridProperties?.rowCount ===
          expectedGridRowCount &&
        promotedProperties.gridProperties?.columnCount >= targetColumnCount &&
        finalStateMatches(promotedState);
      let formatsWerePromoted = false;
      if (valuesWerePromoted) {
        formatsWerePromoted = await this.numberFormatsMatch(
          sheetTitle,
          formatBlocks,
        );
      }
      const originalIsUnchanged =
        promotedProperties?.sheetId === originalSheetId &&
        promotedProperties.gridProperties?.rowCount === originalRowCount &&
        promotedProperties.gridProperties?.columnCount ===
          originalColumnCount &&
        stateMatchesSnapshot(
          promotedState,
          initialSnapshot,
          matchColumnIndexes,
          targetColumnCount,
        );
      if (
        promotionError &&
        valuesWerePromoted &&
        formatsWerePromoted &&
        originalIsUnchanged
      ) {
        promotionState = "unknown";
        throw new Error(
          `Resultado ambiguo da promocao: ${sheetTitle}`,
          { cause: promotionError },
        );
      }
      if (valuesWerePromoted && formatsWerePromoted) {
        promotionState = "promoted";
      } else {
        if (promotionError && originalIsUnchanged) {
          promotionState = "unchanged";
          throw promotionError;
        }
        promotionState = "unknown";
        if (promotionError) throw promotionError;
        throw new Error(`Validacao apos promocao falhou: ${sheetTitle}`);
      }

      await deleteStaging();
      return {
        previous: previousBodyLength,
        removed: matched.length,
        inserted: newRows.length,
        final: expectedBodyLength,
      };
    } catch (error) {
      if (
        stagingCreated &&
        (promotionState === "not-started" ||
          promotionState === "unchanged")
      ) {
        try {
          await deleteStaging();
        } catch {
          // The original error is more useful. The staging sheet is hidden and
          // deliberately retained if cleanup cannot be confirmed.
        }
      }
      throw error;
    }
  }
}

GoogleSheets.literalCell = literalCell;
GoogleSheets.dateCell = dateCell;
GoogleSheets.dateTimeCell = dateTimeCell;
GoogleSheets.timeCell = timeCell;
GoogleSheets.monthCell = monthCell;
GoogleSheets.textCell = textCell;

module.exports = GoogleSheets;
