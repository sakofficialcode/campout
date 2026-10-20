import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import ScheduleResults from '../components/ScheduleResults';
import { generateSchedule, getGroup, viewSchedule } from '../lib/api';
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

  React.useEffect(() => {
    getGroup(uuid)
      .then(setGroup)
      .catch((err) => setGroupError(err instanceof Error ? err.message : 'Failed to load group'));
  }, [uuid]);

  const run = async (action: (uuid: string, password: string | null) => Promise<ScheduleResult>) => {
    setLoading(true);
    setScheduleError(null);
    try {
      setResult(await action(uuid, group?.hasAdminPassword ? password : null));
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

  return (
    <div className="ui-page">
      <div className="ui-page-content">
        <div className="ui-card">
          <h1 className="text-2xl font-bold text-gray-900">{group.groupName} — Admin</h1>
          <Link to={`/${uuid}`} className="text-sm text-blue-600 hover:underline">
            &larr; Back to scheduler
          </Link>
        </div>

        <div className="ui-card">
          <h2 className="text-lg font-bold text-gray-900 mb-1">Submissions</h2>
          <p className="text-sm text-gray-600 mb-4">
            {submittedCount} of {group.numMembers} members have submitted availability.
          </p>

          {submittedCount === 0 ? (
            <p className="text-sm text-gray-500">No one has submitted yet.</p>
          ) : (
            <ul className="divide-y divide-gray-200 border border-gray-200 rounded-md overflow-hidden">
              {group.members.map((member) => (
                <li key={member.memberName} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="font-medium text-gray-900">{member.memberName}</span>
                  <span className="text-gray-500">Updated {formatUpdatedAt(member.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ui-card">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Schedule</h2>

          {group.hasAdminPassword && (
            <div className="mb-4">
              <label className="ui-label">Admin Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="ui-input max-w-xs"
              />
            </div>
          )}

          <div className="flex gap-3">
            <button disabled={loading} onClick={() => run(generateSchedule)} className="ui-btn-primary">
              {loading ? 'Working...' : 'Generate Schedule'}
            </button>
            <button disabled={loading} onClick={() => run(viewSchedule)} className="ui-btn-secondary">
              View Last Schedule
            </button>
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
            <ScheduleResults result={result} memberNames={group.members.map((m) => m.memberName)} />
          </div>
        )}
      </div>
    </div>
  );
}
