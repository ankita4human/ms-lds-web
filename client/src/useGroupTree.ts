import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type GroupNode, type GroupTree } from './api';

/** Group tree that fills in step by step:
 *  1. the main groups appear first,
 *  2. each lower level is fetched in the background (a few requests at a time) and added as it arrives,
 *  3. the document counts load separately (slow on big databases) and fill in when ready.
 *  `complete` turns true when every level is there. Every query key starts with 'groups', so invalidating ['groups']
 *  reloads everything; on a refresh the old tree stays visible until the new one is ready. */
export function useGroupTree(lang: string) {
  const root = useQuery({ queryKey: ['groups', lang], queryFn: () => api.groupLevel(lang, 0), enabled: !!lang });
  const counts = useQuery({ queryKey: ['groups', 'counts', lang], queryFn: () => api.groupCounts(lang), enabled: !!root.data });
  const [lower, setLower] = useState<GroupNode[]>([]);
  const [done, setDone] = useState(false);
  const shownLang = useRef('');

  useEffect(() => {
    const r = root.data; if (!r) return;
    let dead = false;
    const fresh = shownLang.current !== lang;            // language change: start empty; refresh: swap when finished
    shownLang.current = lang;
    if (fresh) setLower([]);
    setDone(false);
    (async () => {
      const acc: GroupNode[] = [];
      let queue = r.groups.filter(g => g.hasChildren).map(g => g.idGroup);
      try {
        while (queue.length && !dead) {
          const batch = queue.splice(0, 6);
          const res = await Promise.all(batch.map(id => api.groupLevel(lang, id)));
          if (dead) return;
          const add = res.flatMap(x => x.groups);
          acc.push(...add);
          queue = queue.concat(add.filter(g => g.hasChildren).map(g => g.idGroup));
          if (fresh) setLower([...acc]);                 // show each level as soon as it arrives
        }
      } catch { /* the levels loaded so far stay visible */ }
      if (dead) return;
      if (!fresh) setLower(acc);
      setDone(true);
    })();
    return () => { dead = true; };
  }, [root.dataUpdatedAt, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const data: GroupTree | undefined = useMemo(() => root.data && ({
    ...root.data,
    total: counts.data?.total ?? 0, expired: counts.data?.expired ?? 0,
    groups: [...root.data.groups, ...lower].map(g => ({ ...g, docCount: counts.data?.counts[g.idGroup] ?? 0 })),
  }), [root.data, lower, counts.data]);
  return { data, isLoading: root.isLoading, isError: root.isError, complete: done && !!root.data, countsLoading: !counts.data && !counts.isError };
}
