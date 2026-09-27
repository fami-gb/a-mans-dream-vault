package api

import (
	"encoding/json"
	"net/http"

	"videovault/internal/store"
)

func (s *Server) listFolders(w http.ResponseWriter, r *http.Request) {
	t, err := s.S.ListFolders(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID       string  `json:"id"`
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	f, err := s.S.CreateFolder(r.Context(), body.ID, body.Name, body.ParentID)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "folders")
	writeJSON(w, http.StatusCreated, f)
}

// updateFolder accepts any of name, parent_id (null = top level) and sort_order.
func (s *Server) updateFolder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body map[string]json.RawMessage
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	ctx := r.Context()
	if raw, ok := body["name"]; ok {
		var name string
		if err := json.Unmarshal(raw, &name); err != nil {
			writeErr(w, store.ValidationError{Msg: "name must be a string"})
			return
		}
		if err := s.S.RenameFolder(ctx, id, name); err != nil {
			writeErr(w, err)
			return
		}
	}
	if raw, ok := body["parent_id"]; ok {
		var parent *string
		if err := json.Unmarshal(raw, &parent); err != nil {
			writeErr(w, store.ValidationError{Msg: "parent_id must be a string or null"})
			return
		}
		if err := s.S.MoveFolder(ctx, id, parent); err != nil {
			writeErr(w, err)
			return
		}
	}
	if raw, ok := body["sort_order"]; ok {
		var order int
		if err := json.Unmarshal(raw, &order); err != nil {
			writeErr(w, store.ValidationError{Msg: "sort_order must be a number"})
			return
		}
		if err := s.S.SetFolderOrder(ctx, id, order); err != nil {
			writeErr(w, err)
			return
		}
	}
	s.publish(r, "folders")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	if err := s.S.DeleteFolder(r.Context(), r.PathValue("id")); err != nil {
		writeErr(w, err)
		return
	}
	s.publish(r, "all")
	w.WriteHeader(http.StatusNoContent)
}
