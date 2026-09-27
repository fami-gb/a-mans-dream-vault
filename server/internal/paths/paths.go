// Package paths maps (root, relative path) pairs stored in the DB to real files.
// The DB never stores absolute host paths, so data/ and library/ can be copied to
// another machine and mounted anywhere.
package paths

import (
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	RootData    = "data"
	RootLibrary = "library"
)

type Roots struct {
	Data    string
	Library string
}

var ErrBadPath = errors.New("invalid path")

// Abs resolves a stored (root, rel) pair. rel always uses forward slashes.
func (r Roots) Abs(root, rel string) (string, error) {
	var base string
	switch root {
	case RootData:
		base = r.Data
	case RootLibrary:
		base = r.Library
	default:
		return "", ErrBadPath
	}
	clean := path.Clean("/" + rel)
	if clean == "/" || strings.Contains(clean, "\x00") {
		return "", ErrBadPath
	}
	return filepath.Join(base, filepath.FromSlash(clean[1:])), nil
}

func (r Roots) DB() string         { return filepath.Join(r.Data, "app.db") }
func (r Roots) TusDir() string     { return filepath.Join(r.Data, "tus") }
func (r Roots) UploadsDir() string { return filepath.Join(r.Data, "uploads") }
func (r Roots) Thumb(id string) string {
	return filepath.Join(r.Data, "thumbs", id+".jpg")
}
func (r Roots) Sprite(id string) string {
	return filepath.Join(r.Data, "sprites", id+".jpg")
}

// PlayableRel is the data-root relative path of a converted, browser-safe MP4.
func PlayableRel(id string) string { return "playable/" + id + ".mp4" }

func UploadRel(id, ext string) string { return "uploads/" + id + ext }

func (r Roots) Ensure() error {
	for _, d := range []string{"tus", "uploads", "playable", "thumbs", "sprites"} {
		if err := os.MkdirAll(filepath.Join(r.Data, d), 0o755); err != nil {
			return err
		}
	}
	return nil
}

func Exists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Size() > 0
}
