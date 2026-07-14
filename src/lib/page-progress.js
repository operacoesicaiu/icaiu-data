function createIdPageTracker({ source, idOf }) {
  if (!source || typeof idOf !== "function") {
    throw new Error("Rastreador de paginas requer source e idOf");
  }

  const fingerprints = new Set();
  const seenIds = new Set();

  return {
    observe(records) {
      if (!Array.isArray(records)) {
        throw new Error(`${source} retornou pagina em formato invalido`);
      }
      if (!records.length) return;

      const ids = records.map((record) => {
        const value = idOf(record);
        if (value === undefined || value === null || value === "") {
          throw new Error(`${source} retornou registro sem identificador`);
        }
        return String(value);
      });

      if (new Set(ids).size !== ids.length) {
        throw new Error(`${source} retornou identificadores duplicados na mesma pagina`);
      }

      const fingerprint = `${ids.length}:${ids.join("\u001f")}`;
      if (fingerprints.has(fingerprint)) {
        throw new Error(`${source} repetiu uma pagina`);
      }
      fingerprints.add(fingerprint);

      const newIds = ids.filter((id) => !seenIds.has(id));
      if (!newIds.length) {
        throw new Error(`${source} nao avancou na paginacao`);
      }
      for (const id of newIds) seenIds.add(id);
    },
  };
}

module.exports = { createIdPageTracker };
