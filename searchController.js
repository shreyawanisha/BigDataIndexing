// searchController.js
const es = require('./esClient');
const redisClient = require('./redis');

const NS = {
    plan: 'plan',
    planservice: 'planservice',
    service: 'service',
    membercostshare: 'membercostshare',
};

const k = (ns, id) => `${ns}:${id}`;

// Reuse same style as in planController/indexWorker
async function get(ns, id) {
    return redisClient.getData(k(ns, id)); // { data, etag } | null
}

// Expand a plan ref into full plan using Redis (same idea as in planController)
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

class SearchController {
    // GET /v1/plan/search
    // Supported query params:
    //   q              - fuzzy text search on planType/_org/service name
    //   planType       - filter parent (inNetwork/outOfNetwork)
    //   minCopay
    //   maxCopay
    //   minDeductible
    //   maxDeductible
    //   page           - 1-based page index (default 1)
    //   pageSize       - page size (default 10)
    //   sort           - "creationDate", "-creationDate", "planType"
    async searchPlans(req, res) {
        try {
            const {
                q,
                planType,
                minCopay,
                maxCopay,
                minDeductible,
                maxDeductible,
                page = '1',
                pageSize = '10',
                sort,
            } = req.query;

            const pageNum = Math.max(parseInt(page, 10) || 1, 1);
            const size = Math.min(Math.max(parseInt(pageSize, 10) || 10, 1), 100);
            const from = (pageNum - 1) * size;

            const must = [];
            const filter = [];
            const should = [];

            // Only return parent docs (plan)
            filter.push({ term: { 'join_field': 'plan' } });

            // Parent-level filters
            if (planType) {
                filter.push({ term: { planType } });
            }

            // Child-level constraints
            const childMust = [];

            // Text search:
            // - parent: planType/_org (multi_match)
            // - child: linkedService.name (fuzzy match)
            if (q && q.trim()) {
                const term = q.trim();

                // Parent fuzzy-ish search
                should.push({
                    multi_match: {
                        query: term,
                        fields: ['planType', '_org'],
                        fuzziness: 'AUTO',
                    },
                });

                // Child fuzzy search on service name
                childMust.push({
                    match: {
                        name: {
                            query: term,
                            fuzziness: 'AUTO',
                        },
                    },
                });
            }

            // Numeric filters on child cost shares
            const minCop = minCopay != null ? parseFloat(minCopay) : null;
            const maxCop = maxCopay != null ? parseFloat(maxCopay) : null;
            const minDed = minDeductible != null ? parseFloat(minDeductible) : null;
            const maxDed = maxDeductible != null ? parseFloat(maxDeductible) : null;

            if (Number.isFinite(minCop) || Number.isFinite(maxCop)) {
                const range = {};
                if (Number.isFinite(minCop)) range.gte = minCop;
                if (Number.isFinite(maxCop)) range.lte = maxCop;
                childMust.push({ range: { copay: range } });
            }

            if (Number.isFinite(minDed) || Number.isFinite(maxDed)) {
                const range = {};
                if (Number.isFinite(minDed)) range.gte = minDed;
                if (Number.isFinite(maxDed)) range.lte = maxDed;
                childMust.push({ range: { deductible: range } });
            }

            // If we have any child constraints (text or numeric), wrap in has_child
            if (childMust.length) {
                must.push({
                    has_child: {
                        type: 'planservice',
                        query: { bool: { must: childMust } },
                        score_mode: 'max',
                    },
                });
            }

            const query = { bool: {} };
            if (must.length) query.bool.must = must;
            if (filter.length) query.bool.filter = filter;
            if (should.length) {
                query.bool.should = should;
                query.bool.minimum_should_match = 1;
            }

            // Sorting
            const sortSpec = [];
            if (sort) {
                if (sort === 'creationDate') {
                    sortSpec.push({ creationDate: { order: 'asc' } });
                } else if (sort === '-creationDate') {
                    sortSpec.push({ creationDate: { order: 'desc' } });
                } else if (sort === 'planType') {
                    sortSpec.push({ planType: { order: 'asc' } });
                }
            }

            const esRequest = {
                index: 'plans',
                from,
                size,
                query,
            };
            if (sortSpec.length) {
                esRequest.sort = sortSpec;
            }

            const esResp = await es.search(esRequest);

            const hits = esResp.hits?.hits || [];
            const total = (esResp.hits?.total && esResp.hits.total.value) || 0;

            // For each hit, fetch full plan from Redis and expand children
            const results = [];
            for (const hit of hits) {
                const source = hit._source || {};
                const planId = source.objectId;
                if (!planId) continue;

                const ref = await get(NS.plan, planId);
                if (!ref) continue;

                const { materialized } = await expandPlanWithEtags(ref.data);
                results.push(materialized);
            }

            return res.status(200).json({
                total,
                page: pageNum,
                pageSize: size,
                returned: results.length,
                results,
            });
        } catch (err) {
            console.error('Error in searchPlans:', err);
            return res.status(500).json({
                error: 'Internal server error',
                message: 'Failed to search plans',
            });
        }
    }
}

module.exports = new SearchController();