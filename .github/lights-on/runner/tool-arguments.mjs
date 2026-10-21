export function matchesToolParameters(value, schema = {}) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (schema.required || []).every((key) => Object.hasOwn(value, key)) &&
        Object.entries(schema.properties || {}).every(([key, property]) =>
          !Object.hasOwn(value, key) || matchesToolParameters(value[key], property));
    case 'array': return Array.isArray(value) && value.every((item) => matchesToolParameters(item, schema.items));
    case 'integer': return Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean': return typeof value === schema.type;
    default: return true;
  }
}
