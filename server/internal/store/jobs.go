package store

import (
	"context"
	"database/sql"
	"errors"
)

func enqueue(ctx context.Context, tx *sql.Tx, videoID string) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO jobs (video_id, state, attempts, updated_at) VALUES (?, 'queued', 0, ?)
		ON CONFLICT(video_id) DO UPDATE SET state = 'queued', attempts = 0, updated_at = excluded.updated_at`, videoID, now()); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE videos SET status = ?, error = '' WHERE id = ?`, StatusProcessing, videoID)
	return err
}

// Enqueue (re)schedules processing for a video.
func (s *Store) Enqueue(ctx context.Context, videoID string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var one int
		if err := tx.QueryRowContext(ctx, `SELECT 1 FROM videos WHERE id = ?`, videoID).Scan(&one); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		return enqueue(ctx, tx, videoID)
	})
}

// ClaimJob atomically takes the oldest queued job.
func (s *Store) ClaimJob(ctx context.Context) (string, bool, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ?
		WHERE video_id = (SELECT video_id FROM jobs WHERE state = 'queued' ORDER BY updated_at LIMIT 1)
		RETURNING video_id`, now()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return id, err == nil, err
}

// Requeue puts a failed job back in the queue unless it has used up its attempts.
func (s *Store) Requeue(ctx context.Context, videoID string, maxAttempts int) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE jobs SET state = 'queued', updated_at = ? WHERE video_id = ? AND attempts < ?`,
		now(), videoID, maxAttempts)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ResetRunning requeues jobs interrupted by a restart.
func (s *Store) ResetRunning(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE jobs SET state = 'queued' WHERE state = 'running'`)
	return err
}

type JobCounts struct {
	Queued  int `json:"queued"`
	Running int `json:"running"`
	Failed  int `json:"failed"`
}

func (s *Store) JobCounts(ctx context.Context) (JobCounts, error) {
	var c JobCounts
	err := s.db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(state = 'queued'), 0), COALESCE(SUM(state = 'running'), 0), COALESCE(SUM(state = 'failed'), 0)
		FROM jobs`).Scan(&c.Queued, &c.Running, &c.Failed)
	return c, err
}
