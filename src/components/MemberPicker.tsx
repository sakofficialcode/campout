import { Select } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon, CircleAlert } from 'lucide-react';
import type { ConflictStatus } from '../lib/types';

const CONFLICT_INFO: Record<Exclude<ConflictStatus, 'ok'>, { label: string; className: string }> = {
  on_shift: { label: 'Already on shift then', className: 'text-red-600' },
  unavailable: { label: 'Marked unavailable', className: 'text-red-600' },
  not_preferred: { label: 'Marked not preferred', className: 'text-amber-500' },
};

function ConflictIcon({ status }: { status: ConflictStatus | undefined }) {
  if (!status || status === 'ok') return null;
  const info = CONFLICT_INFO[status];
  return (
    <span title={info.label} className={`inline-flex shrink-0 ${info.className}`}>
      <CircleAlert className="size-4" aria-label={info.label} />
    </span>
  );
}

interface MemberPickerProps {
  members: string[];
  value: string;
  onChange: (name: string) => void;
  // Per-person verdict for the selected time range; null while loading or
  // unavailable, in which case the picker still works, just without icons.
  conflicts: Record<string, ConflictStatus> | null;
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

// Anyone can be picked; a conflict is a warning, never a block.
export default function MemberPicker({
  members,
  value,
  onChange,
  conflicts,
  loading,
  placeholder = 'Select a member',
  disabled,
}: MemberPickerProps) {
  const selectedStatus = value ? conflicts?.[value] : undefined;

  return (
    <div className="flex flex-col gap-1">
      <Select.Root value={value || null} onValueChange={(v) => onChange((v as string) ?? '')} disabled={disabled}>
        <Select.Trigger className="flex h-9 min-w-48 items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-600 data-[popup-open]:bg-gray-50 disabled:opacity-50">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate ${value ? '' : 'text-gray-500'}`}>{value || placeholder}</span>
            <ConflictIcon status={selectedStatus} />
          </span>
          <Select.Icon className="flex">
            <ChevronDownIcon className="size-4" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className="z-50" sideOffset={4}>
            <Select.Popup className="min-w-[var(--anchor-width)] rounded-md border border-gray-200 bg-white py-1 shadow-lg">
              <Select.List className="max-h-72 overflow-y-auto outline-none">
                {members.map((name) => {
                  const status = conflicts?.[name];
                  const info = status && status !== 'ok' ? CONFLICT_INFO[status] : null;
                  return (
                    <Select.Item
                      key={name}
                      value={name}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-gray-900 outline-none hover:bg-gray-100 data-[highlighted]:bg-gray-100"
                    >
                      <Select.ItemIndicator className="w-4">
                        <CheckIcon className="size-4" />
                      </Select.ItemIndicator>
                      <Select.ItemText className="flex-1">{name}</Select.ItemText>
                      {info && <span className={`text-xs ${info.className}`}>{info.label}</span>}
                      <ConflictIcon status={status} />
                    </Select.Item>
                  );
                })}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      {loading && <span className="text-[11px] text-gray-400">Checking availability…</span>}
      {!loading && selectedStatus && selectedStatus !== 'ok' && (
        <span className={`text-[11px] ${CONFLICT_INFO[selectedStatus].className}`}>
          {value}: {CONFLICT_INFO[selectedStatus].label.toLowerCase()} for this time
        </span>
      )}
    </div>
  );
}
