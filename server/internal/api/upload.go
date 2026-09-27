package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"
	"golang.org/x/text/unicode/norm"

	"videovault/internal/events"
	"videovault/internal/library"
	"videovault/internal/paths"
	"videovault/internal/store"
)

var extRe = regexp.MustCompile(`^\.[a-z0-9]{1,5}$`)

// uploadHandler serves the tus resumable-upload protocol under /api/uploads/.
// Clients send metadata: id (UUID chosen by the client), filename, folder_id.
// The video row is created in PreFinishResponseCallback, i.e. before the final
// PATCH response, so the client can show the real card as soon as it succeeds.
func (s *Server) uploadHandler(ctx context.Context) (http.Handler, error) {
	composer := tusd.NewStoreComposer()
	filestore.New(s.R.TusDir()).UseIn(composer)

	h, err := tusd.NewHandler(tusd.Config{
		BasePath:                "/api/uploads/",
		StoreComposer:           composer,
		RespectForwardedHeaders: true,
		PreUploadCreateCallback: func(ev tusd.HookEvent) (tusd.HTTPResponse, tusd.FileInfoChanges, error) {
			md := ev.Upload.MetaData
			if !store.ValidID(md["id"]) {
				return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, tusd.NewError("ERR_BAD_ID", "metadata id must be a UUID", http.StatusBadRequest)
			}
			if !library.IsVideoExt(path.Ext(strings.ToLower(md["filename"]))) && !strings.HasPrefix(md["filetype"], "video/") {
				return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, tusd.NewError("ERR_NOT_VIDEO", "動画ファイルではありません", http.StatusUnsupportedMediaType)
			}
			if _, err := s.S.GetVideo(ev.Context, md["id"]); err == nil {
				return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, tusd.NewError("ERR_EXISTS", "already uploaded", http.StatusConflict)
			}
			return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, nil
		},
		PreFinishResponseCallback: func(ev tusd.HookEvent) (tusd.HTTPResponse, error) {
			if err := s.finishUpload(ev.Context, ev.Upload); err != nil {
				return tusd.HTTPResponse{}, err
			}
			return tusd.HTTPResponse{}, nil
		},
	})
	if err != nil {
		return nil, err
	}
	return http.StripPrefix("/api/uploads/", relativeLocation(h)), nil
}

func (s *Server) finishUpload(ctx context.Context, info tusd.FileInfo) error {
	md := info.MetaData
	id := md["id"]
	name := norm.NFC.String(path.Base(strings.ReplaceAll(md["filename"], `\`, "/")))
	ext := strings.ToLower(path.Ext(name))
	if !extRe.MatchString(ext) {
		ext = ".mp4"
	}
	title := strings.TrimSuffix(name, path.Ext(name))
	if t, err := store.CleanTitle(title); err == nil {
		title = t
	} else {
		title = "無題"
	}
	var folder *string
	if f := md["folder_id"]; f != "" {
		folder = &f
	}

	rel := paths.UploadRel(id, ext)
	dst, _ := s.R.Abs(paths.RootData, rel)
	if err := os.Rename(info.Storage["Path"], dst); err != nil {
		return err
	}
	os.Remove(info.Storage["Path"] + ".info")
	fp, size, err := library.Fingerprint(dst)
	if err != nil {
		return err
	}
	err = s.S.InsertVideo(ctx, store.Video{
		ID: id, FolderID: folder, Title: title, SrcRoot: paths.RootData, SrcRel: rel, SizeBytes: size, Fingerprint: fp,
	})
	if err != nil && !errors.Is(err, store.ErrConflict) {
		return err
	}
	s.W.Wake()
	s.Hub.Publish(events.Event{Type: "changed", Scope: "all"})
	return nil
}

// relativeLocation rewrites tusd's absolute Location header to a path, so uploads
// work behind any proxy (e.g. tailscale serve over HTTPS) regardless of forwarded headers.
func relativeLocation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&locWriter{ResponseWriter: w}, r)
	})
}

type locWriter struct {
	http.ResponseWriter
	done bool
}

func (l *locWriter) WriteHeader(code int) {
	if !l.done {
		l.done = true
		if loc := l.Header().Get("Location"); loc != "" {
			if u, err := url.Parse(loc); err == nil && u.IsAbs() {
				l.Header().Set("Location", u.RequestURI())
			}
		}
	}
	l.ResponseWriter.WriteHeader(code)
}

func (l *locWriter) Write(b []byte) (int, error) {
	if !l.done {
		l.WriteHeader(http.StatusOK)
	}
	return l.ResponseWriter.Write(b)
}

func (l *locWriter) Unwrap() http.ResponseWriter { return l.ResponseWriter }
