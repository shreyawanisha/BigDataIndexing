const planSchema = {
    type: "object",
    properties: {
      planCostShares: {
        type: "object",
        properties: {
          deductible: { type: "number", minimum: 0 },
          _org: { type: "string", pattern: "^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
          copay: { type: "number", minimum: 0 },
          objectId: { type: "string", minLength: 1 },
          objectType: { type: "string", enum: ["membercostshare"] }
        },
        required: ["deductible", "_org", "copay", "objectId", "objectType"],
        additionalProperties: false
      },
      linkedPlanServices: {
        type: "array",
        items: {
          type: "object",
          properties: {
            linkedService: {
              type: "object",
              properties: {
                _org: { type: "string", pattern: "^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
                objectId: { type: "string", minLength: 1 },
                objectType: { type: "string", enum: ["service"] },
                name: { type: "string", minLength: 1 }
              },
              required: ["_org", "objectId", "objectType", "name"],
              additionalProperties: false
            },
            planserviceCostShares: {
              type: "object",
              properties: {
                deductible: { type: "number", minimum: 0 },
                _org: { type: "string", pattern: "^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
                copay: { type: "number", minimum: 0 },
                objectId: { type: "string", minLength: 1 },
                objectType: { type: "string", enum: ["membercostshare"] }
              },
              required: ["deductible", "_org", "copay", "objectId", "objectType"],
              additionalProperties: false
            },
            _org: { type: "string", pattern: "^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
            objectId: { type: "string", minLength: 1 },
            objectType: { type: "string", enum: ["planservice"] }
          },
          required: ["linkedService", "planserviceCostShares", "_org", "objectId", "objectType"],
          additionalProperties: false
        }
      },
      _org: { type: "string", pattern: "^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
      objectId: { type: "string", minLength: 1 },
      objectType: { type: "string", enum: ["plan"] },
      planType: { type: "string", enum: ["inNetwork", "outOfNetwork"] },
      creationDate: { 
        type: "string", 
        pattern: "^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])-(19|20)\\d\\d$" 
      }
    },
    required: ["planCostShares", "linkedPlanServices", "_org", "objectId", "objectType", "planType", "creationDate"],
    additionalProperties: false
  };
  
  module.exports = { planSchema };