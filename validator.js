const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { planSchema } = require('./schema');

class Validator {
  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    addFormats(this.ajv);
    this.validatePlan = this.ajv.compile(planSchema);
  }

  validate(data, schema = 'plan') {
    let isValid = false, errors = [];
    if (schema === 'plan') {
      isValid = this.validatePlan(data);
      errors = this.validatePlan.errors || [];
    } else throw new Error(`Unknown schema: ${schema}`);
    return { isValid, errors: this.formatErrors(errors) };
  }

  validatePlanData(data) { return this.completeValidation(data); } // <- use this in controllers

  formatErrors(errors) {
    return errors.map(e => ({
      field: e.instancePath || e.schemaPath, message: e.message,
      rejectedValue: e.data, allowedValues: e.schema
    }));
  }

  validateObjectId(objectId) {
    if (!objectId || typeof objectId !== 'string' || objectId.trim().length === 0) {
      return { isValid: false, errors: [{ field: 'objectId', message: 'ObjectId is required and must be a non-empty string' }] };
    }
    return { isValid: true, errors: [] };
  }

  validateNestedStructure(data) {
    const issues = [];
  
    // Only enforce uniqueness for planservice IDs within the array.
    const seenPlanservice = new Set();
  
    if (Array.isArray(data.linkedPlanServices)) {
      data.linkedPlanServices.forEach((s, i) => {
        if (!s) return;
  
        // 1) planservice.objectId must be unique among siblings
        if (s.objectId) {
          if (seenPlanservice.has(s.objectId)) {
            issues.push({
              field: `linkedPlanServices[${i}]`,
              message: `Duplicate planservice objectId: ${s.objectId}`,
              rejectedValue: s.objectId
            });
          } else {
            seenPlanservice.add(s.objectId);
          }
        }
  
        // 2) DO NOT enforce uniqueness for linkedService.objectId
        //    Services may be shared across multiple planservices.
  
        // 3) DO NOT enforce uniqueness for planserviceCostShares.objectId
        //    Member-cost-shares may also be shared.
  
        // If you still want *existence* checks, do that elsewhere against the store,
        // not as "duplicate" structure validation here.
      });
    }
  
    // Root-level planCostShares may reuse the same membercostshare id as a planservice if desired.
    // If you want to forbid that, add a check here comparing
    // data.planCostShares.objectId against each s.planserviceCostShares.objectId.
  
    return { isValid: issues.length === 0, errors: issues };
  }

  completeValidation(data) {
    const a = this.validate(data);
    const b = this.validateNestedStructure(data);
    return { isValid: a.isValid && b.isValid, errors: [...a.errors, ...b.errors] };
  }
}

module.exports = new Validator();