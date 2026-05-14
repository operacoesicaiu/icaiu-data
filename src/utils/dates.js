function formatarDataBR(dataISO) {
    if (!dataISO) return null;

    try {
        return new Date(dataISO).toISOString();
    } catch {
        return null;
    }
}

module.exports = {
    formatarDataBR
};