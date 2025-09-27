const { createClient } = require('redis');
const crypto = require('crypto');

class RedisClient {
  constructor() {
    this.client = createClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      maxRetriesPerRequest: null
    });

    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    this.client.on('connect', () => {
      console.log('Connected to Redis server');
    });
  }

  async connect() {
    try {
      await this.client.connect();
      console.log('Redis client connected successfully');
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      await this.client.disconnect();
      console.log('Redis client disconnected');
    } catch (error) {
      console.error('Error disconnecting from Redis:', error);
    }
  }

  // Generate ETag for data integrity
  generateETag(data) {
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  }

  // Store data with ETag
  async setData(key, data) {
    try {
      const jsonData = JSON.stringify(data);
      const etag = this.generateETag(data);
      
      // Store both data and etag
      await this.client.hSet(key, {
        'data': jsonData,
        'etag': etag
      });
      
      return etag;
    } catch (error) {
      console.error('Error setting data in Redis:', error);
      throw error;
    }
  }

  // Get data with ETag
  async getData(key) {
    try {
      const result = await this.client.hGetAll(key);
      
      if (!result.data) {
        return null;
      }
      
      return {
        data: JSON.parse(result.data),
        etag: result.etag
      };
    } catch (error) {
      console.error('Error getting data from Redis:', error);
      throw error;
    }
  }

  // Delete data
  async deleteData(key) {
    try {
      const result = await this.client.del(key);
      return result > 0;
    } catch (error) {
      console.error('Error deleting data from Redis:', error);
      throw error;
    }
  }

  // Check if key exists
  async exists(key) {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      console.error('Error checking key existence:', error);
      throw error;
    }
  }

  // Get all keys matching pattern
  async getKeys(pattern = '*') {
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      console.error('Error getting keys:', error);
      throw error;
    }
  }
}

module.exports = new RedisClient();