import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import ScheduleResults from '../components/ScheduleResults';
import CoverageEditor from '../components/CoverageEditor';
import {
  ApiError,
  assignShift,
  generateSchedule,
  getConflicts,
  getGroup,
  reassignShift,
  removeMember,
  updateGroupCoverage,
  updateGroupSize,
  viewSchedule,
} from '../lib/api';
import type { AdminEditConfig } from '../components/ScheduleResults';
import { addsHours, coverageFromGroup, totalCoveredHours, type Coverage } from '../lib/coverage';
import type { GroupConfig, ScheduleResult } from '../lib/types';

function formatUpdatedAt(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function AdminPage() {
  const { uuid = '' } = useParams<{ uuid: string }>();

  const [group, setGroup] = React.useState<GroupConfig | null>(null);
  const [groupError, setGroupError] = React.useState<string | null>(null);

  const [password, setPassword] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [scheduleError, setScheduleError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ScheduleResult | null>(null);

  const [sizeInput, setSizeInput] = React.useState('');
  const [membersBusy, setMembersBusy] = React.useState(false);
  const [membersError, setMembersError] = React.useState<string | null>(null);
  const [membersNotice, setMembersNotice] = React.useState<string | null>(null);

  const [coverageDraft, setCoverageDraft] = React.useState<Coverage | null>(null);
  const [coverageBusy, setCoverageBusy] = React.useState(false);
  const [coverageError, setCoverageError] = React.useState<string | null>(null);
  const [coverageNotice, setCoverageNotice] = React.useState<string | null>(null);

  const loadGroup = React.useCallback(async () => {
    const fresh = await getGroup(uuid);
    setGroup(fresh);
    setSizeInput(String(fresh.numMembers));
    return fresh;
  }, [uuid]);

  React.useEffect(() => {
    loadGroup()
      .then((fresh) => setCoverageDraft(coverageFromGroup(fresh)))
      .catch((err) => setGroupError(err instanceof Error ? err.message : 'Failed to load group'));
  }, [loadGroup]);

  const adminPassword = group?.hasAdminPassword ? password : null;

  // Show the saved schedule without a separate "view" click: straight away for
  // open groups, and once the right admin password is typed for protected
  // ones. Only fills an empty view — never replaces one on screen.
  const [autoLoad, setAutoLoad] = React.useState<'pending' | 'none' | 'denied'>('pending');
  const hasAdminPassword = group?.hasAdminPassword;
  React.useEffect(() => {
    if (hasAdminPassword === undefined || result) return;
    if (hasAdminPassword && !password) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        viewSchedule(uuid, hasAdminPassword ? password : null)
          .then((saved) => !cancelled && setResult((current) => current ?? saved))
          // 404 = nothing generated yet; 403 = password still being typed or wrong.
          .catch((err) => !cancelled && setAutoLoad(err instanceof ApiError && err.status === 403 ? 'denied' : 'none'));
      },
      hasAdminPassword ? 400 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [uuid, hasAdminPassword, password, result]);

  const runMemberAction = async (action: () => Promise<unknown>, notice: string) => {
    setMembersBusy(true);
    setMembersError(null);
    setMembersNotice(null);
    try {
      await action();
      await loadGroup();
      setMembersNotice(notice);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setMembersBusy(false);
    }
  };

  const handleSaveSize = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(sizeInput);
    runMemberAction(() => updateGroupSize(uuid, n, adminPassword), `Group size set to ${n}.`);
  };

  const handleSaveCoverage = async () => {
    setCoverageBusy(true);
    setCoverageError(null);
    setCoverageNotice(null);
    try {
      await updateGroupCoverage(uuid, coverageDraft?.start ?? null, coverageDraft?.end ?? null, adminPassword);
      const fresh = await loadGroup();
      setCoverageDraft(coverageFromGroup(fresh));
      setCoverageNotice('Hours updated. Regenerate the schedule to apply them.');
    } catch (err) {
      setCoverageError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setCoverageBusy(false);
    }
  };

  const handleRemove = (memberName: string) => {
    if (!window.confirm(`Remove ${memberName} from the group? Their availability will be deleted.`)) return;
    runMemberAction(
      () => removeMember(uuid, memberName, adminPassword),
      `Removed ${memberName}. Regenerate the schedule to take them off it.`
    );
  };

  const run = async (action: (uuid: string, password: string | null) => Promise<ScheduleResult>) => {
    if (
      result &&
      !window.confirm('Regenerate the schedule? This replaces the current one, including any manual reassignments.')
    ) {
      return;
    }
    setLoading(true);
    setScheduleError(null);
    try {
      setResult(await action(uuid, adminPassword));
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  if (groupError) {
    return (
      <div className="ui-page-centered">
        <p className="text-red-600">{groupError}</p>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="ui-page-centered">
        <p className="text-gray-500">Loading group...</p>
      </div>
    );
  }

  const submittedCount = group.members.length;

  // Direct schedule edits. Each reassign returns the saved schedule, which
  // replaces what's shown, so the view never drifts from the server.
  const adminEdit: AdminEditConfig = {
    members: group.members.map((m) => m.memberName),
    snapMinutes: group.timeGranularity,
    fetchConflicts: (start, end) => getConflicts(uuid, start, end, { adminPassword }),
    onReassign: async (fromMember, toMember, start, end) => {
      setResult(await reassignShift(uuid, adminPassword, fromMember, toMember, start, end));
    },
    onAssign: async (toMember, start, end) => {
      setResult(await assignShift(uuid, adminPassword, toMember, start, end));
    },
  };
  const minForShifts = Math.max(group.stdOnShift, group.nightShifts ? group.nightOnShift ?? 0 : 0);
  const minSize = Math.max(1, submittedCount, minForShifts);
  const isFull = submittedCount >= group.numMembers;

  const savedCoverage = coverageFromGroup(group);
  const coverageChanged =
    (savedCoverage?.start ?? null) !== (coverageDraft?.start ?? null) ||
    (savedCoverage?.end ?? null) !== (coverageDraft?.end ?? null);
  const coverageInvalid = coverageDraft !== null && coverageDraft.start === coverageDraft.end;
  const widening = coverageChanged && submittedCount > 0 && addsHours(savedCoverage, coverageDraft);
  const draftTotalHours = totalCoveredHours(group.shiftStart, group.shiftEnd, coverageDraft);
  const night =
    group.nightShifts && group.nightShiftStart != null && group.nightShiftEnd != null
      ? { start: group.nightShiftStart, end: group.nightShiftEnd }
      : null;

  return (
    <div className="ui-page">
      <div className="ui-page-content">
        <div className="ui-card">
          <h1 className="text-2xl font-bold text-gray-900">{group.groupName} — Admin</h1>
          <Link to={`/${uuid}`} className="text-sm text-blue-600 hover:underline">
            &larr; Back to scheduler
          </Link>

          {group.hasAdminPassword && (
            <div className="mt-4">
              <label className="ui-label">Admin Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="ui-input max-w-xs"
              />
              <p className="mt-1 text-xs text-gray-500">Needed to change members, group size, or the schedule.</p>
            </div>
          )}
        </div>

        <div className="ui-card">
          <h2 className="text-lg font-bold text-gray-900 mb-1">Members</h2>
          <p className="text-sm text-gray-600 mb-4">
            {submittedCount} of {group.numMembers} members have joined and submitted availability.
            {isFull && " The group is full — new people can't join until you raise the size or remove someone."}
          </p>

          <form onSubmit={handleSaveSize} className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="ui-label">Group Size</label>
              <input
                type="number"
                min={minSize}
                max={64}
                step={1}
                value={sizeInput}
                onChange={(e) => setSizeInput(e.target.value)}
                className="ui-input w-28"
              />
            </div>
            <button
              type="submit"
              disabled={membersBusy || !sizeInput || Number(sizeInput) === group.numMembers}
              className="ui-btn-secondary"
            >
              Save Size
            </button>
          </form>
          {submittedCount > minForShifts && (
            <p className="-mt-2 mb-4 text-xs text-gray-500">
              To go below {submittedCount}, remove members first.
            </p>
          )}

          {membersError && (
            <div className="ui-banner-error mb-4">
              <p className="text-sm text-red-600">{membersError}</p>
            </div>
          )}
          {membersNotice && <p className="mb-4 text-sm text-green-700">{membersNotice}</p>}

          {submittedCount === 0 ? (
            <p className="text-sm text-gray-500">No one has submitted yet.</p>
          ) : (
            <ul className="divide-y divide-gray-200 border border-gray-200 rounded-md overflow-hidden">
              {group.members.map((member) => (
                <li key={member.memberName} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="font-medium text-gray-900">{member.memberName}</span>
                  <span className="flex items-center gap-4">
                    <span className="text-gray-500">Updated {formatUpdatedAt(member.updatedAt)}</span>
                    <button
                      type="button"
                      disabled={membersBusy}
                      onClick={() => handleRemove(member.memberName)}
                      className="text-red-600 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ui-card">
          <h2 className="text-lg font-bold text-gray-900 mb-1">Coverage Hours</h2>
          <p className="text-sm text-gray-600 mb-4">When shifts need someone on, every day of the event.</p>

          <CoverageEditor
            value={coverageDraft}
            onChange={(next) => {
              setCoverageDraft(next);
              setCoverageNotice(null);
            }}
            night={night}
            extraSummary={draftTotalHours != null ? `~${Math.round(draftTotalHours)} h total` : undefined}
            disabled={coverageBusy}
          />

          {widening && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              This adds hours members haven't seen. They'll count as available for the new hours until they update their
              availability. They'll be asked to review it next time they log in.
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSaveCoverage}
              disabled={coverageBusy || !coverageChanged || coverageInvalid}
              className="ui-btn-secondary"
            >
              {coverageBusy ? 'Saving...' : 'Save Hours'}
            </button>
            {coverageChanged && !coverageBusy && (
              <button
                type="button"
                onClick={() => setCoverageDraft(savedCoverage)}
                className="text-sm text-gray-600 hover:underline"
              >
                Reset
              </button>
            )}
          </div>

          {coverageError && (
            <div className="ui-banner-error">
              <p className="text-sm text-red-600">{coverageError}</p>
            </div>
          )}
          {coverageNotice && <p className="mt-3 text-sm text-green-700">{coverageNotice}</p>}
        </div>

        <div className="ui-card">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Schedule</h2>

          <div className="flex flex-wrap items-center gap-3">
            <button disabled={loading} onClick={() => run(generateSchedule)} className="ui-btn-primary">
              {loading ? 'Working...' : result ? 'Regenerate Schedule' : 'Generate Schedule'}
            </button>
            {!result && group.hasAdminPassword && !password && (
              <span className="text-sm text-gray-500">Enter the admin password above to see the current schedule.</span>
            )}
            {!result && autoLoad === 'none' && <span className="text-sm text-gray-500">No schedule yet.</span>}
            {!result && autoLoad === 'denied' && password && (
              <span className="text-sm text-red-600">That admin password doesn&rsquo;t match.</span>
            )}
          </div>

          {scheduleError && (
            <div className="ui-banner-error">
              <p className="text-sm text-red-600">{scheduleError}</p>
            </div>
          )}

          <p className="mt-4 text-sm text-gray-600">
            Members can view the schedule and suggest swaps by logging in on the{' '}
            <Link to={`/${uuid}/schedule`} className="text-blue-600 hover:underline">
              schedule page
            </Link>
            .
          </p>
        </div>

        {result && (
          <div className="ui-card">
            <ScheduleResults
              result={result}
              memberNames={group.members.map((m) => m.memberName)}
              coverage={savedCoverage}
              adminEdit={adminEdit}
            />
          </div>
        )}
      </div>
    </div>
  );
}
