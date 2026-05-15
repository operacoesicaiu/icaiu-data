const runZohoLeadsSync = require('./zoho-leads-sync');

async function run() {
  try {
    await runZohoLeadsSync({ days: 7, label: 'últimos 7 dias' });
  } catch (e) {
    console.error('[contact_site] Erro:', e.response?.data || e.message);
    process.exit(1);
  }
}

module.exports = run;
