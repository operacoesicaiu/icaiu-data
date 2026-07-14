const TIME_ZONE = "America/Sao_Paulo";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function parts(formatter, date) {
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function dateKey(date) {
  const value = parts(dateFormatter, date);
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function shiftDateKey(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function timeZoneOffsetMs(date) {
  const value = parts(dateTimeFormatter, date);
  const representedAsUtc = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  return representedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function startOfDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const requestedWallClock = Date.UTC(year, month - 1, day);
  let instant = requestedWallClock;

  for (let attempt = 0; attempt < 3; attempt++) {
    const adjusted =
      requestedWallClock - timeZoneOffsetMs(new Date(instant));
    if (adjusted === instant) break;
    instant = adjusted;
  }

  return new Date(instant);
}

function saoPauloDayRange(daysAgo, now = new Date()) {
  if (!Number.isInteger(daysAgo) || daysAgo < 0) {
    throw new Error("daysAgo precisa ser inteiro >= 0");
  }

  const day = shiftDateKey(dateKey(now), -daysAgo);
  const nextDay = shiftDateKey(day, 1);
  const start = startOfDate(day);
  const end = new Date(startOfDate(nextDay).getTime() - 1);
  const [year, month, date] = day.split("-");

  return {
    day,
    label: `${date}/${month}/${year}`,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

module.exports = saoPauloDayRange;
