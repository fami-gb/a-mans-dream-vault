// Package library implements the idempotent import/verify operations and file cleanup.
// Running Import or Verify any number of times converges to the same state.
package library

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"

	"videovault/internal/paths"
	"videovault/internal/store"
)

var videoExts = map[string]bool{
	".mp4": true, ".m4v": true, ".mov": true, ".webm": true, ".mkv": true, ".avi": true,
	".wmv": true, ".flv": true, ".mpg": true, ".mpeg": true, ".3gp": true, ".ts": true, ".mts": true, ".m2ts": true,
}

func IsVideoExt(ext string) bool { return videoExts[strings.ToLower(ext)] }

const fpChunk = 256 << 10

// Fingerprint identifies a file by size plus hashes of its head and tail, so a
// moved or renamed file can be matched back to its row without reading it all.
// Reads through Docker Desktop's Windows file share occasionally fail with ENOMEM
// under load, so transient errors are retried.
func Fingerprint(p string) (fp string, size int64, err error) {
	for i := 0; i < 4; i++ {
		if fp, size, err = fingerprint(p); err == nil || errors.Is(err, fs.ErrNotExist) {
			return
		}
		time.Sleep(time.Duration(i+1) * 300 * time.Millisecond)
	}
	return
}

func fingerprint(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	size := st.Size()
	h := sha256.New()
	io.WriteString(h, strconv.FormatInt(size, 10)+":")
	if _, err := io.CopyN(h, f, min(size, fpChunk)); err != nil && !errors.Is(err, io.EOF) {
		return "", 0, err
	}
	if size > fpChunk {
		if _, err := f.Seek(max(size-fpChunk, fpChunk), io.SeekStart); err != nil {
			return "", 0, err
		}
		if _, err := io.Copy(h, f); err != nil {
			return "", 0, err
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:32], size, nil
}

type ImportResult struct {
	Added     int `json:"added"`
	Relinked  int `json:"relinked"`
	Unchanged int `json:"unchanged"`
	Missing   int `json:"missing"`
	Errors    int `json:"errors"`
}

func key(rel string) string { return norm.NFC.String(rel) }

// Import registers every video under the library root into "未分類".
// Matching order: same relative path → same fingerprint of a row whose file is gone → new row.
func Import(ctx context.Context, s *store.Store, r paths.Roots) (ImportResult, error) {
	var res ImportResult
	all, err := s.AllVideos(ctx)
	if err != nil {
		return res, err
	}
	byRel := map[string]store.Video{}
	byFP := map[string][]store.Video{}
	for _, v := range all {
		if v.SrcRoot == paths.RootLibrary {
			byRel[key(v.SrcRel)] = v
		}
		if v.Fingerprint != "" {
			byFP[v.Fingerprint] = append(byFP[v.Fingerprint], v)
		}
	}
	seen := map[string]bool{}
	relinked := map[string]bool{}

	err = filepath.WalkDir(r.Library, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			log.Printf("import: %s: %v", p, err)
			res.Errors++
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		name := d.Name()
		if strings.HasPrefix(name, ".") && p != r.Library {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !IsVideoExt(filepath.Ext(name)) {
			return nil
		}
		relOS, err := filepath.Rel(r.Library, p)
		if err != nil {
			return nil
		}
		rel := filepath.ToSlash(relOS)
		k := key(rel)
		seen[k] = true

		if v, ok := byRel[k]; ok {
			if v.Missing {
				s.SetMissing(ctx, v.ID, false)
				if v.Status == store.StatusFailed {
					s.Enqueue(ctx, v.ID)
				}
			}
			res.Unchanged++
			return nil
		}
		fp, size, err := Fingerprint(p)
		if err != nil {
			log.Printf("import: fingerprint %s: %v", p, err)
			res.Errors++
			return nil
		}
		for _, cand := range byFP[fp] {
			if relinked[cand.ID] {
				continue
			}
			if abs, err := r.Abs(cand.SrcRoot, cand.SrcRel); err == nil && fileExists(abs) {
				continue
			}
			if err := s.Relink(ctx, cand.ID, paths.RootLibrary, rel, size); err != nil {
				return err
			}
			relinked[cand.ID] = true
			res.Relinked++
			return nil
		}
		info, _ := d.Info()
		created := int64(0)
		if info != nil {
			created = info.ModTime().UnixMilli()
		}
		title := norm.NFC.String(strings.TrimSuffix(path.Base(rel), path.Ext(rel)))
		err = s.InsertVideo(ctx, store.Video{
			ID: store.NewID(), Title: title, SrcRoot: paths.RootLibrary, SrcRel: rel,
			SizeBytes: size, Fingerprint: fp, CreatedAt: created,
		})
		if errors.Is(err, store.ErrConflict) {
			res.Unchanged++
			return nil
		}
		if err != nil {
			return err
		}
		res.Added++
		return nil
	})
	if err != nil {
		return res, err
	}
	for k, v := range byRel {
		if !seen[k] && !relinked[v.ID] && !v.Missing {
			if abs, err := r.Abs(v.SrcRoot, v.SrcRel); err == nil && !fileExists(abs) {
				s.SetMissing(ctx, v.ID, true)
				res.Missing++
			}
		}
	}
	return res, nil
}

type VerifyResult struct {
	Checked  int `json:"checked"`
	Missing  int `json:"missing"`
	Requeued int `json:"requeued"`
}

// Verify flags rows whose source vanished and requeues rows whose derived files
// (playable mp4, thumbnail, sprite) are absent, e.g. after copying only app.db.
func Verify(ctx context.Context, s *store.Store, r paths.Roots) (VerifyResult, error) {
	var res VerifyResult
	all, err := s.AllVideos(ctx)
	if err != nil {
		return res, err
	}
	for _, v := range all {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		res.Checked++
		src, err := r.Abs(v.SrcRoot, v.SrcRel)
		if err != nil || !fileExists(src) {
			if !v.Missing {
				s.SetMissing(ctx, v.ID, true)
			}
			res.Missing++
			continue
		}
		if v.Missing {
			s.SetMissing(ctx, v.ID, false)
		}
		need := v.Status == store.StatusProcessing || (v.Status == store.StatusFailed && v.Missing)
		if v.Status == store.StatusReady {
			play, err := r.Abs(v.PlayRoot, v.PlayRel)
			need = err != nil || !fileExists(play) || !fileExists(r.Thumb(v.ID)) || !fileExists(r.Sprite(v.ID))
		}
		if need {
			if err := s.Enqueue(ctx, v.ID); err != nil {
				return res, err
			}
			res.Requeued++
		}
	}
	return res, nil
}

// RemoveFiles deletes a video's source and every derived file.
func RemoveFiles(r paths.Roots, v store.Video) {
	var files []string
	if src, err := r.Abs(v.SrcRoot, v.SrcRel); err == nil {
		files = append(files, src)
	}
	if v.PlayRoot == paths.RootData {
		if p, err := r.Abs(v.PlayRoot, v.PlayRel); err == nil {
			files = append(files, p)
		}
	}
	files = append(files, r.Thumb(v.ID), r.Sprite(v.ID))
	for _, f := range files {
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			log.Printf("remove %s: %v", f, err)
		}
	}
}

// Purge permanently deletes trashed videos (files first, then rows).
func Purge(ctx context.Context, s *store.Store, r paths.Roots, vids []store.Video) (int, error) {
	n := 0
	for _, v := range vids {
		RemoveFiles(r, v)
		if err := s.DeleteVideoRow(ctx, v.ID); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
