const { Queue, Worker, QueueEvents } = require('bullmq');

const QUEUE_NAME = 'message-delivery';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function buildConnectionOptions(redisUrl = REDIS_URL) {
    const url = new URL(redisUrl);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
        throw new Error('Redis URL must use redis:// or rediss://');
    }

    const options = {
        host: url.hostname,
        port: Number(url.port || 6379)
    };
    if (url.username) options.username = decodeURIComponent(url.username);
    if (url.password) options.password = decodeURIComponent(url.password);

    const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : undefined;
    if (Number.isInteger(db) && db >= 0) options.db = db;
    if (url.protocol === 'rediss:') options.tls = {};

    return options;
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
