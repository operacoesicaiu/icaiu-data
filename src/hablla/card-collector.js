const { extractCards } = require("./response-contracts");

const DEFAULT_MAX_PAGES = 2000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_PAGES_WITHOUT_RECENT_CREATED = 2;

function positiveInteger(value, fallback, name) {
  const selected = value === undefined || value === null || value === ""
    ? fallback
    : value;
  const number = Number(selected);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} precisa ser inteiro >= 1`);
  }
  return number;
}

function requiredId(card, page, index) {
  const { id } = card;
  const validType = typeof id === "string" || typeof id === "number";
  if (
    !validType ||
    (typeof id === "number" && !Number.isFinite(id)) ||
    String(id).trim() === ""
  ) {
    throw new Error(
      `Hablla retornou card sem id valido na pagina ${page}, indice ${index}`,
    );
  }
  return String(id);
}

function requiredUpdatedAt(card, page, index) {
  const value = card.updated_at;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Hablla retornou card sem updated_at na pagina ${page}, indice ${index}`,
    );
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `Hablla retornou updated_at invalido na pagina ${page}, indice ${index}`,
    );
  }
  return timestamp;
}

function requiredCreatedAt(card, page, index) {
  const value = card.created_at;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Hablla retornou card sem created_at na pagina ${page}, indice ${index}`,
    );
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      `Hablla retornou created_at invalido na pagina ${page}, indice ${index}`,
    );
  }
  return timestamp;
}

function parseCutoff(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("cutoff dos cards Hablla e invalido");
  }
  return timestamp;
}

function pageFingerprint(validatedCards) {
  return JSON.stringify(
    validatedCards.map(({ id, createdAt, updatedAt }) => [
      id,
      createdAt,
      updatedAt,
    ]),
  );
}

async function collectHabllaCards({
  hablla,
  workspaceId,
  boardId,
  cutoff,
  maxPages = process.env.HABLLA_CARDS_MAX_PAGES,
  pageSize = DEFAULT_PAGE_SIZE,
  pagesWithoutRecentCreated =
    process.env.HABLLA_CARDS_PAGES_WITHOUT_RECENT_CREATED,
}) {
  if (!hablla || typeof hablla.get !== "function") {
    throw new Error("Cliente Hablla invalido");
  }
  if (!workspaceId) throw new Error("HABLLA_WORKSPACE_ID ausente");
  if (!boardId) throw new Error("HABLLA_BOARD_ID ausente");

  const cutoffTimestamp = parseCutoff(cutoff);
  const cutoffIso = new Date(cutoffTimestamp).toISOString();
  const safeMaxPages = positiveInteger(
    maxPages,
    DEFAULT_MAX_PAGES,
    "HABLLA_CARDS_MAX_PAGES",
  );
  const safePageSize = positiveInteger(
    pageSize,
    DEFAULT_PAGE_SIZE,
    "pageSize",
  );
  const safePagesWithoutRecentCreated = positiveInteger(
    pagesWithoutRecentCreated,
    DEFAULT_PAGES_WITHOUT_RECENT_CREATED,
    "HABLLA_CARDS_PAGES_WITHOUT_RECENT_CREATED",
  );
  const cardsById = new Map();
  const pageFingerprints = new Set();
  let consecutivePagesWithoutRecentCreated = 0;
  let completed = false;

  for (let page = 1; page <= safeMaxPages; page++) {
    const response = await hablla.get(
      `/v3/workspaces/${workspaceId}/cards`,
      {
        params: {
          board: boardId,
          limit: safePageSize,
          page,
          updated_after: cutoffIso,
          order: "updated_at",
          direction: "desc",
        },
      },
    );
    const cards = extractCards(response.data);
    if (!cards.length) {
      completed = true;
      break;
    }

    const validatedCards = cards.map((card, index) => ({
      card,
      id: requiredId(card, page, index),
      createdAt: requiredCreatedAt(card, page, index),
      updatedAt: requiredUpdatedAt(card, page, index),
    }));
    for (const { createdAt, updatedAt } of validatedCards) {
      if (createdAt > updatedAt) {
        throw new Error("Hablla retornou card com created_at posterior a updated_at");
      }
    }
    const fingerprint = pageFingerprint(validatedCards);
    if (pageFingerprints.has(fingerprint)) {
      throw new Error("Hablla repetiu uma pagina de cards");
    }
    pageFingerprints.add(fingerprint);

    const pageHasRecentCreated = validatedCards.some(
      ({ createdAt }) => createdAt >= cutoffTimestamp,
    );
    for (const item of validatedCards) {
      // A API pagina por updated_at, mas a janela de negocio e created_at.
      if (item.createdAt >= cutoffTimestamp) {
        const existing = cardsById.get(item.id);
        if (!existing || item.updatedAt > existing.updatedAt) {
          cardsById.set(item.id, item);
        }
      }
    }

    consecutivePagesWithoutRecentCreated = pageHasRecentCreated
      ? 0
      : consecutivePagesWithoutRecentCreated + 1;
    if (
      consecutivePagesWithoutRecentCreated >=
      safePagesWithoutRecentCreated
    ) {
      completed = true;
      break;
    }
    if (cards.length < safePageSize) {
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new Error(
      `Hablla atingiu o limite seguro de ${safeMaxPages} paginas de cards`,
    );
  }

  return [...cardsById.values()].map(({ card }) => card);
}

module.exports = collectHabllaCards;
module.exports.DEFAULT_MAX_PAGES = DEFAULT_MAX_PAGES;
module.exports.DEFAULT_PAGES_WITHOUT_RECENT_CREATED =
  DEFAULT_PAGES_WITHOUT_RECENT_CREATED;
