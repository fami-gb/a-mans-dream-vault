// Command videovault serves the video library.
//
//	videovault [serve]   start the web server and processing workers
//	videovault import    register videos under LIBRARY_DIR (idempotent)
//	videovault verify    flag missing sources, requeue missing thumbnails/conversions (idempotent)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"videovault/internal/api"
	"videovault/internal/config"
	"videovault/internal/events"
	"videovault/internal/jobs"
	"videovault/internal/library"
	"videovault/internal/paths"
	"videovault/internal/store"
	"videovault/webui"
)

func main() {
	cfg := config.Load()
	roots := paths.Roots{Data: cfg.DataDir, Library: cfg.LibraryDir}
	if err := roots.Ensure(); err != nil {
		log.Fatalf("data dir: %v", err)
	}
	s, err := store.Open(roots.DB())
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer s.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "serve":
		serve(ctx, cfg, s, roots)
	case "import":
		res, err := library.Import(ctx, s, roots)
		printResult(res, err)
	case "verify":
		res, err := library.Verify(ctx, s, roots)
		printResult(res, err)
	default:
		fmt.Fprintf(os.Stderr, "usage: videovault [serve|import|verify]\n")
		os.Exit(2)
	}
}

func printResult(res any, err error) {
	b, _ := json.MarshalIndent(res, "", "  ")
	fmt.Println(string(b))
	if err != nil {
		log.Fatal(err)
	}
}

func serve(ctx context.Context, cfg config.Config, s *store.Store, roots paths.Roots) {
	hub := events.NewHub()
	w := &jobs.Worker{S: s, R: roots, Hub: hub, N: cfg.Workers, TrashDays: cfg.TrashDays}
	w.Run(ctx)

	srv := &api.Server{S: s, R: roots, Hub: hub, W: w, Password: cfg.Password, Web: webui.FS()}
	h, err := srv.Handler(ctx)
	if err != nil {
		log.Fatalf("handler: %v", err)
	}
	httpSrv := &http.Server{Addr: cfg.Addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdown)
	}()
	log.Printf("listening on %s (data=%s library=%s auth=%v)", cfg.Addr, roots.Data, roots.Library, cfg.Password != "")
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
