import pRetry from 'p-retry';

import { lambda } from '@cumulus/aws-client/services';
import Logger from '@cumulus/logger';

import { CumulusApiClientError } from './CumulusApiClientError';
import * as types from './types';

const logger = new Logger({ sender: '@api-client/cumulusApiClient' });

/**
 * Invoke the Cumulus private API lambda (using pRetry)
 *
 * @param {Object} params
 * @param {string} params.prefix - the prefix configured for the stack
 * @param {string} params.payload - the payload object (e.g. httpMethod,
 *   resource, headers, path, body) containing params the lambda expects in the
 *   payload
 * @param {pRetry.Options} [params.pRetryOptions={}]
 * @returns {Promise<Object|undefined>} - Returns promise that resolves to the
 *   output payload from the API lambda
 */
export async function invokeApi(
  params: types.InvokeApiFunctionParams
): Promise<types.ApiGatewayLambdaHttpProxyResponse> {
  const {
    prefix,
    payload,
    expectedStatusCodes = 200,
    pRetryOptions = {},
  } = params;

  const expectedStatusCodesFlat = [expectedStatusCodes].flat();

  return await pRetry(
    async () => {
      const apiOutput = await lambda().invoke({
        Payload: JSON.stringify(payload),
        FunctionName: `${prefix}-PrivateApiLambda`,
      }).promise();

      if (!apiOutput.Payload) {
        throw new Error('No payload received from lambda invocation');
      }

      const parsedPayload = JSON.parse(apiOutput.Payload.toString());

      if (parsedPayload?.errorMessage?.includes('Task timed out')) {
        throw new CumulusApiClientError(
          `Error calling ${payload.path}: ${parsedPayload.errorMessage}`,
          parsedPayload?.statusCode,
          undefined
        );
      }

      if (!expectedStatusCodesFlat.includes(parsedPayload?.statusCode)) {
        throw new CumulusApiClientError(
          `${payload.path} returned ${parsedPayload.statusCode}: ${parsedPayload.body}`,
          parsedPayload?.statusCode,
          parsedPayload.body
        );
      }
      return parsedPayload;
    },
    {
      retries: 3,
      maxTimeout: 10000,
      onFailedAttempt: (e) => logger.error(`API invoke error: ${e.message}.`),
      ...pRetryOptions,
    }
  );
}
