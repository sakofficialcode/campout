import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import ScheduleResults from '../components/ScheduleResults';
import type { InteractiveConfig } from '../components/ScheduleResults';
import SwapRequestsPanel from '../components/SwapRequestsPanel';
import { coverageFromGroup } from '../lib/coverage';
import { ApiError, createSwapRequest, getConflicts, getGroup, listSwapRequests, viewScheduleAsMember } from '../lib/api';
import type { GroupConfig, ScheduleResult, SwapRequest } from '../lib/types';

function storageKey(uuid: string) {
  return `campout:lastName:${uuid}`;
}

export default function SchedulePage() {
  const { uuid = '' } = useParams<{ uuid: string }>();

  const [group, setGroup] = React.useState<GroupConfig | null>(null);
  const [groupError, setGroupError] = React.useState<string | null>(null);

  const [memberName, setMemberName] = React.useState('');
  const [memberPassword, setMemberPassword] = React.useState('');
  const [loggedIn, setLoggedIn] = React.useState<{ name: string; password: string } | null>(null);

  const [result, setResult] = React.useState<ScheduleResult | null>(null);
  const [requests, setRequests] = React.useState<{ incoming: SwapRequest[]; outgoing: SwapRequest[] }>({
    incoming: [],
    outgoing: [],
  });

  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = React.useState<SwapRequest | null>(null);

  React.useEffect(() => {
    getGroup(uuid).then(setGroup).catch((err) => setGroupError(err instanceof Error ? err.message : 'Failed to load group'));
  }, [uuid]);

  React.useEffect(() => {
    const savedName = localStorage.getItem(storageKey(uuid));
    if (savedName) setMemberName(savedName);
  }, [uuid]);

  const refreshData = React.useCallback(
    async (name: string, password: string) => {
      // Authenticate first, so a wrong password surfaces as a login error
      // instead of being swallowed by the "no schedule yet" case below.
      const requestResult = await listSwapRequests(uuid, name, password);
      setRequests(requestResult);

      try {
        setResult(await viewScheduleAsMember(uuid, name, password));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setResult(null);
        } else {
          throw err;
        }
      }
    },
    [uuid]
  );

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = memberName.trim();
    if (!trimmed || !memberPassword) return;

    setLoading(true);
    setError(null);
    try {
      await refreshData(trimmed, memberPassword);
      setLoggedIn({ name: trimmed, password: memberPassword });
      localStorage.setItem(storageKey(uuid), trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const handleChanged = React.useCallback(() => {
    if (loggedIn) refreshData(loggedIn.name, loggedIn.password).catch(() => {});
  }, [loggedIn, refreshData]);

  const interactive: InteractiveConfig | undefined = React.useMemo(() => {
    if (!loggedIn || !group) return undefined;
    return {
      viewerName: loggedIn.name,
      otherMembers: group.members.map((m) => m.memberName).filter((n) => n !== loggedIn.name),
      snapMinutes: group.timeGranularity,
      fetchConflicts: (start, end) =>
        getConflicts(uuid, start, end, { memberName: loggedIn.name, password: loggedIn.password }),
      onSubmit: async (proposal) => {
        await createSwapRequest(uuid, {
          fromMember: loggedIn.name,
          fromPassword: loggedIn.password,
          toMember: proposal.toMember,
          fromStart: proposal.fromStart,
          fromEnd: proposal.fromEnd,
          toStart: proposal.toStart,
          toEnd: proposal.toEnd,
          message: proposal.message,
        });
        handleChanged();
      },
    };
  }, [loggedIn, group, uuid, handleChanged]);

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

  return (
    <div className="ui-page">
      <div className="ui-page-content">
        <div className="ui-card">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{group.groupName} — Schedule</h1>
              <Link to={`/${uuid}`} className="text-sm text-blue-600 hover:underline">
                &larr; Back to scheduler
              </Link>
            </div>
          </div>

          {!loggedIn && (
            <form onSubmit={handleLogin} className="mt-4 flex flex-wrap items-end gap-4">
              <div className="max-w-xs">
                <label className="ui-label">Your Name</label>
                <input
                  type="text"
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  className="ui-input"
                />
              </div>
              <div className="max-w-xs">
                <label className="ui-label">Password</label>
                <input
                  type="password"
                  value={memberPassword}
                  onChange={(e) => setMemberPassword(e.target.value)}
                  className="ui-input"
                />
              </div>
              <button
                type="submit"
                disabled={loading || !memberName.trim() || !memberPassword}
                className="ui-btn-primary"
              >
                {loading ? 'Loading...' : 'View Schedule'}
              </button>
            </form>
          )}

          {error && (
            <div className="ui-banner-error">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}
        </div>

        {loggedIn && (
          <>
            <div className="ui-card">
              {result ? (
                <ScheduleResults
                  result={result}
                  interactive={interactive}
                  previewRequest={previewRequest}
                  coverage={coverageFromGroup(group)}
                />
              ) : (
                <p className="text-sm text-gray-500">No schedule has been generated yet.</p>
              )}
            </div>

            <div className="ui-card">
              <h2 className="text-lg font-bold text-gray-900 mb-4">Swap Requests</h2>
              <SwapRequestsPanel
                uuid={uuid}
                loggedInName={loggedIn.name}
                loggedInPassword={loggedIn.password}
                incoming={requests.incoming}
                outgoing={requests.outgoing}
                onChanged={handleChanged}
                onPreview={setPreviewRequest}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
