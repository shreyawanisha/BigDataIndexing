const Ajv = require('ajv');
const { planSchema } = require('./schema');

class Validator {
  constructor() {
    this.ajv = new Ajv({ allErrors: true, verbose: true });
    
    // Compile the plan schema
    this.validatePlan = this.ajv.compile(planSchema);
  }

  // Validate plan data
  validate(data, schema = 'plan') {
    let isValid = false;
    let errors = [];

    switch (schema) {
      case 'plan':
        isValid = this.validatePlan(data);
        errors = this.validatePlan.errors || [];
        break;
      default:
        throw new Error(`Unknown schema: ${schema}`);
    }

    return {
      isValid,
      errors: this.formatErrors(errors)
    };
  }

  // Format validation errors for better readability
  formatErrors(errors) {
    return errors.map(error => ({
      field: error.instancePath || error.schemaPath,
      message: error.message,
      rejectedValue: error.data,
      allowedValues: error.schema
    }));
  }

  // Validate specific object types within the plan
  validateObjectId(objectId) {
    if (!objectId || typeof objectId !== 'string' || objectId.trim().length === 0) {
      return {
        isValid: false,
        errors: [{ field: 'objectId', message: 'ObjectId is required and must be a non-empty string' }]
      };
    }
    return { isValid: true, errors: [] };
  }

  // Custom validation for nested objects
  validateNestedStructure(data) {
    const issues = [];

    // Check for duplicate objectIds
    const objectIds = new Set();
    
    const addObjectId = (obj, path) => {
      if (obj && obj.objectId) {
        if (objectIds.has(obj.objectId)) {
          issues.push({
            field: path,
            message: `Duplicate objectId found: ${obj.objectId}`,
            rejectedValue: obj.objectId
          });
        } else {
          objectIds.add(obj.objectId);
        }
      }
    };

    // Check main plan objectId
    addObjectId(data, 'root');
    
    // Check planCostShares objectId
    if (data.planCostShares) {
      addObjectId(data.planCostShares, 'planCostShares');
    }

    // Check linkedPlanServices objectIds
    if (data.linkedPlanServices && Array.isArray(data.linkedPlanServices)) {
      data.linkedPlanServices.forEach((service, index) => {
        addObjectId(service, `linkedPlanServices[${index}]`);
        if (service.linkedService) {
          addObjectId(service.linkedService, `linkedPlanServices[${index}].linkedService`);
        }
        if (service.planserviceCostShares) {
          addObjectId(service.planserviceCostShares, `linkedPlanServices[${index}].planserviceCostShares`);
        }
      });
    }

    return {
      isValid: issues.length === 0,
      errors: issues
    };
  }

  // Complete validation including nested structure
  completeValidation(data) {
    const schemaValidation = this.validate(data);
    const structureValidation = this.validateNestedStructure(data);

    return {
      isValid: schemaValidation.isValid && structureValidation.isValid,
      errors: [...schemaValidation.errors, ...structureValidation.errors]
    };
  }
}

module.exports = new Validator();