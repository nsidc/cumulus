'use strict';

const fs = require('fs');
const path = require('path');
const test = require('ava');
const cloneDeep = require('lodash/cloneDeep');

const {
  buildS3Uri,
  getObjectSize,
  recursivelyDeleteS3Bucket,
  putJsonS3Object,
  promiseS3Upload,
  parseS3Uri,
} = require('@cumulus/aws-client/S3');
const {
  randomId, randomString, validateConfig, validateInput, validateOutput,
} = require('@cumulus/common/test-utils');
const { s3 } = require('@cumulus/aws-client/services');
const { getDistributionBucketMapKey } = require('@cumulus/distribution-utils');

const { updateGranulesCmrMetadataFileLinks } = require('..');

function cmrReadStream(file) {
  return file.endsWith('.cmr.xml') ? fs.createReadStream('tests/data/meta.xml') : fs.createReadStream('tests/data/ummg-meta.json');
}

async function uploadFiles(files, bucket) {
  await Promise.all(files.map((file) => promiseS3Upload({
    params: {
      Bucket: bucket,
      Key: parseS3Uri(file).Key,
      Body: !(file.endsWith('.cmr.xml') || file.endsWith('.cmr.json'))
        ? parseS3Uri(file).Key : cmrReadStream(file),
    },
  })));
}

function granulesToFileURIs(stagingBucket, granules) {
  const files = granules.reduce((arr, g) => arr.concat(g.files), []);
  return files.map((file) => buildS3Uri(stagingBucket, file.key));
}

function buildPayload(t) {
  const newPayload = t.context.payload;

  newPayload.config.bucket = t.context.stagingBucket;
  newPayload.config.buckets.internal.name = t.context.stagingBucket;
  newPayload.config.buckets.public.name = t.context.publicBucket;
  newPayload.config.buckets.protected.name = t.context.protectedBucket;

  const updatedETagConfigObject = {};
  Object.keys(newPayload.config.etags).forEach((k) => {
    const ETag = newPayload.config.etags[k];
    const newURI = buildS3Uri(
      t.context.stagingBucket,
      parseS3Uri(k).Key
    );
    updatedETagConfigObject[newURI] = ETag;
  });
  newPayload.config.etags = updatedETagConfigObject;

  newPayload.input.granules.forEach((gran) => {
    gran.files.forEach((file) => {
      file.bucket = t.context.stagingBucket;
    });
  });

  return newPayload;
}

test.beforeEach(async (t) => {
  t.context.stagingBucket = randomId('staging');
  t.context.publicBucket = randomId('public');
  t.context.protectedBucket = randomId('protected');
  t.context.systemBucket = randomId('system');
  t.context.stackName = randomString();
  await Promise.all([
    s3().createBucket({ Bucket: t.context.stagingBucket }),
    s3().createBucket({ Bucket: t.context.publicBucket }),
    s3().createBucket({ Bucket: t.context.protectedBucket }),
    s3().createBucket({ Bucket: t.context.systemBucket }),
  ]);
  process.env.system_bucket = t.context.systemBucket;
  process.env.stackName = t.context.stackName;
  putJsonS3Object(
    t.context.systemBucket,
    getDistributionBucketMapKey(t.context.stackName),
    {
      [t.context.stagingBucket]: t.context.stagingBucket,
      [t.context.publicBucket]: t.context.publicBucket,
      [t.context.protectedBucket]: t.context.protectedBucket,
      [t.context.systemBucket]: t.context.systemBucket,
    }
  );

  const payloadPath = path.join(__dirname, 'data', 'payload.json');
  const rawPayload = fs.readFileSync(payloadPath, 'utf8');
  t.context.payload = JSON.parse(rawPayload);
  const filesToUpload = granulesToFileURIs(
    t.context.stagingBucket,
    t.context.payload.input.granules
  );
  t.context.filesToUpload = filesToUpload;
  process.env.REINGEST_GRANULE = false;
});

test.afterEach.always(async (t) => {
  await recursivelyDeleteS3Bucket(t.context.publicBucket);
  await recursivelyDeleteS3Bucket(t.context.stagingBucket);
  await recursivelyDeleteS3Bucket(t.context.protectedBucket);
  await recursivelyDeleteS3Bucket(t.context.systemBucket);
});

test.serial('Should map etag for each CMR metadata file by checking that etag is one or more characters, not whitespace', async (t) => {
  const newPayload = buildPayload(t);
  await validateConfig(t, newPayload.config);
  await validateInput(t, newPayload.input);
  const filesToUpload = cloneDeep(t.context.filesToUpload);
  await uploadFiles(filesToUpload, t.context.stagingBucket);

  const output = await updateGranulesCmrMetadataFileLinks(newPayload);
  await validateOutput(t, output);

  Object.values(output.etags).forEach((etag) => t.regex(etag, /"\S+"/));
});

test.serial('Should update existing etag on CMR metadata file', async (t) => {
  const newPayload = buildPayload(t);
  await validateConfig(t, newPayload.config);
  await validateInput(t, newPayload.input);
  const filesToUpload = cloneDeep(t.context.filesToUpload);
  const ETagS3URI = Object.keys(newPayload.config.etags)[0];
  const previousEtag = newPayload.config.etags[ETagS3URI];
  await uploadFiles(filesToUpload, t.context.stagingBucket);

  const output = await updateGranulesCmrMetadataFileLinks(newPayload);
  await validateOutput(t, output);
  const newEtag = output.etags[ETagS3URI];
  t.false([previousEtag, undefined].includes(newEtag));
});

test.serial('update-granules-cmr-metadata-file-links throws an error when cmr file type is both and no distribution endpoint is set', async (t) => {
  const newPayload = buildPayload(t);
  await validateConfig(t, newPayload.config);
  await validateInput(t, newPayload.input);
  delete newPayload.config.distribution_endpoint;

  const filesToUpload = cloneDeep(t.context.filesToUpload);
  await uploadFiles(filesToUpload, t.context.stagingBucket);

  await t.throwsAsync(
    () => updateGranulesCmrMetadataFileLinks(newPayload),
    { message: 'cmrGranuleUrlType is both, but no distribution endpoint is configured.' }
  );
});

test.serial('update-granules-cmr-metadata-file-links does not throw error if no etags config is provided', async (t) => {
  const newPayload = buildPayload(t);
  // remove etags config
  delete newPayload.config.etags;

  await validateConfig(t, newPayload.config);
  await validateInput(t, newPayload.input);

  const filesToUpload = cloneDeep(t.context.filesToUpload);
  await uploadFiles(filesToUpload, t.context.stagingBucket);

  await t.notThrowsAsync(
    () => updateGranulesCmrMetadataFileLinks(newPayload)
  );
});

test.serial('update-granules-cmr-metadata-file-links clears checksums for updated CMR file', async (t) => {
  const newPayload = buildPayload(t);

  await validateConfig(t, newPayload.config);
  await validateInput(t, newPayload.input);

  const filesToUpload = cloneDeep(t.context.filesToUpload);
  await uploadFiles(filesToUpload, t.context.stagingBucket);

  const message = await updateGranulesCmrMetadataFileLinks(newPayload);

  message.granules.forEach((granule) => {
    granule.files.forEach((file) => {
      if (file.type == "metadata") {
        t.is(file.checksum, undefined);
        t.is(file.checksumType, undefined);
      } else {
        t.not(file.checksum, undefined);
        t.not(file.checksumType, undefined);
      }
    });
  });
});

test.serial('update-granules-cmr-metadata-file-links updates size for updated CMR file', async (t) => {
  const newPayload = buildPayload(t);

  await validateConfig(t, newPayload.config);
  await validateInput(t, newPayload.input);

  const filesToUpload = cloneDeep(t.context.filesToUpload);
  await uploadFiles(filesToUpload, t.context.stagingBucket);

  const message = await updateGranulesCmrMetadataFileLinks(newPayload);

  for (const granule of message.granules) {
    for (const file of granule.files) {
      if (file.type === "metadata") {
        const bucket = file.bucket;
        const key = file.key;
        let expectedSize = await getObjectSize({ s3: s3(), bucket, key });

        t.is(file.size, expectedSize);
      }
    }
  }
});