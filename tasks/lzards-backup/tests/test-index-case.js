const test = require('ava');
const cryptoRandomString = require('crypto-random-string');
const cloneDeep = require('lodash/cloneDeep');
const omit = require('lodash/omit');

const sandbox = require('sinon').createSandbox();
const proxyquire = require('proxyquire');

const {
  createBucket,
  s3PutObject,
  recursivelyDeleteS3Bucket,
  deleteS3Object,
} = require('@cumulus/aws-client/S3');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { randomString } = require('@cumulus/common/test-utils');
const {
  CollectionPgModel,
  destroyLocalTestDb,
  fakeCollectionRecordFactory,
  generateLocalTestDb,
  localStackConnectionEnv,
  migrationDir,
} = require('@cumulus/db');
const { validateInput, validateConfig, validateOutput } = require('@cumulus/common/test-utils');

const { ChecksumError, CollectionInvalidRegexpError } = require('../dist/src/errors');

function removeStackObjectFromErrorBody(object) {
  const updateObject = { ...object };
  updateObject.body = JSON.stringify(omit(JSON.parse(updateObject.body), ['stack']));
  return updateObject;
}

function removeBackupResultsObjectErrorStack(object) {
  return object.map((result) => removeStackObjectFromErrorBody(result));
}

function stageFixtureObjects(fakePayload) {
  return Promise.all(fakePayload.input.granules.map(
    (granule) => Promise.all(granule.files.map((file) => s3PutObject({
      Bucket: file.bucket,
      Key: file.key,
      Body: 'foobar',
    })))
  ));
}

function deleteFixtureObjects(fakePayload) {
  return Promise.all(fakePayload.input.granules.map(
    (granule) => Promise.all(granule.files.map((file) => deleteS3Object(
      file.bucket,
      file.key
    )))
  ));
}

const fakePostReturn = {
  body: 'fake body',
  statusCode: 201,
};
const fakeCollection = {
  files: [
    {
      regex: 'foo.jpg',
      lzards: { backup: true },
    },
    {
      regex: 'foo.dat',
      lzards: { backup: false },
    },
  ],
};

const fakeBucketMap = {
  foo: 'bar',
};

const getCollectionStub = sandbox.stub().returns(fakeCollection);
const gotPostStub = sandbox.stub().returns(fakePostReturn);
const fetchBucketMapStub = sandbox.stub().returns(fakeBucketMap);
const index = proxyquire('../dist/src', {
  '@cumulus/api-client/collections': {
    getCollection: getCollectionStub,
  },
  '@cumulus/distribution-utils': {
    fetchDistributionBucketMap: fetchBucketMapStub,
  },
  got: {
    default: {
      post: gotPostStub,
    },
  },
});
const env = { ...process.env };

const testDbName = randomString(12);

async function setupDefaultPostRequestToLzardsTest(params = {}) {
  const accessUrl = 'fakeUrl';
  const authToken = 'fakeToken';
  const collection = 'fakeCollectionString';
  const file = { bucket: 'fakeBucket', key: 'fakeKey', checksumType: 'MD5', checksum: 'fakeChecksum' };
  const granuleId = 'fakeGranuleId';
  const lzardsApi = 'fakeApi';
  const provider = 'fakeProvider';
  const now = new Date().getTime();
  const tenMinutesAgo = now - (1000 * 60 * 10);
  const createdAt = tenMinutesAgo;

  process.env.lzards_api = lzardsApi;
  process.env.lzards_provider = params.lzardsEnvProvider;

  const actual = await index.postRequestToLzards({
    accessUrl,
    authToken,
    collection,
    file,
    granuleId,
    provider,
    createdAt,
    lzardsApi,
    lzardsProvider: params.lzardsProvider,
  });

  return {
    accessUrl,
    actual,
    collection,
    granuleId,
    provider,
    createdAt,
    authToken,
    file,
    lzardsApi,
  };
}

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.testKnex = knex;
  t.context.testKnexAdmin = knexAdmin;
  t.context.collectionPgModel = new CollectionPgModel();

  t.context.fakeBucket1 = cryptoRandomString({ length: 10 });
  t.context.fakeBucket2 = cryptoRandomString({ length: 10 });
  await createBucket(t.context.fakeBucket1);
  await createBucket(t.context.fakeBucket2);
});

test.beforeEach(() => {
  process.env = { ...env };
});

test.afterEach.always(() => {
  sandbox.restore();
  gotPostStub.resetHistory();
  getCollectionStub.resetHistory();
});

test.after.always(async (t) => {
  await recursivelyDeleteS3Bucket(t.context.fakeBucket1);
  await recursivelyDeleteS3Bucket(t.context.fakeBucket2);
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName,
  });
});

test('shouldBackupFile returns true if the regex matches and the backup option is set on the matching collection file', (t) => {
  const fakeCollectionConfig = {
    files: [
      {
        regex: '^foo.jpg$',
        lzards: { backup: true },
      },
      {
        regex: '^foo.MD5$',
        lzards: { backup: false },
      },
    ],
  };
  t.true(index.shouldBackupFile('foo.jpg', fakeCollectionConfig));
});

test('shouldBackupFile returns false if the regex does not match any file', (t) => {
  const fakeCollectionConfig = {
    files: [
      {
        regex: '^foo.MD5$',
        lzards: { backup: true },
      },
    ],
  };
  t.false(index.shouldBackupFile('foo.jpg', fakeCollectionConfig));
});

test.serial('postRequestToLzards creates the expected query', async (t) => {
  const lzardsEnvProvider = 'fakeProvider';
  const setupObj = await setupDefaultPostRequestToLzardsTest({ lzardsEnvProvider });

  t.is(setupObj.actual, fakePostReturn);
  t.deepEqual(gotPostStub.getCalls()[0].args, [setupObj.lzardsApi, {
    json: {
      provider: lzardsEnvProvider,
      objectUrl: setupObj.accessUrl,
      expectedMd5Hash: setupObj.file.checksum,
      metadata: {
        filename: `s3://${setupObj.file.bucket}/${setupObj.file.key}`,
        collection: setupObj.collection,
        granuleId: setupObj.granuleId,
        provider: setupObj.provider,
        createdAt: setupObj.createdAt,
      },
    },
    headers: {
      Authorization: `Bearer ${setupObj.authToken}`,
    },
  }]);
});

test.serial('postRequestToLzards creates the expected query with SHA256 checksum', async (t) => {
  const accessUrl = 'fakeUrl';
  const authToken = 'fakeToken';
  const collection = 'fakeCollectionString';
  const file = { bucket: 'fakeBucket', key: 'fakeKey', checksumType: 'SHA256', checksum: 'fakeChecksum' };
  const granuleId = 'fakeGranuleId';
  const lzardsApi = 'fakeApi';
  const lzardsProviderName = 'fakeProvider';
  const provider = 'fakeProvider';
  const now = new Date().getTime();
  const tenMinutesAgo = now - (1000 * 60 * 10);
  const createdAt = tenMinutesAgo;

  process.env.lzards_provider = lzardsProviderName;
  process.env.lzards_api = lzardsApi;

  await index.postRequestToLzards({
    accessUrl,
    authToken,
    collection,
    file,
    granuleId,
    provider,
    createdAt,
    lzardsApi,
    lzardsProviderName,
  });

  t.deepEqual(gotPostStub.getCalls()[0].args, [lzardsApi, {
    json: {
      provider: lzardsProviderName,
      objectUrl: accessUrl,
      expectedSha256Hash: file.checksum,
      metadata: {
        filename: `s3://${file.bucket}/${file.key}`,
        collection,
        granuleId,
        provider,
        createdAt,
      },
    },
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  }]);
});

test.serial('postRequestToLzards creates the expected query with SHA512 checksum', async (t) => {
  const accessUrl = 'fakeUrl';
  const authToken = 'fakeToken';
  const collection = 'fakeCollectionString';
  const file = { bucket: 'fakeBucket', key: 'fakeKey', checksumType: 'SHA512', checksum: 'fakeChecksum' };
  const granuleId = 'fakeGranuleId';
  const lzardsApi = 'fakeApi';
  const lzardsProviderName = 'fakeProvider';
  const provider = 'fakeProvider';
  const now = new Date().getTime();
  const tenMinutesAgo = now - (1000 * 60 * 10);
  const createdAt = tenMinutesAgo;

  process.env.lzards_provider = lzardsProviderName;
  process.env.lzards_api = lzardsApi;

  await index.postRequestToLzards({
    accessUrl,
    authToken,
    collection,
    file,
    granuleId,
    provider,
    createdAt,
    lzardsApi,
    lzardsProviderName,
  });

  t.deepEqual(gotPostStub.getCalls()[0].args, [lzardsApi, {
    json: {
      provider: lzardsProviderName,
      objectUrl: accessUrl,
      expectedSha512Hash: file.checksum,
      metadata: {
        filename: `s3://${file.bucket}/${file.key}`,
        collection,
        granuleId,
        provider,
        createdAt,
      },
    },
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  }]);
});

test.serial('postRequestToLzards throws if lzardsApiUrl is not set', async (t) => {
  const accessUrl = 'fakeUrl';
  const authToken = 'fakeToken';
  const collection = 'fakeCollectionString';
  const file = { bucket: 'fakeBucket', key: 'fakeKey', checksumType: 'MD5', checksum: 'fakeChecksum' };
  const granuleId = 'fakeGranuleId';
  const lzardsProviderName = 'fakeProvider';
  const provider = 'fakeProvider';
  const now = new Date().getTime();
  const tenMinutesAgo = now - (1000 * 60 * 10);
  const createdAt = tenMinutesAgo;

  process.env.lzards_provider = lzardsProviderName;
  await t.throwsAsync(index.postRequestToLzards({
    accessUrl,
    authToken,
    collection,
    file,
    granuleId,
    provider,
    createdAt,
  }));
});

test.serial('backupGranulesToLzards returns the expected payload with "workflow output" type input granule containing dataType and version', async (t) => {
  const { fakeBucket1, fakeBucket2 } = t.context;
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });

  process.env.OAUTH_PROVIDER = 'earthdata';
  const now = new Date().getTime();
  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          dataType: 'FakeGranuleType',
          version: '000',
          provider: 'FakeProvider',
          createdAt: now,
          files: [
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: '/path/to/granule1/foo.dat',
            },
          ],
        },
        {
          granuleId: 'FakeGranule2',
          dataType: 'FakeGranuleType',
          version: '000',
          provider: 'FakeProvider',
          createdAt: now,
          files: [
            {
              bucket: fakeBucket2,
              key: 'path/to/granule1/foo.jpg',
              checksumType: 'MD5',
              checksum: 'fakehash',
            },
            {
              bucket: fakeBucket2,
              key: 'path/to/granule1/foo.dat',
              checksumType: 'MD5',
              checksum: 'fakehash',
            },
          ],
        },
      ],
    },
    config: {
      urlType: 's3',
    },
  };

  await stageFixtureObjects(fakePayload);
  t.teardown(() => deleteFixtureObjects(fakePayload));

  process.env.lzards_api = 'fakeApi';
  process.env.lzards_provider = 'fakeProvider';
  process.env.stackName = 'fakeStack';

  await validateInput(t, fakePayload.input);
  await validateConfig(t, fakePayload.config);
  const actual = await index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod);
  await validateOutput(t, actual);
  const expected = {
    backupResults: [
      {
        body: 'fake body',
        filename: `s3://${fakeBucket1}/path/to/granule1/foo.jpg`,
        status: 'COMPLETED',
        granuleId: 'FakeGranule1',
        collectionId: 'FakeGranuleType___000',
        provider: 'FakeProvider',
        createdAt: now,
        statusCode: 201,
      },
      {
        body: 'fake body',
        filename: `s3://${fakeBucket2}/path/to/granule1/foo.jpg`,
        status: 'COMPLETED',
        granuleId: 'FakeGranule2',
        collectionId: 'FakeGranuleType___000',
        provider: 'FakeProvider',
        createdAt: now,
        statusCode: 201,
      },
    ],
    granules: fakePayload.input.granules,
  };
  t.deepEqual(actual, expected);
});

test.serial('backupGranulesToLzards returns the expected payload with API type input granule', async (t) => {
  const {
    collectionPgModel,
    fakeBucket1,
    fakeBucket2,
    testKnex,
  } = t.context;
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });
  const now = new Date().getTime();
  const testCollection1 = fakeCollectionRecordFactory();
  const testCollection2 = fakeCollectionRecordFactory();
  await collectionPgModel.create(testKnex, testCollection1);
  await collectionPgModel.create(testKnex, testCollection2);
  const collectionId1 = constructCollectionId(testCollection1.name, testCollection1.version);
  const collectionId2 = constructCollectionId(testCollection2.name, testCollection2.version);

  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          collectionId: collectionId1,
          provider: 'FakeProvider',
          createdAt: now,
          files: [
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: '/path/to/granule1/foo.dat',
            },
          ],
        },
        {
          granuleId: 'FakeGranule2',
          collectionId: collectionId2,
          provider: 'FakeProvider',
          createdAt: now,
          files: [
            {
              bucket: fakeBucket2,
              key: 'path/to/granule1/foo.jpg',
              checksumType: 'MD5',
              checksum: 'fakehash',
            },
            {
              bucket: fakeBucket2,
              key: 'path/to/granule1/foo.dat',
              checksumType: 'MD5',
              checksum: 'fakehash',
            },
          ],
        },
      ],
    },
    config: {
      urlType: 's3',
    },
  };

  await stageFixtureObjects(fakePayload);
  t.teardown(() => deleteFixtureObjects(fakePayload));

  process.env.lzards_api = 'fakeApi';
  process.env.lzards_provider = 'fakeProvider';
  process.env.stackName = 'fakeStack';

  await validateInput(t, fakePayload.input);
  await validateConfig(t, fakePayload.config);
  const actual = await index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod);
  await validateOutput(t, actual);
  const expected = {
    backupResults: [
      {
        body: 'fake body',
        filename: `s3://${fakeBucket1}/path/to/granule1/foo.jpg`,
        status: 'COMPLETED',
        granuleId: 'FakeGranule1',
        collectionId: collectionId1,
        provider: 'FakeProvider',
        createdAt: now,
        statusCode: 201,
      },
      {
        body: 'fake body',
        filename: `s3://${fakeBucket2}/path/to/granule1/foo.jpg`,
        status: 'COMPLETED',
        granuleId: 'FakeGranule2',
        collectionId: collectionId2,
        provider: 'FakeProvider',
        createdAt: now,
        statusCode: 201,
      },
    ],
    granules: fakePayload.input.granules,
  };
  t.deepEqual(actual, expected);
});

test.serial('backupGranulesToLzards returns the expected payload with input granule that contains both collectionId and dataType and version', async (t) => {
  const {
    collectionPgModel,
    fakeBucket1,
    fakeBucket2,
    testKnex,
  } = t.context;
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });
  const now = new Date().getTime();
  const testCollection1 = fakeCollectionRecordFactory();
  const testCollection2 = fakeCollectionRecordFactory();
  await collectionPgModel.create(testKnex, testCollection1);
  await collectionPgModel.create(testKnex, testCollection2);
  const collectionId1 = constructCollectionId(testCollection1.name, testCollection1.version);
  const collectionId2 = constructCollectionId(testCollection2.name, testCollection2.version);

  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          collectionId: collectionId1,
          provider: 'FakeProvider',
          createdAt: now,
          dataType: 'FakeGranuleType',
          version: '000',
          files: [
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: '/path/to/granule1/foo.dat',
            },
          ],
        },
        {
          granuleId: 'FakeGranule2',
          collectionId: collectionId2,
          provider: 'FakeProvider',
          createdAt: now,
          files: [
            {
              bucket: fakeBucket2,
              key: 'path/to/granule1/foo.jpg',
              checksumType: 'MD5',
              checksum: 'fakehash',
            },
            {
              bucket: fakeBucket2,
              key: 'path/to/granule1/foo.dat',
              checksumType: 'MD5',
              checksum: 'fakehash',
            },
          ],
        },
      ],
    },
    config: {
      urlType: 's3',
    },
  };

  await stageFixtureObjects(fakePayload);
  t.teardown(() => deleteFixtureObjects(fakePayload));

  process.env.lzards_api = 'fakeApi';
  process.env.lzards_provider = 'fakeProvider';
  process.env.stackName = 'fakeStack';

  await validateInput(t, fakePayload.input);
  await validateConfig(t, fakePayload.config);
  const actual = await index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod);
  await validateOutput(t, actual);
  const expected = {
    backupResults: [
      {
        body: 'fake body',
        filename: `s3://${fakeBucket1}/path/to/granule1/foo.jpg`,
        status: 'COMPLETED',
        granuleId: 'FakeGranule1',
        collectionId: collectionId1,
        provider: 'FakeProvider',
        createdAt: now,
        statusCode: 201,
      },
      {
        body: 'fake body',
        filename: `s3://${fakeBucket2}/path/to/granule1/foo.jpg`,
        status: 'COMPLETED',
        granuleId: 'FakeGranule2',
        collectionId: collectionId2,
        provider: 'FakeProvider',
        createdAt: now,
        statusCode: 201,
      },
    ],
    granules: fakePayload.input.granules,
  };
  t.deepEqual(actual, expected);
});

test.serial('backupGranulesToLzards throws an error with a granule missing collection information', async (t) => {
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });

  getCollectionStub.returns(fakeCollection);
  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          files: [
            {
              bucket: 'fakeBucket1',
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: 'fakeBucket1',
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.dat',
            },
          ],
        },
      ],
    },
  };

  process.env.lzards_api = 'fakeApi';
  process.env.lzards_provider = 'fakeProvider';
  process.env.stackName = 'fakeStack';
  await t.throwsAsync(
    index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod),
    { message: '[{"status":"rejected","reason":{"name":"CollectionIdentifiersNotProvidedError"}}]' }
  );
});

test.serial('backupGranulesToLzards throws an error with a granule incomplete collection information, containing only dataType', async (t) => {
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });

  getCollectionStub.returns(fakeCollection);
  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          dataType: 'FakeType',
          files: [
            {
              bucket: 'fakeBucket1',
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: 'fakeBucket1',
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.dat',
            },
          ],
        },
      ],
    },
  };

  process.env.lzards_api = 'fakeApi';
  process.env.lzards_provider = 'fakeProvider';
  process.env.stackName = 'fakeStack';
  await t.throwsAsync(
    index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod),
    { message: '[{"status":"rejected","reason":{"name":"CollectionIdentifiersNotProvidedError"}}]' }
  );
});

test.serial('backupGranulesToLzards throws an error with a granule incomplete collection information, containing only version', async (t) => {
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });

  getCollectionStub.returns(fakeCollection);
  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          version: '001',
          files: [
            {
              bucket: 'fakeBucket1',
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: 'fakeBucket1',
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.dat',
            },
          ],
        },
      ],
    },
  };

  process.env.lzards_api = 'fakeApi';
  process.env.lzards_provider = 'fakeProvider';
  process.env.stackName = 'fakeStack';
  await t.throwsAsync(
    index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod),
    { message: '[{"status":"rejected","reason":{"name":"CollectionIdentifiersNotProvidedError"}}]' }
  );
});

test.serial('backupGranulesToLzards returns failed record (by default) or throws error (failTaskWhenFileBackupFail set to true), if one of file backups fails', async (t) => {
  const { fakeBucket1, fakeBucket2 } = t.context;
  const getAuthTokenMethod = () => Promise.resolve('fakeAuthToken');
  sandbox.stub(index, 'generateAccessCredentials').returns({
    Credentials: {
      SecretAccessKey: 'FAKEKey',
      AccessKeyId: 'FAKEId',
      SessionToken: 'FAKEToken',
    },
  });
  const collectionId1 = constructCollectionId('fakename1', 'fakeversion1');
  const collectionId2 = constructCollectionId('fakename2', 'fakeversion2');
  const now = new Date().getTime();
  const backupError = {
    name: 'RequestError',
    message: 'connect ETIMEDOUT 1.2.3.4',
    stack: 'RequestError: connect ETIMEDOUT 1.2.3.4',
  };
  const stubbedBackupGranuleResults = [{
    statusCode: 201,
    granuleId: 'FakeGranule1',
    collectionId: collectionId1,
    filename: `s3://${fakeBucket1}/path/to/granule1/foo.jpg`,
    provider: 'FakeProvider',
    createdAt: now,
    body: 'fake body',
    status: 'COMPLETED',
  },
  {
    granuleId: 'FakeGranule2',
    collectionId: collectionId2,
    filename: `s3://${fakeBucket2}/path/to/granule2/foo.jpg`,
    provider: 'FakeProvider',
    createdAt: now,
    body: JSON.stringify(backupError),
    status: 'FAILED',
  }];
  sandbox.stub(index, 'backupGranule').returns(stubbedBackupGranuleResults);

  const fakePayload = {
    input: {
      granules: [
        {
          granuleId: 'FakeGranule1',
          collectionId: collectionId1,
          provider: 'FakeProvider',
          createdAt: now,
          files: [
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: 'path/to/granule1/foo.jpg',
            },
            {
              bucket: fakeBucket1,
              checksumType: 'MD5',
              checksum: 'fakehash',
              key: '/path/to/granule1/foo.dat',
            },
          ],
        },
      ],
    },
    config: {
      urlType: 's3',
    },
  };

  const expectedBackupResults = [
    { ...stubbedBackupGranuleResults[0], statusCode: 201, status: 'COMPLETED' },
    { ...stubbedBackupGranuleResults[1], status: 'FAILED' },
  ];

  await validateInput(t, fakePayload.input);
  await validateConfig(t, fakePayload.config);
  const actual = await index.backupGranulesToLzards(fakePayload, undefined, getAuthTokenMethod);
  await validateOutput(t, actual);
  const expected = {
    backupResults: expectedBackupResults,
    granules: fakePayload.input.granules,
  };
  t.deepEqual(actual, expected);

  const newFakePayload = cloneDeep(fakePayload);
  newFakePayload.config.failTaskWhenFileBackupFail = true;
  await validateInput(t, newFakePayload.input);
  await validateConfig(t, newFakePayload.config);
  const error = await t.throwsAsync(
    index.backupGranulesToLzards(newFakePayload, undefined, getAuthTokenMethod)
  );
  const errorResults = JSON.parse(error.message).map((result) => result.value).flat();
  t.deepEqual(errorResults, expectedBackupResults);
});
