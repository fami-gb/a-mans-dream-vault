// Package store holds all SQLite access.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

// ValidationError is returned for bad input and maps to HTTP 400.
type ValidationError struct{ Msg string }

func (e ValidationError) Error() string { return e.Msg }

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

var migrations = []string{
	`CREATE TABLE folders (
		id TEXT PRIMARY KEY,
		parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
		name TEXT NOT NULL,
		sort_order INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);
	CREATE UNIQUE INDEX folders_parent_name ON folders(COALESCE(parent_id, ''), name);
	CREATE TABLE videos (
		id TEXT PRIMARY KEY,
		folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
		title TEXT NOT NULL,
		src_root TEXT NOT NULL,
		src_rel TEXT NOT NULL,
		play_root TEXT NOT NULL DEFAULT '',
		play_rel TEXT NOT NULL DEFAULT '',
		size_bytes INTEGER NOT NULL DEFAULT 0,
		fingerprint TEXT NOT NULL DEFAULT '',
		duration_ms INTEGER NOT NULL DEFAULT 0,
		width INTEGER NOT NULL DEFAULT 0,
		height INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		error TEXT NOT NULL DEFAULT '',
		missing INTEGER NOT NULL DEFAULT 0,
		media_v INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		trashed_at INTEGER
	);
	CREATE UNIQUE INDEX videos_src ON videos(src_root, src_rel);
	CREATE INDEX videos_folder ON videos(folder_id, trashed_at, created_at);
	CREATE INDEX videos_fingerprint ON videos(fingerprint);
	CREATE INDEX videos_trashed ON videos(trashed_at);
	CREATE TABLE jobs (
		video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
		state TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL
	);`,
}

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i := v; i < len(migrations); i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return err
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func now() int64 { return time.Now().UnixMilli() }

// NewID returns a time-ordered UUIDv7.
func NewID() string { return uuid.Must(uuid.NewV7()).String() }

// ValidID reports whether a client-supplied id is a UUID.
func ValidID(id string) bool {
	_, err := uuid.Parse(id)
	return err == nil && len(id) == 36
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func inClause(ids []string) (string, []any) {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return "(" + ph + ")", args
}
