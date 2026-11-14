import { coverageLabel, formatClockHour, hoursPerDay, inHourWindow, isCoveredHour, type Coverage } from '../lib/coverage';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DEFAULT_DAILY_COVERAGE: Coverage = { start: 9, end: 17 };

interface Night {
  start: number;
  end: number;
}

// 24 cells, midnight to midnight: covered hours blue, night hours inside
// coverage darker, everything else grey.
export function CoverageStrip({ coverage, night }: { coverage: Coverage | null; night?: Night | null }) {
  return (
    <div>
      <div className="flex h-4 overflow-hidden rounded border border-gray-200" aria-hidden>
        {HOURS.map((h) => {
          const covered = isCoveredHour(h, coverage);
          const isNight = covered && night != null && inHourWindow(h, night.start, night.end);
          return (
            <div
              key={h}
              title={formatClockHour(h)}
              className={`flex-1 border-r border-white/60 last:border-r-0 ${
                isNight ? 'bg-blue-800' : covered ? 'bg-blue-500' : 'bg-gray-200'
              }`}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-gray-500 tabular-nums" aria-hidden>
        <span>12a</span>
        <span>6a</span>
        <span>12p</span>
        <span>6p</span>
        <span>12a</span>
      </div>
    </div>
  );
}

interface CoverageEditorProps {
  value: Coverage | null;
  onChange: (value: Coverage | null) => void;
  night?: Night | null;
  // Shown under the strip, e.g. "· ~70 h total".
  extraSummary?: string;
  disabled?: boolean;
}

export default function CoverageEditor({ value, onChange, night, extraSummary, disabled }: CoverageEditorProps) {
  const daily = value !== null;
  const segment = (active: boolean) =>
    `flex-1 px-3 py-2 text-sm font-medium transition-colors ${
      active ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
    }`;

  const hourSelect = (current: number, set: (h: number) => void, label: string) => (
    <label className="flex flex-col gap-1">
      <span className="ui-label">{label}</span>
      <select
        value={current}
        disabled={disabled}
        onChange={(e) => set(Number(e.target.value))}
        className="ui-input w-32"
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {formatClockHour(h)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-sm overflow-hidden rounded-md border border-gray-300" role="radiogroup">
        <button
          type="button"
          role="radio"
          aria-checked={!daily}
          disabled={disabled}
          onClick={() => onChange(null)}
          className={segment(!daily)}
        >
          Around the clock
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={daily}
          disabled={disabled}
          onClick={() => onChange(value ?? DEFAULT_DAILY_COVERAGE)}
          className={`${segment(daily)} border-l border-gray-300`}
        >
          Set daily hours
        </button>
      </div>

      {value && (
        <div className="flex flex-wrap items-end gap-3">
          {hourSelect(value.start, (start) => onChange({ ...value, start }), 'From')}
          {hourSelect(value.end, (end) => onChange({ ...value, end }), 'To')}
          {value.end < value.start && (
            <span className="mb-2 rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">next day</span>
          )}
        </div>
      )}
      {value && value.start === value.end && (
        <p className="text-sm text-red-600">Pick a different end time, or use around the clock.</p>
      )}

      <CoverageStrip coverage={value} night={night} />
      <p className="text-sm text-gray-600">
        {value ? `Shifts run ${coverageLabel(value)}` : 'Shifts run around the clock'} · {hoursPerDay(value)} h/day
        {extraSummary ? ` · ${extraSummary}` : ''}
      </p>
    </div>
  );
}
