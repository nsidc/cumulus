'use strict';

const cumulusMessageAdapter = require('@cumulus/cumulus-message-adapter-js');
const get = require('lodash/get');
const keyBy = require('lodash/keyBy');

const { fetchDistributionBucketMap } = require('@cumulus/distribution-utils');

const BucketsConfig = require('@cumulus/common/BucketsConfig');

const {
  addEtagsToFileObjects,
  isCMRFile,
  granulesToCmrFileObjects,
  mapFileEtags,
  removeEtagsFromFileObjects,
  updateCMRMetadata,
} = require('@cumulus/cmrjs');

/**
 * Update each of the CMR files' OnlineAccessURL fields to represent the new
 * file locations. This function assumes that there will only ever be a single CMR file per granule.
 *
 * @param {Array<Object>} cmrFiles       - array of objects that include CMR xmls uris and
 *                                         granuleIds
 * @param {Object} granulesObject        - an object of the granules where the key is the granuleId
 * @param {string} cmrGranuleUrlType .   - type of granule CMR url
 * @param {string} distEndpoint          - the api distribution endpoint
 * @param {Object} bucketTypes           - map of bucket names to bucket types
 * @param {Object} distributionBucketMap - mapping of bucket->distirubtion path values
 *                                         (e.g. { bucket: distribution path })
 * @returns {Promise<Object[]>} Array of updated CMR files with etags of newly updated files.
 *
 */
async function updateEachCmrFileAccessURLs(
  cmrFiles,
  granulesObject,
  cmrGranuleUrlType,
  distEndpoint,
  bucketTypes,
  distributionBucketMap
) {
  return await Promise.all(cmrFiles.map(async (cmrFile) => {
    const granuleId = cmrFile.granuleId;
    const granule = granulesObject[granuleId];
    return await updateCMRMetadata({
      granuleId,
      cmrFile: granule.files.find(isCMRFile),
      files: granule.files,
      distEndpoint,
      published: false,
      bucketTypes,
      cmrGranuleUrlType,
      distributionBucketMap,
    });
  }));
}

async function updateGranulesCmrMetadataFileLinks(event) {
  const config = event.config;
  const bucketsConfig = new BucketsConfig(config.buckets);
  const bucketTypes = Object.fromEntries(Object.values(bucketsConfig.buckets)
    .map(({ name, type }) => [name, type]));

  const cmrGranuleUrlType = get(config, 'cmrGranuleUrlType', 'both');

  const incomingETags = event.config.etags || {};
  const granules = event.input.granules.map((g) => addEtagsToFileObjects(g, incomingETags));
  const cmrFiles = granulesToCmrFileObjects(granules);
  const granulesByGranuleId = keyBy(granules, 'granuleId');

  const excludes = {
    'extensions': {}
    // This should be the `meta.extensionExcludes`, I believe, though it can be modified
    // to use a regex if necessary.  I was trying to figure out how the `event.config`
    // object is mapped out; is it the same as the `event.meta` in the input file?
  };

  const distributionBucketMap = await fetchDistributionBucketMap();
  const updatedCmrFiles = await updateEachCmrFileAccessURLs(
    cmrFiles,
    granulesByGranuleId,
    cmrGranuleUrlType,
    config.distribution_endpoint,
    bucketTypes,
    distributionBucketMap
    // I think we may need to pass the `excludes` along the pipeline here so we have access to 
    // the configuration.
  );

  // Map etag info from granules' CMR files
  const updatedCmrETags = mapFileEtags(updatedCmrFiles);
  const outputGranules = Object.values(granulesByGranuleId);
  outputGranules.forEach(removeEtagsFromFileObjects);
  return {
    granules: outputGranules,
    etags: { ...incomingETags, ...updatedCmrETags },
  };
}

/**
 * Lambda handler
 *
 * @param {Object} event      - a Cumulus Message
 * @param {Object} context    - an AWS Lambda context
 * @returns {Promise<Object>} - Returns output from task.
 *                              See schemas/output.json for detailed output schema
 */
async function handler(event, context) {
  return await cumulusMessageAdapter.runCumulusTask(
    updateGranulesCmrMetadataFileLinks,
    event, context
  );
}

exports.handler = handler;
exports.updateGranulesCmrMetadataFileLinks = updateGranulesCmrMetadataFileLinks;
