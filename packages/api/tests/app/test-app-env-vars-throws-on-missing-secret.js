const test = require('ava');
const { MissingRequiredEnvVarError } = require('@cumulus/errors');

process.env.dynamoTableNamesParameterName = 'fake-param-name';

test('handler throws error if environment variable for secret ID is missing', async (t) => {
  process.env.INIT_ENV_VARS_FUNCTION_TEST = 'true';
  // eslint-disable-next-line global-require
  const { handler } = require('../../app');
  await t.throwsAsync(handler({}), { instanceOf: MissingRequiredEnvVarError });
});
