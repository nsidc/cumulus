'use strict';

const fs = require('fs-extra');
const path = require('path');
const pMap = require('p-map');
const pRetry = require('p-retry');
const { URL, resolve } = require('url');

const difference = require('lodash/difference');
const get = require('lodash/get');
const includes = require('lodash/includes');
const intersection = require('lodash/intersection');
const isObject = require('lodash/isObject');

const {
  Execution,
  Granule,
  Pdr,
} = require('@cumulus/api/models');
const GranuleFilesCache = require('@cumulus/api/lib/GranuleFilesCache');
const StepFunctions = require('@cumulus/aws-client/StepFunctions');
const { pullStepFunctionEvent } = require('@cumulus/message/StepFunctions');
const {
  deleteS3Object,
  parseS3Uri,
  s3CopyObject,
  s3GetObjectTagging,
  s3ObjectExists,
} = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { generateChecksumFromStream } = require('@cumulus/checksum');
const { randomId } = require('@cumulus/common/test-utils');
const { isCMRFile, metadataObjectFromCMRFile } = require('@cumulus/cmrjs/cmr-utils');
const { constructCollectionId } = require('@cumulus/message/Collections');
const {
  addCollections,
  conceptExists,
  getExecutionOutput,
  getOnlineResources,
  waitForAsyncOperationStatus,
  waitForConceptExistsOutcome,
  waitForTestExecutionStart,
  waitForCompletedExecution,
} = require('@cumulus/integration-tests');
const apiTestUtils = require('@cumulus/integration-tests/api/api');
const executionsApiTestUtils = require('@cumulus/api-client/executions');
const providersApi = require('@cumulus/api-client/providers');
const { deleteCollection } = require('@cumulus/api-client/collections');
const { deleteExecution } = require('@cumulus/api-client/executions');
const {
  applyWorkflow,
  bulkReingestGranules,
  getGranule,
  moveGranule,
  removeFromCMR,
  removePublishedGranule,
} = require('@cumulus/api-client/granules');
const {
  getDistributionFileUrl,
  getTEADistributionApiRedirect,
  getTEADistributionApiFileStream,
  getTEARequestHeaders,
} = require('@cumulus/integration-tests/api/distribution');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');

const {
  buildAndExecuteWorkflow,
  buildAndStartWorkflow,
} = require('../../helpers/workflowUtils');
const {
  loadConfig,
  templateFile,
  uploadTestDataToBucket,
  deleteFolder,
  getExecutionUrl,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
  getFilesMetadata,
} = require('../../helpers/testUtils');
const {
  setDistributionApiEnvVars,
  waitForModelStatus,
} = require('../../helpers/apiUtils');
const {
  addUniqueGranuleFilePathToGranuleFiles,
  addUrlPathToGranuleFiles,
  setupTestGranuleForIngest,
  loadFileWithUpdatedGranuleIdPathAndCollection,
} = require('../../helpers/granuleUtils');

const { isReingestExecutionForGranuleId } = require('../../helpers/workflowUtils');

const lambdaStep = new LambdaStep();
const workflowName = 'IngestAndPublishGranule';

const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg',
];

function failOnSetupError(setupErrors) {
  const errors = setupErrors.filter((e) => e);

  if (errors.length > 0) {
    console.log('Test setup failed, aborting');
    console.log(errors);
    fail(errors[0]);
  }
}

function isExecutionForGranuleId(taskInput, params) {
  return taskInput.payload.granules && taskInput.payload.granules[0].granuleId === params.granuleId;
}

describe('The S3 Ingest Granules workflow', () => {
  const inputPayloadFilename = './spec/parallel/ingestGranule/IngestGranule.input.payload.json';
  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006_full_ingest';
  const collectionDupeHandling = 'error';

  let beforeAllError;
  let collection;
  let config;
  let executionModel;
  let expectedPayload;
  let expectedS3TagSet;
  let expectedSyncGranulePayload;
  let failingWorkflowExecution;
  let granuleCompletedMessageKey;
  let granuleModel;
  let granuleRunningMessageKey;
  let inputPayload;
  let opendapFilePath;
  let pdrFilename;
  let pdrModel;
  let postToCmrOutput;
  let provider;
  let testDataFolder;
  let workflowExecutionArn;
  let granuleWasDeleted = false;

  beforeAll(async () => {
    try {
      config = await loadConfig();

      const testId = createTimestampedTestId(config.stackName, 'IngestGranuleSuccess');
      const testSuffix = createTestSuffix(testId);
      testDataFolder = createTestDataPath(testId);

      collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
      const newCollectionId = constructCollectionId(collection.name, collection.version);
      provider = { id: `s3_provider${testSuffix}` };

      process.env.GranulesTable = `${config.stackName}-GranulesTable`;
      granuleModel = new Granule();
      process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
      executionModel = new Execution();
      process.env.system_bucket = config.bucket;
      process.env.ProvidersTable = `${config.stackName}-ProvidersTable`;
      process.env.PdrsTable = `${config.stackName}-PdrsTable`;
      pdrModel = new Pdr();

      const providerJson = JSON.parse(fs.readFileSync(`${providersDir}/s3_provider.json`, 'utf8'));
      const providerData = {
        ...providerJson,
        id: provider.id,
        host: config.bucket,
      };

      // populate collections, providers and test data
      await Promise.all([
        uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
        addCollections(config.stackName, config.bucket, collectionsDir, testSuffix, testId, collectionDupeHandling),
        apiTestUtils.addProviderApi({ prefix: config.stackName, provider: providerData }),
      ]);

      const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');

      // update test data filepaths
      inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
      pdrFilename = inputPayload.pdr.name;
      const granuleId = inputPayload.granules[0].granuleId;
      expectedS3TagSet = [{ Key: 'granuleId', Value: granuleId }];
      await Promise.all(inputPayload.granules[0].files.map((fileToTag) =>
        s3().putObjectTagging({ Bucket: config.bucket, Key: `${fileToTag.path}/${fileToTag.name}`, Tagging: { TagSet: expectedS3TagSet } }).promise()));

      const collectionUrlString = '{cmrMetadata.Granule.Collection.ShortName}___{cmrMetadata.Granule.Collection.VersionId}/{substring(file.name, 0, 3)}/';

      const templatedSyncGranuleFilename = templateFile({
        inputTemplateFilename: './spec/parallel/ingestGranule/SyncGranule.output.payload.template.json',
        config: {
          granules: [
            {
              files: [
                {
                  bucket: config.buckets.internal.name,
                  filename: `s3://${config.buckets.internal.name}/file-staging/${config.stackName}/replace-me-collectionId/replace-me-granuleId.hdf`,
                  fileStagingDir: `file-staging/${config.stackName}/replace-me-collectionId`,
                },
                {
                  bucket: config.buckets.internal.name,
                  filename: `s3://${config.buckets.internal.name}/file-staging/${config.stackName}/replace-me-collectionId/replace-me-granuleId.hdf.met`,
                  fileStagingDir: `file-staging/${config.stackName}/replace-me-collectionId`,
                },
                {
                  bucket: config.buckets.internal.name,
                  filename: `s3://${config.buckets.internal.name}/file-staging/${config.stackName}/replace-me-collectionId/replace-me-granuleId_ndvi.jpg`,
                  fileStagingDir: `file-staging/${config.stackName}/replace-me-collectionId`,
                },
              ],
            },
          ],
        },
      });

      expectedSyncGranulePayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedSyncGranuleFilename, granuleId, testDataFolder, newCollectionId, config.stackName);

      expectedSyncGranulePayload.granules[0].dataType += testSuffix;
      expectedSyncGranulePayload.granules[0].files = addUrlPathToGranuleFiles(expectedSyncGranulePayload.granules[0].files, testId, '');

      const templatedOutputPayloadFilename = templateFile({
        inputTemplateFilename: './spec/parallel/ingestGranule/IngestGranule.output.payload.template.json',
        config: {
          granules: [
            {
              files: [
                {
                  bucket: config.buckets.protected.name,
                  filename: `s3://${config.buckets.protected.name}/MOD09GQ___006/2017/MOD/replace-me-granuleId.hdf`,
                },
                {
                  bucket: config.buckets.private.name,
                  filename: `s3://${config.buckets.private.name}/MOD09GQ___006/MOD/replace-me-granuleId.hdf.met`,
                },
                {
                  bucket: config.buckets.public.name,
                  filename: `s3://${config.buckets.public.name}/MOD09GQ___006/MOD/replace-me-granuleId_ndvi.jpg`,
                },
                {
                  bucket: config.buckets['protected-2'].name,
                  filename: `s3://${config.buckets['protected-2'].name}/MOD09GQ___006/MOD/replace-me-granuleId.cmr.xml`,
                },
              ],
            },
          ],
        },
      });

      expectedPayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedOutputPayloadFilename, granuleId, testDataFolder, newCollectionId);
      expectedPayload.granules[0].dataType += testSuffix;
      expectedPayload.granules = addUniqueGranuleFilePathToGranuleFiles(expectedPayload.granules, testId);
      expectedPayload.granules[0].files = addUrlPathToGranuleFiles(expectedPayload.granules[0].files, testId, collectionUrlString);
      // process.env.DISTRIBUTION_ENDPOINT needs to be set for below
      setDistributionApiEnvVars();

      console.log('Start SuccessExecution');
      workflowExecutionArn = await buildAndStartWorkflow(
        config.stackName,
        config.bucket,
        workflowName,
        collection,
        provider,
        inputPayload,
        {
          distribution_endpoint: process.env.DISTRIBUTION_ENDPOINT,
        }
      );
      opendapFilePath = `https://opendap.uat.earthdata.nasa.gov/collections/C1218668453-CUMULUS/granules/${granuleId}`;
    } catch (error) {
      beforeAllError = error;
    }
  });

  afterAll(async () => {
    // granule may already have been deleted by
    // granule deletion spec. but in case that spec
    // wasn't reached, make sure granule is deleted
    if (!granuleWasDeleted) {
      try {
        await removePublishedGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
        });
      } catch (error) {
        if (error.statusCode !== 404 &&
            // remove from CMR throws a 400 when granule is missing
            (error.statusCode !== 400 && !error.apiMessage.includes('No record found'))) {
          throw error;
        }
      }
    }

    // clean up stack state added by test
    await apiTestUtils.deletePdr({
      prefix: config.stackName,
      pdr: pdrFilename,
    });
    await providersApi.deleteProvider({
      prefix: config.stackName,
      provider: { id: provider.id },
    });
    await deleteExecution({ prefix: config.stackName, executionArn: workflowExecutionArn });
    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      deleteCollection({
        prefix: config.stackName,
        collectionName: collection.name,
        collectionVersion: collection.version,
      }),
      deleteS3Object(config.bucket, granuleCompletedMessageKey),
      deleteS3Object(config.bucket, granuleRunningMessageKey),
    ]);
  });

  beforeEach(() => {
    if (beforeAllError) fail(beforeAllError);
  });

  it('prepares the test suite successfully', () => {
    failOnSetupError([beforeAllError]);
  });

  it('triggers a running execution record being added to DynamoDB', async () => {
    failOnSetupError([beforeAllError]);

    const record = await waitForModelStatus(
      executionModel,
      { arn: workflowExecutionArn },
      ['running', 'completed']
    );
    expect(['running', 'completed'].includes(record.status)).toBeTrue();
  });

  it('triggers a running PDR record being added to DynamoDB', async () => {
    failOnSetupError([beforeAllError]);

    const record = await waitForModelStatus(
      pdrModel,
      { pdrName: inputPayload.pdr.name },
      ['running', 'completed']
    );
    expect(['running', 'completed'].includes(record.status)).toBeTrue();
  });

  it('makes the granule available through the Cumulus API', async () => {
    failOnSetupError([beforeAllError]);

    await waitForModelStatus(
      granuleModel,
      { granuleId: inputPayload.granules[0].granuleId },
      ['running', 'completed']
    );

    const granule = await getGranule({
      prefix: config.stackName,
      granuleId: inputPayload.granules[0].granuleId,
    });

    expect(granule.granuleId).toEqual(inputPayload.granules[0].granuleId);
    expect(['running', 'completed'].includes(granule.status)).toBeTrue();
  });

  it('completes execution with success status', async () => {
    failOnSetupError([beforeAllError]);
    const workflowExecutionStatus = await waitForCompletedExecution(workflowExecutionArn);
    expect(workflowExecutionStatus).toEqual('SUCCEEDED');
  });

  it('adds checksums to all granule files', async () => {
    failOnSetupError([beforeAllError]);

    const execution = await StepFunctions.describeExecution({
      executionArn: workflowExecutionArn,
    });

    const executionOutput = JSON.parse(execution.output);

    const fullExecutionOutput = await pullStepFunctionEvent(executionOutput);

    fullExecutionOutput.meta.input_granules.forEach((granule) => {
      granule.files.forEach((granuleFile) => {
        expect(granuleFile.checksumType).withContext(JSON.stringify(granuleFile)).toBeTruthy();
        expect(granuleFile.checksum).withContext(JSON.stringify(granuleFile)).toBeTruthy();
      });
    });
  });

  it('can retrieve the specific provider that was created', async () => {
    failOnSetupError([beforeAllError]);

    const providerListResponse = await apiTestUtils.getProviders({ prefix: config.stackName });
    const providerList = JSON.parse(providerListResponse.body);
    expect(providerList.results.length).toBeGreaterThan(0);

    const providerResultResponse = await apiTestUtils.getProvider({ prefix: config.stackName, providerId: provider.id });
    const providerResult = JSON.parse(providerResultResponse.body);
    expect(providerResult).not.toBeNull();
  });

  it('can retrieve the specific collection that was created', async () => {
    failOnSetupError([beforeAllError]);

    const collectionListResponse = await apiTestUtils.getCollections({ prefix: config.stackName });
    const collectionList = JSON.parse(collectionListResponse.body);
    expect(collectionList.results.length).toBeGreaterThan(0);

    const collectionResponse = await apiTestUtils.getCollection(
      { prefix: config.stackName, collectionName: collection.name, collectionVersion: collection.version }
    );
    const collectionResult = JSON.parse(collectionResponse.body);
    expect(collectionResult).not.toBeNull();
  });

  it('results in the files being added to the granule files cache table', async () => {
    failOnSetupError([beforeAllError]);

    process.env.FilesTable = `${config.stackName}-FilesTable`;

    const executionOutput = await getExecutionOutput(workflowExecutionArn);

    await pMap(
      executionOutput.payload.granules[0].files,
      async (file) => {
        const { Bucket, Key } = parseS3Uri(file.filename);

        const granuleId = await pRetry(
          async () => {
            const id = await GranuleFilesCache.getGranuleId(Bucket, Key);
            if (id === undefined) throw new Error(`File not found in cache: s3://${Bucket}/${Key}`);
            return id;
          },
          { retries: 30, minTimeout: 2000, maxTimeout: 2000 }
        );

        expect(granuleId).toEqual(executionOutput.payload.granules[0].granuleId);
      },
      { concurrency: 1 }
    );
  });

  describe('the BackupGranulesToLzards task', () => {
    let lambdaOutput;
    let subTestSetupError;
    beforeAll(async () => {
      try {
        failOnSetupError([beforeAllError, subTestSetupError]);
        lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'LzardsBackup');
      } catch (error) {
        subTestSetupError = error;
      }
    });

    beforeEach(() => {
      failOnSetupError([beforeAllError, subTestSetupError]);
    });

    it('adds LZARDS backup output', () => {
      expect(true, lambdaOutput.meta.backupStatus.every((file) => file.status === 'COMPLETED'));
    });
  });

  describe('the SyncGranules task', () => {
    let lambdaInput;
    let lambdaOutput;
    let subTestSetupError;

    beforeAll(async () => {
      try {
        failOnSetupError([beforeAllError, subTestSetupError]);

        lambdaInput = await lambdaStep.getStepInput(workflowExecutionArn, 'SyncGranule');
        lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'SyncGranule');
      } catch (error) {
        beforeAllError = error;
      }
    });

    beforeEach(() => {
      failOnSetupError([beforeAllError, subTestSetupError]);
    });

    it('receives the correct collection and provider configuration', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      expect(lambdaInput.meta.collection.name).toEqual(collection.name);
      expect(lambdaInput.meta.provider.id).toEqual(provider.id);
    });

    it('output includes the ingested granule with file staging location paths', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const updatedGranule = {
        ...expectedSyncGranulePayload.granules[0],
        sync_granule_duration: lambdaOutput.meta.input_granules[0].sync_granule_duration,
      };

      const updatedPayload = {
        ...expectedSyncGranulePayload,
        granules: [updatedGranule],
      };
      expect(lambdaOutput.payload).toEqual(updatedPayload);
    });

    it('updates the meta object with input_granules', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const updatedGranule = {
        ...expectedSyncGranulePayload.granules[0],
        sync_granule_duration: lambdaOutput.meta.input_granules[0].sync_granule_duration,
      };
      expect(lambdaOutput.meta.input_granules).toEqual([updatedGranule]);
    });
  });

  describe('the MoveGranules task', () => {
    let lambdaOutput;
    let files;
    let movedTaggings;
    let existCheck = [];
    let subTestSetupError;

    beforeAll(async () => {
      try {
        failOnSetupError([subTestSetupError]);

        lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'MoveGranules');
        files = lambdaOutput.payload.granules[0].files;
        movedTaggings = await Promise.all(lambdaOutput.payload.granules[0].files.map((file) => {
          const { Bucket, Key } = parseS3Uri(file.filename);
          return s3GetObjectTagging(Bucket, Key);
        }));

        existCheck = await Promise.all([
          s3ObjectExists({ Bucket: files[0].bucket, Key: files[0].filepath }),
          s3ObjectExists({ Bucket: files[1].bucket, Key: files[1].filepath }),
          s3ObjectExists({ Bucket: files[2].bucket, Key: files[2].filepath }),
        ]);
      } catch (error) {
        subTestSetupError = error;
      }
    });

    beforeEach(() => {
      failOnSetupError([beforeAllError, subTestSetupError]);
    });

    it('has a payload with correct buckets, filenames, sizes', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      files.forEach((file) => {
        const expectedFile = expectedPayload.granules[0].files.find((f) => f.name === file.name);
        expect(file.filename).toEqual(expectedFile.filename);
        expect(file.bucket).toEqual(expectedFile.bucket);
        if (file.size && expectedFile.size) {
          expect(file.size).toEqual(expectedFile.size);
        }
      });
    });

    it('moves files to the bucket folder based on metadata', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });

    it('preserves tags on moved files', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      movedTaggings.forEach((tagging) => {
        expect(tagging.TagSet).toEqual(expectedS3TagSet);
      });
    });
  });

  describe('the PostToCmr task', () => {
    let cmrResource;
    let ummCmrResource;
    let files;
    let granule;
    let resourceURLs;
    let teaRequestHeaders;
    let scienceFileUrl;
    let s3ScienceFileUrl;
    let browseImageUrl;
    let s3BrowseImageUrl;
    let s3CredsUrl;

    let subTestSetupError;

    beforeAll(async () => {
      process.env.CMR_ENVIRONMENT = 'UAT';
      postToCmrOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'PostToCmr');

      if (postToCmrOutput === null) {
        beforeAllError = new Error(`Failed to get the PostToCmr step's output for ${workflowExecutionArn}`);
        return;
      }

      try {
        failOnSetupError([beforeAllError]);
        granule = postToCmrOutput.payload.granules[0];
        files = granule.files;

        const ummGranule = { ...granule, cmrMetadataFormat: 'umm_json_v1_6_2' };
        const result = await Promise.all([
          getOnlineResources(granule),
          getOnlineResources(ummGranule),
          getTEARequestHeaders(config.stackName),
        ]);

        cmrResource = result[0];
        ummCmrResource = result[1];
        resourceURLs = cmrResource.map((resource) => resource.href);
        teaRequestHeaders = result[2];

        scienceFileUrl = getDistributionFileUrl({ bucket: files[0].bucket, key: files[0].filepath });
        s3ScienceFileUrl = getDistributionFileUrl({ bucket: files[0].bucket, key: files[0].filepath, urlType: 's3' });
        browseImageUrl = getDistributionFileUrl({ bucket: files[2].bucket, key: files[2].filepath });
        s3BrowseImageUrl = getDistributionFileUrl({ bucket: files[2].bucket, key: files[2].filepath, urlType: 's3' });
        s3CredsUrl = resolve(process.env.DISTRIBUTION_ENDPOINT, 's3credentials');
      } catch (error) {
        subTestSetupError = error;
      }
    });

    beforeEach(() => {
      failOnSetupError([beforeAllError, subTestSetupError]);
    });

    it('publishes the granule metadata to CMR', async () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const result = await conceptExists(granule.cmrLink);
      expect(granule.published).toEqual(true);
      expect(result).not.toEqual(false);
    });

    it('updates the CMR metadata online resources with the final metadata location', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      console.log('parallel resourceURLs:', resourceURLs);
      console.log('s3CredsUrl:', s3CredsUrl);

      expect(resourceURLs).toContain(scienceFileUrl);
      expect(resourceURLs).toContain(s3ScienceFileUrl);
      expect(resourceURLs).toContain(browseImageUrl);
      expect(resourceURLs).toContain(s3BrowseImageUrl);
      expect(resourceURLs).toContain(s3CredsUrl);
      expect(resourceURLs).toContain(opendapFilePath);
    });

    it('updates the CMR metadata "online resources" with the proper types and urls', () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const resource = ummCmrResource;
      const expectedTypes = [
        'GET DATA',
        'GET DATA VIA DIRECT ACCESS',
        'VIEW RELATED INFORMATION',
        'VIEW RELATED INFORMATION',
        'GET RELATED VISUALIZATION',
        'GET RELATED VISUALIZATION',
        'VIEW RELATED INFORMATION',
        'USE SERVICE API',
      ];
      const cmrUrls = resource.map((r) => r.URL);

      expect(cmrUrls).toContain(scienceFileUrl);
      expect(cmrUrls).toContain(s3ScienceFileUrl);
      expect(cmrUrls).toContain(browseImageUrl);
      expect(cmrUrls).toContain(s3BrowseImageUrl);
      expect(cmrUrls).toContain(s3CredsUrl);
      expect(cmrUrls).toContain(opendapFilePath);
      expect(resource.map((r) => r.Type).sort()).toEqual(expectedTypes.sort());
    });

    it('includes the Earthdata login ID for requests to protected science files', async () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const filepath = `/${files[0].bucket}/${files[0].filepath}`;
      const s3SignedUrl = await getTEADistributionApiRedirect(filepath, teaRequestHeaders);
      const earthdataLoginParam = new URL(s3SignedUrl).searchParams.get('A-userid');
      expect(earthdataLoginParam).toEqual(process.env.EARTHDATA_USERNAME);
    });

    it('downloads the requested science file for authorized requests', async () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const scienceFileUrls = resourceURLs
        .filter((url) =>
          (url.startsWith(process.env.DISTRIBUTION_ENDPOINT) ||
          url.match(/s3\.amazonaws\.com/)) &&
          !url.endsWith('.cmr.xml') &&
          !url.includes('s3credentials'));

      const checkFiles = await Promise.all(
        scienceFileUrls
          .map(async (url) => {
            const extension = path.extname(new URL(url).pathname);
            const sourceFile = s3data.find((d) => d.endsWith(extension));
            const sourceChecksum = await generateChecksumFromStream(
              'cksum',
              fs.createReadStream(require.resolve(sourceFile))
            );
            const file = files.find((f) => f.name.endsWith(extension));

            const filepath = `/${file.bucket}/${file.filepath}`;
            const fileStream = await getTEADistributionApiFileStream(filepath, teaRequestHeaders);
            // Compare checksum of downloaded file with expected checksum.
            const downloadChecksum = await generateChecksumFromStream('cksum', fileStream);
            return downloadChecksum === sourceChecksum;
          })
      );

      checkFiles.forEach((fileCheck) => expect(fileCheck).toBeTrue());
    });
  });

  describe('A Cloudwatch event', () => {
    let subTestSetupError;

    beforeAll(async () => {
      try {
        failOnSetupError([beforeAllError]);
        console.log('Start FailingExecution');

        failingWorkflowExecution = await buildAndExecuteWorkflow(
          config.stackName,
          config.bucket,
          workflowName,
          collection,
          provider,
          {}
        );
      } catch (error) {
        subTestSetupError = error;
      }
    });

    beforeEach(() => {
      failOnSetupError([beforeAllError, subTestSetupError]);
    });

    it('triggers the granule record being added to DynamoDB', async () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const record = await waitForModelStatus(
        granuleModel,
        { granuleId: inputPayload.granules[0].granuleId },
        'completed'
      );
      expect(record.execution).toEqual(getExecutionUrl(workflowExecutionArn));
    });

    it('triggers the successful execution record being added to DynamoDB', async () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const record = await waitForModelStatus(
        executionModel,
        { arn: workflowExecutionArn },
        'completed'
      );
      expect(record.status).toEqual('completed');
    });

    it('triggers the failed execution record being added to DynamoDB', async () => {
      failOnSetupError([beforeAllError, subTestSetupError]);
      const record = await waitForModelStatus(
        executionModel,
        { arn: failingWorkflowExecution.executionArn },
        'failed'
      );
      expect(record.status).toEqual('failed');
      expect(record.error).toBeInstanceOf(Object);
    });
  });

  describe('an SNS message', () => {
    let executionName;
    let executionCompletedKey;
    let executionFailedKey;
    let failedExecutionArn;
    let failedExecutionName;

    beforeAll(() => {
      failedExecutionArn = failingWorkflowExecution.executionArn;
      failedExecutionName = failedExecutionArn.split(':').pop();
      executionName = postToCmrOutput.cumulus_meta.execution_name;

      executionFailedKey = `${config.stackName}/test-output/${failedExecutionName}.output`;
      executionCompletedKey = `${config.stackName}/test-output/${executionName}.output`;

      granuleCompletedMessageKey = `${config.stackName}/test-output/${inputPayload.granules[0].granuleId}-completed.output`;
      granuleRunningMessageKey = `${config.stackName}/test-output/${inputPayload.granules[0].granuleId}-running.output`;
    });

    afterAll(async () => {
      await deleteExecution({ prefix: config.stackName, executionArn: failedExecutionArn });

      await Promise.all([
        deleteS3Object(config.bucket, executionCompletedKey),
        deleteS3Object(config.bucket, executionFailedKey),
      ]);
    });

    beforeEach(() => {
      failOnSetupError([beforeAllError]);
    });

    it('is published for an execution on a successful workflow completion', async () => {
      failOnSetupError([beforeAllError]);

      const executionExists = await s3ObjectExists({
        Bucket: config.bucket,
        Key: executionCompletedKey,
      });
      expect(executionExists).toEqual(true);
    });

    it('is published for a granule on a successful workflow completion', async () => {
      failOnSetupError([beforeAllError]);

      const granuleExists = await s3ObjectExists({
        Bucket: config.bucket,
        Key: granuleCompletedMessageKey,
      });
      expect(granuleExists).toEqual(true);
    });

    it('is published for an execution on workflow failure', async () => {
      failOnSetupError([beforeAllError]);

      const executionExists = await s3ObjectExists({
        Bucket: config.bucket,
        Key: executionFailedKey,
      });

      expect(executionExists).toEqual(true);
    });
  });

  describe('The Cumulus API', () => {
    describe('granule endpoint', () => {
      let granule;
      let cmrLink;
      let publishGranuleExecution;
      let updateCmrAccessConstraintsExecutionArn;

      let subTestSetupError;

      beforeAll(async () => {
        try {
          failOnSetupError([beforeAllError]);

          granule = await getGranule({
            prefix: config.stackName,
            granuleId: inputPayload.granules[0].granuleId,
          });
          cmrLink = granule.cmrLink;
        } catch (error) {
          subTestSetupError = error;
        }
      });

      afterAll(async () => {
        const publishExecutionName = publishGranuleExecution.executionArn.split(':').pop();
        await deleteExecution({ prefix: config.stackName, executionArn: publishGranuleExecution.executionArn });
        await deleteExecution({ prefix: config.stackName, executionArn: updateCmrAccessConstraintsExecutionArn });
        await deleteS3Object(config.bucket, `${config.stackName}/test-output/${publishExecutionName}.output`);
      });

      beforeEach(() => {
        failOnSetupError([beforeAllError, subTestSetupError]);
      });

      it('makes the granule available through the Cumulus API', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(granule.granuleId).toEqual(inputPayload.granules[0].granuleId);
      });

      it('returns the granule with a CMR link', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(granule.cmrLink).not.toBeUndefined();
      });

      it('returns the granule with a timeToPreprocess', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(granule.timeToPreprocess).toBeInstanceOf(Number);
      });

      it('returns the granule with a timeToArchive', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(granule.timeToArchive).toBeInstanceOf(Number);
      });

      it('returns the granule with a processingStartDateTime', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(granule.processingStartDateTime).toBeInstanceOf(String);
      });

      it('returns the granule with a processingEndDateTime', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(granule.processingEndDateTime).toBeInstanceOf(String);
      });

      describe('when a reingest granule is triggered via the API', () => {
        let oldExecution;
        let oldUpdatedAt;
        let startTime;
        let reingestGranuleId;
        let fakeGranuleId;
        let asyncOperationId;
        let reingestExecutionArn;
        let bulkReingestResponse;
        let reingestBeforeAllError;

        beforeAll(async () => {
          try {
            startTime = new Date();
            oldUpdatedAt = granule.updatedAt;
            oldExecution = granule.execution;
            reingestGranuleId = inputPayload.granules[0].granuleId;
            fakeGranuleId = randomId('fakeGranuleId');

            bulkReingestResponse = await bulkReingestGranules({
              prefix: config.stackName,
              body: {
                ids: [reingestGranuleId, fakeGranuleId],
              },
            });
          } catch (error) {
            reingestBeforeAllError = error;
          }
        });

        afterAll(async () => {
          await apiTestUtils.deletePdr({
            prefix: config.stackName,
            pdr: pdrFilename,
          });

          await deleteExecution({ prefix: config.stackName, executionArn: reingestExecutionArn });
        });

        it('generates an async operation through the Cumulus API', () => {
          failOnSetupError([beforeAllError, subTestSetupError, reingestBeforeAllError]);

          const responseBody = JSON.parse(bulkReingestResponse.body);
          asyncOperationId = responseBody.id;
          expect(responseBody.operationType).toBe('Bulk Granule Reingest');
        });

        it('executes async operation successfully', async () => {
          failOnSetupError([beforeAllError, subTestSetupError, reingestBeforeAllError]);

          const asyncOperation = await waitForAsyncOperationStatus({
            id: asyncOperationId,
            status: 'SUCCEEDED',
            stackName: config.stackName,
            retryOptions: {
              retries: 70,
              factor: 1.041,
            },
          });

          const reingestOutput = JSON.parse(asyncOperation.output);
          expect(reingestOutput.length).toBe(2);
          expect(reingestOutput.includes(reingestGranuleId)).toBe(true);
          const fakeGranResult = reingestOutput.filter((result) => isObject(result));
          expect(fakeGranResult.length).toBe(1);
          expect(get(fakeGranResult[0], 'granuleId')).toEqual(fakeGranuleId);
        });

        it('overwrites granule files', async () => {
          failOnSetupError([beforeAllError, subTestSetupError, reingestBeforeAllError]);

          // Await reingest completion
          const reingestGranuleExecution = await waitForTestExecutionStart({
            workflowName,
            stackName: config.stackName,
            bucket: config.bucket,
            findExecutionFn: isReingestExecutionForGranuleId,
            findExecutionFnParams: { granuleId: inputPayload.granules[0].granuleId },
            startTask: 'SyncGranule',
          });

          reingestExecutionArn = reingestGranuleExecution.executionArn;
          console.log(`Wait for completed execution ${reingestExecutionArn}`);

          await waitForCompletedExecution(reingestExecutionArn);

          const moveGranuleOutput = await lambdaStep.getStepOutput(
            reingestExecutionArn,
            'MoveGranule'
          );

          const moveGranuleOutputFiles = moveGranuleOutput.payload.granules[0].files;
          const nonCmrFiles = moveGranuleOutputFiles.filter((f) => !f.filename.endsWith('.cmr.xml'));
          nonCmrFiles.forEach((f) => expect(f.duplicate_found).toBeTrue());

          await waitForModelStatus(
            granuleModel,
            { granuleId: reingestGranuleId },
            'completed'
          );

          const updatedGranule = await getGranule({
            prefix: config.stackName,
            granuleId: reingestGranuleId,
          });

          expect(updatedGranule.status).toEqual('completed');
          expect(updatedGranule.updatedAt).toBeGreaterThan(oldUpdatedAt);
          expect(updatedGranule.execution).not.toEqual(oldExecution);

          // the updated granule has the same files
          const oldFileNames = granule.files.map((f) => f.filename);
          const newFileNames = updatedGranule.files.map((f) => f.filename);
          expect(difference(oldFileNames, newFileNames).length).toBe(0);

          const currentFiles = await getFilesMetadata(updatedGranule.files);
          currentFiles.forEach((cf) => {
            expect(cf.LastModified).toBeGreaterThan(startTime);
          });
        });

        it('saves asyncOperationId to execution record', async () => {
          failOnSetupError([beforeAllError, subTestSetupError, reingestBeforeAllError]);

          const reingestExecution = await waitForModelStatus(
            executionModel,
            { arn: reingestExecutionArn },
            'completed'
          );
          expect(reingestExecution.asyncOperationId).toEqual(asyncOperationId);
        });
      });

      it('removeFromCMR removes the ingested granule from CMR', async () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        const existsInCMR = await conceptExists(cmrLink);

        expect(existsInCMR).toEqual(true);

        // Remove the granule from CMR
        await removeFromCMR({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
        });

        // Check that the granule was removed
        await waitForConceptExistsOutcome(cmrLink, false);
        const doesExist = await conceptExists(cmrLink);
        expect(doesExist).toEqual(false);
      });

      it('applyWorkflow PublishGranule publishes the granule to CMR', async () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        const existsInCMR = await conceptExists(cmrLink);
        expect(existsInCMR).toEqual(false);

        // Publish the granule to CMR
        await applyWorkflow({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
          workflow: 'PublishGranule',
        });

        publishGranuleExecution = await waitForTestExecutionStart({
          workflowName: 'PublishGranule',
          stackName: config.stackName,
          bucket: config.bucket,
          findExecutionFn: isExecutionForGranuleId,
          findExecutionFnParams: { granuleId: inputPayload.granules[0].granuleId },
          startTask: 'PostToCmr',
        });

        console.log(`Wait for completed execution ${publishGranuleExecution.executionArn}`);

        await waitForCompletedExecution(publishGranuleExecution.executionArn);

        await waitForConceptExistsOutcome(cmrLink, true);
        const doesExist = await conceptExists(cmrLink);
        expect(doesExist).toEqual(true);
      });

      it('applyworkflow UpdateCmrAccessConstraints updates and publishes CMR metadata', async () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        const existsInCMR = await conceptExists(cmrLink);
        expect(existsInCMR).toEqual(true);

        const accessConstraints = {
          value: 17,
          description: 'Test-UpdateCmrAccessConstraints',
        };
        // Publish the granule to CMR
        await applyWorkflow({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
          workflow: 'UpdateCmrAccessConstraints',
          meta: {
            accessConstraints,
          },
        });

        const updateCmrAccessConstraintsExecution = await waitForTestExecutionStart({
          workflowName: 'UpdateCmrAccessConstraints',
          stackName: config.stackName,
          bucket: config.bucket,
          findExecutionFn: isExecutionForGranuleId,
          findExecutionFnParams: { granuleId: inputPayload.granules[0].granuleId },
          startTask: 'UpdateCmrAccessConstraints',
        });

        updateCmrAccessConstraintsExecutionArn = updateCmrAccessConstraintsExecution.executionArn;

        console.log(`Wait for completed execution ${updateCmrAccessConstraintsExecutionArn}`);

        await waitForCompletedExecution(updateCmrAccessConstraintsExecutionArn);
        await waitForModelStatus(
          granuleModel,
          { granuleId: granule.granuleId },
          'completed'
        );

        const updatedGranuleRecord = await getGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
        });
        const updatedGranuleCmrFile = updatedGranuleRecord.files.find(isCMRFile);

        const granuleCmrMetadata = await metadataObjectFromCMRFile(`s3://${updatedGranuleCmrFile.bucket}/${updatedGranuleCmrFile.key}`);
        expect(granuleCmrMetadata.Granule.RestrictionFlag).toEqual(accessConstraints.value.toString());
        expect(granuleCmrMetadata.Granule.RestrictionComment).toEqual(accessConstraints.description);
      });

      describe('when moving a granule', () => {
        let file;
        let destinationKey;
        let destinations;
        let moveGranuleSetupError;

        beforeAll(() => {
          try {
            failOnSetupError([beforeAllError]);

            file = granule.files[0];

            destinationKey = `${testDataFolder}/${file.key}`;

            destinations = [{
              regex: '.*.hdf$',
              bucket: config.bucket,
              filepath: `${testDataFolder}/${path.dirname(file.key)}`,
            }];
          } catch (error) {
            subTestSetupError = error;
            console.error('Error in beforeAll() block:', error);
            console.log(`File errored on: ${JSON.stringify(file, undefined, 2)}`);
          }
        });

        beforeEach(() => {
          failOnSetupError([beforeAllError, subTestSetupError, moveGranuleSetupError]);
        });

        it('rejects moving a granule to a location that already exists', async () => {
          failOnSetupError([beforeAllError, subTestSetupError, moveGranuleSetupError]);
          await s3CopyObject({
            Bucket: config.bucket,
            CopySource: `${file.bucket}/${file.key}`,
            Key: destinationKey,
          });

          let moveGranuleResponseError;
          try {
            await moveGranule({
              prefix: config.stackName,
              granuleId: inputPayload.granules[0].granuleId,
              destinations,
            });
          } catch (error) {
            moveGranuleResponseError = error;
          }

          expect(moveGranuleResponseError.statusCode).toEqual(409);
          expect(JSON.parse(moveGranuleResponseError.apiMessage).message).toEqual(
            `Cannot move granule because the following files would be overwritten at the destination location: ${granule.files[0].fileName}. Delete the existing files or reingest the source files.`
          );
        });

        it('when the file is deleted and the move retried, the move completes successfully', async () => {
          failOnSetupError([beforeAllError, subTestSetupError, moveGranuleSetupError]);
          await deleteS3Object(config.bucket, destinationKey);

          // Sanity check
          let fileExists = await s3ObjectExists({ Bucket: config.bucket, Key: destinationKey });
          expect(fileExists).toBe(false);

          const moveGranuleResponse = await moveGranule({
            prefix: config.stackName,
            granuleId: inputPayload.granules[0].granuleId,
            destinations,
          });

          expect(moveGranuleResponse.statusCode).toEqual(200);

          fileExists = await s3ObjectExists({ Bucket: config.bucket, Key: destinationKey });
          expect(fileExists).toBeTrue();
        });
      });

      it('can delete the ingested granule from the API', async () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        await removePublishedGranule({
          prefix: config.stackName,
          granuleId: inputPayload.granules[0].granuleId,
        });

        // Verify deletion
        let granuleResponseError;
        try {
          await getGranule({
            prefix: config.stackName,
            granuleId: inputPayload.granules[0].granuleId,
            expectedStatusCodes: 404,
          });
        } catch (error) {
          granuleResponseError = error;
        }
        expect(JSON.parse(granuleResponseError.apiMessage).message).toEqual('Granule not found');
        granuleWasDeleted = true;
      });
    });

    describe('executions endpoint', () => {
      let executionResponse;
      let executions;

      let subTestSetupError;

      beforeAll(async () => {
        try {
          failOnSetupError([beforeAllError]);
          const executionsApiResponse = await executionsApiTestUtils.getExecutions({
            prefix: config.stackName,
          });
          executions = JSON.parse(executionsApiResponse.body);
          executionResponse = await executionsApiTestUtils.getExecution({
            prefix: config.stackName,
            arn: workflowExecutionArn,
          });
        } catch (error) {
          subTestSetupError = error;
        }
      });

      beforeEach(() => {
        if (beforeAllError) fail(beforeAllError);
        if (subTestSetupError) fail(subTestSetupError);
      });

      it('returns a list of exeuctions', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(executions.results.length).toBeGreaterThan(0);
      });

      it('returns overall status and timing for the execution', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        expect(executionResponse.status).toBeDefined();
        expect(executionResponse.createdAt).toBeDefined();
        expect(executionResponse.updatedAt).toBeDefined();
        expect(executionResponse.duration).toBeDefined();
      });

      it('returns tasks metadata with name and version', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);
        expect(executionResponse.tasks).toBeDefined();
        expect(executionResponse.tasks.length).not.toEqual(0);
        Object.keys(executionResponse.tasks).forEach((step) => {
          const task = executionResponse.tasks[step];
          expect(task.name).toBeDefined();
          expect(task.version).toBeDefined();
        });
      });
    });

    describe('When accessing a workflow execution via the API', () => {
      let executionStatus;

      let subTestSetupError;

      beforeAll(async () => {
        try {
          const executionStatusResponse = await executionsApiTestUtils.getExecutionStatus({
            prefix: config.stackName,
            arn: workflowExecutionArn,
          });

          executionStatus = JSON.parse(executionStatusResponse.body);
        } catch (error) {
          subTestSetupError = error;
        }
      });

      beforeEach(() => {
        if (beforeAllError) fail(beforeAllError);
        if (subTestSetupError) fail(subTestSetupError);
      });

      it('returns the inputs and outputs for the entire workflow', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        expect(executionStatus.execution).toBeTruthy();
        expect(executionStatus.execution.executionArn).toEqual(workflowExecutionArn);
        const input = JSON.parse(executionStatus.execution.input);
        const output = JSON.parse(executionStatus.execution.output);
        expect(input.payload).toEqual(inputPayload);
        expect(output.payload || output.replace).toBeTruthy();
      });

      it('returns the stateMachine information and workflow definition', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        expect(executionStatus.stateMachine).toBeTruthy();
        expect(executionStatus.stateMachine.stateMachineArn).toEqual(executionStatus.execution.stateMachineArn);
        expect(executionStatus.stateMachine.stateMachineArn.endsWith(executionStatus.stateMachine.name)).toBeTrue();

        const definition = JSON.parse(executionStatus.stateMachine.definition);
        expect(definition.Comment).toEqual('Ingest Granule');

        // definition has all the states' information
        expect(Object.keys(definition.States).length).toBe(12);
      });

      it('returns the inputs, outputs, timing, and status information for each executed step', () => {
        failOnSetupError([beforeAllError, subTestSetupError]);

        expect(executionStatus.executionHistory).toBeTruthy();

        // expected 'not executed' steps
        const expectedNotExecutedSteps = ['WorkflowFailed'];

        // expected 'executed' steps
        const expectedExecutedSteps = [
          'SyncGranule',
          'ChooseProcess',
          'ProcessingStep',
          'FilesToGranulesStep',
          'MoveGranuleStep',
          'UpdateGranulesCmrMetadataFileLinksStep',
          'HyraxMetadataUpdatesTask',
          'CmrStep',
          'WorkflowSucceeded',
          'BackupGranulesToLzards',
        ];

        // steps with *EventDetails will have the input/output, and also stepname when state is entered/exited
        const stepNames = [];
        executionStatus.executionHistory.events.forEach((event) => {
          // expect timing information for each step
          expect(event.timestamp).toBeDefined();
          const eventKeys = Object.keys(event);
          // protect against "undefined": TaskStateEntered has "input" but not "name"
          if (event.name && intersection(eventKeys, ['input', 'output']).length === 1) {
            // each step should contain status information
            if (event.type === 'TaskStateExited') {
              const prevEvent = executionStatus.executionHistory.events[event.previousEventId - 1];
              expect(['LambdaFunctionSucceeded', 'LambdaFunctionFailed']).toContain(prevEvent.type);
            }
            if (!includes(stepNames, event.name)) stepNames.push(event.name);
          }
        });

        // all the executed steps have *EventDetails
        expect(difference(expectedExecutedSteps, stepNames).length).toBe(0);
        // some steps are not executed
        expect(difference(expectedNotExecutedSteps, stepNames).length).toBe(expectedNotExecutedSteps.length);
      });
    });
  });
});
