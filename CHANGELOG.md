# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/).

## Unreleased

## [v11.0.0] 2022-03-24 [STABLE]

### v9.9->v11.0 MIGRATION NOTES

Release v11.0 is a maintenance release series, replacing v9.9.   If you are
upgrading to or past v11 from v9.9.x to this release, please pay attention to the following
migration notes from prior releases:

#### Migration steps

##### **After deploying the `data-persistence` module, but before deploying the main `cumulus` module**

- Due to a bug in the PUT `/rules/<name>` endpoint, the rule records in PostgreSQL may be
out of sync with records in DynamoDB. In order to bring the records into sync, re-run the
[previously deployed `data-migration1` Lambda](https://nasa.github.io/cumulus/docs/upgrade-notes/upgrade-rds#3-deploy-and-run-data-migration1) with a payload of
`{"forceRulesMigration": true}`:

```shell
aws lambda invoke --function-name $PREFIX-data-migration1 \
  --payload $(echo '{"forceRulesMigration": true}' | base64) $OUTFILE
```

##### As part of the `cumulus` deployment

- Please read the [documentation on the updates to the granule files schema for our Cumulus workflow tasks and how to upgrade your deployment for compatibility](https://nasa.github.io/cumulus/docs/upgrade-notes/update-task-file-schemas).
- (Optional) Update the `task-config` for all workflows that use the `sync-granule` task to include `workflowStartTime` set to
`{$.cumulus_meta.workflow_start_time}`. See [here](https://github.com/nasa/cumulus/blob/master/example/cumulus-tf/sync_granule_workflow.asl.json#L9) for an example.

### Notable changes

- **CUMULUS-2703**
  - `ORCA Backup` is now a supported `reportType` for the `POST /reconciliationReports` endpoint

### Added

- **CUMULUS-2311** - RDS Migration Epic Phase 2
  - **CUMULUS-2208**
    - Added `@cumulus/message/utils.parseException` to parse exception objects
    - Added helpers to `@cumulus/message/Granules`:
      - `getGranuleProductVolume`
      - `getGranuleTimeToPreprocess`
      - `getGranuleTimeToArchive`
      - `generateGranuleApiRecord`
    - Added `@cumulus/message/PDRs/generatePdrApiRecordFromMessage` to generate PDR from Cumulus workflow message
    - Added helpers to `@cumulus/es-client/indexer`:
      - `deleteAsyncOperation` to delete async operation records from Elasticsearch
      - `updateAsyncOperation` to update an async operation record in Elasticsearch
    - Added granules `PUT` endpoint to Cumulus API for updating a granule.
    Requests to this endpoint should be submitted **without an `action`**
    attribute in the request body.
    - Added `@cumulus/api-client/granules.updateGranule` to update granule via the API
  - **CUMULUS-2303**
    - Add translatePostgresProviderToApiProvider method to `@cumulus/db/translate/providers`
  - **CUMULUS-2306**
    - Updated API execution GET endpoint to read individual execution records
      from PostgreSQL database instead of DynamoDB
    - Updated API execution-status endpoint to read execution records from
      PostgreSQL database instead of DynamoDB
  - **CUMULUS-2302**
    - Added translatePostgresCollectionToApiCollection method to
      `@cumulus/db/translate/collections`
    - Added `searchWithUpdatedAtRange` method to
      `@cumulus/db/models/collections`
  - **CUMULUS-2301**
    - Created API asyncOperations POST endpoint to create async operations.
  - **CUMULUS-2307**
    - Updated API PDR GET endpoint to read individual PDR records from
      PostgreSQL database instead of DynamoDB
    - Added `deletePdr` to `@cumulus/api-client/pdrs`
  - **CUMULUS-2782**
    - Update API granules endpoint `move` action to update granules in the index
      and utilize postgres as the authoritative datastore
  - **CUMULUS-2769**
    - Update collection PUT endpoint to require existance of postgresql record
      and to ignore lack of dynamoDbRecord on update
  - **CUMULUS-2767**
    - Update provider PUT endpoint to require existence of PostgreSQL record
      and to ignore lack of DynamoDB record on update
  - **CUMULUS-2759**
    - Updates collection/provider/rules/granules creation (post) endpoints to
      primarily check for existence/collision in PostgreSQL database instead of DynamoDB
  - **CUMULUS-2714**
    - Added `@cumulus/db/base.deleteExcluding` method to allow for deletion of a
      record set with an exclusion list of cumulus_ids
  - **CUMULUS-2317**
    - Added `@cumulus/db/getFilesAndGranuleInfoQuery()` to build a query for searching file
    records in PostgreSQL and return specified granule information for each file
    - Added `@cumulus/db/QuerySearchClient` library to handle sequentially fetching and paging
    through results for an arbitrary PostgreSQL query
    - Added `insert` method to all `@cumulus/db` models to handle inserting multiple records into
    the database at once
    - Added `@cumulus/db/translatePostgresGranuleResultToApiGranule` helper to
    translate custom PostgreSQL granule result to API granule
  - **CUMULUS-2672**
    - Added migration to add `type` text column to Postgres database `files` table
  - **CUMULUS-2634**
    - Added new functions for upserting data to Elasticsearch:
      - `@cumulus/es-client/indexer.upsertExecution` to upsert an execution
      - `@cumulus/es-client/indexer.upsertPdr` to upsert a PDR
      - `@cumulus/es-client/indexer.upsertGranule` to upsert a granule
  - **CUMULUS-2510**
    - Added `execution_sns_topic_arn` environment variable to
      `sf_event_sqs_to_db_records` lambda TF definition.
    - Added to `sf_event_sqs_to_db_records_lambda` IAM policy to include
      permissions for SNS publish for `report_executions_topic`
    - Added `collection_sns_topic_arn` environment variable to
      `PrivateApiLambda` and `ApiEndpoints` lambdas.
    - Added `updateCollection` to `@cumulus/api-client`.
    - Added to `ecs_cluster` IAM policy to include permissions for SNS publish
      for `report_executions_sns_topic_arn`, `report_pdrs_sns_topic_arn`,
      `report_granules_sns_topic_arn`
    - Added variables for report topic ARNs to `process_dead_letter_archive.tf`
    - Added variable for granule report topic ARN to `bulk_operation.tf`
    - Added `pdr_sns_topic_arn` environment variable to
      `sf_event_sqs_to_db_records` lambda TF definition.
    - Added the new function `publishSnsMessageByDataType` in `@cumulus/api` to
      publish SNS messages to the report topics to PDRs, Collections, and
      Executions.
    - Added the following functions in `publishSnsMessageUtils` to handle
      publishing SNS messages for specific data and event types:
      - `publishCollectionUpdateSnsMessage`
      - `publishCollectionCreateSnsMessage`
      - `publishCollectionDeleteSnsMessage`
      - `publishGranuleUpdateSnsMessage`
      - `publishGranuleDeleteSnsMessage`
      - `publishGranuleCreateSnsMessage`
      - `publishExecutionSnsMessage`
      - `publishPdrSnsMessage`
      - `publishGranuleSnsMessageByEventType`
    - Added to `ecs_cluster` IAM policy to include permissions for SNS publish
      for `report_executions_topic` and `report_pdrs_topic`.
  - **CUMULUS-2315**
    - Added `paginateByCumulusId` to `@cumulus/db` `BasePgModel` to allow for paginated
      full-table select queries in support of elasticsearch indexing.
    - Added `getMaxCumulusId` to `@cumulus/db` `BasePgModel` to allow all
      derived table classes to support querying the current max `cumulus_id`.
  - **CUMULUS-2673**
    - Added `ES_HOST` environment variable to `postgres-migration-async-operation`
    Lambda using value of `elasticsearch_hostname` Terraform variable.
    - Added `elasticsearch_security_group_id` to security groups for
      `postgres-migration-async-operation` lambda.
    - Added permission for `DynamoDb:DeleteItem` to
      `postgres-migration-async-operation` lambda.
  - **CUMULUS-2778**
    - Updated default value of `async_operation_image` in
      `tf-modules/cumulus/variables.tf` to `cumuluss/async-operation:41`
    - Added `ES_HOST` environment variable to async operation ECS task
      definition to ensure that async operation tasks write to the correct
      Elasticsearch domain
- **CUMULUS-2642**
  - Reduces the reconcilation report's default maxResponseSize that returns
     the full report rather than an s3 signed url. Reports very close to the
     previous limits were failing to download, so the limit has been lowered to
     ensure all files are handled properly.
- **CUMULUS-2703**
  - Added `@cumulus/api/lambdas/reports/orca-backup-reconciliation-report` to create
    `ORCA Backup` reconciliation report

### Removed

- **CUMULUS-2311** - RDS Migration Epic Phase 2
  - **CUMULUS-2208**
    - Removed trigger for `dbIndexer` Lambda for DynamoDB tables:
      - `<prefix>-AsyncOperationsTable`
      - `<prefix>-CollectionsTable`
      - `<prefix>-ExecutionsTable`
      - `<prefix>-GranulesTable`
      - `<prefix>-PdrsTable`
      - `<prefix>-ProvidersTable`
      - `<prefix>-RulesTable`
  - **CUMULUS-2782**
    - Remove deprecated `@ingest/granule.moveGranuleFiles`
  - **CUMULUS-2770**
    - Removed `waitForModelStatus` from `example/spec/helpers/apiUtils` integration test helpers
  - **CUMULUS-2510**
    - Removed `stream_enabled` and `stream_view_type` from `executions_table` TF
      definition.
    - Removed `aws_lambda_event_source_mapping` TF definition on executions
      DynamoDB table.
    - Removed `stream_enabled` and `stream_view_type` from `collections_table`
      TF definition.
    - Removed `aws_lambda_event_source_mapping` TF definition on collections
      DynamoDB table.
    - Removed lambda `publish_collections` TF resource.
    - Removed `aws_lambda_event_source_mapping` TF definition on granules
    - Removed `stream_enabled` and `stream_view_type` from `pdrs_table` TF
      definition.
    - Removed `aws_lambda_event_source_mapping` TF definition on PDRs
      DynamoDB table.
  - **CUMULUS-2694**
    - Removed `@cumulus/api/models/granules.storeGranulesFromCumulusMessage()` method
  - **CUMULUS-2662**
    - Removed call to `addToLocalES` in POST `/granules` endpoint since it is
      redundant.
    - Removed call to `addToLocalES` in POST and PUT `/executions` endpoints
      since it is redundant.
    - Removed function `addToLocalES` from `es-client` package since it is no
      longer used.
  - **CUMULUS-2771**
    - Removed `_updateGranuleStatus` to update granule to "running" from `@cumulus/api/lib/ingest.reingestGranule`
    and `@cumulus/api/lib/ingest.applyWorkflow`

### Changed

- CVE-2022-2477
  - Update node-forge to 1.3.0 in `@cumulus/common` to address CVE-2022-2477
- **CUMULUS-2311** - RDS Migration Epic Phase 2
  - **CUMULUS_2641**
    - Update API granule schema to set productVolume as a string value
    - Update `@cumulus/message` package to set productVolume as string
      (calculated with `file.size` as a `BigInt`) to match API schema
    - Update `@cumulus/db` granule translation to translate `granule` objects to
      match the updated API schema
  - **CUMULUS-2714**
    - Updated
      - @cumulus/api/lib.writeRecords.writeGranulesFromMessage
      - @cumulus/api/lib.writeRecords.writeGranuleFromApi
      - @cumulus/api/lib.writeRecords.createGranuleFromApi
      - @cumulus/api/lib.writeRecords.updateGranuleFromApi
    - These methods now remove postgres file records that aren't contained in
        the write/update action if such file records exist.  This update
        maintains consistency with the writes to elasticsearch/dynamodb.
  - **CUMULUS-2672**
    - Updated `data-migration2` lambda to migrate Dynamo `granule.files[].type`
      instead of dropping it.
    - Updated `@cumlus/db` `translateApiFiletoPostgresFile` to retain `type`
    - Updated `@cumulus/db` `translatePostgresFileToApiFile` to retain `type`
    - Updated `@cumulus/types.api.file` to add `type` to the typing.
  - **CUMULUS-2315**
    - Update `index-from-database` lambda/ECS task and elasticsearch endpoint to read
      from PostgreSQL database
    - Update `index-from-database` endpoint to add the following configuration
      tuning parameters:
      - postgresResultPageSize -- The number of records to read from each
        postgres table per request.   Default is 1000.
      - postgresConnectionPoolSize -- The max number of connections to allow the
        index function to make to the database.  Default is 10.
      - esRequestConcurrency -- The maximium number of concurrent record
        translation/ES record update requests.   Default is 10.
  - **CUMULUS-2308**
    - Update `/granules/<granule_id>` GET endpoint to return PostgreSQL Granules instead of DynamoDB Granules
    - Update `/granules/<granule_id>` PUT endpoint to use PostgreSQL Granule as source rather than DynamoDB Granule
    - Update `unpublishGranule` (used in /granules PUT) to use PostgreSQL Granule as source rather than DynamoDB Granule
    - Update integration tests to use `waitForApiStatus` instead of `waitForModelStatus`
    - Update Granule ingest to update the Postgres Granule status as well as the DynamoDB Granule status
  - **CUMULUS-2302**
    - Update API collection GET endpoint to read individual provider records from
      PostgreSQL database instead of DynamoDB
    - Update sf-scheduler lambda to utilize API endpoint to get provider record
      from database via Private API lambda
    - Update API granule `reingest` endpoint to read collection from PostgreSQL
      database instead of DynamoDB
    - Update internal-reconciliation report to base report Collection comparison
      on PostgreSQL instead of DynamoDB
    - Moved createGranuleAndFiles `@cumulus/api` unit helper from `./lib` to
      `.test/helpers`
  - **CUMULUS-2208**
    - Moved all `@cumulus/api/es/*` code to new `@cumulus/es-client` package
    - Updated logic for collections API POST/PUT/DELETE to create/update/delete
      records directly in Elasticsearch in parallel with updates to
      DynamoDb/PostgreSQL
    - Updated logic for rules API POST/PUT/DELETE to create/update/delete
      records directly in Elasticsearch in parallel with updates to
      DynamoDb/PostgreSQL
    - Updated logic for providers API POST/PUT/DELETE to create/update/delete
      records directly in  Elasticsearch in parallel with updates to
      DynamoDb/PostgreSQL
    - Updated logic for PDRs API DELETE to delete records directly in
      Elasticsearch in parallel with deletes to DynamoDB/PostgreSQL
    - Updated logic for executions API DELETE to delete records directly in
      Elasticsearch in parallel with deletes to DynamoDB/PostgreSQL
    - Updated logic for granules API DELETE to delete records directly in
      Elasticsearch in parallel with deletes to DynamoDB/PostgreSQL
    - `sfEventSqsToDbRecords` Lambda now writes following data directly to
      Elasticsearch in parallel with writes to DynamoDB/PostgreSQL:
      - executions
      - PDRs
      - granules
    - All async operations are now written directly to Elasticsearch in parallel
      with DynamoDB/PostgreSQL
    - Updated logic for async operation API DELETE to delete records directly in
      Elasticsearch in parallel with deletes to DynamoDB/PostgreSQL
    - Moved:
      - `packages/api/lib/granules.getGranuleProductVolume` ->
      `@cumulus/message/Granules.getGranuleProductVolume`
      - `packages/api/lib/granules.getGranuleTimeToPreprocess`
      -> `@cumulus/message/Granules.getGranuleTimeToPreprocess`
      - `packages/api/lib/granules.getGranuleTimeToArchive` ->
      `@cumulus/message/Granules.getGranuleTimeToArchive`
      - `packages/api/models/Granule.generateGranuleRecord`
      -> `@cumulus/message/Granules.generateGranuleApiRecord`
  - **CUMULUS-2306**
    - Updated API local serve (`api/bin/serve.js`) setup code to add cleanup/executions
    related records
    - Updated @cumulus/db/models/granules-executions to add a delete method in
      support of local cleanup
    - Add spec/helpers/apiUtils/waitForApiStatus integration helper to retry API
      record retrievals on status in lieu of using `waitForModelStatus`
  - **CUMULUS-2303**
    - Update API provider GET endpoint to read individual provider records from
      PostgreSQL database instead of DynamoDB
    - Update sf-scheduler lambda to utilize API endpoint to get provider record
      from database via Private API lambda
  - **CUMULUS-2301**
    - Updated `getAsyncOperation` to read from PostgreSQL database instead of
      DynamoDB.
    - Added `translatePostgresAsyncOperationToApiAsyncOperation` function in
      `@cumulus/db/translate/async-operation`.
    - Updated `translateApiAsyncOperationToPostgresAsyncOperation` function to
      ensure that `output` is properly translated to an object for the
      PostgreSQL record for the following cases of `output` on the incoming API
      record:
      - `record.output` is a JSON stringified object
      - `record.output` is a JSON stringified array
      - `record.output` is a JSON stringified string
      - `record.output` is a string
  - **CUMULUS-2317**
    - Changed reconciliation reports to read file records from PostgreSQL instead of DynamoDB
  - **CUMULUS-2304**
    - Updated API rule GET endpoint to read individual rule records from
      PostgreSQL database instead of DynamoDB
    - Updated internal consumer lambdas for SNS, SQS and Kinesis to read
      rules from PostgreSQL.
  - **CUMULUS-2634**
    - Changed `sfEventSqsToDbRecords` Lambda to use new upsert helpers for executions, granules, and PDRs
    to ensure out-of-order writes are handled correctly when writing to Elasticsearch
  - **CUMULUS-2510**
    - Updated `@cumulus/api/lib/writeRecords/write-execution` to publish SNS
      messages after a successful write to Postgres, DynamoDB, and ES.
    - Updated functions `create` and `upsert` in the `db` model for Executions
      to return an array of objects containing all columns of the created or
      updated records.
    - Updated `@cumulus/api/endpoints/collections` to publish an SNS message
      after a successful collection delete, update (PUT), create (POST).
    - Updated functions `create` and `upsert` in the `db` model for Collections
      to return an array of objects containing all columns for the created or
      updated records.
    - Updated functions `create` and `upsert` in the `db` model for Granules
      to return an array of objects containing all columns for the created or
      updated records.
    - Updated `@cumulus/api/lib/writeRecords/write-granules` to publish SNS
      messages after a successful write to Postgres, DynamoDB, and ES.
    - Updated `@cumulus/api/lib/writeRecords/write-pdr` to publish SNS
      messages after a successful write to Postgres, DynamoDB, and ES.
  - **CUMULUS-2733**
    - Updated `_writeGranuleFiles` function creates an aggregate error which
      contains the workflow error, if any, as well as any error that may occur
      from writing granule files.
  - **CUMULUS-2674**
    - Updated `DELETE` endpoints for the following data types to check that record exists in
      PostgreSQL or Elasticsearch before proceeding with deletion:
      - `provider`
      - `async operations`
      - `collections`
      - `granules`
      - `executions`
      - `PDRs`
      - `rules`
  - **CUMULUS-2294**
    - Updated architecture and deployment documentation to reference RDS
  - **CUMULUS-2642**
    - Inventory and Granule Not Found Reconciliation Reports now compare
      Databse against S3 in on direction only, from Database to S3
      Objects. This means that only files in the database are compared against
      objects found on S3 and the filesInCumulus.onlyInS3 report key will
      always be empty. This significantly decreases the report output size and
      aligns with a users expectations.
    - Updates getFilesAndGranuleInfoQuery to take additional optional
      parameters `collectionIds`, `granuleIds`, and `providers` to allow
      targeting/filtering of the results.

  - **CUMULUS-2694**
    - Updated database write logic in `sfEventSqsToDbRccords` to log message if Cumulus
    workflow message is from pre-RDS deployment but still attempt parallel writing to DynamoDB
    and PostgreSQL
    - Updated database write logic in `sfEventSqsToDbRccords` to throw error if requirements to write execution to PostgreSQL cannot be met
  - **CUMULUS-2660**
    - Updated POST `/executions` endpoint to publish SNS message of created record to executions SNS topic
  - **CUMULUS-2661**
    - Updated PUT `/executions/<arn>` endpoint to publish SNS message of updated record to executions SNS topic
  - **CUMULUS-2765**
    - Updated `updateGranuleStatusToQueued` in `write-granules` to write to
      Elasticsearch and publish SNS message to granules topic.
  - **CUMULUS-2774**
    - Updated `constructGranuleSnsMessage` and `constructCollectionSnsMessage`
      to throw error if `eventType` is invalid or undefined.
  - **CUMULUS-2776**
    - Updated `getTableIndexDetails` in `db-indexer` to use correct
      `deleteFnName` for reconciliation reports.
  - **CUMULUS-2780**
    - Updated bulk granule reingest operation to read granules from PostgreSQL instead of DynamoDB.
  - **CUMULUS-2778**
    - Updated default value of `async_operation_image` in `tf-modules/cumulus/variables.tf` to `cumuluss/async-operation:38`
  - **CUMULUS-2854**
    - Updated rules model to decouple `createRuleTrigger` from `create`.
    - Updated rules POST endpoint to call `rulesModel.createRuleTrigger` directly to create rule trigger.
    - Updated rules PUT endpoints to call `rulesModel.createRuleTrigger` if update fails and reversion needs to occur.

### Fixed

- **CUMULUS-2311** - RDS Migration Epic Phase 2
  - **CUMULUS-2810**
    - Updated @cumulus/db/translate/translatePostgresProviderToApiProvider to
      correctly return provider password and updated tests to prevent
      reintroduction.
  - **CUMULUS-2778**
    - Fixed async operation docker image to correctly update record status in
    Elasticsearch
  - Updated localAPI to set additional env variable, and fixed `GET /executions/status` response
  - **CUMULUS-2877**
    - Ensure database records receive a timestamp when writing granules.
