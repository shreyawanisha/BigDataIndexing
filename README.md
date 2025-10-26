# Plan Management REST API

- A robust REST API built with Node.js, Express, and Redis for managing healthcare plan data with comprehensive JSON schema - validation and caching support.

1. Setup Project

   ```bash
   npm install
   ```

2. Start Redis Database

   ```bash
    # Start Redis using Docker
    docker run -d -p 6379:6379 --name redis-server redis:alpine

    # Verify Redis is running
    docker ps
    ```

3. Start the API Server

   ```bash
    # Start the Node.js server
    npm start

    # You should see:
    # Server is running on port 3000
    # API Documentation available at http://localhost:3000/
   ```

4. Test the API

   ```bash
    # Check if everything is working
    curl http://localhost:3000/v1/health
    ```

5. APIs
   - BaseURL - <http://localhost:3000>
   - Create new plan - POST - /v1/plan
   - GET Plan Conditional(Only if not modified) - /v1/plan/:objectId
   - PATCH Plan Conditional(Only if latest eTag available) - /v1/plan/:objectId
   - PUT Plan Conditional(Only if latest eTag available) - /v1/plan/:objectId
   - DELETE Plan Conditional(Only if latest eTag available) - /v1/plan/:objectId

6. Complete Demo Workflow:

```comment
   # Create plan → Get plan → Test ETag → View DB → Delete plan
```

## Redis Database Inspection

- Redis CLI via Docker:

```bash
   docker exec -it redis-server redis-cli
   KEYS *
   # To see values of keys
   HGETALL plan:12xvxc345ssdsds-508
   exit
```

## Quick Reset for Fresh Demo

```bash
    docker stop redis-server && docker rm redis-server
    docker run -d -p 6379:6379 --name redis-server redis:alpine
    npm start
```
