// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import ColorPickerInterface from './interface';
import { defineInterface } from '@heopress/extension-sdk';

// 1. Export the extension manifest
export const manifest = {
  id: 'heopress/color-picker',
  name: 'Color Picker',
  version: '1.0.0',
  type: 'interface',
  icon: 'palette',
  description: 'A premium visual color picker field interface.',
  author: {
    name: 'HeoPress Team',
    email: 'hello@heopress.example',
  },
  requiredCapabilities: [],
  compatibleWith: '^1.0.0-rc.4',
};

// 2. Export the interface definition.
// At runtime, HeoPress Studio imports this default export and registers the component.
export default defineInterface({
  id: 'color-picker',
  name: 'Color Picker',
  component: ColorPickerInterface,
  types: ['string'], // compatible with string field types in Postgres
  group: 'standard',
  options: [
    {
      field: 'defaultColor',
      name: 'Default Hex Color',
      type: 'string',
      meta: {
        interface: 'input',
        options: {
          placeholder: '#FFFFFF',
        },
      },
    },
  ],
});
