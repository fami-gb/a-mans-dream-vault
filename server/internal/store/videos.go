package store

import (
	"context"
	"database/sql"
	"errors"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	StatusProcessing = "processing"
	StatusReady      = "ready"
	StatusFailed     = "failed"
)

type Video struct {
	ID         string  `json:"id"`
	FolderID   *string `json:"folder_id"`
	Title      string  `json:"title"`
	DurationMs int64   `json:"duration_ms"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	SizeBytes  int64   `json:"size_bytes"`
	Status     string  `json:"status"`
	Error      string  `json:"error"`
	Missing    bool    `json:"missing"`
	MediaV     int     `json:"media_v"`
	CreatedAt  int64   `json:"created_at"`
	TrashedAt  *int64  `json:"trashed_at"`
	Ext        string  `json:"ext"`

	SrcRoot     string `json:"-"`
	SrcRel      string `json:"-"`
	PlayRoot    string `json:"-"`
	PlayRel     string `json:"-"`
	Fingerprint string `json:"-"`
}

const videoCols = `id, folder_id, title, duration_ms, width, height, size_bytes, status, error, missing,
	media_v, created_at, trashed_at, src_root, src_rel, play_root, play_rel, fingerprint`

func scanVideo(sc interface{ Scan(...any) error }) (Video, error) {
	var v Video
	err := sc.Scan(&v.ID, &v.FolderID, &v.Title, &v.DurationMs, &v.Width, &v.Height, &v.SizeBytes,
		&v.Status, &v.Error, &v.Missing, &v.MediaV, &v.CreatedAt, &v.TrashedAt,
		&v.SrcRoot, &v.SrcRel, &v.PlayRoot, &v.PlayRel, &v.Fingerprint)
	v.Ext = strings.TrimPrefix(strings.ToLower(path.Ext(v.SrcRel)), ".")
	return v, err
}

type ListParams struct {
	View   string // all | unsorted | trash | <folder id>
	Sort   string // new | old | name | long | short
	Q      string
	Offset int
	Limit  int
}

func (p ListParams) where() (string, []any) {
	var conds []string
	var args []any
	switch p.View {
	case "", "all":
		conds = append(conds, "trashed_at IS NULL")
	case "unsorted":
		conds = append(conds, "trashed_at IS NULL", "folder_id IS NULL")
	case "trash":
		conds = append(conds, "trashed_at IS NOT NULL")
	default:
		conds = append(conds, "trashed_at IS NULL", "folder_id = ?")
		args = append(args, p.View)
	}
	if q := strings.TrimSpace(p.Q); q != "" {
		for _, term := range strings.Fields(norm.NFC.String(q)) {
			esc := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(term)
			conds = append(conds, `title LIKE ? ESCAPE '\'`)
			args = append(args, "%"+esc+"%")
		}
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

func (p ListParams) order() string {
	if p.View == "trash" && (p.Sort == "" || p.Sort == "new") {
		return " ORDER BY trashed_at DESC, id DESC"
	}
	switch p.Sort {
	case "old":
		return " ORDER BY created_at ASC, id ASC"
	case "name":
		return " ORDER BY title COLLATE NOCASE ASC, id ASC"
	case "long":
		return " ORDER BY duration_ms DESC, id DESC"
	case "short":
		return " ORDER BY duration_ms ASC, id ASC"
	default:
		return " ORDER BY created_at DESC, id DESC"
	}
}

func (s *Store) ListVideos(ctx context.Context, p ListParams) ([]Video, int, error) {
	where, args := p.where()
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM videos`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if p.Limit <= 0 || p.Limit > 200 {
		p.Limit = 60
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+videoCols+` FROM videos`+where+p.order()+` LIMIT ? OFFSET ?`,
		append(args, p.Limit, p.Offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []Video{}
	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, v)
	}
	return items, total, rows.Err()
}

// ListVideoIDs returns every id of a view in display order (select-all, prev/next).
func (s *Store) ListVideoIDs(ctx context.Context, p ListParams) ([]string, error) {
	where, args := p.where()
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM videos`+where+p.order(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) GetVideo(ctx context.Context, id string) (Video, error) {
	v, err := scanVideo(s.db.QueryRowContext(ctx, `SELECT `+videoCols+` FROM videos WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	return v, err
}

func (s *Store) GetVideos(ctx context.Context, ids []string) ([]Video, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	in, args := inClause(ids)
	rows, err := s.db.QueryContext(ctx, `SELECT `+videoCols+` FROM videos WHERE id IN `+in, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// InsertVideo creates a row and queues it for processing in one transaction.
func (s *Store) InsertVideo(ctx context.Context, v Video) error {
	if v.ID == "" {
		v.ID = NewID()
	}
	if v.CreatedAt == 0 {
		v.CreatedAt = now()
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if v.FolderID != nil {
			if _, err := s.getFolder(ctx, tx, *v.FolderID); errors.Is(err, ErrNotFound) {
				v.FolderID = nil
			} else if err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO videos
			(id, folder_id, title, src_root, src_rel, size_bytes, fingerprint, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			v.ID, v.FolderID, v.Title, v.SrcRoot, v.SrcRel, v.SizeBytes, v.Fingerprint, StatusProcessing, v.CreatedAt, now())
		if isUnique(err) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		return enqueue(ctx, tx, v.ID)
	})
}

func CleanTitle(t string) (string, error) {
	t = norm.NFC.String(strings.TrimSpace(t))
	if t == "" {
		return "", ValidationError{"タイトルを入力してください"}
	}
	if utf8.RuneCountInString(t) > 300 {
		return "", ValidationError{"タイトルが長すぎます"}
	}
	return t, nil
}

func (s *Store) UpdateTitle(ctx context.Context, id, title string) error {
	title, err := CleanTitle(title)
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE videos SET title = ?, updated_at = ? WHERE id = ?`, title, now(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func checkIDs(ids []string) error {
	if len(ids) == 0 {
		return ValidationError{"ids is empty"}
	}
	if len(ids) > 10000 {
		return ValidationError{"too many ids"}
	}
	return nil
}

// MoveVideos puts videos into folderID (nil = unsorted) atomically.
func (s *Store) MoveVideos(ctx context.Context, ids []string, folderID *string) (int64, error) {
	if err := checkIDs(ids); err != nil {
		return 0, err
	}
	var n int64
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if folderID != nil {
			if _, err := s.getFolder(ctx, tx, *folderID); err != nil {
				return err
			}
		}
		in, args := inClause(ids)
		res, err := tx.ExecContext(ctx, `UPDATE videos SET folder_id = ?, updated_at = ? WHERE id IN `+in,
			append([]any{folderID, now()}, args...)...)
		if err != nil {
			return err
		}
		n, _ = res.RowsAffected()
		return nil
	})
	return n, err
}

func (s *Store) TrashVideos(ctx context.Context, ids []string) (int64, error) {
	if err := checkIDs(ids); err != nil {
		return 0, err
	}
	in, args := inClause(ids)
	res, err := s.db.ExecContext(ctx, `UPDATE videos SET trashed_at = ?, updated_at = ? WHERE trashed_at IS NULL AND id IN `+in,
		append([]any{now(), now()}, args...)...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) RestoreVideos(ctx context.Context, ids []string) (int64, error) {
	if err := checkIDs(ids); err != nil {
		return 0, err
	}
	in, args := inClause(ids)
	res, err := s.db.ExecContext(ctx, `UPDATE videos SET trashed_at = NULL, updated_at = ? WHERE id IN `+in,
		append([]any{now()}, args...)...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// TrashedVideos returns trashed rows among ids, or all trashed before `before` when ids is nil.
func (s *Store) TrashedVideos(ctx context.Context, ids []string, before int64) ([]Video, error) {
	q := `SELECT ` + videoCols + ` FROM videos WHERE trashed_at IS NOT NULL`
	var args []any
	if ids != nil {
		if err := checkIDs(ids); err != nil {
			return nil, err
		}
		in, a := inClause(ids)
		q += ` AND id IN ` + in
		args = a
	} else {
		q += ` AND trashed_at < ?`
		args = []any{before}
	}
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) DeleteVideoRow(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM videos WHERE id = ?`, id)
	return err
}

// MediaResult is what processing learned about a video.
type MediaResult struct {
	DurationMs    int64
	Width, Height int
	PlayRoot      string
	PlayRel       string
	Bumped        bool // thumbnails/sprite regenerated
}

func (s *Store) SetReady(ctx context.Context, id string, m MediaResult) error {
	bump := 0
	if m.Bumped {
		bump = 1
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE videos SET duration_ms = ?, width = ?, height = ?, play_root = ?, play_rel = ?,
			status = ?, error = '', missing = 0, media_v = media_v + ?, updated_at = ? WHERE id = ?`,
			m.DurationMs, m.Width, m.Height, m.PlayRoot, m.PlayRel, StatusReady, bump, now(), id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM jobs WHERE video_id = ?`, id)
		return err
	})
}

func (s *Store) SetFailed(ctx context.Context, id, msg string, missing bool) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE videos SET status = ?, error = ?, missing = ?, updated_at = ? WHERE id = ?`,
			StatusFailed, msg, missing, now(), id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE jobs SET state = 'failed', updated_at = ? WHERE video_id = ?`, now(), id)
		return err
	})
}

func (s *Store) SetMissing(ctx context.Context, id string, missing bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE videos SET missing = ? WHERE id = ?`, missing, id)
	return err
}

// Relink points an existing row at a new source file (the file was moved).
func (s *Store) Relink(ctx context.Context, id, root, rel string, size int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE videos SET src_root = ?, src_rel = ?, size_bytes = ?, missing = 0, updated_at = ? WHERE id = ?`,
			root, rel, size, now(), id); err != nil {
			return err
		}
		return enqueue(ctx, tx, id)
	})
}

// SourceIndex lists every row of a root for import matching.
func (s *Store) AllVideos(ctx context.Context) ([]Video, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+videoCols+` FROM videos`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		v, err := scanVideo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
