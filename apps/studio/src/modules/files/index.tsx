// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { Folder, File as FileIcon, Upload, Trash2, HardDrive, Search, Plus, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { FolderResource, FileResource, UploadConfigResource } from '@heopress/sdk';
import { publicFetch } from '@/lib/http';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Client-side pre-check mirroring the server upload guard so the user gets an
 * immediate, friendly reason instead of a failed request. The server remains
 * the source of truth — this only avoids obviously-doomed uploads.
 */
function rejectFile(file: File, cfg: UploadConfigResource | undefined): string | null {
  if (!cfg) return null;
  if (file.size > cfg.maxBytes) {
    const mb = (cfg.maxBytes / (1024 * 1024)).toFixed(cfg.maxBytes % (1024 * 1024) === 0 ? 0 : 1);
    return i18n.t('files:tooLarge', { name: file.name, mb });
  }
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  const extOk = ext !== '' && cfg.allowedExtensions.includes(ext);
  const mimeOk = file.type !== '' && cfg.allowedMimeTypes.includes(file.type);
  if (!extOk && !mimeOk) {
    return i18n.t('files:badType', { name: file.name, allowed: cfg.allowedExtensions.join(', ') });
  }
  return null;
}

export function FilesPage() {
  const { t } = useTranslation('files');
  const client = getApiClient();
  const qc = useQueryClient();

  const foldersQuery = useQuery({
    queryKey: ['folders'],
    queryFn: async () => (await client.folders.list()).data,
  });

  const filesQuery = useQuery({
    queryKey: ['files'],
    queryFn: async () => (await client.files.list()).data,
  });

  // Effective upload policy — constrains the picker and pre-checks client-side.
  // The server enforces the same policy regardless of what the picker allows.
  const uploadConfigQuery = useQuery({
    queryKey: ['upload-config'],
    queryFn: async () => (await client.uploads.getConfig()).data,
  });
  const uploadConfig = uploadConfigQuery.data;
  const acceptAttr = uploadConfig
    ? [...uploadConfig.allowedMimeTypes, ...uploadConfig.allowedExtensions].join(',')
    : undefined;

  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  const folders = foldersQuery.data ?? [];
  const files = filesQuery.data ?? [];

  const displayedFolders = folders.filter(f => f.parent === currentFolder);
  const displayedFiles = files.filter(f => f.folder === currentFolder);

  const breadcrumbs = [];
  let curr = currentFolder;
  while (curr) {
    const f = folders.find(x => x.id === curr);
    if (!f) break;
    breadcrumbs.unshift(f);
    curr = f.parent;
  }

  const deleteFolderMutation = useMutation({
    mutationFn: (id: string) => client.folders.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: string) => client.files.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  // Real upload logic
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const { data: presigned } = await client.files.getPresignedUrl(file.name);
      
      // Perform the actual upload to R2/S3 via Hono Worker proxy
      await publicFetch(presigned.url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
      });

      return client.files.create({
        filenameDisk: presigned.key,
        filenameDownload: file.name,
        mime: file.type || 'application/octet-stream',
        filesize: file.size,
        folder: currentFolder,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    for (const f of fileList) {
      const rejection = rejectFile(f, uploadConfig);
      if (rejection) {
        alert(rejection);
        continue;
      }
      uploadFileMutation.mutate(f);
    }
    // Allow re-selecting the same file after a rejection.
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('title')}
        description={
          <span className="flex items-center gap-2">
            <button 
              onClick={() => setCurrentFolder(null)} 
              className="hover:text-fg"
            >
              <HardDrive className="h-4 w-4 inline mr-1" /> {t('root')}
            </button>
            {breadcrumbs.map(b => (
              <span key={b.id} className="flex items-center gap-2">
                <span>/</span>
                <button onClick={() => setCurrentFolder(b.id)} className="hover:text-fg">
                  {b.name}
                </button>
              </span>
            ))}
          </span>
        }
        actions={
          <>
          <button
            onClick={() => setIsCreatingFolder(true)}
            className="inline-flex items-center gap-2 rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2"
          >
            <Plus className="h-4 w-4" /> {t('newFolder')}
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg hover:opacity-90">
            <Upload className="h-4 w-4" /> {t('upload')}
            <input type="file" className="hidden" multiple accept={acceptAttr} onChange={handleFileUpload} />
          </label>
          </>
        }
      />

      {foldersQuery.isLoading || filesQuery.isLoading ? (
        <div className="py-12 text-center text-dim">{t('common:loading')}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
          {displayedFolders.map(folder => (
            <div 
              key={folder.id}
              className="group relative flex cursor-pointer flex-col items-center gap-2 rounded-card border border-line bg-panel p-4 transition-colors hover:bg-panel-2"
              onClick={() => setCurrentFolder(folder.id)}
            >
              <Folder className="h-10 w-10 text-brand" />
              <span className="text-sm font-medium truncate w-full text-center">{folder.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(t('deleteFolder'))) deleteFolderMutation.mutate(folder.id);
                }}
                className="absolute top-2 right-2 hidden text-dim hover:text-bad group-hover:block"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}

          {displayedFiles.map(file => (
            <div 
              key={file.id}
              className="group relative flex flex-col items-center gap-2 rounded-card border border-line bg-panel p-4 transition-colors hover:bg-panel-2"
            >
              <FileIcon className="h-10 w-10 text-dim" />
              <span className="text-sm font-medium truncate w-full text-center">{file.filenameDownload}</span>
              <span className="text-xs text-dim">{t('sizeKb', { size: (file.filesize / 1024).toFixed(1) })}</span>
              
              <div className="absolute top-2 right-2 hidden items-center gap-1 group-hover:flex">
                <button
                  onClick={() => {
                    if (confirm(t('deleteFile'))) deleteFileMutation.mutate(file.id);
                  }}
                  className="text-dim hover:text-bad p-1"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          {displayedFolders.length === 0 && displayedFiles.length === 0 && (
            <div className="col-span-full py-12 text-center border-2 border-line border-dashed rounded-card text-dim">
              {t('emptyFolder')}
            </div>
          )}
        </div>
      )}

      {isCreatingFolder && (
        <CreateFolderDialog 
          parent={currentFolder} 
          onClose={() => setIsCreatingFolder(false)} 
        />
      )}
    </div>
  );
}

function CreateFolderDialog({ parent, onClose }: { parent: string | null; onClose: () => void }) {
  const { t } = useTranslation('files');
  const client = getApiClient();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: () => client.folders.create({ name, parent }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">{t('createFolder')}</h2>
        <div className="space-y-4">
          <input
            type="text"
            autoFocus
            placeholder={t('folderName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-ctl border border-line px-3 py-2 text-sm outline-none focus:border-brand"
            onKeyDown={(e) => { if (e.key === 'Enter') mutation.mutate(); }}
          />
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose} className="rounded-ctl px-4 py-2 text-sm font-medium hover:bg-panel-2">
              {t('common:cancel')}
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!name || mutation.isPending}
              className="rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
            >
              {t('create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
