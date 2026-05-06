const { Queue, Worker, QueueEvents } = require('bullmq');

const QUEUE_NAME = 'message-delivery';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function buildConnectionOptions(redisUrl = REDIS_URL) {
    const url = new URL(redisUrl);
    return {
        host: url.hostname,
        port: Number(url.port || 6379),
        password: url.password || undefined
    };
}

function createDeliveryQueue(options = {}) {
    return new Queue(options.queueName || QUEUE_NAME, {
        connection: options.connection || buildConnectionOptions(options.redisUrl)
    });
}

function createDeliveryWorker(processor, options = {}) {
    return new Worker(options.queueName || QUEUE_NAME, processor, {
        connection: options.connection || buildConnectionOptions(options.redisUrl),
        concurrency: options.concurrency || 1
    });
}

function createDeliveryQueueEvents(options = {}) {
    return new QueueEvents(options.queueName || QUEUE_NAME, {
        connection: options.connection || buildConnectionOptions(options.redisUrl)
    });
}

module.exports = {
    QUEUE_NAME,
    buildConnectionOptions,
    createDeliveryQueue,
    createDeliveryWorker,
    createDeliveryQueueEvents
};
