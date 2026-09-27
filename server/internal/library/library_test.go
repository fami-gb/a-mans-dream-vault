package library

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"videovault/internal/paths"
	"videovault/internal/store"
)

func setup(t *testing.T) (*store.Store, paths.Roots) {
	t.Helper()
	dir := t.TempDir()
	r := paths.Roots{Data: filepath.Join(dir, "data"), Library: filepath.Join(dir, "lib")}
	if err := r.Ensure(); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(r.Library, 0o755)
	s, err := store.Open(r.DB())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, r
}

func write(t *testing.T, p, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestImportIsIdempotentAndFollowsMoves(t *testing.T) {
	ctx := context.Background()
	s, r := setup(t)
	write(t, filepath.Join(r.Library, "a.mp4"), "video-a")
	write(t, filepath.Join(r.Library, "sub", "b.mov"), "video-b")
	write(t, filepath.Join(r.Library, "desktop.ini"), "x")

	res, err := Import(ctx, s, r)
	if err != nil || res.Added != 2 {
		t.Fatalf("first import: %+v %v", res, err)
	}
	res, err = Import(ctx, s, r)
	if err != nil || res.Added != 0 || res.Unchanged != 2 {
		t.Fatalf("second import must not add: %+v %v", res, err)
	}

	// Organise a.mp4 into a folder, then move the file on disk.
	all, _ := s.AllVideos(ctx)
	var aID string
	for _, v := range all {
		if v.SrcRel == "a.mp4" {
			aID = v.ID
		}
	}
	f, _ := s.CreateFolder(ctx, "", "Kept", nil)
	s.MoveVideos(ctx, []string{aID}, &f.ID)
	os.MkdirAll(filepath.Join(r.Library, "moved"), 0o755)
	os.Rename(filepath.Join(r.Library, "a.mp4"), filepath.Join(r.Library, "moved", "renamed.mp4"))

	res, err = Import(ctx, s, r)
	if err != nil || res.Relinked != 1 || res.Added != 0 {
		t.Fatalf("move should relink: %+v %v", res, err)
	}
	v, _ := s.GetVideo(ctx, aID)
	if v.SrcRel != "moved/renamed.mp4" || v.FolderID == nil || *v.FolderID != f.ID {
		t.Fatalf("relinked row lost its folder or path: %+v", v)
	}

	os.Remove(filepath.Join(r.Library, "sub", "b.mov"))
	res, _ = Import(ctx, s, r)
	if res.Missing != 1 {
		t.Fatalf("deleted file should be flagged missing: %+v", res)
	}
	if got, _ := s.AllVideos(ctx); len(got) != 2 {
		t.Fatalf("import must never delete rows, have %d", len(got))
	}
}

func TestVerifyRequeuesMissingDerivedFiles(t *testing.T) {
	ctx := context.Background()
	s, r := setup(t)
	write(t, filepath.Join(r.Library, "a.mp4"), "video-a")
	Import(ctx, s, r)
	all, _ := s.AllVideos(ctx)
	id := all[0].ID
	s.ClaimJob(ctx)
	write(t, r.Thumb(id), "jpg")
	write(t, r.Sprite(id), "jpg")
	s.SetReady(ctx, id, store.MediaResult{PlayRoot: "library", PlayRel: "a.mp4"})

	res, err := Verify(ctx, s, r)
	if err != nil || res.Requeued != 0 {
		t.Fatalf("complete video should not requeue: %+v %v", res, err)
	}
	os.Remove(r.Thumb(id))
	res, _ = Verify(ctx, s, r)
	if res.Requeued != 1 {
		t.Fatalf("missing thumb should requeue: %+v", res)
	}
	res, _ = Verify(ctx, s, r)
	if res.Requeued != 1 { // still processing → still (idempotently) queued
		t.Fatalf("second verify: %+v", res)
	}
	if c, _ := s.JobCounts(ctx); c.Queued != 1 {
		t.Fatalf("exactly one job expected: %+v", c)
	}
}
