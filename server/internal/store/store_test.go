package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func addVideo(t *testing.T, s *Store, rel string, folder *string) string {
	t.Helper()
	id := NewID()
	if err := s.InsertVideo(context.Background(), Video{ID: id, Title: rel, SrcRoot: "library", SrcRel: rel, FolderID: folder}); err != nil {
		t.Fatal(err)
	}
	return id
}

func ids(t *testing.T, s *Store, view string) []string {
	t.Helper()
	out, err := s.ListVideoIDs(context.Background(), ListParams{View: view})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFolderCycle(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateFolder(ctx, "", "A", nil)
	b, _ := s.CreateFolder(ctx, "", "B", &a.ID)
	c, _ := s.CreateFolder(ctx, "", "C", &b.ID)

	if err := s.MoveFolder(ctx, a.ID, &c.ID); !errors.Is(err, ErrCycle) {
		t.Fatalf("A into its grandchild: got %v, want ErrCycle", err)
	}
	if err := s.MoveFolder(ctx, a.ID, &a.ID); !errors.Is(err, ErrCycle) {
		t.Fatalf("A into itself: got %v, want ErrCycle", err)
	}
	if err := s.MoveFolder(ctx, c.ID, nil); err != nil {
		t.Fatalf("C to root: %v", err)
	}
}

func TestFolderNamesUniquePerParent(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	a, _ := s.CreateFolder(ctx, "", "Same", nil)
	if _, err := s.CreateFolder(ctx, "", "Same", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate root name: got %v", err)
	}
	if _, err := s.CreateFolder(ctx, "", "Same", &a.ID); err != nil {
		t.Fatalf("same name under other parent should be allowed: %v", err)
	}
	// Idempotent retry with the same client id.
	id := NewID()
	f1, err := s.CreateFolder(ctx, id, "Retry", nil)
	if err != nil {
		t.Fatal(err)
	}
	f2, err := s.CreateFolder(ctx, id, "Retry", nil)
	if err != nil || f2.ID != f1.ID {
		t.Fatalf("retry: %v %v", f2, err)
	}
}

func TestMoveTrashRestore(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	f, _ := s.CreateFolder(ctx, "", "F", nil)
	v1 := addVideo(t, s, "1.mp4", nil)
	v2 := addVideo(t, s, "2.mp4", nil)
	v3 := addVideo(t, s, "3.mp4", nil)

	if n, err := s.MoveVideos(ctx, []string{v1, v2}, &f.ID); err != nil || n != 2 {
		t.Fatalf("move: %d %v", n, err)
	}
	if got := ids(t, s, f.ID); len(got) != 2 {
		t.Fatalf("folder has %v", got)
	}
	if got := ids(t, s, "unsorted"); len(got) != 1 || got[0] != v3 {
		t.Fatalf("unsorted has %v", got)
	}
	missing := "00000000-0000-7000-8000-000000000000"
	if _, err := s.MoveVideos(ctx, []string{v3}, &missing); !errors.Is(err, ErrNotFound) {
		t.Fatalf("move to missing folder: %v", err)
	}

	if _, err := s.TrashVideos(ctx, []string{v1, v3}); err != nil {
		t.Fatal(err)
	}
	if got := ids(t, s, "all"); len(got) != 1 {
		t.Fatalf("all after trash: %v", got)
	}
	tree, _ := s.ListFolders(ctx)
	if tree.Trash != 2 || tree.All != 1 || tree.Folders[0].Count != 1 {
		t.Fatalf("counts: %+v", tree)
	}
	if _, err := s.RestoreVideos(ctx, []string{v1}); err != nil {
		t.Fatal(err)
	}
	if got := ids(t, s, f.ID); len(got) != 2 {
		t.Fatalf("restore should return to original folder: %v", got)
	}
	trashed, err := s.TrashedVideos(ctx, []string{v1, v2, v3}, 0)
	if err != nil || len(trashed) != 1 || trashed[0].ID != v3 {
		t.Fatalf("only v3 is purgeable: %v %v", trashed, err)
	}
}

func TestDeleteFolderPromotesContents(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	parent, _ := s.CreateFolder(ctx, "", "Parent", nil)
	doomed, _ := s.CreateFolder(ctx, "", "Doomed", &parent.ID)
	child, _ := s.CreateFolder(ctx, "", "Child", &doomed.ID)
	s.CreateFolder(ctx, "", "Child", &parent.ID) // name clash after promotion
	v := addVideo(t, s, "v.mp4", &doomed.ID)

	if err := s.DeleteFolder(ctx, doomed.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetVideo(ctx, v)
	if got.FolderID == nil || *got.FolderID != parent.ID {
		t.Fatalf("video should move to parent, got %v", got.FolderID)
	}
	tree, _ := s.ListFolders(ctx)
	for _, f := range tree.Folders {
		if f.ID == child.ID {
			if f.ParentID == nil || *f.ParentID != parent.ID || f.Name != "Child (2)" {
				t.Fatalf("child not promoted/renamed: %+v", f)
			}
			return
		}
	}
	t.Fatal("child folder disappeared")
}

func TestJobQueue(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	v := addVideo(t, s, "a.mp4", nil)
	id, ok, err := s.ClaimJob(ctx)
	if err != nil || !ok || id != v {
		t.Fatalf("claim: %s %v %v", id, ok, err)
	}
	if _, ok, _ := s.ClaimJob(ctx); ok {
		t.Fatal("job claimed twice")
	}
	s.ResetRunning(ctx)
	if _, ok, _ := s.ClaimJob(ctx); !ok {
		t.Fatal("reset job should be claimable")
	}
	if err := s.SetReady(ctx, v, MediaResult{DurationMs: 1000, PlayRoot: "library", PlayRel: "a.mp4", Bumped: true}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetVideo(ctx, v)
	if got.Status != StatusReady || got.MediaV != 1 {
		t.Fatalf("after ready: %+v", got)
	}
	c, _ := s.JobCounts(ctx)
	if c.Queued+c.Running+c.Failed != 0 {
		t.Fatalf("jobs left: %+v", c)
	}
}
