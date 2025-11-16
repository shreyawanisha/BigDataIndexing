// indexWorker.js
const amqp = require('amqplib');
const es = require('./esClient');
const redisClient = require('./redis');

const QUEUE = 'indexJobs';

async function ensurePlansIndex() {
    try {
        await es.indices.create({
            index: 'plans',
            mappings: {
                properties: {
                    join_field: {
                        type: 'join',
                        relations: {
                            plan: 'planservice'
                        }
                    },
                    objectId: { type: 'keyword' },
                    _org: { type: 'keyword' },
                    planType: { type: 'keyword' },
                    creationDate: { type: 'date', format: 'MM-dd-yyyy' },
                    name: { type: 'text' },
                    copay: { type: 'double' },
                    deductible: { type: 'double' }
                }
            }
        });
        console.log('Created Elasticsearch index: plans');
    } catch (err) {
        const type = err?.meta?.body?.error?.type;
        if (type === 'resource_already_exists_exception') {
            console.log('Elasticsearch index "plans" already exists, skipping create');
        } else {
            console.error('Failed to ensure plans index:', err.meta?.body || err);
            throw err;
        }
    }
}

// Namespaces – same as PlanController
const NS = {
    plan: 'plan',
    planservice: 'planservice',
    service: 'service',
    membercostshare: 'membercostshare',
};

const k = (ns, id) => `${ns}:${id}`;
const get = (ns, id) => redisClient.getData(k(ns, id)); // { data, etag } | null

// Copy of expandPlanWithEtags logic (worker-side)
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

// --------- Indexing helpers ---------

async function indexPlan(planId) {
    const ref = await get(NS.plan, planId);
    if (!ref) {
        console.log(`⚠️ indexPlan: plan ${planId} not found in Redis, skipping`);
        return;
    }

    const { materialized } = await expandPlanWithEtags(ref.data);
    const plan = materialized;

    console.log(`📦 Indexing plan ${plan.objectId} into Elasticsearch`);

    // parent
    await es.index({
        index: 'plans',
        id: plan.objectId,
        routing: plan.objectId,   // 🔹 add this
        document: {
            join_field: 'plan',
            objectId: plan.objectId,
            _org: plan._org,
            planType: plan.planType,
            creationDate: plan.creationDate
        }
    });

    // children
    if (Array.isArray(plan.linkedPlanServices)) {
        for (const lps of plan.linkedPlanServices) {
            await es.index({
                index: 'plans',
                id: lps.objectId,
                routing: plan.objectId,
                document: {
                    join_field: {
                        name: 'planservice',
                        parent: plan.objectId,
                    },
                    objectId: lps.objectId,
                    _org: lps._org,
                    name: lps.linkedService?.name,
                    copay: lps.planserviceCostShares?.copay,
                    deductible: lps.planserviceCostShares?.deductible,
                },
            });
        }
    }

    await es.indices.refresh({ index: 'plans' }).catch(() => { });
    console.log(`Indexed plan ${plan.objectId} and its linkedPlanServices`);
}

async function deletePlanFromIndex(planId) {
    try {
        const resp = await es.deleteByQuery({
            index: 'plans',
            refresh: true,          // make deletions immediately visible to searches
            body: {
                query: {
                    term: {
                        _routing: planId  // delete parent + all children with this routing key
                    }
                }
            }
        });

        console.log(
            `🧹 Deleted plan ${planId} and its children from index`,
            resp.deleted ?? ''
        );
    } catch (err) {
        console.error(
            `❌ Failed to delete plan ${planId} from index:`,
            err.meta?.body || err
        );
    }
}

// --------- Worker main loop ---------

async function startWorker() {
    console.log('Index worker connecting to Redis...');
    await redisClient.connect();
    console.log('Index worker connected to Redis');

    await ensurePlansIndex();

    const url = process.env.RABBITMQ_URL || 'amqp://localhost';
    console.log('Index worker connecting to RabbitMQ at', url);
    const conn = await amqp.connect(url);
    const channel = await conn.createChannel();

    await channel.assertQueue(QUEUE, { durable: true });
    console.log('Index worker listening on queue:', QUEUE);

    channel.consume(QUEUE, async (msg) => {
        if (!msg) return;
        const job = JSON.parse(msg.content.toString());
        console.log('➡️ Received job:', job);

        try {
            if (job.op === 'upsert') {
                await indexPlan(job.planId);
            } else if (job.op === 'delete') {
                await deletePlanFromIndex(job.planId);
            } else {
                console.log('⚠️ Unknown job op, ignoring:', job.op);
            }
            channel.ack(msg);
        } catch (err) {
            console.error('Error processing job', job, err);
            channel.ack(msg);
        }
    });
}

startWorker().catch((err) => {
    console.error('Index worker failed to start:', err);
    process.exit(1);
});