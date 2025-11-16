# Plan Management REST API

A REST API built with **Node.js**, **Express**, **Redis**, **RabbitMQ**, and **Elasticsearch** implementing:

- CRUD operations  
- PATCH with merge & append semantics  
- JSON Schema validation  
- ETag-based conditional GET + conditional update  
- Redis key/value storage  
- Queue-based asynchronous indexing  
- Elasticsearch **Parent–Child** indexing for search  
- Google ID Token (RS256) security  

---

## 1. Project Setup

### Install dependencies

```bash
npm install 
```

## 2. Environment Variables

```bash
PORT=3000
NODE_ENV=development

REDIS_HOST=localhost
REDIS_PORT=6379

RABBITMQ_URL=amqp://localhost
ES_NODE=http://localhost:9200

ALLOWED_ORIGINS=http://localhost:3000
GOOGLE_CLIENT_ID=<your-google-client-id>
```

## 3. Start Required Services (Docker)

   Start Redis, RabbitMQ, and Elasticsearch:

   ```bash
   docker compose up -d
   docker ps -a
   ```

   Open RabbitMq in localHost

```url
   http://localhost:15672/#/
```

1. Start API Server

```bash
npm start
```

## 4. Start Index Worker (Elastic Indexer)

   Run in a second terminal:

   ``` bash
   node indexWorker.js 
   ```

## 5. Data Model Summary

   A Plan document contains:
 • planCostShares
 • linkedPlanServices[] (each with service + cost share)
 • plan metadata (_org, planType, creationDate, etc.)

All entries stored in Redis as:

`plan:<id>`
`planservice:<id>`
`service:<id>`
`membercostshare:<id>`
Each stored with { data, etag }.

## 6. API Endpoints

All require Authorization: Bearer `<Google-ID-Token>`
(RS256 verified via Google)

➤ POST /v1/plan

Create a new plan
 • Validates JSON Schema
 • Writes parent + children to Redis
 • Enqueues { op: "upsert", planId } for indexing

Returns:
201 Created + ETag header + Location

⸻

➤ GET /v1/plan/:id

Fetch a plan (expanded with children)
Supports:
```If-None-Match: "<etag>"```
 • Returns 304 Not Modified if ETag matches
 • Else returns plan + new ETag

➤ PATCH /v1/plan/:id

Partial update
 • Requires:
If-Match: `"<etag>"`
 • Merge + append logic for linkedPlanServices
 • Revalidated with JSON Schema
 • Writes to Redis
 • Enqueues { op: "upsert", planId }

⸻

➤ DELETE /v1/plan/:id

Deletes plan
 • Removes parent from Redis
 • Enqueues { op: "delete", planId }
 • Worker removes parent + children from Elasticsearch

Returns 204 No Content

## 7. Search API (Parent–Child on Elasticsearch)

```GET /v1/plan/search```
Supports filters:
q=  (fuzzy search)
planType=
minCopay=
maxCopay=
minDeductible=
maxDeductible=

page=1
pageSize=10
sort=creationDate | -creationDate

Under the hood:
 • Parent filters (plan)
 • has_child queries (planservice)
 • Fuzzy text matching
 • Pagination + sorting
 • Full plans reconstructed from Redis

## 8. Flow

1. Start API + Worker + Docker
2. POST sample plan
3. Show Redis keys
4. Worker logs index job
5. Search: /v1/plan/search?q=baby
6. PATCH plan (append new service)
7. Worker reindexes
8. Search again (new service visible)
9. DELETE plan
10. Search index → no results

## 9. Helpful Commands

Inspect Elasticsearch
```bash curl "http://localhost:9200/plans/_search?pretty"```
a. See list of indices

```bash
http://localhost:9200/_cat/indices?v
```

b. See index settings + mappings

```bash 
http://localhost:9200/plans
```

c. Check how many docs are in the index

```url
http://localhost:9200/plans/_count
```

- Redis CLI via Docker:

```bash
   docker exec -it redis redis-cli
   KEYS *
   # To see values of keys
   HGETALL plan:<ObjectId>
   exit
```

```bash
    docker stop redis-server && docker rm redis-server
    docker run -d -p 6379:6379 --name redis-server redis:alpine
    npm start
```
