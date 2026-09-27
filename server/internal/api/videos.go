package api

import (
	"net/http"
	"strconv"

	"videovault/internal/library"
	"videovault/internal/store"
)

func listParams(r *http.Request) store.ListParams {
	q := r.URL.Query()
	offset, _ := strconv.Atoi(q.Get("cursor"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	return store.ListParams{View: q.Get("view"), Sort: q.Get("sort"), Q: q.Get("q"), Offset: max(0, offset), Limit: limit}
}

func (s *Server) listVideos(w http.ResponseWriter, r *http.Request) {
	p := listParams(r)
	items, total, err := s.S.ListVideos(r.Context(), p)
	if err != nil {
		writeErr(w, err)
		return
	}
	var next *string
	if end := p.Offset + len(items); end < total && len(items) > 0 {
		c := strconv.Itoa(end)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total, "next_cursor": next})
}

func (s *Server) listVideoIDs(w http.ResponseWriter, r *http.Request) {
	ids, err := s.S.ListVideoIDs(r.Context(), listParams(r))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ids": ids})
}

func (s *Server) getVideo(w http.ResponseWriter, r *http.Request) {
	v, err := s.S.GetVideo(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) updateVideo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.S.UpdateTitle(r.Context(), r.PathValue("id"), body.Title); err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "videos")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) retryVideo(w http.ResponseWriter, r *http.Request) {
	if err := s.S.Enqueue(r.Context(), r.PathValue("id")); err != nil {
		writeErr(w, err)
		return
	}
	s.W.Wake()
	s.publish(r, "videos")
	w.WriteHeader(http.StatusNoContent)
}

type idsBody struct {
	IDs      []string `json:"ids"`
	FolderID *string  `json:"folder_id"`
}

func (s *Server) moveVideos(w http.ResponseWriter, r *http.Request) {
	var b idsBody
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	n, err := s.S.MoveVideos(r.Context(), b.IDs, b.FolderID)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "all")
	writeJSON(w, http.StatusOK, map[string]int64{"updated": n})
}

func (s *Server) trashVideos(w http.ResponseWriter, r *http.Request) {
	var b idsBody
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	n, err := s.S.TrashVideos(r.Context(), b.IDs)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "all")
	writeJSON(w, http.StatusOK, map[string]int64{"updated": n})
}

func (s *Server) restoreVideos(w http.ResponseWriter, r *http.Request) {
	var b idsBody
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	n, err := s.S.RestoreVideos(r.Context(), b.IDs)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "all")
	writeJSON(w, http.StatusOK, map[string]int64{"updated": n})
}

// deleteVideos permanently removes videos, but only ones already in the trash.
func (s *Server) deleteVideos(w http.ResponseWriter, r *http.Request) {
	var b idsBody
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	vids, err := s.S.TrashedVideos(r.Context(), b.IDs, 0)
	if err != nil {
		writeErr(w, err)
		return
	}
	n, err := library.Purge(r.Context(), s.S, s.R, vids)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "all")
	writeJSON(w, http.StatusOK, map[string]int{"deleted": n})
}
