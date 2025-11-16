// queue.js
const amqp = require('amqplib');

let connection = null;
let channel = null;
const QUEUE = 'indexJobs';

async function connectQueue() {
    const url = process.env.RABBITMQ_URL || 'amqp://localhost';
    console.log('Connecting to RabbitMQ at', url);
    connection = await amqp.connect(url);
    channel = await connection.createChannel();
    await channel.assertQueue(QUEUE, { durable: true });
    console.log('RabbitMQ connected, queue asserted:', QUEUE);

    connection.on('error', (err) => console.error('RabbitMQ connection error:', err));
    connection.on('close', () => console.warn('RabbitMQ connection closed'));
}

async function enqueueIndexJob(job) {
    if (!channel) {
        throw new Error('RabbitMQ channel not initialized. Did you call connectQueue()?');
    }
    const payload = Buffer.from(JSON.stringify(job));
    channel.sendToQueue(QUEUE, payload, { persistent: true });
    console.log('Enqueued index job:', job);
}

// new: close function for graceful shutdown
async function closeQueue() {
    try {
        if (channel) {
            await channel.close();
            console.log('RabbitMQ channel closed');
        }
        if (connection) {
            await connection.close();
            console.log('RabbitMQ connection closed');
        }
    } catch (err) {
        console.error('Error closing RabbitMQ:', err);
    }
}

module.exports = {
    connectQueue,
    enqueueIndexJob,
    closeQueue,
    QUEUE,
};