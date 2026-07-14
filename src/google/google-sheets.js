const axios = require("axios");

const SHEETS_BASE_URL = "https://sheets.googleapis.com/v4/spreadsheets";

function encodeRange(range) {
  return encodeURIComponent(range).replace(/%21/g, "!");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCell(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "number")
    return { userEnteredValue: { numberValue: value } };
  if (typeof value === "boolean")
    return { userEnteredValue: { boolValue: value } };
  return { userEnteredValue: { stringValue: String(value) } };
}

class GoogleSheets {
  constructor({ spreadsheetId, accessToken }) {
    if (!spreadsheetId) throw new Error("spreadsheetId obrigatorio");
    if (!accessToken) throw new Error("accessToken obrigatorio");

    this.spreadsheetId = spreadsheetId;
    this.http = axios.create({
      baseURL: `${SHEETS_BASE_URL}/${spreadsheetId}`,
      timeout: 60000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async request(config, { maxAttempts = 4, operation = config.url } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.http.request(config);
      } catch (error) {
        const status = error.response?.status;
        const retryable =
          status === 429 ||
          status >= 500 ||
          ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(error.code);
        if (retryable && attempt < maxAttempts - 1) {
          await sleep((attempt + 1) * 2000);
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
    const spreadsheet = await this.getSpreadsheet();
    const result = {};
    for (const sheet of spreadsheet.sheets || []) {
      result[sheet.properties.title] = sheet.properties.sheetId;
    }
    return result;
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
      },
      {
        operation: `batchGet(${ranges.join(", ")})`,
      },
    );
    return (response.data.valueRanges || []).map((item) => item.values || []);
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
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
      },
      data: { values },
    });
    return response.data;
  }

  async replaceRows({
    sheetTitle,
    columnRange,
    header,
    newRows,
    shouldReplace,
  }) {
    if (!Array.isArray(header) || !header.length)
      throw new Error("header obrigatorio");
    if (!Array.isArray(newRows)) throw new Error("newRows precisa ser array");

    const range = `'${sheetTitle.replace(/'/g, "''")}'!${columnRange}`;
    const current = await this.getValues(range);
    const normalized = (value) =>
      String(value ?? "")
        .trim()
        .toLowerCase();
    const first = current[0] || [];
    const headerMatches = header.filter(
      (value, index) => normalized(first[index]) === normalized(value),
    ).length;
    const hasHeader = headerMatches >= Math.min(3, header.length);
    const body = hasHeader ? current.slice(1) : current;
    const sheetIds = await this.getSheetIdByTitle();
    const sheetId = sheetIds[sheetTitle];
    if (sheetId === undefined)
      throw new Error(`Aba nao encontrada: ${sheetTitle}`);
    const matched = body
      .map((row, index) => (shouldReplace(row, index) ? index + 1 : null))
      .filter((index) => index !== null);
    const blocks = [];
    for (const index of matched) {
      const last = blocks.at(-1);
      if (last && last.end === index) last.end = index + 1;
      else blocks.push({ start: index, end: index + 1 });
    }
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
        rows: [{ values: header.map(toCell) }],
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
          rows: newRows.map((row) => ({ values: row.map(toCell) })),
          fields: "userEnteredValue",
        },
      });
    await this.batchUpdate(requests, { idempotent: false });
    return {
      previous: body.length,
      removed: matched.length,
      inserted: newRows.length,
      final: body.length - matched.length + newRows.length,
    };
  }
}

module.exports = GoogleSheets;
