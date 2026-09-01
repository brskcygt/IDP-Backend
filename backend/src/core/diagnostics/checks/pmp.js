'use strict';

/**
 * T-73 PMP vault check (ManageEngine PMP REST API) — shared by the PMP
 * provider and any Server/SSH/WinRM project configured with authType: 'pmp'.
 */

const { makeCheck } = require('./shared');

async function testPmpVault({ pmpConfig, PmpService }) {
  if (!pmpConfig || !pmpConfig.baseUrl || !pmpConfig.authToken) {
    return makeCheck('PMP Vault', null, 'PMP vault not configured — nothing to test.');
  }
  const result = await PmpService.testConnection(pmpConfig);
  return makeCheck(
    'PMP Vault',
    !!result.success,
    result.message || (result.success ? 'Connected.' : 'Failed to connect to the PMP vault.')
  );
}

module.exports = { testPmpVault };
