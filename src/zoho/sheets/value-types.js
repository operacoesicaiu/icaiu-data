const GoogleSheets = require("../../google/sheets");

const MONTHS = [
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

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function monthNumber(value) {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  const index = MONTHS.findIndex(
    (month) => month.toLowerCase() === String(value).toLowerCase(),
  );
  return index < 0 ? 0 : index + 1;
}

function parseDatePart(value) {
  const text = String(value).trim();
  let match = text.match(/^(\d{1,2})[-/]([A-Za-z]{3}|\d{1,2})[-/](\d{4})$/);
  if (!match) {
    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) match = [match[0], match[3], match[2], match[1]];
  }
  if (!match) throw new Error("Data Zoho em formato inesperado");

  const day = Number(match[1]);
  const month = monthNumber(match[2]);
  const year = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("Data Zoho invalida");
  }
  return { day, month, year };
}

function parseTimePart(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Hora Zoho em formato inesperado");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("Hora Zoho invalida");
  }
  return { hour, minute, second };
}

function dateTimeParts(value) {
  const text = String(value).trim();
  const match = text.match(/^(.+?)[ T](\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (!match) throw new Error("Data/hora Zoho em formato inesperado");
  return { ...parseDatePart(match[1]), ...parseTimePart(match[2]) };
}

function toDateTimeCell(value, { pattern = "dd/mm/yyyy hh:mm:ss" } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const parts = dateTimeParts(value);
  const text =
    `${twoDigits(parts.day)}/${twoDigits(parts.month)}/${parts.year} ` +
    `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}:${twoDigits(parts.second)}`;
  return GoogleSheets.dateTimeCell(text, { pattern });
}

function toDateCell(value, { pattern = "dd/mm/yyyy" } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const parts = parseDatePart(value);
  return GoogleSheets.dateCell(
    `${twoDigits(parts.day)}/${twoDigits(parts.month)}/${parts.year}`,
    { pattern },
  );
}

function toTimeCell(value, { pattern = "hh:mm:ss" } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const parts = parseTimePart(value);
  return GoogleSheets.timeCell(
    `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}:${twoDigits(parts.second)}`,
    { pattern },
  );
}

function toMonthCell(value, { pattern = "mm/yyyy" } = {}) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  let month;
  let year;
  const monthMatch = text.match(/^([A-Za-z]{3}|\d{1,2})[-/](\d{4})$/);
  if (monthMatch) {
    month = monthNumber(monthMatch[1]);
    year = Number(monthMatch[2]);
  } else {
    const date = parseDatePart(text);
    month = date.month;
    year = date.year;
  }
  if (month < 1 || month > 12 || year < 1900) {
    throw new Error("Mes Zoho invalido");
  }
  return GoogleSheets.monthCell(`${twoDigits(month)}/${year}`, { pattern });
}

function digitsToNumber(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Campo numerico Zoho excede a precisao segura");
  }
  return number;
}

module.exports = {
  digitsToNumber,
  toDateCell,
  toDateTimeCell,
  toMonthCell,
  toTimeCell,
};
