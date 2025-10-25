const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const redisClient = require('./redis');
const planController = require('./planController');
const verifyGoogleToken = require('./authMiddleware');
const { applyMergePatch } = require('./mergePatch');

class Server {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Security middleware
    this.app.use(helmet());
    
    // CORS middleware
    this.app.use(cors({
      origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
      credentials: true,
      methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
      allowedHeaders: ['Content-Type','Authorization','If-None-Match','If-Match','Cache-Control']
    }));

    // Body parsing middleware
    this.app.use(express.json({
      limit: '10mb',
      strict: true,
      // parse merge-patch bodies too
      type: ['application/json', 'application/merge-patch+json']
      }));
    this.app.use(express.urlencoded({ 
      extended: true,
      limit: '10mb' 
    }));

    // Request logging middleware
    this.app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
      
      // Log request body for POST requests (excluding sensitive data)
      if (req.method === 'POST' && req.body) {
        console.log(`[${timestamp}] Request Body Keys: ${Object.keys(req.body).join(', ')}`);
      }
      
      // Add request timestamp
      req.timestamp = timestamp;
      next();
    });

    // Content-Type validation for JSON & Merge Patch on v1/plan
    this.app.use('/v1/plan', (req, res, next) => {
    if (['POST','PUT','PATCH'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (req.method === 'PATCH') {
        if (!ct.includes('application/merge-patch+json')) {
          return res.status(415).json({ error: 'Content-Type must be application/merge-patch+json' });
        }
      } else {
        if (!ct.includes('application/json')) {
          return res.status(415).json({ error: 'Content-Type must be application/json' });
        }
      }
    }
    next();
    });
  }

  setupRoutes() {
    // API Version 1 Routes
    const v1Router = express.Router();

    // Plan routes
    v1Router.post('/plan', planController.createPlan.bind(planController));
    v1Router.get('/plan/:objectId', planController.getPlan.bind(planController));
    v1Router.delete('/plan/:objectId', planController.deletePlan.bind(planController));
    v1Router.get('/plans', planController.getAllPlans.bind(planController));
    v1Router.put('/plan/:objectId', planController.updatePlan.bind(planController));
    v1Router.patch('/plan/:objectId', planController.patchPlan.bind(planController));

    // Health check route
    v1Router.get('/health', planController.healthCheck.bind(planController));

    // Mount v1 router
    this.app.use('/v1', verifyGoogleToken, v1Router);

    // Root route
    this.app.get('/', (req, res) => {
      res.json({
        message: 'Plan Management REST API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: {
          'POST /v1/plan': 'Create a new plan',
          'GET /v1/plan/:objectId': 'Get a plan by objectId (supports conditional reads)',
          'DELETE /v1/plan/:objectId': 'Delete a plan by objectId',
          'GET /v1/plans': 'Get all plans (summary)',
          'GET /v1/health': 'Health check'
        },
        features: [
          'JSON Schema Validation',
          'Redis Key-Value Storage', 
          'ETag Support for Caching',
          'Conditional Reads (If-None-Match)',
          'RESTful API Design',
          'Comprehensive Error Handling'
        ]
      });
    });

    // 404 handler for unmatched routes
    this.app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Not Found',
        message: `The requested endpoint ${req.method} ${req.originalUrl} was not found`,
        availableEndpoints: {
          'POST /v1/plan': 'Create a new plan',
          'GET /v1/plan/:objectId': 'Get a plan by objectId',
          'DELETE /v1/plan/:objectId': 'Delete a plan by objectId',
          'GET /v1/plans': 'Get all plans',
          'GET /v1/health': 'Health check'
        }
      });
    });
  }

  setupErrorHandling() {
    // JSON parsing error handler
    this.app.use((error, req, res, next) => {
      if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid JSON syntax in request body',
          details: error.message
        });
      }
      next(error);
    });

    // General error handler
    this.app.use((error, req, res, next) => {
      console.error(`[${new Date().toISOString()}] Error:`, error);
      
      // Don't send error details in production
      const isDevelopment = process.env.NODE_ENV === 'development';
      
      res.status(error.status || 500).json({
        error: 'Internal Server Error',
        message: isDevelopment ? error.message : 'Something went wrong',
        ...(isDevelopment && { stack: error.stack }),
        timestamp: new Date().toISOString()
      });
    });
  }

  async start() {
    try {
      // Connect to Redis
      console.log('Connecting to Redis...');
      await redisClient.connect();

      // Start Express server
      this.app.listen(this.port, () => {
        console.log(`Server is running on port ${this.port}`);
        console.log(`API Documentation available at http://localhost:${this.port}/`);
        console.log(`Health check available at http://localhost:${this.port}/v1/health`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      });

      // Graceful shutdown handlers
      process.on('SIGTERM', this.gracefulShutdown.bind(this));
      process.on('SIGINT', this.gracefulShutdown.bind(this));

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  async gracefulShutdown() {
    console.log('\n🔄 Graceful shutdown initiated...');
    
    try {
      await redisClient.disconnect();
      console.log('Redis connection closed');
    } catch (error) {
      console.error('Error closing Redis connection:', error);
    }
    
    console.log('Server shutdown complete');
    process.exit(0);
  }
}

// Start the server if this file is run directly
if (require.main === module) {
  const server = new Server();
  server.start();
}

module.exports = Server;