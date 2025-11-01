const crypto = require('crypto');
const redisClient = require('./redis');
const validator = require('./validator');
const { applyMergePatch } = require('./mergePatch');

const NS = {
  plan: 'plan',
  planservice: 'planservice',
  service: 'service',
  membercostshare: 'membercostshare',
};

// ---------- tiny namespaced store helpers ----------
const k = (ns, id) => `${ns}:${id}`;
const put = (ns, id, data) => redisClient.setData(k(ns, id), data);              // returns etag
const get = (ns, id) => redisClient.getData(k(ns, id));                          // { data, etag } | null
const exists = (ns, id) => redisClient.exists(k(ns, id));
const del = (ns, id) => redisClient.deleteData(k(ns, id));
const listKeys = (pattern) => redisClient.getKeys(pattern);

// ---------- ETag helpers ----------
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Composite ETag for a plan that includes children etags.
// We want plan ETag to change when any child changes.
function computeCompositePlanETag(planRefDoc, childEtags = []) {
  const base = JSON.stringify(planRefDoc) + '|' + childEtags.sort().join('|');
  return md5(base);
}

// ---------- Normalization (write children canonically) ----------
async function writeChildEntities(plan) {
  // Root planCostShares
  if (plan.planCostShares) {
    await put(NS.membercostshare, plan.planCostShares.objectId, plan.planCostShares);
  }

  // linkedPlanServices and their nested parts
  if (Array.isArray(plan.linkedPlanServices)) {
    for (const lps of plan.linkedPlanServices) {
      await put(NS.planservice, lps.objectId, lps);

      // nested: linkedService (service)
      if (lps.linkedService) {
        await put(NS.service, lps.linkedService.objectId, lps.linkedService);
      }

      // nested: planserviceCostShares (membercostshare)
      if (lps.planserviceCostShares) {
        await put(NS.membercostshare, lps.planserviceCostShares.objectId, lps.planserviceCostShares);
      }
    }
  }
}

// Produce a lean parent (stores references to children only)
function toPlanRefDoc(plan) {
  return {
    _org: plan._org,
    objectId: plan.objectId,
    objectType: plan.objectType,
    planType: plan.planType,
    creationDate: plan.creationDate,

    planCostSharesId: plan.planCostShares?.objectId ?? null,
    linkedPlanServiceIds: Array.isArray(plan.linkedPlanServices)
      ? plan.linkedPlanServices.map(s => s.objectId)
      : [],
  };
}

// Expand a plan ref into the full document + collect child ETags for composite etag
async function expandPlanWithEtags(refDoc) {
  const childEtags = [];

  // planCostShares
  let planCostShares = null;
  if (refDoc.planCostSharesId) {
    const pcs = await get(NS.membercostshare, refDoc.planCostSharesId);
    if (pcs) {
      planCostShares = pcs.data;
      childEtags.push(pcs.etag);
    }
  }

  // linkedPlanServices
  const linkedPlanServices = [];
  for (const id of refDoc.linkedPlanServiceIds || []) {
    const lps = await get(NS.planservice, id);
    if (!lps) continue;
    childEtags.push(lps.etag);

    // refresh nested canonical parts
    let linkedService = lps.data.linkedService;
    if (linkedService?.objectId) {
      const svc = await get(NS.service, linkedService.objectId);
      if (svc) {
        linkedService = svc.data;
        childEtags.push(svc.etag);
      }
    }

    let planserviceCostShares = lps.data.planserviceCostShares;
    if (planserviceCostShares?.objectId) {
      const mc = await get(NS.membercostshare, planserviceCostShares.objectId);
      if (mc) {
        planserviceCostShares = mc.data;
        childEtags.push(mc.etag);
      }
    }

    linkedPlanServices.push({
      ...lps.data,
      linkedService,
      planserviceCostShares,
    });
  }

  const materialized = {
    _org: refDoc._org,
    objectId: refDoc.objectId,
    objectType: refDoc.objectType,
    planType: refDoc.planType,
    creationDate: refDoc.creationDate,
    planCostShares,
    linkedPlanServices,
  };

  return { materialized, childEtags };
}

// ---------- Controller ----------
class PlanController {
  constructor() {}

  // enforce If-Match for write ops
  requireIfMatchOr412(req, res, expectedEtag) {
    const ifm = req.headers['if-match'];
    if (!ifm) {
      res.status(412).json({ error: 'If-Match required' });
      return false;
    }
    const want = ifm.replace(/"/g, '');
    if (want !== expectedEtag) {
      res.status(412).json({ error: 'Precondition Failed (stale ETag)' });
      return false;
    }
    return true;
  }

  // ---------- POST /v1/plan ----------
  async createPlan(req, res) {
    try {
      const planData = req.body;

      const validation = validator.completeValidation(planData);
      if (!validation.isValid) {
        return res.status(400).json({ error: 'Validation failed', details: validation.errors });
      }

      const planId = planData.objectId;
      if (await exists(NS.plan, planId)) {
        return res.status(409).json({ error: 'Conflict', message: `Plan with objectId ${planId} already exists` });
      }

      // write children canonically
      await writeChildEntities(planData);

      // write plan ref
      const refDoc = toPlanRefDoc(planData);
      const refEtag = await put(NS.plan, planId, refDoc);

      // composite ETag (parent-only for POST is also fine; we can compute full)
      const { childEtags } = await expandPlanWithEtags(refDoc);
      const composite = computeCompositePlanETag(refDoc, [refEtag, ...childEtags]);

      return res
        .status(201)
        .header('ETag', `"${composite}"`)
        .header('Cache-Control', 'no-cache')
        .header('Location', `/v1/plan/${planId}`)
        .json(planData);
    } catch (e) {
      console.error('Error creating plan:', e);
      res.status(500).json({ error: 'Internal server error', message: 'Failed to create plan' });
    }
  }

  // ---------- GET /v1/plan/:objectId ----------
  async getPlan(req, res) {
    try {
      const planId = req.params.objectId;
      const ref = await get(NS.plan, planId);
      if (!ref) {
        return res.status(404).json({ error: 'Not Found', message: `Plan with objectId ${planId} not found` });
      }

      const { materialized, childEtags } = await expandPlanWithEtags(ref.data);
      const composite = computeCompositePlanETag(ref.data, [ref.etag, ...childEtags]);

      const inm = req.headers['if-none-match'];
      if (inm && inm.replace(/"/g, '') === composite) {
        return res.status(304).header('ETag', `"${composite}"`).end();
      }

      return res
        .status(200)
        .header('ETag', `"${composite}"`)
        .header('Cache-Control', 'no-cache')
        .json(materialized);
    } catch (e) {
      console.error('Error retrieving plan:', e);
      res.status(500).json({ error: 'Internal server error', message: 'Failed to retrieve plan' });
    }
  }

  // ---------- PUT /v1/plan/:objectId (full replace) ----------
  async updatePlan(req, res) {
    try {
      const planId = req.params.objectId;

      // Ensure plan exists to compute composite ETag for If-Match
      const existingRef = await get(NS.plan, planId);
      if (!existingRef) {
        return res.status(404).json({ error: 'Not Found', message: `Plan with objectId ${planId} not found` });
      }

      const { childEtags: beforeChildEtags } = await expandPlanWithEtags(existingRef.data);
      const beforeComposite = computeCompositePlanETag(existingRef.data, [existingRef.etag, ...beforeChildEtags]);
      if (!this.requireIfMatchOr412(req, res, beforeComposite)) return;

      const planData = req.body;

      // optional: enforce path id = body id
      if (planData.objectId && planData.objectId !== planId) {
        return res.status(400).json({ error: 'Invalid objectId', message: 'Body objectId must match path parameter' });
      }

      const validation = validator.completeValidation(planData);
      if (!validation.isValid) {
        return res.status(400).json({ error: 'Validation failed', details: validation.errors });
      }

      // rewrite children + ref
      await writeChildEntities(planData);
      const refDoc = toPlanRefDoc(planData);
      const refEtag = await put(NS.plan, planId, refDoc);

      const { materialized, childEtags } = await expandPlanWithEtags(refDoc);
      const composite = computeCompositePlanETag(refDoc, [refEtag, ...childEtags]);

      return res
        .status(200)
        .header('ETag', `"${composite}"`)
        .header('Cache-Control', 'no-cache')
        .json(materialized);
    } catch (e) {
      console.error('Error updating plan:', e);
      res.status(500).json({ error: 'Internal server error', message: 'Failed to update plan' });
    }
  }

// ---------- PATCH /v1/plan/:objectId (append/upsert semantics for LPS) ----------
async patchPlan(req, res) {
  try {
    const planId = req.params.objectId;

    // Load current plan ref and expanded version to compute If-Match composite
    const ref = await get(NS.plan, planId);
    if (!ref) {
      return res.status(404).json({ error: 'Not Found', message: `Plan with objectId ${planId} not found` });
    }

    const beforeExp = await expandPlanWithEtags(ref.data);
    const beforeComposite = computeCompositePlanETag(ref.data, [ref.etag, ...beforeExp.childEtags]);
    if (!this.requireIfMatchOr412(req, res, beforeComposite)) return;

    const before = beforeExp.materialized;
    const patch = req.body || {};

    // --- 1) Merge plan-level scalars (non-array)
    const after = { ...before };
    const scalarFields = ["_org", "objectType", "planType", "creationDate"];
    for (const f of scalarFields) {
      if (Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== null) {
        after[f] = patch[f];
      }
    }

    // --- 2) planCostShares: upsert or move-to-new-id
    if (patch.planCostShares) {
      const pcsAfter = patch.planCostShares;
      if (!pcsAfter.objectId || typeof pcsAfter.objectId !== "string") {
        return res.status(400).json({ error: "Validation failed", details: [{ field: "planCostShares.objectId", message: "required string" }] });
      }

      const beforePcsId = before.planCostShares?.objectId || null;
      if (beforePcsId && pcsAfter.objectId !== beforePcsId) {
        // new child id → create new, keep old intact, update parent ref
        if (await exists(NS.membercostshare, pcsAfter.objectId)) {
          return res.status(409).json({ error: "Conflict", message: `membercostshare ${pcsAfter.objectId} already exists` });
        }
        await put(NS.membercostshare, pcsAfter.objectId, pcsAfter);
        ref.data.planCostSharesId = pcsAfter.objectId;
      } else {
        // same id or previously null → upsert
        await put(NS.membercostshare, pcsAfter.objectId, pcsAfter);
        ref.data.planCostSharesId = pcsAfter.objectId;
      }
      after.planCostShares = pcsAfter;
    }

    // --- 3) linkedPlanServices: APPEND / UPSERT semantics (not array replace)
    if (Array.isArray(patch.linkedPlanServices)) {
      // index existing ids => set for quick membership checks
      const existingIds = new Set(ref.data.linkedPlanServiceIds || []);
      const newIdsToAppend = [];

      for (const lpsPatch of patch.linkedPlanServices) {
        if (!lpsPatch || typeof lpsPatch !== "object") continue;
        const lpsId = lpsPatch.objectId;
        if (!lpsId || typeof lpsId !== "string") {
          return res.status(400).json({ error: "Validation failed", details: [{ field: "linkedPlanServices[].objectId", message: "required string" }] });
        }

        // Upsert nested children mentioned inside this planservice
        if (lpsPatch.linkedService?.objectId) {
          await put(NS.service, lpsPatch.linkedService.objectId, lpsPatch.linkedService);
        }
        if (lpsPatch.planserviceCostShares?.objectId) {
          await put(NS.membercostshare, lpsPatch.planserviceCostShares.objectId, lpsPatch.planserviceCostShares);
        }

        if (existingIds.has(lpsId)) {
          // Update in place
          await put(NS.planservice, lpsId, lpsPatch);
        } else {
          // New child → create & mark for append
          if (await exists(NS.planservice, lpsId)) {
            // If you prefer strictness, you can 409 here. We'll overwrite to simplify.
            // return res.status(409).json({ error: "Conflict", message: `planservice ${lpsId} already exists` });
          }
          await put(NS.planservice, lpsId, lpsPatch);
          newIdsToAppend.push(lpsId);
          existingIds.add(lpsId);
        }
      }

      // Append new ids (preserve existing order)
      if (newIdsToAppend.length) {
        ref.data.linkedPlanServiceIds = (ref.data.linkedPlanServiceIds || []).concat(newIdsToAppend);
      }

      // Rebuild `after.linkedPlanServices` = before + patched upserts (materialized)
      // Fetch all ids currently referenced after mutation
      const finalIds = ref.data.linkedPlanServiceIds || [];
      const rebuilt = [];
      for (const id of finalIds) {
        const lps = await get(NS.planservice, id);
        if (!lps) continue;

        // ensure nested are expanded from canonical store
        let linkedService = lps.data.linkedService;
        if (linkedService?.objectId) {
          const svc = await get(NS.service, linkedService.objectId);
          if (svc) linkedService = svc.data;
        }
        let planserviceCostShares = lps.data.planserviceCostShares;
        if (planserviceCostShares?.objectId) {
          const mc = await get(NS.membercostshare, planserviceCostShares.objectId);
          if (mc) planserviceCostShares = mc.data;
        }

        rebuilt.push({ ...lps.data, linkedService, planserviceCostShares });
      }
      after.linkedPlanServices = rebuilt;
    }

    // --- Validate final document shape
    const validation = validator.completeValidation(after);
    if (!validation.isValid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    // --- Update parent ref scalars
    ref.data._org = after._org;
    ref.data.objectType = after.objectType;
    ref.data.planType = after.planType;
    ref.data.creationDate = after.creationDate;

    // Persist parent and compute composite ETag for response
    const refEtag = await put(NS.plan, planId, ref.data);
    const { childEtags } = await expandPlanWithEtags(ref.data);
    const composite = computeCompositePlanETag(ref.data, [refEtag, ...childEtags]);

    return res
      .status(200)
      .header('ETag', `"${composite}"`)
      .header('Cache-Control', 'no-cache')
      .json(after);
  } catch (e) {
    console.error('Error patching plan (append/upsert LPS):', e);
    res.status(500).json({ error: 'Internal server error', message: 'Failed to patch plan' });
  }
}

  // ---------- DELETE /v1/plan/:objectId ----------
  async deletePlan(req, res) {
    try {
      const planId = req.params.objectId;

      // Existence
      const ref = await get(NS.plan, planId);
      if (!ref) {
        return res.status(404).json({ error: 'Not Found', message: `Plan with objectId ${planId} not found` });
      }

      // Composite etag for If-Match
      // const { childEtags } = await expandPlanWithEtags(ref.data);
      // const composite = computeCompositePlanETag(ref.data, [ref.etag, ...childEtags]);
      // if (!this.requireIfMatchOr412(req, res, composite)) return;

      // Delete ONLY the plan parent; keep children intact (safer)
      const ok = await del(NS.plan, planId);
      if (ok) return res.status(204).end();
      return res.status(500).json({ error: 'Internal server error', message: 'Failed to delete plan' });
    } catch (e) {
      console.error('Error deleting plan:', e);
      res.status(500).json({ error: 'Internal server error', message: 'Failed to delete plan' });
    }
  }

  // ---------- GET /v1/plans (summary) ----------
  async getAllPlans(req, res) {
    try {
      const keys = await listKeys(`${NS.plan}:*`);
      const out = [];
      for (const key of keys) {
        const id = key.substring(key.indexOf(':') + 1);
        const ref = await get(NS.plan, id);
        if (ref) {
          out.push({
            objectId: ref.data.objectId,
            planType: ref.data.planType,
            creationDate: ref.data.creationDate,
            etag: ref.etag,
          });
        }
      }
      res.status(200).json({ count: out.length, plans: out });
    } catch (e) {
      console.error('Error retrieving all plans:', e);
      res.status(500).json({ error: 'Internal server error', message: 'Failed to retrieve plans' });
    }
  }

  // ---------- Debug (unchanged shape) ----------
  async debugDatabase(req, res) {
    try {
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Forbidden', message: 'Debug endpoint not available in production' });
      }
      const keys = await listKeys('*');
      const allData = {};
      for (const key of keys) {
        const result = await redisClient.getData(key);
        if (result) {
          allData[key] = { data: result.data, etag: result.etag };
        }
      }
      res.status(200).json({ totalKeys: keys.length, keys, data: allData });
    } catch (e) {
      console.error('Error getting debug data:', e);
      res.status(500).json({ error: 'Internal server error', message: 'Failed to retrieve debug data' });
    }
  }

  // ---------- Health ----------
  async healthCheck(req, res) {
    try {
      const testKey = 'health:test';
      await redisClient.setData(testKey, { timestamp: new Date().toISOString() });
      await redisClient.getData(testKey);
      await redisClient.deleteData(testKey);
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: { redis: 'connected', api: 'running' }
      });
    } catch (e) {
      console.error('Health check failed:', e);
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString(), error: e.message });
    }
  }
}

module.exports = new PlanController();