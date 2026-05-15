function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function formatPublicError(error) {
  if (!error) return 'unknown error';

  const parts = [];

  if (error.response?.status) {
    parts.push(`status=${error.response.status}`);
  }

  if (error.code) {
    parts.push(`code=${oneLine(error.code)}`);
  }

  if (error.message) {
    parts.push(`message=${oneLine(error.message)}`);
  }

  return parts.join(' | ') || 'unknown error';
}

module.exports = formatPublicError;