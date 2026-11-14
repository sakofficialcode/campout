import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Field } from '@base-ui/react/field';
import { Form } from '@base-ui/react/form';
import { Button } from '@base-ui/react/button';
import { Select } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon, Minus, Plus } from 'lucide-react';
import { NumberField } from '@base-ui/react/number-field';
import { Fieldset, Slider, Switch } from '@base-ui/react';
import { createGroup } from '../lib/api';
import CoverageEditor from '../components/CoverageEditor';
import { inHourWindow, isCoveredHour, totalCoveredHours, type Coverage } from '../lib/coverage';

const timeGranularity = [
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
];

// `hour` runs 0-48; values past 24 are the next day.
function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${displayHour}:00 ${period}`;
}

export default function Create() {
  const navigate = useNavigate();
  const [errors, setErrors] = React.useState<{ submit?: string }>({});
  const [loading, setLoading] = React.useState(false);
  const [numMembers, setNumMembers] = React.useState<number | undefined>(undefined);
  const [stdOnShift, setStdOnShift] = React.useState<number | undefined>(undefined);
  const [nightShifts, setNightShifts] = React.useState(false);
  const [nightHours, setNightHours] = React.useState([22, 30]); // 10 PM to 6 AM (on a noon-to-noon slider domain)
  const [selectedGranularity, setSelectedGranularity] = React.useState<15 | 30 | 60>(30);
  const [coverage, setCoverage] = React.useState<Coverage | null>(null);
  const [shiftStartValue, setShiftStartValue] = React.useState('');
  const [shiftEndValue, setShiftEndValue] = React.useState('');

  const night = nightShifts ? { start: nightHours[0] % 24, end: nightHours[1] % 24 } : null;
  const nightOverlapsCoverage =
    night === null ||
    Array.from({ length: 24 }, (_, h) => h).some((h) => isCoveredHour(h, coverage) && inHourWindow(h, night.start, night.end));
  const totalHours = totalCoveredHours(shiftStartValue, shiftEndValue, coverage);

  return (
    <div className="ui-page py-8">
      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Create New Group</h1>

        <Form
          className="flex flex-col gap-6"
          errors={errors}
          onSubmit={async (event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);

            if (!numMembers || !stdOnShift) {
              setErrors({ submit: 'Please fill in all required fields' });
              return;
            }
            if (coverage && coverage.start === coverage.end) {
              setErrors({ submit: 'Daily hours need a different start and end time' });
              return;
            }

            const payload = {
              groupName: formData.get('groupName') as string,
              numMembers,
              shiftStart: formData.get('shiftStart') as string,
              shiftEnd: formData.get('shiftEnd') as string,
              stdOnShift,
              timeGranularity: selectedGranularity,
              nightShifts,
              ...(nightShifts && {
                nightShiftStart: nightHours[0] % 24,
                nightShiftEnd: nightHours[1] % 24,
                nightOnShift: Number(formData.get('nightOnShift')),
              }),
              coverageStart: coverage?.start ?? null,
              coverageEnd: coverage?.end ?? null,
              adminPassword: (formData.get('adminPassword') as string) || null,
            };

            setLoading(true);
            setErrors({});

            try {
              const { uuid } = await createGroup(payload);
              navigate(`/${uuid}`);
            } catch (error) {
              setErrors({ submit: error instanceof Error ? error.message : 'Network error. Please try again.' });
              setLoading(false);
            }
          }}
        >
          {/* Group Name */}
          <Field.Root name="groupName" className="flex flex-col gap-1">
            <Field.Label className="ui-label">
              Group Name
            </Field.Label>
            <Field.Control
              type="text"
              required
              placeholder="Joe's Tent"
              className="ui-input"
            />
            <Field.Error className="text-sm text-red-600" />
          </Field.Root>

          {/* Number of Members and People Per Shift */}
          <div className="grid grid-cols-2 gap-4">
            <Field.Root name="numMembers">
              <NumberField.Root
                defaultValue={undefined}
                onValueChange={(value) => setNumMembers(value ?? undefined)}
                min={1}
                max={64}
                required
                className="flex flex-col gap-1"
              >
                <Field.Label className="ui-label">
                  Number of Members
                </Field.Label>
                <NumberField.Group className="flex">
                  <NumberField.Decrement className="flex size-10 items-center justify-center rounded-l-md border border-gray-300 bg-gray-50 text-gray-900 hover:bg-gray-100 active:bg-gray-200">
                    <Minus className="size-4" />
                  </NumberField.Decrement>
                  <NumberField.Input className="h-10 w-full border-t border-b border-gray-300 text-center text-base text-gray-900 tabular-nums focus:z-10 focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-blue-600" />
                  <NumberField.Increment className="flex size-10 items-center justify-center rounded-r-md border border-gray-300 bg-gray-50 text-gray-900 hover:bg-gray-100 active:bg-gray-200">
                    <Plus className="size-4" />
                  </NumberField.Increment>
                </NumberField.Group>
              </NumberField.Root>
              <Field.Error className="text-sm text-red-600" />
            </Field.Root>

            <Field.Root name="stdOnShift">
              <NumberField.Root
                defaultValue={undefined}
                onValueChange={(value) => setStdOnShift(value ?? undefined)}
                min={1}
                max={numMembers || 64}
                required
                className="flex flex-col gap-1"
              >
                <Field.Label className="ui-label">
                  People Per Shift
                </Field.Label>
                <NumberField.Group className="flex">
                  <NumberField.Decrement className="flex size-10 items-center justify-center rounded-l-md border border-gray-300 bg-gray-50 text-gray-900 hover:bg-gray-100 active:bg-gray-200">
                    <Minus className="size-4" />
                  </NumberField.Decrement>
                  <NumberField.Input className="h-10 w-full border-t border-b border-gray-300 text-center text-base text-gray-900 tabular-nums focus:z-10 focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-blue-600" />
                  <NumberField.Increment className="flex size-10 items-center justify-center rounded-r-md border border-gray-300 bg-gray-50 text-gray-900 hover:bg-gray-100 active:bg-gray-200">
                    <Plus className="size-4" />
                  </NumberField.Increment>
                </NumberField.Group>
              </NumberField.Root>
              <Field.Error className="text-sm text-red-600" />
            </Field.Root>
          </div>

          {/* Schedule Date Range */}
          <div className="grid grid-cols-2 gap-4">
            <Field.Root name="shiftStart" className="flex flex-col gap-1">
              <Field.Label className="ui-label">
                Schedule Start
              </Field.Label>
              <Field.Control
                type="datetime-local"
                required
                onChange={(e) => setShiftStartValue(e.target.value)}
                className="ui-input"
              />
              <Field.Error className="text-sm text-red-600" />
            </Field.Root>

            <Field.Root name="shiftEnd" className="flex flex-col gap-1">
              <Field.Label className="ui-label">
                Schedule End
              </Field.Label>
              <Field.Control
                type="datetime-local"
                required
                onChange={(e) => setShiftEndValue(e.target.value)}
                className="ui-input"
              />
              <Field.Error className="text-sm text-red-600" />
            </Field.Root>
          </div>

          {/* Time Granularity */}
          <Field.Root name="timeGranularity" className="flex flex-col gap-1">
            <Field.Label className="ui-label">
              Shift Duration
            </Field.Label>
            <Select.Root
              items={timeGranularity}
              name="timeGranularity"
              defaultValue={30}
              onValueChange={(val) => setSelectedGranularity(val as 15 | 30 | 60)}
            >
              <Select.Trigger className="flex h-10 items-center justify-between gap-3 rounded-md border border-gray-300 px-3 text-base bg-white text-gray-900 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-600 data-[popup-open]:bg-gray-50">
                <Select.Value />
                <Select.Icon className="flex">
                  <ChevronDownIcon className="size-4" />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner className="z-50" sideOffset={4}>
                  <Select.Popup className="min-w-[var(--anchor-width)] rounded-md bg-white shadow-lg border border-gray-200 py-1">
                    <Select.List className="outline-none">
                      {timeGranularity.map(({ label, value }) => (
                        <Select.Item
                          key={value}
                          value={value}
                          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-900 cursor-pointer hover:bg-gray-100 data-[highlighted]:bg-gray-100 outline-none"
                        >
                          <Select.ItemIndicator className="w-4">
                            <CheckIcon className="size-4" />
                          </Select.ItemIndicator>
                          <Select.ItemText>{label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </Field.Root>

          {/* Daily coverage window */}
          <fieldset className="flex flex-col gap-2">
            <legend className="ui-label">When do shifts need covering?</legend>
            <CoverageEditor
              value={coverage}
              onChange={setCoverage}
              night={night}
              extraSummary={totalHours != null ? `~${Math.round(totalHours)} h total` : undefined}
            />
          </fieldset>

          {/* Night Shifts Toggle */}
          <Field.Root name="nightShifts" className="flex items-center gap-3 py-2">
            <Switch.Root
              checked={nightShifts}
              onCheckedChange={setNightShifts}
              className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 data-[checked]:bg-blue-600 bg-gray-300"
            >
              <Switch.Thumb className="inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform data-[checked]:translate-x-5 translate-x-0.5" />
            </Switch.Root>
            <Field.Label className="ui-label mb-0 cursor-pointer">
              Enable Night Shifts
            </Field.Label>
          </Field.Root>

          {/* Night Shift Configuration */}
          {nightShifts && (
            <div className="space-y-4 p-4 bg-gray-50 rounded-md border border-gray-200">
              <Field.Root name="nightHours" className="flex flex-col gap-3">
                <Fieldset.Root className="flex flex-col gap-2">
                  <Fieldset.Legend className="ui-label">
                    Night Shift Hours: {formatHour(nightHours[0])} - {formatHour(nightHours[1])}
                  </Fieldset.Legend>
                  <Slider.Root
                    value={nightHours}
                    onValueChange={setNightHours}
                    min={12}
                    max={36}
                    step={1}
                    className="relative flex items-center"
                  >
                    <Slider.Control className="relative flex w-full touch-none items-center py-4">
                      <Slider.Track className="relative h-2 w-full rounded-full bg-gray-300">
                        <Slider.Indicator className="absolute h-full rounded-full bg-blue-600" />
                        <Slider.Thumb
                          index={0}
                          className="block size-5 rounded-full bg-white border-2 border-blue-600 shadow-md cursor-grab active:cursor-grabbing focus:outline focus:outline-2 focus:outline-blue-600 focus:outline-offset-2"
                        />
                        <Slider.Thumb
                          index={1}
                          className="block size-5 rounded-full bg-white border-2 border-blue-600 shadow-md cursor-grab active:cursor-grabbing focus:outline focus:outline-2 focus:outline-blue-600 focus:outline-offset-2"
                        />
                      </Slider.Track>
                    </Slider.Control>
                  </Slider.Root>
                </Fieldset.Root>
                {!nightOverlapsCoverage && (
                  <p className="text-sm text-amber-700">
                    No night hours fall inside your coverage window, so night rules won't apply.
                  </p>
                )}
              </Field.Root>

              <Field.Root name="nightOnShift">
                <NumberField.Root
                  defaultValue={stdOnShift}
                  min={1}
                  max={numMembers || 64}
                  required={nightShifts}
                  className="flex flex-col gap-1"
                >
                  <Field.Label className="ui-label">
                    People Per Night Shift
                  </Field.Label>
                  <NumberField.Group className="flex">
                    <NumberField.Decrement className="flex size-10 items-center justify-center rounded-l-md border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 active:bg-gray-100">
                      <Minus className="size-4" />
                    </NumberField.Decrement>
                    <NumberField.Input className="h-10 w-32 border-t border-b border-gray-300 text-center text-base text-gray-900 tabular-nums focus:z-10 focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-blue-600" />
                    <NumberField.Increment className="flex size-10 items-center justify-center rounded-r-md border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 active:bg-gray-100">
                      <Plus className="size-4" />
                    </NumberField.Increment>
                  </NumberField.Group>
                </NumberField.Root>
                <Field.Error className="text-sm text-red-600" />
              </Field.Root>
            </div>
          )}

          {/* Admin Password */}
          <Field.Root name="adminPassword" className="flex flex-col gap-1">
            <Field.Label className="ui-label">
              Admin Password <span className="text-gray-500 font-normal">(Optional)</span>
            </Field.Label>
            <Field.Control
              type="password"
              placeholder="Leave blank for none"
              className="ui-input"
            />
            <p className="text-xs text-gray-600">
              Set a password if you want to restrict admin actions
            </p>
            <Field.Error className="text-sm text-red-600" />
          </Field.Root>

          {/* Error Message */}
          {errors.submit && (
            <div className="p-3 rounded-md bg-red-50 border border-red-200">
              <p className="text-sm text-red-600">{errors.submit}</p>
            </div>
          )}

          {/* Submit Button */}
          <Button
            disabled={loading}
            type="submit"
            className="ui-btn-primary h-11 px-6 active:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 focus-visible:outline-offset-2 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating Group...' : 'Create Group'}
          </Button>
        </Form>
      </div>
    </div>
  );
}
