function sanitize(val) {
    if (typeof val !== 'string') return val;

    const formulaChars = ['=', '+', '-', '@'];

    if (formulaChars.some(char => val.startsWith(char))) {
        return `'${val}`;
    }

    return val;
}

module.exports = sanitize;