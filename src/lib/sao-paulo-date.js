const TIME_ZONE = "America/Sao_Paulo";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function validDate(value, name = "date") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} invalida`);
  return date;
}

// A UTC-midnight Date is used only as a timezone-independent carrier for a
// business calendar day. Consumers must use the UTC getters below.
function today(now = new Date()) {
  const parts = dateFormatter.formatToParts(validDate(now, "now"));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function addDays(date, days) {
  if (!Number.isInteger(days)) throw new Error("days precisa ser inteiro");
  const result = new Date(validDate(date).getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function startOfMonth(date, monthOffset = 0) {
  if (!Number.isInteger(monthOffset)) {
    throw new Error("monthOffset precisa ser inteiro");
  }
  const value = validDate(date);
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + monthOffset, 1),
  );
}

function atTime(date, hours = 0, minutes = 0, seconds = 0, milliseconds = 0) {
  const value = validDate(date);
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      hours,
      minutes,
      seconds,
      milliseconds,
    ),
  );
}

function isoDay(date) {
  return validDate(date).toISOString().slice(0, 10);
}

module.exports = { TIME_ZONE, addDays, atTime, isoDay, startOfMonth, today };
