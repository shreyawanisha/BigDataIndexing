// esClient.js
const { Client } = require('@elastic/elasticsearch');

const es = new Client({
    node: process.env.ES_NODE || 'http://localhost:9200',
});

async function ping() {
    try {
        await es.info();
        console.log('Connected to Elasticsearch');
    } catch (err) {
        console.error('Elasticsearch connection failed:', err.message);
    }
}

ping().catch(() => { });

module.exports = es;