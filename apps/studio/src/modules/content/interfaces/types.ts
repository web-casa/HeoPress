// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { FieldResource } from "@heopress/sdk";

/**
 * Common contract for every Studio interface component (Phase B FE slice 3+).
 *
 * An "interface" is the field-level editor rendered inside item detail forms.
 * Interfaces are registered by the `field.interface` string returned by the
 * schema engine, e.g. `input`, `input-multiline`, `toggle`, `select-dropdown`.
 */
export interface InterfaceProps<T = unknown> {
  /** Current value as stored in the item's `data` JSONB blob. */
  value: T | null | undefined;
  /** Field metadata from the schema engine; gives access to `meta.options`. */
  field: FieldResource;
  /** Disabled flag (driven by per-field permissions in Phase C). */
  disabled?: boolean;
  /** Notify parent of a new value. */
  onChange: (next: T | null) => void;
}

/** Component signature for everything in `interfaces/registry.tsx`. */
export type InterfaceComponent<T = unknown> = React.FC<InterfaceProps<T>>;

/**
 * Helper for interfaces that read a field's configuration: `field.options`, as the API returns it (HeoPress P07: the
 * preset's repeaters and choices live there), or `field.meta.options` from older callers. The runtime shape is
 * unknown — callers narrow with their own option interface.
 */
export function readOptions<T>(field: FieldResource): T {
  const meta = (field as unknown as { meta?: Record<string, unknown> }).meta;
  const own = field.options && Object.keys(field.options).length > 0 ? field.options : undefined;
  return ((own ?? meta?.options ?? field.options) as T) ?? ({} as T);
}
