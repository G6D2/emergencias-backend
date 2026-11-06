ALTER TABLE outbox_events
    ADD COLUMN payload_hash TEXT,
    ADD COLUMN gateway_event_id UUID;
