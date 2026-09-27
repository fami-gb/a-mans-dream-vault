// Package media wraps ffprobe/ffmpeg: probing, making a browser-safe MP4,
// and generating the thumbnail and scrub-preview sprite.
package media

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Sprite geometry shared with the frontend.
const (
	SpriteFrames = 10
	SpriteW      = 320
	SpriteH      = 180
)

type Probe struct {
	DurationMs int64
	VideoMs    int64 // video stream duration; can be shorter than the container's
	Width      int
	Height     int
	VCodec     string
	ACodec     string
	PixFmt     string
}

func ProbeFile(ctx context.Context, src string) (Probe, error) {
	out, err := run(ctx, "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", src)
	if err != nil {
		return Probe{}, err
	}
	var raw struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType string            `json:"codec_type"`
			CodecName string            `json:"codec_name"`
			Width     int               `json:"width"`
			Height    int               `json:"height"`
			PixFmt    string            `json:"pix_fmt"`
			Duration  string            `json:"duration"`
			Tags      map[string]string `json:"tags"`
			SideData  []struct {
				Rotation float64 `json:"rotation"`
			} `json:"side_data_list"`
			Disposition map[string]int `json:"disposition"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return Probe{}, fmt.Errorf("ffprobe json: %w", err)
	}
	var p Probe
	dur, _ := strconv.ParseFloat(raw.Format.Duration, 64)
	for _, s := range raw.Streams {
		switch s.CodecType {
		case "video":
			if p.VCodec != "" || s.Disposition["attached_pic"] == 1 {
				continue
			}
			p.VCodec, p.PixFmt, p.Width, p.Height = s.CodecName, s.PixFmt, s.Width, s.Height
			rot, _ := strconv.Atoi(s.Tags["rotate"])
			for _, sd := range s.SideData {
				if sd.Rotation != 0 {
					rot = int(sd.Rotation)
				}
			}
			if rot%180 != 0 {
				p.Width, p.Height = p.Height, p.Width
			}
			vd, _ := strconv.ParseFloat(s.Duration, 64)
			p.VideoMs = int64(vd * 1000)
			if dur == 0 {
				dur = vd
			}
		case "audio":
			if p.ACodec == "" {
				p.ACodec = s.CodecName
			}
		}
	}
	if p.VCodec == "" {
		return p, fmt.Errorf("映像トラックがありません")
	}
	p.DurationMs = int64(math.Round(dur * 1000))
	if p.VideoMs <= 0 || p.VideoMs > p.DurationMs {
		p.VideoMs = p.DurationMs
	}
	return p, nil
}

func h264Safe(p Probe) bool {
	return p.VCodec == "h264" && (p.PixFmt == "yuv420p" || p.PixFmt == "yuvj420p")
}

func audioSafe(p Probe) bool {
	return p.ACodec == "" || p.ACodec == "aac" || p.ACodec == "mp3"
}

// Compatible reports whether the source file itself plays in every major browser.
func Compatible(p Probe, ext string) bool {
	ext = strings.ToLower(ext)
	return (ext == ".mp4" || ext == ".m4v") && h264Safe(p) && audioSafe(p)
}

// MakePlayable writes an H.264/AAC MP4 with faststart to dst. H.264 sources are
// remuxed without re-encoding; anything else (HEVC, VP9, ...) is transcoded.
func MakePlayable(ctx context.Context, src, dst string, p Probe) error {
	args := []string{"-y", "-v", "error", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"}
	if h264Safe(p) && audioSafe(p) {
		args = append(args, "-c", "copy")
	} else {
		args = append(args,
			"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
			"-vf", "scale=w='trunc(min(1,1920/max(iw,ih))*iw/2)*2':h='trunc(min(1,1920/max(iw,ih))*ih/2)*2'",
			"-c:a", "aac", "-b:a", "160k", "-ac", "2")
	}
	return writeAtomic(dst, func(tmp string) error {
		_, err := run(ctx, "ffmpeg", append(args, "-movflags", "+faststart", "-f", "mp4", tmp)...)
		return err
	})
}

// MakeThumb grabs a frame ~10% in, which avoids black intro frames.
func MakeThumb(ctx context.Context, src, dst string, durMs int64) error {
	at := float64(durMs) / 1000 * 0.1
	if at > 30 {
		at = 30
	}
	grab := func(t float64) error {
		return writeAtomic(dst, func(tmp string) error {
			_, err := run(ctx, "ffmpeg", "-y", "-v", "error", "-ss", ftoa(t), "-i", src,
				"-frames:v", "1", "-vf", "scale=w='min(640,iw)':h=-2", "-q:v", "4", "-f", "image2", tmp)
			if err == nil && !nonEmpty(tmp) {
				err = fmt.Errorf("no frame at %.1fs", t)
			}
			return err
		})
	}
	if err := grab(at); err != nil && at > 0 {
		return grab(0)
	} else {
		return err
	}
}

// MakeSprite tiles SpriteFrames evenly spaced frames horizontally, each
// letterboxed into SpriteW x SpriteH, using fast input seeking per frame.
// videoMs should be the video stream's duration: seeking past the last video
// frame yields no frame and fails the whole sprite, so it retries over a shorter span.
func MakeSprite(ctx context.Context, src, dst string, videoMs int64) error {
	err := makeSprite(ctx, src, dst, float64(videoMs)/1000*0.97)
	if err != nil && ctx.Err() == nil {
		err = makeSprite(ctx, src, dst, float64(videoMs)/1000*0.7)
	}
	return err
}

func makeSprite(ctx context.Context, src, dst string, dur float64) error {
	var args []string
	var filter strings.Builder
	for i := 0; i < SpriteFrames; i++ {
		t := dur * (float64(i) + 0.5) / SpriteFrames
		args = append(args, "-ss", ftoa(t), "-i", src)
		fmt.Fprintf(&filter, "[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:black,setsar=1,trim=end_frame=1[f%d];",
			i, SpriteW, SpriteH, SpriteW, SpriteH, i)
	}
	for i := 0; i < SpriteFrames; i++ {
		fmt.Fprintf(&filter, "[f%d]", i)
	}
	fmt.Fprintf(&filter, "hstack=inputs=%d[out]", SpriteFrames)
	return writeAtomic(dst, func(tmp string) error {
		full := append([]string{"-y", "-v", "error"}, args...)
		full = append(full, "-filter_complex", filter.String(), "-map", "[out]", "-frames:v", "1", "-q:v", "5", "-f", "image2", tmp)
		_, err := run(ctx, "ffmpeg", full...)
		if err == nil && !nonEmpty(tmp) {
			err = fmt.Errorf("sprite empty")
		}
		return err
	})
}

func writeAtomic(dst string, fn func(tmp string) error) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".tmp" + filepath.Ext(dst)
	defer os.Remove(tmp)
	if err := fn(tmp); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 400 {
			msg = "…" + msg[len(msg)-400:]
		}
		return nil, fmt.Errorf("%s: %v: %s", name, err, msg)
	}
	return stdout.Bytes(), nil
}

func nonEmpty(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Size() > 0
}

func ftoa(f float64) string { return strconv.FormatFloat(f, 'f', 3, 64) }
