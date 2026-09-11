ALTER TABLE outbox_events
    DROP CONSTRAINT outbox_events_status_check,
    ADD CONSTRAINT outbox_events_status_check
      CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));

CREATE INDEX idx_outbox_events_published_created_at
    ON outbox_events (created_at)
    WHERE status = 'PUBLISHED';