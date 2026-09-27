package api

import (
	"io/fs"
	"net/http"
	"strings"
)

// spa serves the embedded frontend, falling back to index.html for client routes.
func (s *Server) spa() http.Handler {
	files := http.FileServerFS(s.Web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasPrefix(p, "api/") || strings.HasPrefix(p, "media/") {
			http.NotFound(w, r)
			return
		}
		if p != "" && p != "index.html" {
			if st, err := fs.Stat(s.Web, p); err == nil && !st.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		// Android share target posts here; the service worker normally intercepts it.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		b, err := fs.ReadFile(s.Web, "index.html")
		if err != nil {
			http.Error(w, "frontend not built", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(b)
	})
}
