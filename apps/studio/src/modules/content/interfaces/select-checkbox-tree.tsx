// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';

interface TreeChoice {
  value: string;
  text?: string;
  children?: TreeChoice[];
}

interface CheckboxTreeOptions {
  choices?: TreeChoice[];
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** Flatten the subtree values for a node (excluding the node itself). */
function descendantValues(node: TreeChoice): string[] {
  const out: string[] = [];
  for (const child of node.children ?? []) {
    out.push(child.value, ...descendantValues(child));
  }
  return out;
}

/**
 * `select-multiple-checkbox-tree` — hierarchical checkbox selection bound to
 * a nested `meta.options.choices` tree. Stores selected values as `string[]`.
 * Toggling a parent toggles all of its descendants too.
 */
export const SelectCheckboxTreeInterface: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<CheckboxTreeOptions>(field);
  const { t } = useTranslation('items');
  const choices = opts.choices ?? [];
  const selected = asArray(value);

  if (choices.length === 0) {
    return <p className="text-xs text-dim">{t('interfaces.noChoices')}</p>;
  }

  const setValues = (next: string[]) => onChange(Array.from(new Set(next)));

  const toggle = (node: TreeChoice) => {
    const family = [node.value, ...descendantValues(node)];
    const active = selected.includes(node.value);
    setValues(active ? selected.filter((v) => !family.includes(v)) : [...selected, ...family]);
  };

  return (
    <div className="rounded-ctl border border-line bg-bg p-2 text-sm">
      {choices.map((node) => (
        <TreeNode
          key={node.value}
          node={node}
          depth={0}
          selected={selected}
          disabled={disabled}
          onToggle={toggle}
        />
      ))}
    </div>
  );
};

function TreeNode({
  node,
  depth,
  selected,
  disabled,
  onToggle,
}: {
  node: TreeChoice;
  depth: number;
  selected: string[];
  disabled?: boolean;
  onToggle: (node: TreeChoice) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation('items');
  const hasChildren = (node.children?.length ?? 0) > 0;
  const active = selected.includes(node.value);

  return (
    <div>
      <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-dim hover:text-fg"
            aria-label={expanded ? t('interfaces.collapse') : t('interfaces.expand')}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-3.5" />
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onToggle(node)}
          className="flex items-center gap-2 text-left disabled:opacity-50"
        >
          <span
            className={cn(
              'flex h-3.5 w-3.5 items-center justify-center rounded border border-line',
              active ? 'border-brand bg-brand text-brand-fg' : 'border-line',
            )}
          >
            {active && <Check className="h-2.5 w-2.5" />}
          </span>
          {node.text ?? node.value}
        </button>
      </div>
      {hasChildren &&
        expanded &&
        node.children!.map((child) => (
          <TreeNode
            key={child.value}
            node={child}
            depth={depth + 1}
            selected={selected}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}
