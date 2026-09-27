// Package events fans out change notifications to SSE subscribers so every
// open device refreshes when something changes elsewhere.
package events

import (
	"encoding/json"
	"sync"
)

type Event struct {
	Type   string `json:"type"`             // changed | video | scan
	Scope  string `json:"scope,omitempty"`  // videos | folders | all
	ID     string `json:"id,omitempty"`     // video id for type=video
	Status string `json:"status,omitempty"` // video status for type=video
	Origin string `json:"origin,omitempty"` // X-Client-Id of the requester
	Data   any    `json:"data,omitempty"`
}

type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func NewHub() *Hub { return &Hub{subs: map[chan []byte]struct{}{}} }

func (h *Hub) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 32)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		delete(h.subs, ch)
		h.mu.Unlock()
	}
}

func (h *Hub) Publish(e Event) {
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- b:
		default: // slow client; it will resync on the next event
		}
	}
}
