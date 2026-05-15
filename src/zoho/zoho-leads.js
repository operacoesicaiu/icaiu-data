const runZohoLeadsSync = require('./zoho-leads-sync');
const formatPublicError = require('../lib/public-error');

async function run() {
  try {
    await runZohoLeadsSync({ days: 15, label: 'últimos 15 dias' });
  } catch (e) {
    console.error('[contact_site] Erro:', formatPublicError(e));
    process.exit(1);
  }
}

module.exports = run;