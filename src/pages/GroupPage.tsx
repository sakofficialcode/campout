import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import WeekScheduler from './WeekScheduler';
import { getGroup, loginMember, saveMemberAvailability } from '../lib/api';
import type { AvailabilityMap, GroupConfig } from '../lib/types';
import { coverageFromGroup, coverageLabel } from '../lib/coverage';

function storageKey(uuid: string) {
  return `campout:lastName:${uuid}`;
}

type AuthStatus = 'idle' | 'checking' | 'existing' | 'new' | 'full' | 'invalid';

export default function GroupPage() {
  const { uuid = '' } = useParams<{ uuid: string }>();

  const [group, setGroup] = React.useState<GroupConfig | null>(null);
  const [groupError, setGroupError] = React.useState<string | null>(null);

  const [memberName, setMemberName] = React.useState('');
  const [memberPassword, setMemberPassword] = React.useState('');
  const [authStatus, setAuthStatus] = React.useState<AuthStatus>('idle');
  const [authError, setAuthError] = React.useState<string | null>(null);

  const [loadedAvailability, setLoadedAvailability] = React.useState<AvailabilityMap>({});
  const [currentAvailability, setCurrentAvailability] = React.useState<AvailabilityMap>({});
  const [memberUpdatedAt, setMemberUpdatedAt] = React.useState<string | null>(null);

  const [saveStatus, setSaveStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);

  React.useEffect(() => {
    getGroup(uuid)
      .then(setGroup)
      .catch((err) => setGroupError(err instanceof Error ? err.message : 'Failed to load group'));
  }, [uuid]);

  React.useEffect(() => {
    const savedName = localStorage.getItem(storageKey(uuid));
    if (savedName) setMemberName(savedName);
  }, [uuid]);

  // A name with no account yet is reported as such, so the scheduler can create
  // one on submit rather than silently exposing someone else's data.
  const attemptLogin = async (name: string, password: string) => {
    const trimmed = name.trim();
    if (!trimmed || !password) return;

    setAuthStatus('checking');
    setAuthError(null);
    try {
      const member = await loginMember(uuid, trimmed, password);
      if (member) {
        setLoadedAvailability(member.availability);
        setCurrentAvailability(member.availability);
        setMemberUpdatedAt(member.updatedAt);
        setAuthStatus('existing');
      } else {
        // Re-fetch so the full check uses the live member count, not the one
        // from page load. The server enforces this too on submit.
        const fresh = await getGroup(uuid);
        setGroup(fresh);
        setLoadedAvailability({});
        setCurrentAvailability({});
        setMemberUpdatedAt(null);
        setAuthStatus(fresh.members.length >= fresh.numMembers ? 'full' : 'new');
      }
      localStorage.setItem(storageKey(uuid), trimmed);
    } catch (err) {
      setAuthStatus('invalid');
      setAuthError(err instanceof Error ? err.message : 'Failed to verify password');
    }
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMemberName(e.target.value);
    setAuthStatus('idle');
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMemberPassword(e.target.value);
    setAuthStatus('idle');
  };

  const handleContinue = (e: React.FormEvent) => {
    e.preventDefault();
    attemptLogin(memberName, memberPassword);
  };

  const handleSubmit = async () => {
    const trimmed = memberName.trim();
    if (!trimmed || !memberPassword) return;

    setSaveStatus('saving');
    setSaveError(null);
    try {
      const saved = await saveMemberAvailability(uuid, trimmed, currentAvailability, memberPassword);
      setMemberUpdatedAt(saved.updatedAt);
      setAuthStatus('existing');
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : 'Failed to save availability');
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

  const unlocked = authStatus === 'existing' || authStatus === 'new';
  const coverage = coverageFromGroup(group);
  // Hours were changed after this member last submitted — any newly added
  // hours default to "available" until they look.
  const hoursChangedSinceSubmit =
    authStatus === 'existing' &&
    group.coverageUpdatedAt != null &&
    memberUpdatedAt != null &&
    memberUpdatedAt < group.coverageUpdatedAt;

  return (
    <div className="ui-page">
      <div className="ui-page-content">
        <div className="ui-card">
          <div className="flex items-start justify-between">
            <h1 className="text-2xl font-bold text-gray-900">{group.groupName}</h1>
            <div className="flex items-center gap-4">
              <Link to={`/${uuid}/schedule`} className="text-sm text-blue-600 hover:underline">
                Schedule
              </Link>
              <Link to={`/${uuid}/admin`} className="text-sm text-blue-600 hover:underline">
                Admin
              </Link>
            </div>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            {group.members.length} of {group.numMembers} joined &middot; {group.stdOnShift} per shift
            {group.nightShifts ? ` (${group.nightOnShift} at night)` : ''}
            {coverage && <> &middot; {coverageLabel(coverage)}</>}
          </p>

          <form onSubmit={handleContinue} className="mt-4 flex flex-wrap items-end gap-4">
            <div className="max-w-xs">
              <label className="ui-label">Your Name</label>
              <input
                type="text"
                value={memberName}
                onChange={handleNameChange}
                placeholder="Enter your name"
                className="ui-input"
              />
            </div>
            <div className="max-w-xs">
              <label className="ui-label">Password</label>
              <input
                type="password"
                value={memberPassword}
                onChange={handlePasswordChange}
                placeholder="New here? Just pick one"
                className="ui-input"
              />
            </div>
            <button
              type="submit"
              disabled={!memberName.trim() || !memberPassword || authStatus === 'checking'}
              className="ui-btn-primary"
            >
              {authStatus === 'checking' ? 'Checking...' : 'Continue'}
            </button>
          </form>

          {authStatus === 'checking' && <p className="mt-2 text-sm text-gray-500">Checking...</p>}
          {authStatus === 'new' && (
            <p className="mt-2 text-sm text-blue-700">
              No account yet for this name — submitting availability will create one with this password.
            </p>
          )}
          {authStatus === 'full' && (
            <p className="mt-2 text-sm text-red-600">
              This group is full ({group.numMembers} of {group.numMembers} members). Ask the group admin to make room
              for you, or check that your name matches the one you joined with.
            </p>
          )}
          {authStatus === 'existing' && <p className="mt-2 text-sm text-green-700">Welcome back, {memberName.trim()}.</p>}
          {hoursChangedSinceSubmit && (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              The group's hours changed since you last submitted — please review your availability and submit again.
            </p>
          )}
          {authStatus === 'invalid' && <p className="mt-2 text-sm text-red-600">{authError}</p>}
        </div>

        {unlocked ? (
          <>
            <div className="ui-card !p-0 overflow-hidden">
              <WeekScheduler
                key={memberName.trim() || 'anonymous'}
                slotMinutes={group.timeGranularity}
                initialAvailability={loadedAvailability}
                initialStartDateTime={group.shiftStart}
                initialEndDateTime={group.shiftEnd}
                onAvailabilityChange={setCurrentAvailability}
                nightShifts={group.nightShifts}
                nightShiftStart={group.nightShiftStart}
                nightShiftEnd={group.nightShiftEnd}
                coverageStart={group.coverageStart}
                coverageEnd={group.coverageEnd}
              />
            </div>

            <div className="ui-card flex items-center justify-between">
              <div>
                {saveStatus === 'saved' && <p className="text-sm text-green-600">Availability saved.</p>}
                {saveStatus === 'error' && <p className="text-sm text-red-600">{saveError}</p>}
              </div>
              <button
                disabled={saveStatus === 'saving'}
                onClick={handleSubmit}
                className="ui-btn-primary h-11 px-6"
              >
                {saveStatus === 'saving' ? 'Saving...' : 'Submit Availability'}
              </button>
            </div>
          </>
        ) : (
          <div className="ui-card flex items-center justify-center text-center py-16">
            <p className="text-sm text-gray-500">
              Enter your name and password above, then hit Continue to load the calendar.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
