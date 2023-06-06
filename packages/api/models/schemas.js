'use strict';

// NOTE -- This schema is being removed/deprecated in P3,
// updates to this schema MUST be made to /api/lib/schemas.js

module.exports.accessToken = {
  title: 'Access Token Object',
  description: 'Cumulus API AccessToken Table schema',
  type: 'object',
  required: ['accessToken', 'expirationTime'],
  additionalProperties: false,
  properties: {
    accessToken: {
      title: 'Access Token',
      description: 'The access token returned by the OAuth provider',
      type: 'string',
    },
    createdAt: { type: 'integer' },
    expirationTime: {
      description: 'The expiration time of the access token in milliseconds',
      type: 'integer',
    },
    refreshToken: {
      title: 'Refresh Token',
      description: 'The refresh token returned by the OAuth provider',
      type: 'string',
    },
    updatedAt: { type: 'integer' },
    username: {
      title: 'Username',
      description:
        'The username associated with the access token. For valid request authorization, the username must match a record in the Users table',
      type: 'string',
    },
    tokenInfo: {
      title: 'Token Info',
      description:
        'The information associated with the access token, such as user profile information',
      type: 'object',
      additionalProperties: true,
    },
  },
};

// NOTE -- This schema is being removed/deprecated in P3,
// updates to this schema MUST be made to /api/lib/schemas.js
// Collection Record Definition
module.exports.collection = {
  title: 'Collection Object',
  description: 'Cumulus-api Collection Table schema',
  type: 'object',
  properties: {
    name: {
      title: 'Name',
      description: 'Collection short_name registered with the CMR',
      type: 'string',
    },
    version: {
      title: 'Version',
      description: 'The version registered with the CMR.',
      type: 'string',
    },
    dataType: {
      title: 'DataType',
      description: 'This field is deprecated and unused',
      type: 'string',
    },
    process: {
      title: 'Process',
      description: 'Name of the docker process to be used, e.g. modis, aster',
      type: 'string',
    },
    url_path: {
      title: 'Url Path',
      description: 'The folder (url) used to save granules on S3 buckets',
      type: 'string',
    },
    duplicateHandling: {
      title: 'Duplicate Granule Handling',
      description: 'How to handle duplicate granules',
      type: 'string',
      enum: ['error', 'skip', 'replace', 'version'],
      default: 'error',
    },
    granuleId: {
      title: 'GranuleId Validation Regex',
      description:
        'The regular expression used to validate the granule ID ' +
        'extracted from filenames according to the `granuleIdExtraction`',
      type: 'string',
    },
    granuleIdExtraction: {
      title: 'GranuleId Extraction Regex',
      description:
        'The regular expression used to extract the granule ID from filenames. ' +
        'The first capturing group extracted from the filename by the regex' +
        'will be used as the granule ID.',
      type: 'string',
    },
    reportToEms: {
      title: 'Report to EMS',
      description: 'Indicates whether the collection will be reported to EMS',
      type: 'boolean',
      default: true,
    },
    sampleFileName: {
      title: 'Sample Filename',
      description:
        'Is used to validate to test granule ID ' +
        'validation and extraction regexes against',
      type: 'string',
    },
    ignoreFilesConfigForDiscovery: {
      title: 'Ignore Files Configuration During Discovery',
      description:
        "When true, ignore this collection's files config list for" +
        ' determining which files to ingest for a granule, and ingest all of' +
        ' them.  When false, ingest only files that match a regex in one of' +
        " this collection's files config list.  When this property is" +
        ' specified on a task, it overrides the value set on a collection.' +
        ' Defaults to false.',
      type: 'boolean',
    },
    files: {
      title: 'Files',
      description: 'List of file definitions',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          regex: {
            title: 'Regex',
            description: 'Regular expression used to identify the file',
            type: 'string',
          },
          sampleFileName: {
            title: 'Sample Filename',
            description:
              'Filename used to validate the provided regular expression',
            type: 'string',
          },
          bucket: {
            title: 'Bucket',
            description: 'Bucket name used to store the file',
            type: 'string',
          },
          url_path: {
            title: 'Url Path',
            description:
              'Folder used to save the granule in the bucket. ' +
              'Defaults to the collection url_path',
            type: 'string',
          },
          type: {
            title: 'File Type',
            description:
              'CNM file type.  Cumulus uses this for CMR submission.  Non-CNM file types will be treated as "data" type',
            type: 'string',
          },
          checksumFor: {
            title: 'Checksum-For Regex',
            description:
              "Regex to identify the base file for which this files serves as a sidecar checksum file. Should be identical to the 'regex' property of the base file",
            type: 'string',
          },
          lzards: {
            title: 'LZARDS configuration',
            type: 'object',
            properties: {
              backup: {
                title: 'LZARDS backup flag',
                description:
                  'Boolean configuration value to determine if file type should be backed up by backup components.  Defaults to false',
                type: 'boolean',
              },
            },
          },
          reportToEms: {
            title: 'Report to EMS',
            description:
              'Indicates whether the granule with this file type will be reported to EMS when the collection level configuration is true.',
            type: 'boolean',
            default: true,
          },
        },
        required: ['regex', 'sampleFileName', 'bucket'],
      },
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: {
      type: 'integer',
    },
    meta: {
      title: 'Optional Metadata for the Collection',
      type: 'object',
      additionalProperties: true,
      s3MultipartChunksizeMb: {
        description:
          'chunk size of the S3 multipart uploads for the collection',
        type: 'number',
      },
      granuleMetadataFileExtension: {
        title: 'Optional file extension for tasks that utilize metadata file to look for the granule metadata information, e.g. .cmr.json, .iso.xml',
        type: 'string',
      },
    },
    tags: {
      title: 'Optional tags for search',
      type: 'array',
      items: {
        type: 'string',
      },
    },
  },
  required: [
    'name',
    'version',
    'granuleId',
    'granuleIdExtraction',
    'sampleFileName',
    'files',
    'createdAt',
    'updatedAt',
  ],
};

// NOTE -- This schema is being removed/deprecated in P3
// updates to this schema MUST be made to /api/lib/schemas.js
module.exports.file = {
  type: 'object',
  required: ['granuleId', 'bucket', 'key', 'createdAt', 'updatedAt'],
  properties: {
    granuleId: { type: 'string' },
    bucket: { type: 'string' },
    key: { type: 'string' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
  },
};

// NOTE -- This schema is being removed/deprecated in P3
// updates to this schema MUST be made to /api/lib/schemas.js
// Granule Record Schema
module.exports.granule = {
  title: 'Granule Object',
  type: 'object',
  properties: {
    granuleId: {
      title: 'Granule ID',
      type: 'string',
      readonly: true,
    },
    pdrName: {
      title: 'PDR associated with the granule',
      type: 'string',
      readonly: true,
    },
    collectionId: {
      title: 'Collection associated with the granule',
      type: 'string',
      readonly: true,
    },
    status: {
      title: 'Ingest status of the granule',
      enum: ['running', 'completed', 'failed', 'queued'],
      type: 'string',
    },
    execution: {
      title: 'Step Function Execution link',
      type: 'string',
      readonly: true,
    },
    cmrLink: {
      type: 'string',
      readonly: true,
    },
    published: {
      type: 'boolean',
      description: 'shows whether the granule is published to CMR',
      readonly: true,
    },
    duration: {
      title: 'Ingest duration',
      type: 'number',
      readonly: true,
    },
    files: {
      title: 'Files',
      description: 'List of file definitions',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bucket: { type: 'string' },
          checksum: { type: 'string' },
          checksumType: { type: 'string' },
          createdAt: { type: 'integer' },
          fileName: { type: 'string' },
          key: { type: 'string' },
          size: { type: 'integer' },
          source: { type: 'string' },
          type: { type: 'string' },
          updatedAt: { type: 'integer' },
        },
      },
    },
    error: {
      type: 'object',
      additionalProperties: true,
    },
    productVolume: {
      type: 'string',
      readonly: true,
    },
    timeToPreprocess: {
      type: 'number',
      readonly: true,
    },
    beginningDateTime: {
      type: 'string',
      readonly: true,
    },
    endingDateTime: {
      type: 'string',
      readonly: true,
    },
    processingStartDateTime: {
      type: 'string',
      readonly: true,
    },
    processingEndDateTime: {
      type: 'string',
      readonly: true,
    },
    lastUpdateDateTime: {
      type: 'string',
      readonly: true,
    },
    timeToArchive: {
      type: 'number',
      readonly: true,
    },
    productionDateTime: {
      type: 'string',
      readonly: true,
    },
    timestamp: { type: 'integer' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    provider: { type: 'string' },
    queryFields: {
      description: 'fields for query and metrics purpose',
      type: 'object',
      additionalProperties: true,
    },
  },
  required: ['granuleId', 'collectionId', 'status', 'updatedAt'],
};

// NOTE -- This schema is being removed/deprecated in P3,
// updates to this schema MUST be made to /api/lib/schemas.js
// Reconciliation Report record
module.exports.reconciliationReport = {
  title: 'ReconciliationReport Object',
  description: 'Cumulus API ReconciliationReports Table schema',
  type: 'object',
  required: ['name', 'type', 'status', 'createdAt', 'updatedAt'],
  properties: {
    name: { type: 'string' },
    type: {
      type: 'string',
      enum: [
        'Granule Inventory',
        'Granule Not Found',
        'Internal',
        'Inventory',
        'ORCA Backup',
      ],
    },
    status: {
      type: 'string',
      enum: ['Generated', 'Pending', 'Failed'],
    },
    location: { type: 'string' },
    error: {
      type: 'object',
      additionalProperties: true,
    },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
  },
};

// NOTE -- This schema is being removed/deprecated in P3,
// updates to this schema MUST be made to /api/lib/schemas.js
// PDR Record Schema
module.exports.pdr = {
  title: 'PDR Record Object',
  type: 'object',
  properties: {
    pdrName: {
      title: 'PDR Name',
      type: 'string',
      readonly: true,
    },
    collectionId: {
      title: 'Collection Name',
      type: 'string',
      readonly: true,
    },
    provider: {
      title: 'Provider Name',
      type: 'string',
      readonly: true,
    },
    status: {
      type: 'string',
      enum: ['running', 'failed', 'completed'],
      readonly: true,
    },
    progress: {
      type: 'number',
      readonly: true,
    },
    execution: {
      type: 'string',
      readonly: true,
    },
    PANSent: {
      type: 'boolean',
      readonly: true,
    },
    PANmessage: {
      type: 'string',
      readonly: true,
    },
    stats: {
      type: 'object',
      readonly: true,
      properties: {
        total: {
          type: 'number',
        },
        completed: {
          type: 'number',
        },
        failed: {
          type: 'number',
        },
        processing: {
          type: 'number',
        },
      },
    },
    address: {
      type: 'string',
      readonly: true,
    },
    originalUrl: {
      type: 'string',
      readonly: true,
    },
    timestamp: { type: 'integer' },
    duration: { type: 'number' },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: { type: 'integer' },
  },
  required: ['pdrName', 'provider', 'collectionId', 'status', 'createdAt'],
};

// NOTE -- This schema is being removed/deprecated in P3,
// updates to this schema MUST be made to /api/lib/schemas.js
// Provider Schema => the model keeps information about each ingest location
module.exports.provider = {
  title: 'Provider Object',
  description: 'Keep the information about each ingest endpoint',
  type: 'object',
  properties: {
    id: {
      title: 'Provider Name',
      type: 'string',
    },
    globalConnectionLimit: {
      title: 'Concurrent Connection Limit',
      type: 'integer',
    },
    protocol: {
      title: 'Protocol',
      type: 'string',
      enum: ['http', 'https', 'ftp', 'sftp', 's3'],
      default: 'http',
    },
    host: {
      title: 'Host',
      type: 'string',
    },
    allowedRedirects: {
      title: 'Allowed Redirects',
      description:
        'Only hosts in this list will have the provider username/password forwarded for authentication. Entries should be specified as host.com or host.com:7000 if redirect port is different than the provider port.',
      type: 'array',
      items: {
        type: 'string',
      },
    },
    port: {
      title: 'Port',
      type: 'number',
    },
    username: {
      type: 'string',
    },
    password: {
      type: 'string',
    },
    encrypted: {
      type: 'boolean',
      readonly: true,
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: {
      type: 'integer',
      readonly: true,
    },
    privateKey: {
      type: 'string',
      description:
        'filename assumed to be in s3://bucketInternal/stackName/crypto',
    },
    cmKeyId: {
      title: 'AWS KMS Customer Master Key ARN Or Alias',
      type: 'string',
      description: 'AWS KMS Customer Master Key ARN Or Alias',
    },
    certificateUri: {
      title: 'S3 URI For Custom SSL Certificate',
      type: 'string',
      description:
        'Optional SSL Certificate S3 URI for custom or self-signed SSL (TLS) certificate',
    },
  },
  required: ['id', 'protocol', 'host', 'createdAt'],
};

// NOTE -- This schema is being removed/deprecated in P3,
// updates to this schema MUST be made to /api/lib/schemas.js
// Execution Schema => the model keeps information about each step function execution
module.exports.execution = {
  title: 'Execution Object',
  description: 'Keep the information about each step function execution',
  type: 'object',
  properties: {
    arn: {
      title: 'Execution arn (this field is unique)',
      type: 'string',
    },
    name: {
      title: 'Execution name',
      type: 'string',
    },
    execution: {
      title: 'The execution page url on AWS console',
      type: 'string',
    },
    error: {
      title: 'The error details in case of a failed execution',
      type: 'object',
      additionalProperties: true,
    },
    tasks: {
      type: 'object',
      additionalProperties: true,
    },
    type: {
      title: 'The workflow name, e.g. IngestGranule',
      type: 'string',
    },
    status: {
      title: 'the execution status',
      enum: ['running', 'completed', 'failed', 'unknown'],
      type: 'string',
    },
    createdAt: {
      type: 'integer',
      readonly: true,
    },
    updatedAt: { type: 'integer' },
    timestamp: {
      type: 'number',
      readonly: true,
    },
    originalPayload: {
      title: 'The original payload for this workflow',
      type: 'object',
      additionalProperties: true,
    },
    finalPayload: {
      title: 'The final payload of this workflow',
      type: 'object',
      additionalProperties: true,
    },
    collectionId: { type: 'string' },
    duration: { type: 'number' },
    parentArn: { type: 'string' },
    asyncOperationId: { type: 'string' },
    cumulusVersion: { type: 'string' },
  },
  required: ['arn', 'name', 'status', 'createdAt', 'updatedAt'],
};
