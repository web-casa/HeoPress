// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { File, Plus, Upload, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';
import { publicFetch } from '@/lib/http';

interface FilesOptions {
  accept?: string;
  maxSize?: number;
  limit?: number;
}

export const FilesInterface: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<FilesOptions>(field);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation('items');
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const client = getApiClient();
  const files = Array.isArray(value) ? value : [];
  const limit = opts.limit ?? 15;

  const upload = async (file: File) => {
    if (opts.maxSize && file.size > opts.maxSize) {
      alert(t('interfaces.file.tooLarge', { max: opts.maxSize }));
      return;
    }
    if (files.length >= limit) {
      alert(t('interfaces.file.limit', { count: limit }));
      return;
    }

    setUploading(true);
    try {
      const { data: presigned } = await client.files.getPresignedUrl(file.name);

      await publicFetch(presigned.url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
      });

      const { data: fileRecord } = await client.files.create({
        filenameDisk: presigned.key,
        filenameDownload: file.name,
        mime: file.type || 'application/octet-stream',
        filesize: file.size,
      });

      onChange([...files, fileRecord.filenameDisk]);
    } catch (err) {
      console.error(err);
      alert(t('interfaces.file.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const file of Array.from(list).slice(0, Math.max(0, limit - files.length))) {
      await upload(file);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    void handleFiles(event.dataTransfer.files);
  };

  const remove = (file: string) => {
    onChange(files.filter((item) => item !== file));
  };

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((file) => (
            <li
              key={file}
              className="flex items-center gap-2 rounded-ctl border border-line bg-bg px-2 py-1.5 text-sm"
            >
              <File className="h-4 w-4 text-dim" />
              <span className="flex-1 truncate font-mono text-xs">{file}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(file)}
                  aria-label={t('interfaces.file.remove', { file })}
                  className="text-dim hover:text-bad"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-ctl border-2 border-line border-dashed bg-bg px-3 py-5 text-sm text-dim transition',
          over && 'border-brand bg-brand-soft',
          disabled && 'pointer-events-none opacity-50',
        )}
        onClick={() => inputRef.current?.click()}
        role="button"
      >
        {files.length > 0 ? <Plus className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
        <span>{uploading ? t('interfaces.file.uploading') : t('interfaces.file.dropMany')}</span>
        <span className="text-[10px]">
          {t('interfaces.file.count', { count: files.length, limit })}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={opts.accept}
          multiple
          hidden
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </div>
    </div>
  );
};
