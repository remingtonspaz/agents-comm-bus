-- AGE-101: durable process-owner start epoch for pid+start-time liveness.
ALTER TABLE sessions ADD COLUMN lease_owner_process_start_time INTEGER;
