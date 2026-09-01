const axios = require('axios');
const https = require('https');

class PmpService {
  /**
   * SECURITY (SEC-07): Builds a per-request https.Agent honoring pmpConfig.allowSelfSigned.
   * Defaults to secure (rejectUnauthorized: true) whenever allowSelfSigned is not exactly
   * `true` — including when it's undefined. This used to be a single agent created once in
   * the constructor with rejectUnauthorized hardcoded to false for every PMP call
   * regardless of config; that has been removed.
   *
   * If the real problem is an internal/enterprise CA (e.g. PMP served with a self-signed
   * or internally-issued cert), the correct fix is to trust that CA properly via the
   * NODE_EXTRA_CA_CERTS environment variable rather than disabling verification.
   */
  _createHttpsAgent(allowSelfSigned) {
    return new https.Agent({ rejectUnauthorized: allowSelfSigned !== true });
  }

  /**
   * Helper to create a configured Axios client for PMP REST API v1.
   */
  _createClient(baseUrl, authToken, allowSelfSigned) {
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    return axios.create({
      baseURL: `${cleanBaseUrl}/restapi/json/v1`,
      headers: {
        'AUTHTOKEN': authToken,
        'Content-Type': 'application/json'
      },
      httpsAgent: this._createHttpsAgent(allowSelfSigned),
      timeout: 15000 // 15 seconds timeout
    });
  }

  _validatePmpResponse(response, contextMessage) {
    if (response.status !== 200) {
      throw new Error(`Unexpected HTTP status: ${response.status} while ${contextMessage}.`);
    }

    console.log(`PMP Raw Response (${contextMessage}):`, JSON.stringify(response.data, null, 2));

    const result = response.data?.operation?.result;
    if (result && result.status !== 'Success') {
      throw new Error(`PMP API Hatası: ${result.message || 'Yetkilendirme veya istek hatası'}`);
    }

    const rawDetails = response.data?.operation?.Details || response.data?.operation?.details;
    if (!rawDetails) {
      throw new Error(`PMP kaynak listesi döndürmedi. Yanıt: ${JSON.stringify(response.data)}`);
    }

    return rawDetails;
  }

  async _findResource(client, targetResourceName) {
    const response = await client.get('/resources');
    const resources = this._validatePmpResponse(response, 'fetching resources');
    
    if (!Array.isArray(resources)) {
      throw new Error('Invalid resources list returned from PMP. (operation.Details is not an array)');
    }

    const target = (targetResourceName || '').trim().toLowerCase();
    const resource = resources.find(r => {
      const name = (r['RESOURCE NAME'] || r.RESOURCE_NAME || r.resourceName || '').trim().toLowerCase();
      return name === target;
    });

    if (!resource) {
      const available = resources.map(r => r['RESOURCE NAME'] || r.RESOURCE_NAME || r.resourceName).filter(Boolean).join(', ');
      throw new Error(`Resource '${targetResourceName}' bulunamadı. Mevcut kaynaklar: [${available}]`);
    }

    const resourceId = resource['RESOURCE ID'] || resource.RESOURCE_ID || resource.resourceId;
    if (!resourceId) {
      throw new Error(`Could not extract RESOURCE ID for resource '${targetResourceName}'.`);
    }

    return resourceId;
  }

  async _findAccount(client, resourceId, targetAccountName) {
    const response = await client.get(`/resources/${resourceId}/accounts`);
    const details = this._validatePmpResponse(response, 'fetching accounts');
    
    // PMP specific format: Accounts are inside ACCOUNT LIST
    const accounts = details['ACCOUNT LIST'] || details.ACCOUNT_LIST || details.accountList || (Array.isArray(details) ? details : []);
    
    if (!Array.isArray(accounts)) {
      throw new Error(`Invalid accounts list returned for resource. (ACCOUNT LIST is not an array)`);
    }

    const target = (targetAccountName || '').trim().toLowerCase();
    const account = accounts.find(a => {
      const name = (a['ACCOUNT NAME'] || a.ACCOUNT_NAME || a.accountName || '').trim().toLowerCase();
      return name === target;
    });

    if (!account) {
      const available = accounts.map(a => a['ACCOUNT NAME'] || a.ACCOUNT_NAME || a.accountName).filter(Boolean).join(', ');
      throw new Error(`Hesap '${targetAccountName}' bulunamadı. Mevcut hesaplar: [${available}]`);
    }

    const accountId = account['ACCOUNT ID'] || account.ACCOUNT_ID || account.accountId;
    if (!accountId) {
      throw new Error(`Could not extract ACCOUNT ID for account '${targetAccountName}'.`);
    }

    return accountId;
  }

  /**
   * Fetches the password from ManageEngine PMP for a given resource and account
   * using the proper REST API v1 ID hierarchy.
   * 
   * @param {Object} pmpConfig 
   * @param {Object} context 
   * @returns {Promise<string>}
   */
  async fetchPassword(pmpConfig, context = {}) {
    const { baseUrl, authToken, resourceName, accountName, allowSelfSigned } = pmpConfig;

    if (!baseUrl || !authToken || !resourceName || !accountName) {
      throw new Error('Missing required PMP configuration parameters.');
    }

    if (allowSelfSigned === true) {
      console.warn(`[PmpService] ⚠ TLS certificate verification is DISABLED for this PMP connection (allowSelfSigned=true). This exposes vault traffic to interception.`);
    }

    const client = this._createClient(baseUrl, authToken, allowSelfSigned);
    const reason = context.reason || `Automated IDP Deployment - Project #${context.projectId || 'Unknown'}`;

    console.log(`[PmpService] Fetching password from PMP API. Target Account: '${accountName}', Resource: '${resourceName}'`);

    try {
      // Step 1: Find Resource ID
      const resourceId = await this._findResource(client, resourceName);
      
      // Step 2: Find Account ID
      const accountId = await this._findAccount(client, resourceId, accountName);

      // Step 3: Fetch the password using INPUT_DATA structure for mandatory reason
      const inputData = JSON.stringify({
        operation: {
          Details: {
            REASON: reason
          }
        }
      });
      
      const passwordRes = await client.get(`/resources/${resourceId}/accounts/${accountId}/password`, {
        params: { INPUT_DATA: inputData }
      });
      
      const passData = passwordRes.data;
      if (passData?.operation?.result?.status === 'Success') {
        const password = passData.operation?.Details?.PASSWORD || passData.operation?.details?.PASSWORD;
        if (!password) {
          throw new Error('Password field is missing in PMP response.');
        }
        return password;
      } else {
        const errorMessage = passData?.operation?.result?.message || 'Unknown error from PMP API.';
        throw new Error(`PMP API Error: ${errorMessage}`);
      }

    } catch (error) {
      this._handleApiError(error);
    }
  }

  /**
   * Tests the connection to the PMP server by validating the resource and account.
   * @param {Object} pmpConfig 
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async testConnection(pmpConfig) {
    const { baseUrl, authToken, resourceName, accountName, allowSelfSigned } = pmpConfig;
    if (!baseUrl || !authToken) {
      return { success: false, message: 'Missing baseUrl or authToken' };
    }

    if (allowSelfSigned === true) {
      console.warn(`[PmpService] ⚠ TLS certificate verification is DISABLED for this PMP connection (allowSelfSigned=true). This exposes vault traffic to interception.`);
    }

    try {
      const client = this._createClient(baseUrl, authToken, allowSelfSigned);

      if (!resourceName) {
        // Just verify basic connectivity if no resource provided
        const response = await client.get('/resources');
        this._validatePmpResponse(response, 'testing connection');
        return { success: true, message: 'Connection verified successfully.' };
      }

      // Step 1: Validate Resource ID
      const resourceId = await this._findResource(client, resourceName);

      // Step 2: Validate Account ID (if provided)
      if (accountName) {
        await this._findAccount(client, resourceId, accountName);
      }

      return { success: true, message: 'Connection and credentials verified successfully.' };
      
    } catch (error) {
      console.error(`[PmpService] Test Connection Error:`, error);
      
      let detailedMessage = error.message;
      if (error.response) {
        const status = error.response.status;
        const apiMessage = error.response.data?.operation?.result?.message || error.response.data?.message;
        detailedMessage = apiMessage || `HTTP ${status}`;
      } else if (error.code) {
        detailedMessage = error.code;
      }

      return { success: false, message: `Failed: ${detailedMessage}` };
    }
  }

  _handleApiError(error) {
    if (error.response) {
      console.error('PMP 400 Error Details:', JSON.stringify(error.response.data, null, 2));
      const status = error.response.status;
      const msg = error.response.data?.operation?.result?.message || error.message;
      console.error(`[PmpService] HTTP ${status} Error:`, msg);
      throw new Error(`PMP HTTP Error ${status}: ${msg}`);
    }
    
    console.error(`[PmpService] Connection Error:`, error.message);
    if (error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.message.includes('self-signed certificate')) {
      throw new Error(`Failed to reach PMP API: Self-signed certificate error. TLS verification failed.`);
    }
    throw new Error(`Failed to reach PMP API: ${error.message}`);
  }
}

module.exports = new PmpService();
