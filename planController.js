const redisClient = require('./redis');
const validator = require('./validator');

class PlanController {
  constructor() {
  }

  // Generate Redis key (just the objectId)
  generateKey(objectId) {
    return objectId;
  }

  // POST /v1/plan - Create new plan
  async createPlan(req, res) {
    try {
      const planData = req.body;

      // Validate the incoming data
      const validation = validator.completeValidation(planData);
      if (!validation.isValid) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const objectId = planData.objectId;
      const key = this.generateKey(objectId);

      // Check if plan already exists
      const exists = await redisClient.exists(key);
      if (exists) {
        return res.status(409).json({
          error: 'Conflict',
          message: `Plan with objectId ${objectId} already exists`
        });
      }

      // Store the plan data
      const etag = await redisClient.setData(key, planData);

      // Return success response with ETag
      res.status(201)
         .header('ETag', `"${etag}"`)
         .header('Location', `/v1/plan/${objectId}`)
         .json({
           message: 'Plan created successfully',
           objectId: objectId,
           etag: etag
         });

    } catch (error) {
      console.error('Error creating plan:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create plan'
      });
    }
  }

  // GET /v1/plan/:objectId - Get plan by ID with conditional read
  async getPlan(req, res) {
    try {
      const objectId = req.params.objectId;
      const key = this.generateKey(objectId);

      // Validate objectId
      const objectIdValidation = validator.validateObjectId(objectId);
      if (!objectIdValidation.isValid) {
        return res.status(400).json({
          error: 'Invalid objectId',
          details: objectIdValidation.errors
        });
      }

      // Get data from Redis
      const result = await redisClient.getData(key);
      if (!result) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Plan with objectId ${objectId} not found`
        });
      }

      // Handle conditional reads (If-None-Match header)
      const clientETag = req.headers['if-none-match'];
      if (clientETag && clientETag.replace(/"/g, '') === result.etag) {
        return res.status(304)
                 .header('ETag', `"${result.etag}"`)
                 .send();
      }

      // Return the plan data
      res.status(200)
         .header('ETag', `"${result.etag}"`)
         .header('Cache-Control', 'no-cache')
         .json(result.data);

    } catch (error) {
      console.error('Error retrieving plan:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve plan'
      });
    }
  }

  // DELETE /v1/plan/:objectId - Delete plan
  async deletePlan(req, res) {
    try {
      const objectId = req.params.objectId;
      const key = this.generateKey(objectId);

      // Validate objectId
      const objectIdValidation = validator.validateObjectId(objectId);
      if (!objectIdValidation.isValid) {
        return res.status(400).json({
          error: 'Invalid objectId',
          details: objectIdValidation.errors
        });
      }

      // Check if plan exists
      const exists = await redisClient.exists(key);
      if (!exists) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Plan with objectId ${objectId} not found`
        });
      }

      // Delete the plan
      const deleted = await redisClient.deleteData(key);
      if (deleted) {
        res.status(204).json({
        //   message: `Plan with objectId ${objectId} deleted successfully`
        });
      } else {
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to delete plan'
        });
      }

    } catch (error) {
      console.error('Error deleting plan:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to delete plan'
      });
    }
  }

  // GET /v1/plans - Get all plans (optional endpoint)
  async getAllPlans(req, res) {
    try {
      const keys = await redisClient.getKeys('*');
      const plans = [];

      for (const key of keys) {
        const result = await redisClient.getData(key);
        if (result) {
          plans.push({
            objectId: result.data.objectId,
            planType: result.data.planType,
            creationDate: result.data.creationDate,
            etag: result.etag
          });
        }
      }

      res.status(200).json({
        count: plans.length,
        plans: plans
      });

    } catch (error) {
      console.error('Error retrieving all plans:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve plans'
      });
    }
  }

  // Debug endpoint to view all data in Redis (development only)
  async debugDatabase(req, res) {
    try {
      if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Debug endpoint not available in production'
        });
      }

      const keys = await redisClient.getKeys('*');
      const allData = {};

      for (const key of keys) {
        const result = await redisClient.getData(key);
        if (result) {
          allData[key] = {
            data: result.data,
            etag: result.etag
          };
        }
      }

      res.status(200).json({
        totalKeys: keys.length,
        keys: keys,
        data: allData
      });

    } catch (error) {
      console.error('Error getting debug data:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve debug data'
      });
    }
  }

  // Health check endpoint
  async healthCheck(req, res) {
    try {
      // Test Redis connection
      const testKey = 'health:test';
      await redisClient.setData(testKey, { timestamp: new Date().toISOString() });
      await redisClient.getData(testKey);
      await redisClient.deleteData(testKey);

      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
          redis: 'connected',
          api: 'running'
        }
      });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  }
}

module.exports = new PlanController();