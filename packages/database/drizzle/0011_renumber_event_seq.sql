-- HeoPress P04: events written before the position columns existed all got
-- the migration's transaction id and a sequence number in physical order.
-- Renumber them in the order readers used until now — (occurred_at, id) —
-- so their order is kept. Events written from here on get increasing numbers.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY occurred_at, id) AS n
    FROM lumibase_cdc_change_events
)
UPDATE lumibase_cdc_change_events e
   SET seq = o.n
  FROM ordered o
 WHERE e.id = o.id;
--> statement-breakpoint
SELECT setval(
  'lumibase_cdc_change_events_seq',
  greatest((SELECT max(seq) FROM lumibase_cdc_change_events), 1),
  (SELECT count(*) > 0 FROM lumibase_cdc_change_events)
);
