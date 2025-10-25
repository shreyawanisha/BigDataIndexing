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
    const issues = [], seen = new Set();
    const add = (obj, path) => {
      if (obj && obj.objectId) {
        if (seen.has(obj.objectId)) issues.push({ field: path, message: `Duplicate objectId: ${obj.objectId}`, rejectedValue: obj.objectId });
        else seen.add(obj.objectId);
      }
    };
    add(data, 'root');
    if (data.planCostShares) add(data.planCostShares, 'planCostShares');
    if (Array.isArray(data.linkedPlanServices)) {
      data.linkedPlanServices.forEach((s, i) => {
        add(s, `linkedPlanServices[${i}]`);
        if (s.linkedService) add(s.linkedService, `linkedPlanServices[${i}].linkedService`);
        if (s.planserviceCostShares) add(s.planserviceCostShares, `linkedPlanServices[${i}].planserviceCostShares`);
      });
    }
    return { isValid: issues.length === 0, errors: issues };
  }

  completeValidation(data) {
    const a = this.validate(data);
    const b = this.validateNestedStructure(data);
    return { isValid: a.isValid && b.isValid, errors: [...a.errors, ...b.errors] };
  }
}

module.exports = new Validator();