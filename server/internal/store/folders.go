package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

type Folder struct {
	ID        string  `json:"id"`
	ParentID  *string `json:"parent_id"`
	Name      string  `json:"name"`
	SortOrder int     `json:"sort_order"`
	CreatedAt int64   `json:"created_at"`
	Count     int     `json:"count"`
	CoverID   *string `json:"cover_id"`
	CoverV    int     `json:"cover_v"`
}

type FolderTree struct {
	Folders  []Folder `json:"folders"`
	All      int      `json:"all"`
	Unsorted int      `json:"unsorted"`
	Trash    int      `json:"trash"`
}

func (s *Store) ListFolders(ctx context.Context) (FolderTree, error) {
	t := FolderTree{Folders: []Folder{}}
	rows, err := s.db.QueryContext(ctx, `
		SELECT f.id, f.parent_id, f.name, f.sort_order, f.created_at,
			(SELECT COUNT(*) FROM videos v WHERE v.folder_id = f.id AND v.trashed_at IS NULL),
			c.id, COALESCE(c.media_v, 0)
		FROM folders f
		LEFT JOIN videos c ON c.id = (
			SELECT v.id FROM videos v
			WHERE v.folder_id = f.id AND v.trashed_at IS NULL AND v.status = 'ready'
			ORDER BY v.created_at DESC LIMIT 1)
		ORDER BY f.sort_order, f.name COLLATE NOCASE`)
	if err != nil {
		return t, err
	}
	defer rows.Close()
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.ParentID, &f.Name, &f.SortOrder, &f.CreatedAt, &f.Count, &f.CoverID, &f.CoverV); err != nil {
			return t, err
		}
		t.Folders = append(t.Folders, f)
	}
	if err := rows.Err(); err != nil {
		return t, err
	}
	err = s.db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(trashed_at IS NULL), 0),
			COALESCE(SUM(trashed_at IS NULL AND folder_id IS NULL), 0),
			COALESCE(SUM(trashed_at IS NOT NULL), 0)
		FROM videos`).Scan(&t.All, &t.Unsorted, &t.Trash)
	return t, err
}

func cleanName(name string) (string, error) {
	name = norm.NFC.String(strings.TrimSpace(name))
	if name == "" {
		return "", ValidationError{"フォルダ名を入力してください"}
	}
	if utf8.RuneCountInString(name) > 100 {
		return "", ValidationError{"フォルダ名が長すぎます"}
	}
	return name, nil
}

func (s *Store) getFolder(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (Folder, error) {
	var f Folder
	err := q.QueryRowContext(ctx, `SELECT id, parent_id, name, sort_order, created_at FROM folders WHERE id = ?`, id).
		Scan(&f.ID, &f.ParentID, &f.Name, &f.SortOrder, &f.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return f, ErrNotFound
	}
	return f, err
}

// CreateFolder is idempotent for a client-supplied id so optimistic retries are safe.
func (s *Store) CreateFolder(ctx context.Context, id, name string, parentID *string) (Folder, error) {
	name, err := cleanName(name)
	if err != nil {
		return Folder{}, err
	}
	if id == "" {
		id = NewID()
	} else if !ValidID(id) {
		return Folder{}, ValidationError{"invalid id"}
	}
	var out Folder
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if existing, err := s.getFolder(ctx, tx, id); err == nil {
			if existing.Name == name && ptrEq(existing.ParentID, parentID) {
				out = existing
				return nil
			}
			return ErrConflict
		}
		if parentID != nil {
			if _, err := s.getFolder(ctx, tx, *parentID); err != nil {
				return err
			}
		}
		var maxOrder int
		tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sort_order), 0) FROM folders WHERE parent_id IS ?`, parentID).Scan(&maxOrder)
		out = Folder{ID: id, ParentID: parentID, Name: name, SortOrder: maxOrder + 1, CreatedAt: now()}
		_, err := tx.ExecContext(ctx, `INSERT INTO folders (id, parent_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
			out.ID, out.ParentID, out.Name, out.SortOrder, out.CreatedAt)
		if isUnique(err) {
			return ErrConflict
		}
		return err
	})
	return out, err
}

func (s *Store) RenameFolder(ctx context.Context, id, name string) error {
	name, err := cleanName(name)
	if err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE folders SET name = ? WHERE id = ?`, name, id)
	if isUnique(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetFolderOrder(ctx context.Context, id string, order int) error {
	res, err := s.db.ExecContext(ctx, `UPDATE folders SET sort_order = ? WHERE id = ?`, order, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ErrCycle is returned when a folder would become its own ancestor.
var ErrCycle = fmt.Errorf("%w: folder cannot be moved into itself", ErrConflict)

func (s *Store) MoveFolder(ctx context.Context, id string, parentID *string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := s.getFolder(ctx, tx, id); err != nil {
			return err
		}
		for cur := parentID; cur != nil; {
			if *cur == id {
				return ErrCycle
			}
			p, err := s.getFolder(ctx, tx, *cur)
			if err != nil {
				return err
			}
			cur = p.ParentID
		}
		_, err := tx.ExecContext(ctx, `UPDATE folders SET parent_id = ? WHERE id = ?`, parentID, id)
		if isUnique(err) {
			return ErrConflict
		}
		return err
	})
}

// DeleteFolder moves the folder's videos (including trashed ones) and subfolders to
// its parent, renaming subfolders that would collide, then deletes it.
func (s *Store) DeleteFolder(ctx context.Context, id string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		f, err := s.getFolder(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE videos SET folder_id = ?, updated_at = ? WHERE folder_id = ?`, f.ParentID, now(), id); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT id, name FROM folders WHERE parent_id = ?`, id)
		if err != nil {
			return err
		}
		type child struct{ id, name string }
		var children []child
		for rows.Next() {
			var c child
			if err := rows.Scan(&c.id, &c.name); err != nil {
				rows.Close()
				return err
			}
			children = append(children, c)
		}
		rows.Close()
		for _, c := range children {
			name := c.name
			for i := 2; ; i++ {
				_, err := tx.ExecContext(ctx, `UPDATE folders SET parent_id = ?, name = ? WHERE id = ?`, f.ParentID, name, c.id)
				if err == nil {
					break
				}
				if !isUnique(err) || i > 100 {
					return err
				}
				name = fmt.Sprintf("%s (%d)", c.name, i)
			}
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM folders WHERE id = ?`, id)
		return err
	})
}

func ptrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
