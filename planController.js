const redisClient = require('./redis');
const validator = require('./validator');
const { applyMergePatch } = require('./mergePatch');

class PlanController {
  constructor() {}

  // Generate Redis key (just the objectId you already use)
  generateKey(objectId) {
    return objectId;
  }

  // Helper: enforce If-Match on write operations
  requireIfMatchOr412 = (req, res, currentEtag) => {
    const ifm = req.headers['if-match'];
    if (!ifm) {
      res.status(412).json({ error: 'If-Match required' });
      return false;
    }
    const want = ifm.replace(/"/g, '');
    if (want !== currentEtag) {
      res.status(412).json({ error: 'Precondition Failed (stale ETag)' });
      return false;
    }
    return true;
  };

  // POST /v1/plan - Create new plan (supports create-only with If-None-Match: *)
  async createPlan(req, res) {
    try {
      const planData = req.body;

      // Validate payload
      const validation = validator.completeValidation(planData);
      if (!validation.isValid) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const objectId = planData.objectId;
      const key = this.generateKey(objectId);

      // Optional create-only precondition
      const inm = req.headers['if-none-match'];
      const exists = await redisClient.exists(key);
      if (inm === '*') {
        if (exists) {
          return res.status(412).json({
            error: 'Precondition Failed',
            message: `Plan with objectId ${objectId} already exists`
          });
        }
      } else if (exists) {
        return res.status(409).json({
          error: 'Conflict',
          message: `Plan with objectId ${objectId} already exists`
        });
      }

      // Store
      const etag = await redisClient.setData(key, planData);

      // Response
      res
        .status(201)
        .header('ETag', `"${etag}"`)
        .header('Cache-Control', 'no-cache')
        .header('Location', `/v1/plan/${objectId}`)
        .json({
          message: 'Plan created successfully',
          objectId,
          etag
        });
    } catch (error) {
      console.error('Error creating plan:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create plan'
      });
    }
  }

  // GET /v1/plan/:objectId - Conditional read with If-None-Match
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

      // Fetch
      const result = await redisClient.getData(key);
      if (!result) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Plan with objectId ${objectId} not found`
        });
      }

      // Conditional GET
      const clientETag = req.headers['if-none-match'];
      const currentETagQuoted = `"${result.etag}"`;
      if (clientETag && clientETag.replace(/"/g, '') === result.etag) {
        return res.status(304).header('ETag', currentETagQuoted).end();
      }

      // Return
      res
        .status(200)
        .header('ETag', currentETagQuoted)
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

  // PUT /v1/plan/:objectId - Full replace (requires If-Match)
  async updatePlan(req, res) {
    try {
      const objectId = req.params.objectId;
      const key = this.generateKey(objectId);

      // Ensure resource exists
      const existing = await redisClient.getData(key);
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Plan with objectId ${objectId} not found`
        });
      }

      // Precondition
      if (!this.requireIfMatchOr412(req, res, existing.etag)) return;

      // Validate full body
      const planData = req.body;

      // (Optional) enforce body.objectId matches path param to avoid accidental ID change
      if (planData.objectId && planData.objectId !== objectId) {
        return res.status(400).json({
          error: 'Invalid objectId',
          message: 'Body objectId must match path parameter'
        });
      }

      const validation = validator.completeValidation(planData);
      if (!validation.isValid) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const etag = await redisClient.setData(key, planData);

      return res
      .status(200)
      .header('ETag', `"${etag}"`)
      .header('Cache-Control', 'no-cache')
      .json(planData);  
    } catch (error) {
      console.error('Error updating plan:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to update plan'
      });
    }
  }

  // PATCH /v1/plan/:objectId - JSON Merge Patch (requires If-Match)
  async patchPlan(req, res) {
    try {
      const objectId = req.params.objectId;
      const key = this.generateKey(objectId);

      // Ensure resource exists
      const existing = await redisClient.getData(key);
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Plan with objectId ${objectId} not found`
        });
      }

      // Precondition
      if (!this.requireIfMatchOr412(req, res, existing.etag)) return;

      // Apply JSON Merge Patch (RFC 7396)
      const merged = applyMergePatch(existing.data, req.body);

      // 🔎 TEMP LOGS — add these for debugging
console.log('PATCH If-Match header:', req.headers['if-match']);
console.log('PATCH current ETag:', existing.etag);
console.log('PATCH merged doc:', JSON.stringify(merged, null, 2));

      // Prevent accidental ID change
      if (merged.objectId && merged.objectId !== objectId) {
        return res.status(400).json({
          error: 'Invalid objectId',
          message: 'Patched objectId must not differ from path parameter'
        });
      }

      // Validate final document
      const validation = validator.completeValidation(merged);
      if (!validation.isValid) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validation.errors
        });
      }

      const etag = await redisClient.setData(key, merged);
      console.log('PATCH new ETag:', etag);

      return res
      .status(200)
      .header('ETag', `"${etag}"`)
      .header('Cache-Control', 'no-cache')
      .json(merged);      
    } catch (error) {
      console.error('Error patching plan:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to patch plan'
      });
    }
  }

  // DELETE /v1/plan/:objectId - Requires If-Match, returns 204 (no body)
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

      // Ensure exists
      const existing = await redisClient.getData(key);
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Plan with objectId ${objectId} not found`
        });
      }

      // Precondition
      if (!this.requireIfMatchOr412(req, res, existing.etag)) return;

      // Delete
      const deleted = await redisClient.deleteData(key);
      if (deleted) {
        return res.status(204).end(); // no body for 204
      } else {
        return res.status(500).json({
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

  // (Optional) GET /v1/plans - summary listing
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

      res.status(200).json({ count: plans.length, plans });
    } catch (error) {
      console.error('Error retrieving all plans:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to retrieve plans'
      });
    }
  }

  // (Optional) Debug endpoint
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
        keys,
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

  // Health check (unchanged)
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