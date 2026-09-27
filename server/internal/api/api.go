// Package api exposes the JSON API, media streaming, tus uploads and the SPA.
package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"videovault/internal/events"
	"videovault/internal/jobs"
	"videovault/internal/library"
	"videovault/internal/paths"
	"videovault/internal/store"
)

type Server struct {
	S        *store.Store
	R        paths.Roots
	Hub      *events.Hub
	W        *jobs.Worker
	Password string
	Web      fs.FS

	scanning atomic.Bool
}

func (s *Server) Handler(ctx context.Context) (http.Handler, error) {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/auth", s.authStatus)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("GET /api/events", s.sse)
	mux.HandleFunc("GET /api/status", s.status)
	mux.HandleFunc("POST /api/library/scan", s.scan)

	mux.HandleFunc("GET /api/folders", s.listFolders)
	mux.HandleFunc("POST /api/folders", s.createFolder)
	mux.HandleFunc("PATCH /api/folders/{id}", s.updateFolder)
	mux.HandleFunc("DELETE /api/folders/{id}", s.deleteFolder)

	mux.HandleFunc("GET /api/videos", s.listVideos)
	mux.HandleFunc("GET /api/videos/ids", s.listVideoIDs)
	mux.HandleFunc("GET /api/videos/{id}", s.getVideo)
	mux.HandleFunc("PATCH /api/videos/{id}", s.updateVideo)
	mux.HandleFunc("POST /api/videos/{id}/retry", s.retryVideo)
	mux.HandleFunc("POST /api/videos/move", s.moveVideos)
	mux.HandleFunc("POST /api/videos/trash", s.trashVideos)
	mux.HandleFunc("POST /api/videos/restore", s.restoreVideos)
	mux.HandleFunc("DELETE /api/videos", s.deleteVideos)

	mux.HandleFunc("GET /media/{id}/play", s.mediaPlay)
	mux.HandleFunc("GET /media/{id}/original", s.mediaOriginal)
	mux.HandleFunc("GET /media/{id}/thumb", s.mediaThumb)
	mux.HandleFunc("GET /media/{id}/sprite", s.mediaSprite)

	tus, err := s.uploadHandler(ctx)
	if err != nil {
		return nil, err
	}
	mux.Handle("/api/uploads/", tus)

	mux.Handle("/", s.spa())
	return s.authMiddleware(mux), nil
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20))
	if err := dec.Decode(v); err != nil {
		return store.ValidationError{Msg: "invalid JSON: " + err.Error()}
	}
	return nil
}

func writeErr(w http.ResponseWriter, err error) {
	var ve store.ValidationError
	switch {
	case errors.As(err, &ve):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": ve.Msg})
	case errors.Is(err, store.ErrCycle):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "フォルダを自分自身の中へは移動できません"})
	case errors.Is(err, store.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "同じ名前のフォルダが既にあります"})
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "見つかりません"})
	default:
		log.Printf("api error: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "サーバーエラー"})
	}
}

func (s *Server) publish(r *http.Request, scope string) {
	s.Hub.Publish(events.Event{Type: "changed", Scope: scope, Origin: r.Header.Get("X-Client-Id")})
}

// ---- auth (only active when APP_PASSWORD is set) ----

const cookieName = "vv_auth"

func (s *Server) token() string {
	m := hmac.New(sha256.New, []byte(s.Password))
	m.Write([]byte("videovault-session-v1"))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *Server) authed(r *http.Request) bool {
	if s.Password == "" {
		return true
	}
	c, err := r.Cookie(cookieName)
	return err == nil && hmac.Equal([]byte(c.Value), []byte(s.token()))
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		protected := (strings.HasPrefix(p, "/api/") && p != "/api/auth" && p != "/api/login") || strings.HasPrefix(p, "/media/")
		if protected && !s.authed(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "ログインが必要です"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"required": s.Password != "", "ok": s.authed(r)})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if s.Password == "" || !hmac.Equal([]byte(body.Password), []byte(s.Password)) {
		time.Sleep(500 * time.Millisecond)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "パスワードが違います"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: s.token(), Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", MaxAge: 365 * 24 * 3600,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- events / status ----

func (s *Server) sse(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("retry: 3000\n\n"))
	fl.Flush()

	ch, unsub := s.Hub.Subscribe()
	defer unsub()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case b := <-ch:
			w.Write([]byte("data: "))
			w.Write(b)
			w.Write([]byte("\n\n"))
			fl.Flush()
		case <-ping.C:
			w.Write([]byte(": ping\n\n"))
			fl.Flush()
		}
	}
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	c, err := s.S.JobCounts(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": c, "scanning": s.scanning.Load()})
}

// scan runs a library import in the background; the result arrives as an SSE "scan" event.
func (s *Server) scan(w http.ResponseWriter, r *http.Request) {
	if !s.scanning.CompareAndSwap(false, true) {
		writeJSON(w, http.StatusAccepted, map[string]bool{"started": false})
		return
	}
	go func() {
		defer s.scanning.Store(false)
		res, err := library.Import(context.Background(), s.S, s.R)
		if err != nil {
			log.Printf("scan: %v", err)
		}
		log.Printf("scan: %+v", res)
		s.W.Wake()
		s.Hub.Publish(events.Event{Type: "scan", Data: res})
		s.Hub.Publish(events.Event{Type: "changed", Scope: "all"})
	}()
	writeJSON(w, http.StatusAccepted, map[string]bool{"started": true})
}
