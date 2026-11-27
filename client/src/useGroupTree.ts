import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, type GroupTree } from './api';

/** The whole folder tree comes in ONE request (no per-level requests, no document counts: those were the slow part).
 *  Every query key starts with 'groups', so invalidating ['groups'] reloads it; the old tree stays visible while it reloads. */
export function useGroupTree(lang: string) {
  const q = useQuery({ queryKey: ['groups', lang], queryFn: () => api.groups(lang, false), enabled: !!lang, staleTime: 60_000, placeholderData: keepPreviousData });
  const data: GroupTree | undefined = useMemo(() => q.data && ({ ...q.data, total: 0, expired: 0, groups: q.data.groups.map(g => ({ ...g, docCount: 0 })) }), [q.data]);
  return { data, isLoading: q.isLoading, isError: q.isError, complete: !!q.data, countsLoading: false };
}
