function extractZenviaList(response, key, dataset) {
  if (Number(response?.status) !== 200) {
    throw new Error(`Zenvia retornou status inesperado para ${dataset}`);
  }
  const data = response.data;
  const envelope = data?.dados;
  if (
    !data ||
    typeof data !== "object" ||
    !envelope ||
    typeof envelope !== "object" ||
    !Object.prototype.hasOwnProperty.call(envelope, key) ||
    !Array.isArray(envelope[key])
  ) {
    throw new Error(`Zenvia retornou lista invalida para ${dataset}`);
  }
  return envelope[key];
}

module.exports = { extractZenviaList };
