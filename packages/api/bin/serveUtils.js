'use strict';

const pEachSeries = require('p-each-series');
const indexer = require('@cumulus/es-client/indexer');
const {
  AsyncOperationPgModel,
  CollectionPgModel,
  createTestDatabase,
  envParams,
  ExecutionPgModel,
  FilePgModel,
  getKnexClient,
  GranulePgModel,
  GranulesExecutionsPgModel,
  localStackConnectionEnv,
  migrationDir,
  PdrPgModel,
  ProviderPgModel,
  RulePgModel,
  translateApiCollectionToPostgresCollection,
  translateApiExecutionToPostgresExecution,
  translateApiGranuleToPostgresGranule,
  translateApiPdrToPostgresPdr,
  translateApiProviderToPostgresProvider,
  translateApiRuleToPostgresRule,
  translatePostgresExecutionToApiExecution,
  upsertGranuleWithExecutionJoinRecord,
} = require('@cumulus/db');
const { log } = require('console');
const models = require('../models');
const { createRuleTrigger } = require('../lib/rulesHelpers');
const { fakeGranuleFactoryV2 } = require('../lib/testUtils');
const { getESClientAndIndex } = require('./local-test-defaults');

/**
* Remove all records from api-related postgres tables
* @param {Object} knex - knex/knex transaction object
* @returns {[Promise]} - Array of promises with deletion results
*/
async function erasePostgresTables(knex) {
  const asyncOperationPgModel = new AsyncOperationPgModel();
  const collectionPgModel = new CollectionPgModel();
  const executionPgModel = new ExecutionPgModel();
  const filePgModel = new FilePgModel();
  const granulePgModel = new GranulePgModel();
  const granulesExecutionsPgModel = new GranulesExecutionsPgModel();
  const pdrPgModel = new PdrPgModel();
  const providerPgModel = new ProviderPgModel();
  const rulePgModel = new RulePgModel();

  await granulesExecutionsPgModel.delete(knex, {});
  await granulePgModel.delete(knex, {});
  await pdrPgModel.delete(knex, {});
  await executionPgModel.delete(knex, {});
  await asyncOperationPgModel.delete(knex, {});
  await filePgModel.delete(knex, {});
  await granulePgModel.delete(knex, {});
  await rulePgModel.delete(knex, {});
  await collectionPgModel.delete(knex, {});
  await providerPgModel.delete(knex, {});
}

async function resetPostgresDb() {
  const knexAdmin = await getKnexClient({ env: localStackConnectionEnv });
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
      migrationDir,
    },
  });

  try {
    await createTestDatabase(knexAdmin, 'postgres', localStackConnectionEnv.PG_USER);
  } catch (error) {
    log(`Skipping Postgres DB creation because ${error}`);
  }

  await knex.migrate.latest();

  await erasePostgresTables(knex);
}

async function addCollections(collections) {
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
    },
  });

  const es = await getESClientAndIndex();
  const collectionPgModel = new CollectionPgModel();
  return await Promise.all(
    collections.map(async (c) => {
      await indexer.indexCollection(es.client, c, es.index);
      const dbRecord = await translateApiCollectionToPostgresCollection(c);
      await collectionPgModel.create(knex, dbRecord);
    })
  );
}

async function addGranules(granules) {
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
    },
  });

  const executionPgModel = new ExecutionPgModel();
  const es = await getESClientAndIndex();
  return await Promise.all(
    granules.map(async (apiGranule) => {
      const newGranule = fakeGranuleFactoryV2(
        {
          ...apiGranule,
        }
      );
      await indexer.indexGranule(es.client, newGranule, es.index);
      const dbRecord = await translateApiGranuleToPostgresGranule({
        dynamoRecord: newGranule,
        knexOrTransaction: knex,
      });
      const executionCumulusId = await executionPgModel.getRecordCumulusId(knex, {
        url: newGranule.execution,
      });

      await upsertGranuleWithExecutionJoinRecord({
        knexTransaction: knex,
        granule: dbRecord,
        executionCumulusId,
      });
    })
  );
}

async function addProviders(providers) {
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
    },
  });

  const es = await getESClientAndIndex();
  const providerPgModel = new ProviderPgModel();
  return await Promise.all(
    providers.map(async (provider) => {
      await indexer.indexProvider(es.client, provider, es.index);
      const dbRecord = await translateApiProviderToPostgresProvider(provider);
      await providerPgModel.create(knex, dbRecord);
    })
  );
}

async function addRules(rules) {
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
    },
  });

  const es = await getESClientAndIndex();
  const rulePgModel = new RulePgModel();
  return await Promise.all(
    rules.map(async (r) => {
      const ruleRecord = await createRuleTrigger(r);
      await indexer.indexRule(es.client, ruleRecord, es.index);
      const dbRecord = await translateApiRuleToPostgresRule(ruleRecord, knex);
      await rulePgModel.create(knex, dbRecord);
    })
  );
}

async function addExecutions(executions) {
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
    },
  });

  const es = await getESClientAndIndex();

  executions.sort((firstEl, secondEl) => {
    if (!firstEl.parentArn && !secondEl.parentArn) {
      return 0;
    }

    if ((!firstEl.parentArn && secondEl.parentArn) || firstEl.arn === secondEl.parentArn) {
      return -1;
    }

    return 1;
  });

  const executionPgModel = new ExecutionPgModel();
  const executionsIterator = async (execution) => {
    const dbRecord = await translateApiExecutionToPostgresExecution(execution, knex);
    const [writtenPostgresDbRecord] = await executionPgModel.create(knex, dbRecord);
    const apiExecutionRecord = await translatePostgresExecutionToApiExecution(
      writtenPostgresDbRecord,
      knex
    );
    await indexer.indexExecution(es.client, apiExecutionRecord, es.index);
  };

  await pEachSeries(executions, executionsIterator);
}

async function addPdrs(pdrs) {
  const knex = await getKnexClient({
    env: {
      ...envParams,
      ...localStackConnectionEnv,
    },
  });

  const es = await getESClientAndIndex();
  const pdrPgModel = new PdrPgModel();
  return await Promise.all(
    pdrs.map(async (p) => {
      await indexer.indexPdr(es.client, p, es.index);
      const dbRecord = await translateApiPdrToPostgresPdr(p, knex);
      await pdrPgModel.create(knex, dbRecord);
    })
  );
}

async function addReconciliationReports(reconciliationReports) {
  const reconciliationReportModel = new models.ReconciliationReport();
  const es = await getESClientAndIndex();
  return await Promise.all(
    reconciliationReports.map((r) =>
      reconciliationReportModel
        .create(r)
        .then((reconciliationReport) =>
          indexer.indexReconciliationReport(es.client, reconciliationReport, es.index)))
  );
}

module.exports = {
  resetPostgresDb,
  addProviders,
  addCollections,
  addExecutions,
  addGranules,
  addPdrs,
  addReconciliationReports,
  addRules,
  erasePostgresTables,
};
