// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Handle, Position } from '@xyflow/react';
import {
  GitBranch,
  RefreshCw,
  Globe,
  Mail,
  Terminal,
  Clock,
  Puzzle,
  Database,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Common node wrapper with glassmorphism and smooth borders
function NodeWrapper({
  title,
  icon: Icon,
  colorClass,
  shapeClass = 'rounded-xl',
  children,
  selected,
}: {
  title: string;
  icon: any;
  colorClass: string;
  shapeClass?: string;
  children?: React.ReactNode;
  selected?: boolean;
}) {
  return (
    <div
      className={`min-w-[180px] border bg-panel p-3 shadow-md backdrop-blur-sm transition-all duration-200 ${shapeClass} ${
        selected ? 'ring-2 ring-brand border-brand scale-[1.02]' : 'hover:border-brand'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-line pb-1.5 mb-2">
        <div className={`flex h-7 w-7 items-center justify-center rounded-card border border-line ${colorClass}`}>
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-xs font-bold text-fg tracking-wide uppercase">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function ConditionNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      
      {/* Diamond-like layout styling */}
      <NodeWrapper
        title={t('node.condition')}
        icon={GitBranch}
        colorClass="bg-warn-soft text-warn border-warn/40"
        shapeClass="rounded-xl"
        selected={selected}
      >
        <div className="text-[10px] text-dim font-mono truncate max-w-[150px]">
          {data.expression || 'if (data.status === "active")'}
        </div>
      </NodeWrapper>
      
      {/* Yes and No handles */}
      <Handle
        type="source"
        position={Position.Right}
        id="yes"
        className="w-2.5 h-2.5 bg-ok !top-1/3"
        style={{ right: -4 }}
      />
      <span className="absolute right-2 top-[12px] text-[8px] font-bold text-ok">{t('node.yes')}</span>
      
      <Handle
        type="source"
        position={Position.Right}
        id="no"
        className="w-2.5 h-2.5 bg-rose-500 !top-2/3"
        style={{ right: -4 }}
      />
      <span className="absolute right-2 top-[32px] text-[8px] font-bold text-rose-600">{t('node.no')}</span>
    </div>
  );
}

export function TransformNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.transform')}
        icon={RefreshCw}
        colorClass="bg-indigo-500/10 text-indigo-500 border-indigo-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-dim font-mono truncate max-w-[150px]">
          {data.script ? t('node.customScript') : t('node.noScript')}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export function HttpNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.http')}
        icon={Globe}
        colorClass="bg-brand-soft text-brand border-brand/40"
        selected={selected}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold text-brand uppercase font-mono">{data.method || 'GET'}</span>
          <span className="text-[10px] text-dim font-mono truncate max-w-[150px]">
            {data.url || 'https://api.example.com'}
          </span>
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export function MailNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.mail')}
        icon={Mail}
        colorClass="bg-violet-500/10 text-violet-500 border-violet-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-dim truncate max-w-[150px]">
          {data.to || 'recipient@example.com'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export function LogNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.log')}
        icon={Terminal}
        colorClass="bg-panel-2 text-dim border-line"
        selected={selected}
      >
        <div className="text-[10px] text-dim font-mono truncate max-w-[150px]">
          {data.message || t('node.logPlaceholder')}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export function SleepNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.sleep')}
        icon={Clock}
        colorClass="bg-orange-500/10 text-orange-500 border-orange-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-dim">
          {data.duration ? `${data.duration} ms` : '1000 ms'}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export function RunExtensionNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.runExtension')}
        icon={Puzzle}
        colorClass="bg-rose-500/10 text-rose-500 border-rose-500/20"
        selected={selected}
      >
        <div className="text-[10px] text-dim truncate max-w-[150px]">
          {data.extensionName || t('node.selectExtension')}
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export function ItemCrudNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={t('node.itemCrud')}
        icon={Database}
        colorClass="bg-cyan-500/10 text-cyan-500 border-cyan-500/20"
        selected={selected}
      >
        <div className="flex flex-col gap-1">
          <span className="text-[9px] font-bold text-cyan-600 uppercase font-mono">{data.action || 'item.create'}</span>
          <span className="text-[10px] text-dim font-mono truncate max-w-[150px]">
            {data.collection || t('node.selectCollection')}
          </span>
        </div>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

/**
 * Fallback node for registry operations without a dedicated component
 * (drift-scan, deploy:trigger, extension-registered ops, …). The real
 * operation key lives in `data.key`; options preview as JSON.
 */
export function GenericOpNode({ data, selected }: { data: any; selected?: boolean }) {
  const { t } = useTranslation('flows');
  const preview = JSON.stringify(data?.options ?? {}, null, 0);
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-brand" />
      <NodeWrapper
        title={String(data?.key ?? t('node.operation'))}
        icon={Puzzle}
        colorClass="bg-panel-2 text-dim border-line"
        selected={selected}
      >
        <span className="text-[10px] text-dim font-mono truncate max-w-[150px] block">
          {preview.length > 2 ? preview : t('node.noOptions')}
        </span>
      </NodeWrapper>
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-brand" />
    </div>
  );
}

export const flowNodeTypes = {
  genericOp: GenericOpNode,
  condition: ConditionNode,
  transform: TransformNode,
  http: HttpNode,
  mail: MailNode,
  log: LogNode,
  sleep: SleepNode,
  'run-extension': RunExtensionNode,
  'item-crud': ItemCrudNode,
};
