import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { knowledgeRoutes } from '../src/routes/knowledge-routes.js';

test('knowledge preserves source details and filters exact milestone month and activity range', async () => {
  const app = Fastify();
  app.decorate('authenticate', async () => {});
  app.register(knowledgeRoutes);
  try {
    const all = await app.inject('/api/v1/development/milestones');
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().data.length, 119);
    assert.ok(all.json().dataRelease.sources.length > 0);
    const month = await app.inject('/api/v1/development/milestones?month=6');
    assert.ok(month.json().data.length > 0);
    for (const item of month.json().data) {
      assert.equal(item.monthAge, 6);
      assert.equal(item.details.assessmentAgeMonths, 6);
      assert.ok(Array.isArray(item.details.sourceRefs));
    }
    const activities = await app.inject('/api/v1/development/activities?month=2');
    assert.ok(activities.json().data.length > 0);
    for (const { details } of activities.json().data) {
      assert.ok(details.ageMinMonths === null || details.ageMinMonths <= 2);
      assert.ok(details.ageMaxMonths === null || details.ageMaxMonths >= 2);
      assert.ok(Array.isArray(details.steps));
    }
    assert.equal((await app.inject('/api/v1/development/milestones?month=-1')).statusCode, 400);
  } finally { await app.close(); }
});
