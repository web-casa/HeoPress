import Ajv2020 from 'ajv/dist/2020.js';
import { THEME_VIEW_MODEL_SCHEMA, type ThemeViewModel } from '@heopress/contracts/theme';

/**
 * Validation of a View Model against the theme contract's JSON Schema before it is rendered (HeoPress P06
 * task 2.1): the renderer never hands a template data the contract does not describe.
 */
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(THEME_VIEW_MODEL_SCHEMA);

export class ViewModelError extends Error {
  readonly code = 'VIEW_MODEL_INVALID';
}

export function assertViewModel(vm: unknown): asserts vm is ThemeViewModel {
  if (validate(vm)) return;
  const first = validate.errors?.slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
  throw new ViewModelError(`page data does not match the theme contract: ${first}`);
}
