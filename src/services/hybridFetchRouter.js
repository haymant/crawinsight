const axios = require('axios');

class HybridFetchRouter {
  constructor({ httpClient } = {}) {
    this.httpClient = httpClient || axios;
  }

  async fetch({ url, headers = {}, timeout = 15000, fallbackFetcher, fallbackStatuses = [401, 403, 429, 503] }) {
    try {
      const response = await this.httpClient.get(url, {
        headers,
        timeout,
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return {
          body: response.data,
          contentType: response.headers?.['content-type'],
          fetchMode: 'http',
          status: response.status,
          resolvedUrl: response.request?.res?.responseUrl || url,
        };
      }

      if (fallbackFetcher && fallbackStatuses.includes(response.status)) {
        const fallbackResult = await fallbackFetcher(url, headers);
        return this.normalizeFallback(fallbackResult, response.status);
      }

      const error = new Error(`Request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    } catch (error) {
      if (!fallbackFetcher) {
        throw error;
      }

      const fallbackResult = await fallbackFetcher(url, headers);
      return this.normalizeFallback(fallbackResult, error.status || null);
    }
  }

  normalizeFallback(result, status) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'body')) {
      return {
        body: result.body,
        contentType: result.contentType,
        fetchMode: 'fallback',
        status,
        resolvedUrl: undefined,
      };
    }

    return {
      body: result,
      contentType: undefined,
      fetchMode: 'fallback',
      status,
      resolvedUrl: undefined,
    };
  }
}

module.exports = { HybridFetchRouter };