// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
export interface AISkillParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  /** JSON Schema of the array items (passed through to the model's tool schema). */
  items?: Record<string, unknown>;
  /** JSON Schema of the object properties (passed through to the model's tool schema). */
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface AISkillDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AISkillParameter>;
    required: string[];
  };
  requiredCapabilities: string[];
}
