import { useCallback, useEffect, useRef, useState } from 'react';
import { studioApi, type StreamEvent } from '../api';

/**
 * The live event stream (HeoPress P07a task 11.7; spec studio/monitoring "事件流视图"): the first page, then every 5
 * seconds what came since the newest event (the server looks back 60 seconds; duplicates are dropped by id). Paused, new
 * events wait aside; resuming merges them in time order and keeps the selection.
 */

const POLL_MS = 5000;

const newestFirst = (a: StreamEvent, b: StreamEvent) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1);

/** `existing` plus what of `incoming` it does not have, newest first. */
export function mergeEvents(existing: readonly StreamEvent[], incoming: readonly StreamEvent[]): StreamEvent[] {
  const seen = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id) && seen.add(e.id));
  return fresh.length ? [...existing, ...fresh].sort(newestFirst) : [...existing];
}

export interface StreamFilter {
  levels: string[];
  sources: string[];
  q: string;
}

export function queryOf(filter: StreamFilter, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (filter.levels.length) p.set('level', filter.levels.join(','));
  if (filter.sources.length) p.set('source', filter.sources.join(','));
  if (filter.q.trim()) p.set('q', filter.q.trim());
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useEventStream(filter: StreamFilter, pollMs = POLL_MS) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [waiting, setWaiting] = useState<StreamEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  // The first page failed (offline, rate limited): shown as a failure, not as "no event matches", until a retry works.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [earliest, setEarliest] = useState<string | null>(null);
  const [earliestBySource, setEarliestBySource] = useState<Record<string, string>>({});
  const key = queryOf(filter);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailed(false);
    setEvents([]);
    setWaiting([]);
    void studioApi.events(queryOf(filterRef.current, { limit: '50' })).then(
      (res) => {
        if (!live) return;
        setEvents(res.data);
        setCursor(res.meta?.nextCursor ?? null);
        setEarliest(res.meta?.earliest ?? null);
        setEarliestBySource(res.meta?.earliestBySource ?? {});
        setLoading(false);
      },
      () => {
        if (!live) return;
        setFailed(true);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);

  useEffect(() => {
    const tick = async () => {
      const newest = [...eventsRef.current, ...waitingRef.current].sort(newestFirst)[0];
      const since = newest?.at ?? new Date(Date.now() - pollMs).toISOString();
      try {
        const res = await studioApi.events(queryOf(filterRef.current, { since, limit: '200' }));
        if (pausedRef.current) setWaiting((w) => mergeEvents(w, res.data.filter((e) => !eventsRef.current.some((x) => x.id === e.id))));
        else setEvents((list) => mergeEvents(list, res.data));
      } catch {
        // Next tick tries again.
      }
    };
    const timer = window.setInterval(() => void tick(), pollMs);
    return () => window.clearInterval(timer);
  }, [key, pollMs]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => {
    setEvents((list) => mergeEvents(list, waitingRef.current));
    setWaiting([]);
    setPaused(false);
  }, []);
  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const res = await studioApi.events(queryOf(filterRef.current, { cursor, limit: '50' }));
    setEvents((list) => mergeEvents(list, res.data));
    setCursor(res.meta?.nextCursor ?? null);
  }, [cursor]);

  return { events, waiting: waiting.length, paused, pause, resume, loading, failed, retry, loadMore, hasMore: !!cursor, earliest, earliestBySource };
}
