// Package jobs runs the persistent media-processing queue and periodic cleanup.
package jobs

import (
	"context"
	"errors"
	"log"
	"os"
	"path"
	"path/filepath"
	"time"

	"videovault/internal/events"
	"videovault/internal/library"
	"videovault/internal/media"
	"videovault/internal/paths"
	"videovault/internal/store"
)

type Worker struct {
	S         *store.Store
	R         paths.Roots
	Hub       *events.Hub
	N         int
	TrashDays int
	wake      chan struct{}
}

func (w *Worker) Wake() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *Worker) Run(ctx context.Context) {
	w.wake = make(chan struct{}, 1)
	if err := w.S.ResetRunning(ctx); err != nil {
		log.Printf("jobs: reset: %v", err)
	}
	for i := 0; i < max(1, w.N); i++ {
		go w.loop(ctx)
	}
	go w.janitor(ctx)
}

func (w *Worker) loop(ctx context.Context) {
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		id, ok, err := w.S.ClaimJob(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("jobs: claim: %v", err)
		}
		if ok {
			w.process(ctx, id)
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-w.wake:
		case <-tick.C:
		}
	}
}

func (w *Worker) process(ctx context.Context, id string) {
	v, err := w.S.GetVideo(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return
	}
	if err != nil {
		log.Printf("jobs: %s: %v", id, err)
		return
	}
	start := time.Now()
	res, err := w.build(ctx, v)
	if ctx.Err() != nil {
		return // shutting down; ResetRunning requeues on next start
	}
	if err != nil {
		var miss missingErr
		isMissing := errors.As(err, &miss)
		if !isMissing {
			if again, _ := w.S.Requeue(ctx, id, 3); again {
				log.Printf("jobs: %s (%s) failed, will retry: %v", id, v.SrcRel, err)
				return
			}
		}
		log.Printf("jobs: %s (%s) failed: %v", id, v.SrcRel, err)
		w.S.SetFailed(ctx, id, err.Error(), isMissing)
		w.Hub.Publish(events.Event{Type: "video", ID: id, Status: store.StatusFailed})
		return
	}
	if err := w.S.SetReady(ctx, id, res); err != nil {
		log.Printf("jobs: %s: set ready: %v", id, err)
		return
	}
	log.Printf("jobs: %s ready in %s", v.SrcRel, time.Since(start).Round(time.Millisecond))
	w.Hub.Publish(events.Event{Type: "video", ID: id, Status: store.StatusReady})
}

type missingErr struct{}

func (missingErr) Error() string { return "元ファイルが見つかりません" }

// build is idempotent: each output is only produced when absent.
func (w *Worker) build(ctx context.Context, v store.Video) (store.MediaResult, error) {
	var res store.MediaResult
	src, err := w.R.Abs(v.SrcRoot, v.SrcRel)
	if err != nil {
		return res, err
	}
	if _, err := os.Stat(src); err != nil {
		return res, missingErr{}
	}
	pr, err := media.ProbeFile(ctx, src)
	if err != nil {
		return res, err
	}
	res.DurationMs, res.Width, res.Height = pr.DurationMs, pr.Width, pr.Height

	play := src
	if media.Compatible(pr, path.Ext(v.SrcRel)) {
		res.PlayRoot, res.PlayRel = v.SrcRoot, v.SrcRel
	} else {
		res.PlayRoot, res.PlayRel = paths.RootData, paths.PlayableRel(v.ID)
		play, _ = w.R.Abs(res.PlayRoot, res.PlayRel)
		if !paths.Exists(play) {
			if err := media.MakePlayable(ctx, src, play, pr); err != nil {
				return res, err
			}
		}
	}
	if !paths.Exists(w.R.Thumb(v.ID)) {
		if err := media.MakeThumb(ctx, play, w.R.Thumb(v.ID), pr.DurationMs); err != nil {
			return res, err
		}
		res.Bumped = true
	}
	if !paths.Exists(w.R.Sprite(v.ID)) {
		// A missing sprite only disables scrub preview, so it is not fatal.
		if err := media.MakeSprite(ctx, play, w.R.Sprite(v.ID), pr.VideoMs); err != nil {
			log.Printf("jobs: sprite %s: %v", v.SrcRel, err)
		} else {
			res.Bumped = true
		}
	}
	return res, nil
}

// janitor purges old trash and abandoned partial uploads.
func (w *Worker) janitor(ctx context.Context) {
	t := time.NewTicker(6 * time.Hour)
	defer t.Stop()
	for {
		before := time.Now().AddDate(0, 0, -w.TrashDays).UnixMilli()
		if vids, err := w.S.TrashedVideos(ctx, nil, before); err == nil && len(vids) > 0 {
			n, err := library.Purge(ctx, w.S, w.R, vids)
			log.Printf("janitor: purged %d trashed videos (err=%v)", n, err)
			w.Hub.Publish(events.Event{Type: "changed", Scope: "all"})
		}
		cutoff := time.Now().Add(-7 * 24 * time.Hour)
		if entries, err := os.ReadDir(w.R.TusDir()); err == nil {
			for _, e := range entries {
				if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
					os.Remove(filepath.Join(w.R.TusDir(), e.Name()))
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
