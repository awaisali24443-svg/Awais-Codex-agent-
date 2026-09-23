-- 016_breakage_alerts.sql — the breakage alert send log.
--
-- One row per incident type per Asia/Karachi calendar day an alert was
-- attempted. The alert claims its (alert_type, alert_day) with
-- INSERT ... ON CONFLICT DO NOTHING *before* sending, so even a restart
-- between ticks can never produce a second message for the same incident and
-- day. A failed send still claims the day: one alert per incident, never
-- retry spam. The owner's standing boundary is anti-spam, and this table is
-- how it is enforced.
CREATE TABLE IF NOT EXISTS breakage_alert_log (
  alert_type text NOT NULL,
  alert_day  date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  detail     text,
  PRIMARY KEY (alert_type, alert_day)
);
