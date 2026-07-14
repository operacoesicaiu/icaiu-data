const crypto = require("crypto");
const axios = require("axios");
const { getGoogleAccessToken } = require("./auth");
const { backoffMs, isRetryableNetworkError, isRetryableStatus, sleep } = require("../lib/http-retry");

const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
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

function secureStateHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalRow(row, width) {
  return Array.from({ length: width }, (_, index) => canonicalCell(row[index]));
}

function completeRowsHash(rows, width) {
  return secureStateHash(rows.map((row) => canonicalRow(row, width)));
}

function selectedRowsHash(rows, indexes, { omitEmpty = false } = {}) {
  const state = [];
  for (const row of rows) {
    const values = indexes.map((index) => canonicalCell(row[index]));
    if (omitEmpty && values.every((value) => value[0] === "empty")) continue;
    state.push(values);
  }
  return secureStateHash(state);
}

function selectorSnapshotHash(state, indexes, headerWidth) {
  return secureStateHash({
    hasHeader: state.hasHeader,
    header: canonicalRow(state.first, headerWidth),
    rows: state.body.map((row) => indexes.map((index) => canonicalCell(row[index]))),
  });
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

class GoogleSheets {
  constructor({ spreadsheetId, accessToken, tokenExpiresAt, refreshAccessToken }) {
    if (!spreadsheetId) throw new Error("spreadsheetId obrigatorio");
    if (!accessToken) throw new Error("accessToken obrigatorio");

    this.spreadsheetId = spreadsheetId;
    this.tokenExpiresAt = Number(tokenExpiresAt || process.env.GOOGLE_TOKEN_EXPIRES_AT || 0);
    this.refreshAccessToken = refreshAccessToken || (() => getGoogleAccessToken({ forceRefresh: true }));
    this.refreshPromise = null;
    this.sheetIdsPromise = null;
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

  async getSheetIdByTitle() {
    if (!this.sheetIdsPromise) {
      this.sheetIdsPromise = this.getSpreadsheet().then((spreadsheet) => {
        const result = {};
        for (const sheet of spreadsheet.sheets || []) result[sheet.properties.title] = sheet.properties.sheetId;
        return result;
      });
    }
    return this.sheetIdsPromise;
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

  async applyTypedNumberFormats(sheetTitle, sheetId, blocks) {
    if (!blocks.length) return;
    let writeError;
    for (let start = 0; start < blocks.length; start += 500) {
      const requests = blocks
        .slice(start, start + 500)
        .map((block) => numberFormatRequest(sheetId, block));
      try {
        await this.batchUpdate(requests, { idempotent: true });
      } catch (error) {
        writeError ||= error;
      }
    }

    let formatsMatch;
    try {
      formatsMatch = await this.numberFormatsMatch(sheetTitle, blocks);
    } catch (validationError) {
      if (writeError) throw writeError;
      throw validationError;
    }
    if (!formatsMatch) {
      if (writeError) throw writeError;
      throw new Error(`Validacao de numberFormat apos escrita falhou: ${sheetTitle}`);
    }
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
      const [headerRows, ...selectorColumns] = await this.getValuesBatch(ranges);
      const first = headerRows[0] || [];
      const normalized = (value) => String(value ?? "").trim().toLowerCase();
      const headerMatches = header.filter((value, index) => normalized(first[index]) === normalized(value)).length;
      const stateHasHeader = headerMatches >= Math.min(3, header.length);
      const columns = selectorColumns.map((column) =>
        stateHasHeader ? column.slice(1) : column,
      );
      const bodyLength = Math.max(0, ...columns.map((column) => column.length));
      const body = Array.from({ length: bodyLength }, (_, rowIndex) => {
        const row = [];
        matchColumnIndexes.forEach((columnIndexValue, selectorIndex) => {
          row[columnIndexValue] = columns[selectorIndex][rowIndex]?.[0] ?? "";
        });
        return row;
      });
      return { body, first, hasHeader: stateHasHeader };
    };

    const readCompleteRowsAtIndexes = async (indexes, stateHasHeader) => {
      const blocks = contiguousBlocks(indexes);
      const rows = [];
      for (let start = 0; start < blocks.length; start += 50) {
        const chunk = blocks.slice(start, start + 50);
        const ranges = chunk.map((block) => {
          const rowOffset = stateHasHeader ? 2 : 1;
          const firstRow = block.start + rowOffset;
          const lastRow = block.end - 1 + rowOffset;
          return `${quotedTitle}!${columnMatch[1]}${firstRow}:${columnMatch[2]}${lastRow}`;
        });
        const valuesByBlock = await this.getValuesBatch(ranges, {
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "SERIAL_NUMBER",
        });
        chunk.forEach((block, blockIndex) => {
          const values = valuesByBlock[blockIndex] || [];
          for (let offset = 0; offset < block.end - block.start; offset++) {
            rows.push(values[offset] || []);
          }
        });
      }
      return rows;
    };

    const initialState = await readState();
    const sheetIds = await this.getSheetIdByTitle();
    const sheetId = sheetIds[sheetTitle];
    if (sheetId === undefined)
      throw new Error(`Aba nao encontrada: ${sheetTitle}`);

    const preWriteState = await readState();
    if (
      selectorSnapshotHash(initialState, matchColumnIndexes, comparisonWidth) !==
      selectorSnapshotHash(preWriteState, matchColumnIndexes, comparisonWidth)
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
    const nonTargetBefore = body.filter((_, index) => !matchedBodyIndexes.has(index));
    const nonTargetHashBefore = selectedRowsHash(
      nonTargetBefore,
      matchColumnIndexes,
      { omitEmpty: true },
    );

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
          endColumnIndex: header.length,
        },
        rows: [{ values: header.map(literalCell) }],
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
    if (newRows.length)
      requests.push({
        appendCells: {
          sheetId,
          rows: newRows.map((row) => ({ values: row.map(literalValueCell) })),
          fields: "userEnteredValue",
        },
      });
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
    const expectedBodyLength = body.length - matched.length + newRows.length;
    const appendedStartIndex = afterValues.body.length - newRows.length;
    const appendedIndexes = Array.from(
      { length: newRows.length },
      (_, index) => appendedStartIndex + index,
    );
    const appendedIndexSet = new Set(appendedIndexes);
    const nonTargetAfterValues = afterValues.body.filter(
      (_, index) => !appendedIndexSet.has(index),
    );
    const headerMatchesBeforeFormat =
      afterValues.hasHeader &&
      completeRowsHash([afterValues.first], comparisonWidth) ===
        completeRowsHash([header], comparisonWidth);
    const nonTargetMatchesBeforeFormat =
      selectedRowsHash(nonTargetAfterValues, matchColumnIndexes, {
        omitEmpty: true,
      }) ===
      nonTargetHashBefore;

    let appendedRowsAfter;
    try {
      appendedRowsAfter = await readCompleteRowsAtIndexes(
        appendedIndexes,
        afterValues.hasHeader,
      );
    } catch (validationReadError) {
      if (writeError) throw writeError;
      throw validationReadError;
    }
    const appendedValuesMatch =
      appendedStartIndex >= 0 &&
      afterValues.body.length === expectedBodyLength &&
      completeRowsHash(appendedRowsAfter, comparisonWidth) ===
        completeRowsHash(newRows, comparisonWidth);

    if (
      !headerMatchesBeforeFormat ||
      !nonTargetMatchesBeforeFormat ||
      !appendedValuesMatch
    ) {
      if (writeError) throw writeError;
      throw new Error(`Validacao completa apos escrita falhou: ${sheetTitle}`);
    }

    const formatBlocks = typedNumberFormatBlocks(
      newRows,
      appendedIndexes,
      afterValues.hasHeader,
    );
    await this.applyTypedNumberFormats(sheetTitle, sheetId, formatBlocks);

    const after = await readState();
    const targetIndexesAfter = after.body
      .map((row, index) => (shouldReplace(row, index) ? index : null))
      .filter((index) => index !== null);
    const targetIndexSetAfter = new Set(targetIndexesAfter);
    const nonTargetAfter = after.body.filter(
      (_, index) => !targetIndexSetAfter.has(index),
    );
    const targetIndexesMatch =
      targetIndexesAfter.length === appendedIndexes.length &&
      targetIndexesAfter.every(
        (value, index) => value === appendedIndexes[index],
      );
    const headerMatchesCompletely =
      after.hasHeader &&
      completeRowsHash([after.first], comparisonWidth) ===
        completeRowsHash([header], comparisonWidth);
    const nonTargetMatches =
      selectedRowsHash(nonTargetAfter, matchColumnIndexes, { omitEmpty: true }) ===
      nonTargetHashBefore;
    const completeRowsAfter = await readCompleteRowsAtIndexes(
      targetIndexesAfter,
      after.hasHeader,
    );
    const targetMatchesCompletely =
      targetIndexesMatch &&
      after.body.length === expectedBodyLength &&
      completeRowsHash(completeRowsAfter, comparisonWidth) ===
        completeRowsHash(newRows, comparisonWidth);

    if (!headerMatchesCompletely || !nonTargetMatches || !targetMatchesCompletely) {
      throw new Error(`Validacao completa apos formatacao falhou: ${sheetTitle}`);
    }

    return {
      previous: body.length,
      removed: matched.length,
      inserted: newRows.length,
      final: body.length - matched.length + newRows.length,
    };
  }
}

GoogleSheets.literalCell = literalCell;
GoogleSheets.dateCell = dateCell;
GoogleSheets.dateTimeCell = dateTimeCell;
GoogleSheets.timeCell = timeCell;
GoogleSheets.monthCell = monthCell;
GoogleSheets.textCell = textCell;

module.exports = GoogleSheets;
