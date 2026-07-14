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

  // Third-party HTTP/database messages may echo URLs, query values or payloads.
  // Only include messages created locally (plain Error without provider metadata).
  if (error.message && !error.isAxiosError && !error.response && !error.code) {
    parts.push(`message=${oneLine(error.message)}`);
  }

  return parts.join(' | ') || 'unknown error';
}

module.exports = formatPublicError;
