package api

import (
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"

	"videovault/internal/store"
)

// serveFile uses http.ServeContent, which handles Range requests for seeking.
func serveFile(w http.ResponseWriter, r *http.Request, p, ctype, cache string) {
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	if ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	w.Header().Set("Cache-Control", cache)
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func (s *Server) video(w http.ResponseWriter, r *http.Request) (store.Video, bool) {
	v, err := s.S.GetVideo(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return v, false
	}
	return v, true
}

func (s *Server) mediaPlay(w http.ResponseWriter, r *http.Request) {
	v, ok := s.video(w, r)
	if !ok {
		return
	}
	root, rel := v.PlayRoot, v.PlayRel
	if rel == "" { // not processed yet: try the original
		root, rel = v.SrcRoot, v.SrcRel
	}
	p, err := s.R.Abs(root, rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	serveFile(w, r, p, mimeFor(rel), "private, max-age=3600")
}

func (s *Server) mediaOriginal(w http.ResponseWriter, r *http.Request) {
	v, ok := s.video(w, r)
	if !ok {
		return
	}
	p, err := s.R.Abs(v.SrcRoot, v.SrcRel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	name := v.Title + path.Ext(v.SrcRel)
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	serveFile(w, r, p, mimeFor(v.SrcRel), "private, max-age=3600")
}

// Thumbnails and sprites are requested with ?v=<media_v>, so they can be cached forever.
func (s *Server) mediaThumb(w http.ResponseWriter, r *http.Request) {
	serveFile(w, r, s.R.Thumb(r.PathValue("id")), "image/jpeg", "private, max-age=31536000, immutable")
}

func (s *Server) mediaSprite(w http.ResponseWriter, r *http.Request) {
	serveFile(w, r, s.R.Sprite(r.PathValue("id")), "image/jpeg", "private, max-age=31536000, immutable")
}

func mimeFor(rel string) string {
	switch ext := strings.ToLower(path.Ext(rel)); ext {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	default:
		return mime.TypeByExtension(ext)
	}
}
